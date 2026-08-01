import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

let testEnv: RulesTestEnvironment;

const ownerUid = "owner-user";
const receipt = {
  ownerUid,
  status: "stored",
  storagePath: `receipts/${ownerUid}/receipt-1/original.jpg`,
  originalFileName: "original.jpg",
  contentType: "image/jpeg",
  size: 1234,
  createdAt: serverTimestamp(),
};

const reviewedReceipt = {
  ...receipt,
  status: "ready_for_extraction",
  storagePath: `receipts/${ownerUid}/receipt-1/original-original.jpg`,
  processedStoragePath: `receipts/${ownerUid}/receipt-1/processed-v1.jpg`,
  processedContentType: "image/jpeg",
  processedSize: 1000,
  processing: {
    version: 1,
    rotation: 90,
    crop: { x: 2.5, y: 3, width: 94, height: 95 },
    sourceWidth: 3024,
    sourceHeight: 4032,
    outputWidth: 1800,
    outputHeight: 2400,
    qualityWarnings: ["low-contrast"],
    processedAt: serverTimestamp(),
  },
};

const emailedReceipt = {
  ownerUid,
  status: "needs_review",
  source: "email",
  storagePath: `receipts/${ownerUid}/receipt-1/original-receipt.pdf`,
  originalFileName: "receipt.pdf",
  contentType: "application/pdf",
  size: 1234,
  contentHash: "a".repeat(64),
  email: {
    sender: "sender@example.com",
    subject: "Your receipt",
    messageId: "<message@example.com>",
    receivedAt: serverTimestamp(),
  },
  createdAt: serverTimestamp(),
};

const emailReviewFields = {
  status: "ready_for_extraction",
  processedStoragePath: `receipts/${ownerUid}/receipt-1/processed-v1.jpg`,
  processedContentType: "image/jpeg",
  processedSize: 1000,
  processing: reviewedReceipt.processing,
  reviewedAt: serverTimestamp(),
};

const readyExtraction = {
  state: "ready_for_verification",
  generation: 1,
  attemptCount: 1,
  queuedAt: serverTimestamp(),
  startedAt: serverTimestamp(),
  completedAt: serverTimestamp(),
  durationMs: 850,
  schemaVersion: 1,
  promptVersion: 1,
  model: "gpt-5.6-luna",
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  result: {
    merchantName: "Corner Shop",
    receiptDate: "2026-07-31",
    currency: "GBP",
    grossTotal: "12.00",
    netTotal: "10.00",
    vatTotal: "2.00",
    confidence: {
      merchantName: "high",
      receiptDate: "high",
      currency: "high",
      grossTotal: "high",
      netTotal: "high",
      vatTotal: "high",
    },
    warnings: [],
  },
};

const verifiedData = {
  merchantName: "Corner Shop",
  purchaseDescription: "Coffee",
  receiptDate: "2026-07-31",
  currency: "GBP",
  grossTotal: "12.00",
  netTotal: "10.00",
  vatTotal: "2.00",
  gbpAmountCharged: null,
};

