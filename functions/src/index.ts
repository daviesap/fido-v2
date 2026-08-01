import { createHash } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { defineJsonSecret, defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
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

initializeApp();

const ingestSharedSecret = defineSecret("FIDO_INGEST_SHARED_SECRET");
const emailConfig = defineJsonSecret<EmailConfig>("FIDO_EMAIL_CONFIG");

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
