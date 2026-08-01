import { createHash, randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { getStorage } from "firebase-admin/storage";
import { defineJsonSecret, defineSecret, defineString } from "firebase-functions/params";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { logger } from "firebase-functions";
import OpenAI from "openai";
import { z } from "zod";
import {
  DEFAULT_RECEIPT_MODEL,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  extractReceiptValues,
} from "./extraction.js";
import {
  EmailConfigSchema,
  IngestPayloadSchema,
  MAX_TOTAL_ATTACHMENT_BYTES,
  decodeBase64,
  detectReceiptType,
  safeReceiptFileName,
  verifyIngestSignature,
  type EmailConfig,
  type IngestPayload,
} from "./protocol.js";
import {
  FREEAGENT_APP_ORIGIN,
  FreeAgentRequestError,
  buildFreeAgentAuthorizationUrl,
  decryptSecret,
  encryptSecret,
  exchangeFreeAgentCode,
  fetchFreeAgentBankAccounts,
  fetchFreeAgentBankTransactions,
  fetchFreeAgentIdentity,
  refreshFreeAgentTokens,
  type EncryptedSecret,
  type FreeAgentBankAccount,
  type FreeAgentBankTransaction,
  type FreeAgentIdentity,
  type FreeAgentTokens,
} from "./freeagent.js";

initializeApp();

const ingestSharedSecret = defineSecret("FIDO_INGEST_SHARED_SECRET");
const emailConfig = defineJsonSecret<EmailConfig>("FIDO_EMAIL_CONFIG");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const freeAgentClientId = defineSecret("FIDO_V2_FREEAGENT_CLIENT_ID");
const freeAgentClientSecret = defineSecret("FIDO_V2_FREEAGENT_CLIENT_SECRET");
const freeAgentTokenEncryptionKey = defineSecret("FIDO_V2_FREEAGENT_TOKEN_ENCRYPTION_KEY");
const receiptModel = defineString("OPENAI_RECEIPT_MODEL", { default: DEFAULT_RECEIPT_MODEL });
const EXTRACTION_FUNCTION_NAME = "extractReceipt";
const EXTRACTION_FUNCTION_RESOURCE = `locations/europe-west1/functions/${EXTRACTION_FUNCTION_NAME}`;
const MAX_EXTRACTION_ATTEMPTS = 3;
const FREEAGENT_STATE_LIFETIME_MS = 10 * 60 * 1000;
const FREEAGENT_SYNC_WINDOW_DAYS = 90;

const FreeAgentAccountSelectionSchema = z.object({
  accountIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(20),
}).strict();

const ExtractionTaskSchema = z.object({
  receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  generation: z.number().int().positive().max(100),
}).strict();

type ExtractionTask = z.infer<typeof ExtractionTaskSchema>;

export const queueReceiptExtraction = onDocumentWritten({
  document: "receipts/{receiptId}",
  region: "europe-west1",
  retry: true,
  maxInstances: 5,
}, async (event) => {
  const snapshot = event.data?.after;
  if (!snapshot?.exists) return;
  const receipt = snapshot.data();
  if (!receipt || receipt.status !== "ready_for_extraction" || receipt.extraction) return;

  const payload: ExtractionTask = { receiptId: event.params.receiptId, generation: 1 };
  const queued = await getFirestore().runTransaction(async (transaction) => {
    const current = await transaction.get(snapshot.ref);
    if (!current.exists || current.get("status") !== "ready_for_extraction") return false;
    const currentExtraction = current.get("extraction") as { state?: string; generation?: number; errorCode?: string } | undefined;
    const queueCanBeRetried = currentExtraction?.generation === payload.generation
      && (currentExtraction.state === "queued"
        || (currentExtraction.state === "failed" && currentExtraction.errorCode === "queue_unavailable"));
    if (currentExtraction && !queueCanBeRetried) return false;
    transaction.set(snapshot.ref, {
      extraction: {
        state: "queued",
        generation: payload.generation,
        attemptCount: 0,
        queuedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true });
    return true;
  });
  if (!queued) return;

  try {
    await enqueueExtraction(payload);
  } catch (cause) {
    if (isTaskAlreadyExists(cause)) return;
    await updateExtractionIfCurrent(snapshot.ref, payload.generation, {
      state: "failed",
      generation: payload.generation,
      attemptCount: 0,
      errorCode: "queue_unavailable",
      failedAt: FieldValue.serverTimestamp(),
    });
    throw new Error("receipt_extraction_queue_unavailable");
  }
});

export const extractReceipt = onTaskDispatched<ExtractionTask>({
  region: "europe-west1",
  secrets: [openaiApiKey],
  timeoutSeconds: 180,
  memory: "1GiB",
  maxInstances: 2,
  concurrency: 1,
  retryConfig: {
    maxAttempts: MAX_EXTRACTION_ATTEMPTS,
    minBackoffSeconds: 30,
    maxBackoffSeconds: 300,
    maxDoublings: 3,
  },
  rateLimits: {
    maxConcurrentDispatches: 2,
    maxDispatchesPerSecond: 2,
  },
}, async (request) => {
  const payloadResult = ExtractionTaskSchema.safeParse(request.data);
  if (!payloadResult.success) {
    logger.warn("Rejected invalid receipt extraction task payload");
    return;
  }

  const payload = payloadResult.data;
  const receiptRef = getFirestore().collection("receipts").doc(payload.receiptId);
  const claimed = await getFirestore().runTransaction(async (transaction) => {
    const current = await transaction.get(receiptRef);
    if (!current.exists || current.get("status") !== "ready_for_extraction") return null;
    const receipt = current.data()!;
    const extraction = receipt.extraction as { state?: string; generation?: number; queuedAt?: unknown } | undefined;
    if (!extraction || extraction.generation !== payload.generation || !["queued", "processing"].includes(extraction.state ?? "")) return null;
    transaction.set(receiptRef, {
      extraction: {
        state: "processing",
        generation: payload.generation,
        attemptCount: request.retryCount + 1,
        queuedAt: extraction.queuedAt ?? FieldValue.serverTimestamp(),
        startedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true });
    return { receipt, queuedAt: extraction.queuedAt };
  });
  if (!claimed) return;
  const { receipt, queuedAt } = claimed;

  const startedAt = Date.now();
  try {
    const processedStoragePath = receipt.processedStoragePath;
    const expectedStoragePath = `receipts/${receipt.ownerUid}/${payload.receiptId}/processed-v1.jpg`;
    if (typeof processedStoragePath !== "string" || processedStoragePath !== expectedStoragePath) {
      throw new PermanentExtractionError("invalid_processed_asset");
    }
    const [image] = await getStorage().bucket().file(processedStoragePath).download();
    if (!image.length || image.length >= 20 * 1024 * 1024) {
      throw new PermanentExtractionError("invalid_processed_asset");
    }

    const extracted = await extractReceiptValues({
      client: new OpenAI({ apiKey: openaiApiKey.value(), maxRetries: 0, timeout: 120_000 }),
      image,
      model: receiptModel.value(),
    });

    await updateExtractionIfCurrent(receiptRef, payload.generation, {
      state: "ready_for_verification",
      generation: payload.generation,
      attemptCount: request.retryCount + 1,
      queuedAt: queuedAt ?? Timestamp.fromMillis(startedAt),
      startedAt: Timestamp.fromMillis(startedAt),
      completedAt: FieldValue.serverTimestamp(),
      durationMs: Date.now() - startedAt,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      model: extracted.model,
      usage: extracted.usage,
      result: extracted.result,
    });
  } catch (cause) {
    const errorCode = extractionErrorCode(cause);
    const finalAttempt = isPermanentExtractionFailure(cause) || request.retryCount >= MAX_EXTRACTION_ATTEMPTS - 1;
    await updateExtractionIfCurrent(receiptRef, payload.generation, finalAttempt ? {
        state: "failed",
        generation: payload.generation,
        attemptCount: request.retryCount + 1,
        queuedAt: queuedAt ?? Timestamp.fromMillis(startedAt),
        errorCode,
        failedAt: FieldValue.serverTimestamp(),
      } : {
        state: "queued",
        generation: payload.generation,
        attemptCount: request.retryCount + 1,
        queuedAt: queuedAt ?? Timestamp.fromMillis(startedAt),
        lastErrorCode: errorCode,
      });
    if (!finalAttempt) throw new Error(`receipt_extraction_retry:${errorCode}`);
  }
});

export const retryReceiptExtraction = onCall({
  region: "europe-west1",
  timeoutSeconds: 30,
}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to retry extraction.");
  if (request.auth.token.fidoOwner !== true) throw new HttpsError("permission-denied", "This account is not the Fido owner.");
  const parsed = z.object({ receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict().safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "A valid receipt is required.");

  const receiptRef = getFirestore().collection("receipts").doc(parsed.data.receiptId);
  const generation = await getFirestore().runTransaction(async (transaction) => {
    const receipt = await transaction.get(receiptRef);
    if (!receipt.exists || receipt.get("ownerUid") !== request.auth!.uid) {
      throw new HttpsError("not-found", "Receipt not found.");
    }
    const extraction = receipt.get("extraction") as { state?: string; generation?: number } | undefined;
    if (receipt.get("status") !== "ready_for_extraction" || (extraction && extraction.state !== "failed")) {
      throw new HttpsError("failed-precondition", "This receipt is not waiting to be queued.");
    }
    const nextGeneration = (extraction?.generation ?? 0) + 1;
    transaction.set(receiptRef, {
      extraction: {
        state: "queued",
        generation: nextGeneration,
        attemptCount: 0,
        queuedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true });
    return nextGeneration;
  });

  const payload = { receiptId: parsed.data.receiptId, generation };
  try {
    await enqueueExtraction(payload);
  } catch (cause) {
    if (!isTaskAlreadyExists(cause)) {
      await updateExtractionIfCurrent(receiptRef, generation, {
        state: "failed",
        generation,
        attemptCount: 0,
        errorCode: "queue_unavailable",
        failedAt: FieldValue.serverTimestamp(),
      });
      throw new HttpsError("unavailable", "Extraction could not be queued. Try again shortly.");
    }
  }
  return { queued: true };
});

export const startFreeAgentOAuth = onCall({
  region: "europe-west1",
  secrets: [freeAgentClientId],
  timeoutSeconds: 30,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  const state = randomBytes(32).toString("base64url");
  const stateRef = getFirestore().collection("freeAgentOAuthStates").doc(hash(state));
  await stateRef.create({
    ownerUid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + FREEAGENT_STATE_LIFETIME_MS),
  });
  return { authorizationUrl: buildFreeAgentAuthorizationUrl({ clientId: freeAgentClientId.value(), state }) };
});

export const freeAgentOAuthCallback = onRequest({
  region: "europe-west1",
  invoker: "public",
  secrets: [freeAgentClientId, freeAgentClientSecret, freeAgentTokenEncryptionKey],
  timeoutSeconds: 60,
  maxInstances: 5,
  cors: false,
}, async (request, response) => {
  response.set("cache-control", "no-store");
  response.set("referrer-policy", "no-referrer");
  if (request.method !== "GET") {
    response.status(405).send("GET required");
    return;
  }
  const query = z.object({
    code: z.string().min(1).max(4096),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).safeParse({ code: singleQueryValue(request.query.code), state: singleQueryValue(request.query.state) });
  if (!query.success) {
    response.redirect(303, freeAgentResultUrl("error", singleQueryValue(request.query.error) || "invalid_callback"));
    return;
  }

  const stateRef = getFirestore().collection("freeAgentOAuthStates").doc(hash(query.data.state));
  try {
    const ownerUid = await getFirestore().runTransaction(async (transaction) => {
      const state = await transaction.get(stateRef);
      const expiresAt = state.get("expiresAt") as Timestamp | undefined;
      if (!state.exists || state.get("consumedAt") || !expiresAt || expiresAt.toMillis() <= Date.now()) {
        throw new OAuthCallbackError("invalid_or_expired_state");
      }
      const uid = state.get("ownerUid");
      if (typeof uid !== "string" || !uid) throw new OAuthCallbackError("invalid_state_owner");
      transaction.update(stateRef, { consumedAt: FieldValue.serverTimestamp() });
      return uid;
    });

    const tokens = await exchangeFreeAgentCode({
      clientId: freeAgentClientId.value(),
      clientSecret: freeAgentClientSecret.value(),
      code: query.data.code,
    });
    const identity = await fetchFreeAgentIdentity(tokens.access_token);
    await storeFreeAgentConnection(ownerUid, tokens, identity, true);
    await stateRef.delete().catch(() => undefined);
    response.redirect(303, freeAgentResultUrl("connected"));
  } catch (cause) {
    const errorCode = freeAgentErrorCode(cause);
    logger.warn("FreeAgent OAuth callback failed", {
      errorCode,
      upstreamStatus: cause instanceof FreeAgentRequestError ? cause.status : undefined,
    });
    response.redirect(303, freeAgentResultUrl("error", errorCode));
  }
});

export const getFreeAgentConnection = onCall({
  region: "europe-west1",
  timeoutSeconds: 30,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  const connection = await freeAgentConnectionRef(ownerUid).get();
  if (!connection.exists || connection.get("status") !== "connected") return { connected: false as const };
  return publicFreeAgentConnection(connection.data()!);
});

export const verifyFreeAgentConnection = onCall({
  region: "europe-west1",
  secrets: [freeAgentClientId, freeAgentClientSecret, freeAgentTokenEncryptionKey],
  timeoutSeconds: 60,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  const identity = await withFreeAgentAccessToken(ownerUid, (accessToken) => fetchFreeAgentIdentity(accessToken));
  await freeAgentConnectionRef(ownerUid).set({
    profile: identity.user,
    company: identity.company,
    lastVerifiedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const updated = await freeAgentConnectionRef(ownerUid).get();
  return publicFreeAgentConnection(updated.data()!);
});

export const getFreeAgentBanking = onCall({
  region: "europe-west1",
  secrets: [freeAgentClientId, freeAgentClientSecret, freeAgentTokenEncryptionKey],
  timeoutSeconds: 60,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  try {
    const accounts = await withFreeAgentAccessToken(ownerUid, (accessToken) => fetchFreeAgentBankAccounts(accessToken));
    return bankingState(ownerUid, accounts);
  } catch (cause) {
    throw freeAgentCallableError(cause, "FreeAgent bank accounts could not be loaded.");
  }
});

export const saveFreeAgentBankAccounts = onCall({
  region: "europe-west1",
  secrets: [freeAgentClientId, freeAgentClientSecret, freeAgentTokenEncryptionKey],
  timeoutSeconds: 60,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  const parsed = FreeAgentAccountSelectionSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Select at least one valid bank account.");
  try {
    const accounts = await withFreeAgentAccessToken(ownerUid, (accessToken) => fetchFreeAgentBankAccounts(accessToken));
    const selectable = new Map(accounts
      .filter((account) => account.status === "active" && account.currency === "GBP")
      .map((account) => [account.id, account]));
    const selectedIds = [...new Set(parsed.data.accountIds)];
    const selectedAccounts = selectedIds.map((id) => selectable.get(id));
    if (selectedAccounts.some((account) => !account)) {
      throw new HttpsError("invalid-argument", "Only active GBP accounts can participate in matching.");
    }
    await freeAgentSyncRef(ownerUid).set({
      ownerUid,
      selectedAccounts,
      syncWindowDays: FREEAGENT_SYNC_WINDOW_DAYS,
      selectionUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await deleteUnselectedTransactions(ownerUid, new Set(selectedIds));
    return bankingState(ownerUid, accounts);
  } catch (cause) {
    if (cause instanceof HttpsError) throw cause;
    throw freeAgentCallableError(cause, "The account selection could not be saved.");
  }
});

export const syncFreeAgentTransactions = onCall({
  region: "europe-west1",
  secrets: [freeAgentClientId, freeAgentClientSecret, freeAgentTokenEncryptionKey],
  timeoutSeconds: 180,
  maxInstances: 2,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  const syncRef = freeAgentSyncRef(ownerUid);
  const config = await syncRef.get();
  const selectedAccounts = parseStoredSelectedAccounts(config.get("selectedAccounts"));
  if (!selectedAccounts.length) throw new HttpsError("failed-precondition", "Choose at least one GBP account before syncing.");

  const runId = randomBytes(12).toString("hex");
  const { fromDate, toDate } = freeAgentSyncWindow(new Date());
  await syncRef.set({
    syncStatus: "syncing",
    syncRunId: runId,
    syncStartedAt: FieldValue.serverTimestamp(),
    syncFromDate: fromDate,
    syncToDate: toDate,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  try {
    const accounts = await withFreeAgentAccessToken(ownerUid, (accessToken) => fetchFreeAgentBankAccounts(accessToken));
    const currentAccounts = new Map(accounts.map((account) => [account.id, account]));
    const validAccounts = selectedAccounts.map((selected) => currentAccounts.get(selected.id));
    if (validAccounts.some((account) => !account || account.status !== "active" || account.currency !== "GBP")) {
      throw new HttpsError("failed-precondition", "A selected account is no longer an active GBP account. Review the selection.");
    }

    const transactions = await withFreeAgentAccessToken(ownerUid, async (accessToken) => {
      const fetched: FreeAgentBankTransaction[] = [];
      for (const account of validAccounts as FreeAgentBankAccount[]) {
        fetched.push(...await fetchFreeAgentBankTransactions({
          accessToken,
          bankAccountUrl: account.url,
          fromDate,
          toDate,
        }));
      }
      return fetched;
    });
    await replaceFreeAgentTransactionWindow(ownerUid, validAccounts as FreeAgentBankAccount[], transactions, {
      runId,
      fromDate,
      toDate,
    });
    await syncRef.set({
      selectedAccounts: validAccounts,
      syncStatus: "ready",
      transactionCount: transactions.length,
      lastSyncCompletedAt: FieldValue.serverTimestamp(),
      lastSyncErrorCode: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return bankingState(ownerUid, accounts);
  } catch (cause) {
    const errorCode = freeAgentErrorCode(cause);
    await syncRef.set({
      syncStatus: "failed",
      lastSyncErrorCode: errorCode,
      lastSyncFailedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (cause instanceof HttpsError) throw cause;
    throw freeAgentCallableError(cause, "FreeAgent transactions could not be synchronised.");
  }
});

export const disconnectFreeAgent = onCall({
  region: "europe-west1",
  timeoutSeconds: 30,
}, async (request) => {
  const ownerUid = requireOwner(request.auth);
  await getFirestore().recursiveDelete(freeAgentSyncRef(ownerUid));
  await freeAgentConnectionRef(ownerUid).delete();
  return { connected: false as const };
});

function requireOwner(auth: { uid: string; token: Record<string, unknown> } | undefined): string {
  if (!auth) throw new HttpsError("unauthenticated", "Sign in to manage FreeAgent.");
  if (auth.token.fidoOwner !== true) throw new HttpsError("permission-denied", "This account is not the Fido owner.");
  return auth.uid;
}

function freeAgentConnectionRef(ownerUid: string) {
  return getFirestore().collection("freeAgentConnections").doc(ownerUid);
}

function freeAgentSyncRef(ownerUid: string) {
  return getFirestore().collection("freeAgentSync").doc(ownerUid);
}

function freeAgentTransactionsRef(ownerUid: string) {
  return freeAgentSyncRef(ownerUid).collection("transactions");
}

async function storeFreeAgentConnection(
  ownerUid: string,
  tokens: FreeAgentTokens,
  identity: FreeAgentIdentity,
  newlyConnected: boolean,
): Promise<void> {
  const now = Date.now();
  await freeAgentConnectionRef(ownerUid).set({
    ownerUid,
    provider: "freeagent",
    environment: "production",
    status: "connected",
    accessToken: encryptSecret(tokens.access_token, freeAgentTokenEncryptionKey.value()),
    refreshToken: encryptSecret(tokens.refresh_token, freeAgentTokenEncryptionKey.value()),
    accessTokenExpiresAt: Timestamp.fromMillis(now + tokens.expires_in * 1000),
    refreshTokenExpiresAt: tokens.refresh_token_expires_in
      ? Timestamp.fromMillis(now + tokens.refresh_token_expires_in * 1000)
      : null,
    profile: identity.user,
    company: identity.company,
    ...(newlyConnected ? { connectedAt: FieldValue.serverTimestamp() } : {}),
    lastVerifiedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function validFreeAgentAccessToken(ownerUid: string, forceRefresh: boolean): Promise<string> {
  const connection = await freeAgentConnectionRef(ownerUid).get();
  if (!connection.exists || connection.get("status") !== "connected") {
    throw new HttpsError("failed-precondition", "FreeAgent is not connected.");
  }
  const expiresAt = connection.get("accessTokenExpiresAt") as Timestamp | undefined;
  const encryptedAccessToken = connection.get("accessToken") as EncryptedSecret | undefined;
  if (!forceRefresh && expiresAt && expiresAt.toMillis() > Date.now() + 60_000 && encryptedAccessToken) {
    return decryptSecret(encryptedAccessToken, freeAgentTokenEncryptionKey.value());
  }

  const encryptedRefreshToken = connection.get("refreshToken") as EncryptedSecret | undefined;
  if (!encryptedRefreshToken) throw new HttpsError("failed-precondition", "Reconnect FreeAgent to continue.");
  const tokens = await refreshFreeAgentTokens({
    clientId: freeAgentClientId.value(),
    clientSecret: freeAgentClientSecret.value(),
    refreshToken: decryptSecret(encryptedRefreshToken, freeAgentTokenEncryptionKey.value()),
  });
  await storeFreeAgentConnection(ownerUid, tokens, {
    user: connection.get("profile") as FreeAgentIdentity["user"],
    company: connection.get("company") as FreeAgentIdentity["company"],
  }, false);
  return tokens.access_token;
}

async function withFreeAgentAccessToken<T>(
  ownerUid: string,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  let accessToken = await validFreeAgentAccessToken(ownerUid, false);
  try {
    return await operation(accessToken);
  } catch (cause) {
    if (!(cause instanceof FreeAgentRequestError) || cause.status !== 401) throw cause;
    accessToken = await validFreeAgentAccessToken(ownerUid, true);
    return operation(accessToken);
  }
}

async function bankingState(ownerUid: string, accounts: FreeAgentBankAccount[]) {
  const [config, transactionSnapshot] = await Promise.all([
    freeAgentSyncRef(ownerUid).get(),
    freeAgentTransactionsRef(ownerUid).get(),
  ]);
  const selectedAccounts = parseStoredSelectedAccounts(config.get("selectedAccounts"));
  const selectedIds = new Set(selectedAccounts.map((account) => account.id));
  const lastSyncCompletedAt = config.get("lastSyncCompletedAt") as Timestamp | undefined;
  return {
    accounts,
    selectedAccountIds: [...selectedIds],
    sync: {
      status: config.get("syncStatus") === "failed" ? "failed" as const : "ready" as const,
      windowDays: FREEAGENT_SYNC_WINDOW_DAYS,
      fromDate: typeof config.get("syncFromDate") === "string" ? config.get("syncFromDate") as string : null,
      toDate: typeof config.get("syncToDate") === "string" ? config.get("syncToDate") as string : null,
      lastCompletedAt: lastSyncCompletedAt?.toDate().toISOString() ?? null,
      transactionCount: transactionSnapshot.size,
    },
    transactions: transactionSnapshot.docs
      .map((document) => publicFreeAgentTransaction(document.data()))
      .filter((transaction) => selectedIds.has(transaction.bankAccountId))
      .sort((left, right) => right.datedOn.localeCompare(left.datedOn) || right.id.localeCompare(left.id)),
    outOfPocket: {
      supported: true as const,
      writeEnabled: false as const,
      message: "Receipts paid personally or with cash can be sent to FreeAgent as an out-of-pocket expense after explicit review.",
    },
  };
}

function publicFreeAgentTransaction(data: Record<string, unknown>) {
  return {
    id: String(data.id ?? ""),
    url: String(data.url ?? ""),
    bankAccountId: String(data.bankAccountId ?? ""),
    bankAccountUrl: String(data.bankAccountUrl ?? ""),
    bankAccountName: String(data.bankAccountName ?? ""),
    currency: "GBP" as const,
    datedOn: String(data.datedOn ?? ""),
    amount: String(data.amount ?? ""),
    description: String(data.description ?? ""),
    fullDescription: String(data.fullDescription ?? ""),
    unexplainedAmount: String(data.unexplainedAmount ?? ""),
    transactionId: typeof data.transactionId === "string" ? data.transactionId : null,
    updatedAt: String(data.updatedAt ?? ""),
  };
}

function parseStoredSelectedAccounts(value: unknown): FreeAgentBankAccount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const account = candidate as Record<string, unknown>;
    if (typeof account.id !== "string" || typeof account.url !== "string" || typeof account.name !== "string"
      || typeof account.type !== "string" || account.currency !== "GBP" || typeof account.isPersonal !== "boolean"
      || account.status !== "active") return [];
    return [{
      id: account.id,
      url: account.url,
      name: account.name,
      type: account.type,
      currency: "GBP",
      isPersonal: account.isPersonal,
      status: "active" as const,
    }];
  });
}

function freeAgentSyncWindow(now: Date) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (FREEAGENT_SYNC_WINDOW_DAYS - 1));
  return { fromDate: isoDate(from), toDate: isoDate(to) };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function replaceFreeAgentTransactionWindow(
  ownerUid: string,
  accounts: FreeAgentBankAccount[],
  transactions: FreeAgentBankTransaction[],
  sync: { runId: string; fromDate: string; toDate: string },
): Promise<void> {
  const collection = freeAgentTransactionsRef(ownerUid);
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const seen = new Set<string>();
  for (let offset = 0; offset < transactions.length; offset += 400) {
    const batch = getFirestore().batch();
    for (const transaction of transactions.slice(offset, offset + 400)) {
      const documentId = hash(transaction.url);
      seen.add(documentId);
      batch.set(collection.doc(documentId), {
        ownerUid,
        ...transaction,
        bankAccountName: accountNames.get(transaction.bankAccountId) ?? "FreeAgent account",
        currency: "GBP",
        syncRunId: sync.runId,
        syncedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  const selectedIds = new Set(accounts.map((account) => account.id));
  const current = await collection.get();
  const stale = current.docs.filter((document) => {
    const data = document.data();
    return selectedIds.has(String(data.bankAccountId))
      && typeof data.datedOn === "string"
      && data.datedOn >= sync.fromDate
      && data.datedOn <= sync.toDate
      && !seen.has(document.id);
  });
  await deleteFreeAgentTransactionDocuments(stale.map((document) => document.ref));
}

async function deleteUnselectedTransactions(ownerUid: string, selectedIds: Set<string>): Promise<void> {
  const current = await freeAgentTransactionsRef(ownerUid).get();
  await deleteFreeAgentTransactionDocuments(current.docs
    .filter((document) => !selectedIds.has(String(document.get("bankAccountId"))))
    .map((document) => document.ref));
}

async function deleteFreeAgentTransactionDocuments(references: DocumentReference[]): Promise<void> {
  for (let offset = 0; offset < references.length; offset += 400) {
    const batch = getFirestore().batch();
    for (const reference of references.slice(offset, offset + 400)) batch.delete(reference);
    await batch.commit();
  }
}

function freeAgentCallableError(cause: unknown, fallback: string): HttpsError {
  if (cause instanceof FreeAgentRequestError) {
    logger.warn("FreeAgent API request failed", { errorCode: cause.code, upstreamStatus: cause.status });
    if (cause.status === 401) return new HttpsError("failed-precondition", "Reconnect FreeAgent to continue.");
    if (cause.status === 403) return new HttpsError("permission-denied", "The connected FreeAgent user needs Banking access.");
    if (cause.status === 429) return new HttpsError("resource-exhausted", "FreeAgent is rate limiting requests. Try again shortly.");
  }
  logger.warn("FreeAgent operation failed", { errorCode: freeAgentErrorCode(cause) });
  return new HttpsError("unavailable", fallback);
}

function publicFreeAgentConnection(data: Record<string, unknown>) {
  const connectedAt = data.connectedAt as Timestamp | undefined;
  const lastVerifiedAt = data.lastVerifiedAt as Timestamp | undefined;
  return {
    connected: true as const,
    environment: "production" as const,
    profile: data.profile,
    company: data.company,
    connectedAt: connectedAt?.toDate().toISOString() ?? null,
    lastVerifiedAt: lastVerifiedAt?.toDate().toISOString() ?? null,
  };
}

function singleQueryValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function freeAgentResultUrl(result: "connected" | "error", error?: string): string {
  const url = new URL(FREEAGENT_APP_ORIGIN);
  url.searchParams.set("freeagent", result);
  if (error) url.searchParams.set("reason", error.slice(0, 80));
  return url.toString();
}

function freeAgentErrorCode(cause: unknown): string {
  if (cause instanceof OAuthCallbackError || cause instanceof FreeAgentRequestError) return cause.code;
  if (cause instanceof z.ZodError) return "invalid_freeagent_response";
  return "freeagent_connection_failed";
}

class OAuthCallbackError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

async function enqueueExtraction(payload: ExtractionTask): Promise<void> {
  const taskId = hash(`receipt-extraction|${payload.receiptId}|${payload.generation}`);
  await getFunctions().taskQueue<ExtractionTask>(EXTRACTION_FUNCTION_RESOURCE).enqueue(payload, {
    id: taskId,
    dispatchDeadlineSeconds: 180,
  });
}

async function updateExtractionIfCurrent(
  receiptRef: DocumentReference,
  generation: number,
  extraction: Record<string, unknown>,
): Promise<boolean> {
  return getFirestore().runTransaction(async (transaction) => {
    const receipt = await transaction.get(receiptRef);
    if (!receipt.exists || receipt.get("status") !== "ready_for_extraction") return false;
    const currentExtraction = receipt.get("extraction") as { generation?: number } | undefined;
    if (currentExtraction?.generation !== generation) return false;
    transaction.set(receiptRef, { extraction }, { merge: true });
    return true;
  });
}

function isTaskAlreadyExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause
    && (cause as { code: unknown }).code === "functions/task-already-exists";
}

function extractionErrorCode(cause: unknown): string {
  if (cause instanceof PermanentExtractionError) return cause.code;
  if (cause instanceof OpenAI.APIError) {
    if (cause.status === 401 || cause.status === 403) return "openai_authentication";
    if (cause.status === 429) return "openai_rate_limit";
    if (cause.status && cause.status >= 500) return "openai_unavailable";
    return "openai_request_failed";
  }
  if (typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === 404) {
    return "processed_asset_missing";
  }
  return "extraction_failed";
}

function isPermanentExtractionFailure(cause: unknown): boolean {
  if (cause instanceof PermanentExtractionError) return true;
  if (cause instanceof OpenAI.APIError) {
    return cause.status != null && cause.status >= 400 && cause.status < 500
      && ![408, 409, 429].includes(cause.status);
  }
  return typeof cause === "object" && cause !== null && "code" in cause
    && (cause as { code?: unknown }).code === 404;
}

class PermanentExtractionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const receiveReceiptEmail = onRequest({
  region: "europe-west1",
  invoker: "public",
  secrets: [ingestSharedSecret, emailConfig],
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 5,
  cors: false,
}, async (request, response) => {
  if (request.method !== "POST" || request.get("content-type")?.split(";", 1)[0] !== "application/json") {
    response.status(405).send("POST application/json required");
    return;
  }

  const rawBody = request.rawBody;
  const timestamp = request.get("x-fido-timestamp") || "";
  const nonce = request.get("x-fido-nonce") || "";
  const signature = request.get("x-fido-signature") || "";
  if (!verifyIngestSignature({
    secret: ingestSharedSecret.value(),
    timestamp,
    nonce,
    body: rawBody,
    signature,
  })) {
    response.status(401).send("Invalid or expired ingestion signature");
    return;
  }

  const payloadResult = IngestPayloadSchema.safeParse(request.body);
  const configResult = EmailConfigSchema.safeParse(emailConfig.value());
  if (!payloadResult.success || !configResult.success) {
    logger.warn("Receipt email payload or configuration validation failed", {
      payloadValid: payloadResult.success,
      configValid: configResult.success,
    });
    response.status(400).send("Invalid receipt email payload");
    return;
  }
  const payload = payloadResult.data;
  const config = configResult.data;
  if (!payload.originalRecipients.map(normaliseAddress).includes(config.publicAddress)) {
    response.status(403).send("Message was not addressed to the configured receipt mailbox");
    return;
  }
  if (config.allowedSenders.length && !config.allowedSenders.includes(normaliseAddress(payload.sender))) {
    response.status(403).send("Sender is not permitted to submit receipts");
    return;
  }

  const db = getFirestore();
  const deliveryId = hash(`${config.ownerUid}|${deliveryKey(payload)}`);
  try {
    const claim = await claimDelivery(db, deliveryId, payload, config);
    if (claim === "complete") {
      response.status(200).json({ accepted: 0, duplicates: payload.attachments.length });
      return;
    }
    if (claim === "busy") {
      response.status(409).send("This email is already being processed");
      return;
    }

    const result = await storeAttachments(db, payload, config);
    await db.collection("emailDeliveries").doc(deliveryId).set({
      status: "complete",
      acceptedCount: result.accepted,
      duplicateCount: result.duplicates,
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.info("Receipt email ingested", {
      deliveryId,
      acceptedCount: result.accepted,
      duplicateCount: result.duplicates,
    });
    response.status(200).json(result);
  } catch (cause) {
    const errorCode = cause instanceof IngestionError ? cause.code : "internal_error";
    await db.collection("emailDeliveries").doc(deliveryId).set({
      status: cause instanceof IngestionError && cause.permanent ? "rejected" : "failed",
      errorCode,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => undefined);
    logger.error("Receipt email ingestion failed", { deliveryId, errorCode, error: cause });
    if (cause instanceof IngestionError && cause.permanent) {
      response.status(400).send(cause.publicMessage);
      return;
    }
    response.status(500).send("Receipt ingestion failed temporarily");
  }
});

async function storeAttachments(db: Firestore, payload: IngestPayload, config: EmailConfig) {
  const decoded = payload.attachments.map((attachment) => {
    const bytes = decodeBase64(attachment.contentBase64);
    const contentType = detectReceiptType(bytes);
    if (!contentType) throw new IngestionError("unsupported_content", "An attachment is not a supported PDF or receipt image.", true);
    return { attachment, bytes, contentType, contentHash: hash(bytes) };
  });
  const totalBytes = decoded.reduce((total, item) => total + item.bytes.length, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new IngestionError("attachments_too_large", "Receipt attachments are larger than 20 MB in total.", true);
  }

  let accepted = 0;
  let duplicates = 0;
  const bucket = getStorage().bucket();
  for (const item of decoded) {
    const receiptId = hash(`${config.ownerUid}|${deliveryKey(payload)}|${item.contentHash}`);
    const receiptRef = db.collection("receipts").doc(receiptId);
    if ((await receiptRef.get()).exists) {
      duplicates += 1;
      continue;
    }
    const storedName = safeReceiptFileName(item.attachment.filename, item.contentType);
    const storagePath = `receipts/${config.ownerUid}/${receiptId}/original-${storedName}`;
    await bucket.file(storagePath).save(item.bytes, {
      resumable: false,
      validation: "crc32c",
      contentType: item.contentType,
      metadata: {
        cacheControl: "private, no-store, max-age=0",
        metadata: {
          receiptId,
          ownerUid: config.ownerUid,
          assetType: "original",
          source: "email",
          contentHash: item.contentHash,
        },
      },
    });
    try {
      await receiptRef.create({
        ownerUid: config.ownerUid,
        status: "needs_review",
        source: "email",
        storagePath,
        originalFileName: item.attachment.filename.slice(0, 255),
        contentType: item.contentType,
        size: item.bytes.length,
        contentHash: item.contentHash,
        email: {
          sender: normaliseAddress(payload.sender),
          subject: payload.subject,
          messageId: payload.messageId,
          receivedAt: Timestamp.fromDate(new Date(payload.receivedAt)),
        },
        createdAt: FieldValue.serverTimestamp(),
      });
      accepted += 1;
    } catch (cause) {
      if (isAlreadyExists(cause)) duplicates += 1;
      else throw cause;
    }
  }
  return { accepted, duplicates };
}

async function claimDelivery(db: Firestore, deliveryId: string, payload: IngestPayload, config: EmailConfig) {
  const deliveryRef = db.collection("emailDeliveries").doc(deliveryId);
  const senderHash = hash(normaliseAddress(payload.sender));
  const day = new Date().toISOString().slice(0, 10);
  const rateRef = db.collection("emailRateLimits").doc(`${day}_${senderHash}`);
  return db.runTransaction(async (transaction) => {
    const delivery = await transaction.get(deliveryRef);
    if (delivery.exists) {
      const status = delivery.get("status");
      if (status === "complete" || status === "rejected") return "complete" as const;
      const updatedAt = delivery.get("updatedAt") as Timestamp | undefined;
      if (status === "processing" && updatedAt && Date.now() - updatedAt.toMillis() < 5 * 60 * 1000) return "busy" as const;
      transaction.set(deliveryRef, {
        status: "processing",
        attempts: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return "claimed" as const;
    }

    const rate = await transaction.get(rateRef);
    const count = (rate.get("count") as number | undefined) ?? 0;
    if (count >= config.dailyMessageLimit) {
      throw new IngestionError("rate_limit", "The daily receipt email limit has been reached.", true);
    }
    transaction.set(rateRef, {
      count: count + 1,
      day,
      senderHash,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(deliveryRef, {
      status: "processing",
      attempts: 1,
      eventId: payload.eventId,
      senderHash,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return "claimed" as const;
  });
}

function deliveryKey(payload: IngestPayload): string {
  return payload.messageId || `${payload.sender}|${payload.subject}|${payload.receivedAt}`;
}

function normaliseAddress(value: string): string {
  return value.trim().toLowerCase();
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code: unknown }).code === 6;
}

class IngestionError extends Error {
  constructor(public code: string, public publicMessage: string, public permanent: boolean) {
    super(publicMessage);
  }
}
