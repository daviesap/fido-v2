import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteObject, getBytes, ref, uploadBytes } from "firebase/storage";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

let testEnv: RulesTestEnvironment;

const ownerUid = "owner-user";
const objectPath = `receipts/${ownerUid}/receipt-1/original.jpg`;
const ownerMetadata = {
  contentType: "image/jpeg",
  customMetadata: { ownerUid, receiptId: "receipt-1" },
};

describe("Storage receipt rules", () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "demo-fido-rules",
      storage: {
        host: "127.0.0.1",
        port: 9899,
        rules: readFileSync(resolve("storage.rules"), "utf8"),
      },
    });
  });

  afterEach(async () => {
    await testEnv.clearStorage();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it("lets the owner upload, read, and delete a supported image", async () => {
    const storage = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).storage();
    const objectRef = ref(storage, objectPath);

    await assertSucceeds(uploadBytes(objectRef, new Uint8Array([1, 2, 3]), ownerMetadata));
    await assertSucceeds(getBytes(objectRef));
    await assertSucceeds(deleteObject(objectRef));
  });

  it("lets the owner store the processed JPEG beside the original", async () => {
    const storage = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).storage();
    const processedRef = ref(storage, `receipts/${ownerUid}/receipt-1/processed-v1.jpg`);

    await assertSucceeds(uploadBytes(processedRef, new Uint8Array([1, 2, 3]), {
      contentType: "image/jpeg",
      customMetadata: { ownerUid, receiptId: "receipt-1", assetType: "processed" },
    }));
    await assertSucceeds(getBytes(processedRef));
    await assertSucceeds(deleteObject(processedRef));
  });

  it("lets the owner store a PDF original", async () => {
    const storage = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).storage();
    const pdfRef = ref(storage, `receipts/${ownerUid}/receipt-1/original-receipt.pdf`);

    await assertSucceeds(uploadBytes(pdfRef, new TextEncoder().encode("%PDF-1.7"), {
      contentType: "application/pdf",
      customMetadata: { ownerUid, receiptId: "receipt-1", assetType: "original" },
    }));
    await assertSucceeds(getBytes(pdfRef));
  });

  it("denies other users and users without the owner claim", async () => {
    const ownerStorage = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).storage();
    await uploadBytes(ref(ownerStorage, objectPath), new Uint8Array([1]), ownerMetadata);

    const otherStorage = testEnv.authenticatedContext("other-user", { fidoOwner: true }).storage();
    const unclaimedStorage = testEnv.authenticatedContext(ownerUid).storage();

    await assertFails(getBytes(ref(otherStorage, objectPath)));
    await assertFails(getBytes(ref(unclaimedStorage, objectPath)));
  });

  it("denies unsupported content types and paths owned by another UID", async () => {
    const storage = testEnv.authenticatedContext(ownerUid, { fidoOwner: true }).storage();

    await assertFails(
      uploadBytes(ref(storage, objectPath), new Uint8Array([1]), { ...ownerMetadata, contentType: "application/javascript" }),
    );
    await assertFails(
      uploadBytes(ref(storage, "receipts/other-user/receipt-1/original.jpg"), new Uint8Array([1]), {
        ...ownerMetadata,
      }),
    );
  });
});