describe("Firestore receipt rules", () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "demo-fido-rules",
      firestore: {
        host: "127.0.0.1",
        port: 8080,
        rules: readFileSync(resolve("firestore.rules"), "utf8"),
      },
    });
  });

  afterEach(async () => {
    await testEnv.clearFirestore();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it("lets the configured owner create, read, and delete their receipt", async () => {
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertSucceeds(setDoc(receiptRef, receipt));
    await assertSucceeds(getDoc(receiptRef));
    await assertSucceeds(deleteDoc(receiptRef));
  });

  it("lets the owner create a reviewed receipt with bounded processing metadata", async () => {
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertSucceeds(setDoc(receiptRef, reviewedReceipt));
    await assertSucceeds(getDoc(receiptRef));
  });

  it("lets the owner preserve a PDF original and its selected source page", async () => {
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertSucceeds(setDoc(receiptRef, {
      ...reviewedReceipt,
      storagePath: `receipts/${ownerUid}/receipt-1/original-receipt.pdf`,
      originalFileName: "receipt.pdf",
      contentType: "application/pdf",
      processing: { ...reviewedReceipt.processing, sourcePage: 2 },
    }));
  });

  it("rejects invalid reviewed receipt paths, crop bounds, and output dimensions", async () => {
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();

    await assertFails(setDoc(doc(db, "receipts/receipt-1"), {
      ...reviewedReceipt,
      processedStoragePath: `receipts/${ownerUid}/receipt-1/not-the-derived-image.jpg`,
    }));
    await assertFails(setDoc(doc(db, "receipts/receipt-1"), {
      ...reviewedReceipt,
      processing: { ...reviewedReceipt.processing, crop: { x: 80, y: 3, width: 30, height: 95 } },
    }));
    await assertFails(setDoc(doc(db, "receipts/receipt-1"), {
      ...reviewedReceipt,
      processing: { ...reviewedReceipt.processing, outputWidth: 2401 },
    }));
    await assertFails(setDoc(doc(db, "receipts/receipt-1"), {
      ...reviewedReceipt,
      processing: { ...reviewedReceipt.processing, qualityWarnings: ["not-a-real-warning"] },
    }));
    await assertFails(setDoc(doc(db, "receipts/receipt-1"), {
      ...reviewedReceipt,
      processing: { ...reviewedReceipt.processing, sourcePage: 0 },
    }));
  });

  it("lets the owner review an emailed receipt without changing its provenance", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "receipts/receipt-1"), emailedReceipt);
    });
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertSucceeds(updateDoc(receiptRef, emailReviewFields));
    await assertSucceeds(getDoc(receiptRef));
  });

  it("rejects review updates that change an emailed receipt's original or provenance", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "receipts/receipt-1"), emailedReceipt);
    });
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertFails(updateDoc(receiptRef, { ...emailReviewFields, originalFileName: "changed.pdf" }));
    await assertFails(updateDoc(receiptRef, { ...emailReviewFields, email: { ...emailedReceipt.email, sender: "other@example.com" } }));
  });

  it("lets the owner verify extracted receipt values without changing the server extraction", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "receipts/receipt-1"), {
        ...reviewedReceipt,
        extraction: readyExtraction,
      });
    });
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertSucceeds(updateDoc(receiptRef, {
      status: "verified",
      verifiedData,
      verifiedAt: serverTimestamp(),
    }));
  });

  it("accepts a user-supplied GBP charge for a foreign receipt", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "receipts/receipt-1"), {
        ...reviewedReceipt,
        extraction: readyExtraction,
      });
    });
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();

    await assertSucceeds(updateDoc(doc(db, "receipts/receipt-1"), {
      status: "verified",
      verifiedData: {
        ...verifiedData,
        currency: "EUR",
        grossTotal: "18.40",
        netTotal: null,
        vatTotal: null,
        gbpAmountCharged: "16.12",
      },
      verifiedAt: serverTimestamp(),
    }));
  });

  it("rejects invalid verification values and client changes to extraction state", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "receipts/receipt-1"), {
        ...reviewedReceipt,
        extraction: readyExtraction,
      });
    });
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertFails(updateDoc(receiptRef, {
      status: "verified",
      verifiedData: { ...verifiedData, currency: "£" },
      verifiedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(receiptRef, {
      status: "verified",
      verifiedData: { ...verifiedData, currency: "EUR", netTotal: null, vatTotal: null },
      verifiedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(receiptRef, {
      status: "verified",
      verifiedData: { ...verifiedData, gbpAmountCharged: "9.00" },
      verifiedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(receiptRef, {
      status: "verified",
      verifiedData: { ...verifiedData, purchaseDescription: "" },
      verifiedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(receiptRef, {
      status: "verified",
      verifiedData,
      verifiedAt: serverTimestamp(),
      extraction: { ...readyExtraction, model: "changed-in-browser" },
    }));
  });

  it("denies another user and a user without the owner claim", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "receipts/receipt-1"), receipt);
    });

    const otherDb = testEnv.authenticatedContext("other-user", { fidoOwner: true }).firestore();
    const unclaimedDb = testEnv.authenticatedContext(ownerUid).firestore();

    await assertFails(getDoc(doc(otherDb, "receipts/receipt-1")));
    await assertFails(getDoc(doc(unclaimedDb, "receipts/receipt-1")));
  });

  it("never exposes FreeAgent tokens or OAuth state to the browser", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "freeAgentConnections/owner-user"), {
        ownerUid,
        accessToken: { ciphertext: "encrypted" },
      });
      await setDoc(doc(context.firestore(), "freeAgentOAuthStates/state-hash"), {
        ownerUid,
        expiresAt: serverTimestamp(),
      });
      await setDoc(doc(context.firestore(), "freeAgentSync/owner-user"), {
        ownerUid,
        selectedAccounts: [{ id: "1", name: "Business account", currency: "GBP" }],
      });
      await setDoc(doc(context.firestore(), "freeAgentSync/owner-user/transactions/transaction-hash"), {
        ownerUid,
        amount: "-12.40",
        description: "Private transaction",
      });
      await setDoc(doc(context.firestore(), "freeAgentSync/owner-user/matchProposals/receipt-1"), {
        ownerUid,
        receiptId: "receipt-1",
        type: "transaction",
        transaction: { id: "8", amount: "-12.40" },
      });
    });
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();

    await assertFails(getDoc(doc(db, "freeAgentConnections/owner-user")));
    await assertFails(getDoc(doc(db, "freeAgentOAuthStates/state-hash")));
    await assertFails(getDoc(doc(db, "freeAgentSync/owner-user")));
    await assertFails(getDoc(doc(db, "freeAgentSync/owner-user/transactions/transaction-hash")));
    await assertFails(getDoc(doc(db, "freeAgentSync/owner-user/matchProposals/receipt-1")));
    await assertFails(setDoc(doc(db, "freeAgentSync/owner-user/matchProposals/receipt-2"), {
      ownerUid,
      receiptId: "receipt-2",
      type: "unmatched",
    }));
  });

  it("denies updates and unexpected fields", async () => {
    const db = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).firestore();
    const receiptRef = doc(db, "receipts/receipt-1");

    await assertSucceeds(setDoc(receiptRef, receipt));
    await assertFails(updateDoc(receiptRef, { originalFileName: "changed.jpg" }));
    await assertFails(
      setDoc(doc(db, "receipts/receipt-2"), {
        ...receipt,
        secret: "not allowed",
      }),
    );
  });
});
