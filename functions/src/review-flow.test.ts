import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { confirmReceiptAttachment, getReceiptAttachmentPreview, getReceiptMatchOptions, saveReceiptMatchProposal } from "./index.js";

const fake = vi.hoisted(() => ({
  documents: new Map<string, Record<string, unknown>>(),
  fetchTransaction: vi.fn(), fetchExplanation: vi.fn(), updateAttachment: vi.fn(),
}));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn() }));
vi.mock("firebase-admin/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase-admin/firestore")>();
  function apply(value: unknown): unknown {
    if (value instanceof actual.Timestamp) return value;
    if (Array.isArray(value)) return value.map(apply);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.operation === "timestamp") return actual.Timestamp.now();
      if (object.operation === "increment") return 1;
      if (object.operation === "delete") return undefined;
      return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, apply(item)]));
    }
    return value;
  }
  function snapshot(path: string) {
    const data = fake.documents.get(path);
    return { id: path.split("/").at(-1), exists: !!data, data: () => data,
      get: (key: string) => key.split(".").reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part], data) };
  }
  function reference(path: string) {
    return { path, get: async () => snapshot(path),
      set: async (data: Record<string, unknown>, options?: { merge: boolean }) => {
        fake.documents.set(path, { ...(options?.merge ? fake.documents.get(path) : {}), ...(apply(data) as Record<string, unknown>) });
      },
      update: async (data: Record<string, unknown>) => { fake.documents.set(path, { ...fake.documents.get(path), ...(apply(data) as Record<string, unknown>) }); },
      delete: async () => { fake.documents.delete(path); },
      collection: (name: string) => collection(`${path}/${name}`),
    };
  }
  function collection(path: string) {
    return { doc: (id: string) => reference(`${path}/${id}`), get: async () => ({ docs: [...fake.documents.keys()].filter((key) => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1).map(snapshot) }) };
  }
  return { ...actual, FieldValue: { serverTimestamp: () => ({ operation: "timestamp" }), delete: () => ({ operation: "delete" }), increment: () => ({ operation: "increment" }) },
    getFirestore: () => ({ collection, runTransaction: async (callback: (transaction: unknown) => unknown) => callback({ get: (ref: ReturnType<typeof reference>) => ref.get(), set: (ref: ReturnType<typeof reference>, data: Record<string, unknown>, options: { merge: boolean }) => ref.set(data, options), update: (ref: ReturnType<typeof reference>, data: Record<string, unknown>) => ref.update(data) }) }) };
});
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => [Buffer.from("test-asset")] }) }) }) }));
vi.mock("./freeagent.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./freeagent.js")>(), decryptSecret: () => "test-access-token",
  fetchFreeAgentBankTransaction: (...args: unknown[]) => fake.fetchTransaction(...args),
  fetchFreeAgentBankTransactionExplanation: (...args: unknown[]) => fake.fetchExplanation(...args),
  updateFreeAgentExplanationAttachment: (...args: unknown[]) => fake.updateAttachment(...args),
}));
const owner = "owner";
const values = { merchantName: "Shop", purchaseDescription: "Coffee", receiptDate: "2026-10-20", currency: "GBP", grossTotal: "12.00", netTotal: "10.00", vatTotal: "2.00", gbpAmountCharged: null };
const syncPath = `freeAgentSync/${owner}`;
const previewPath = `${syncPath}/attachmentPreviews/receipt`;
const receiptPath = "receipts/receipt";
const bankTransaction = { id: "bank", url: "https://api.freeagent.com/v2/bank_transactions/bank", description: "SHOP", amount: "-12.00", unexplainedAmount: "0.00", datedOn: "2026-10-20", updatedAt: "now", explanations: [{ url: "https://api.freeagent.com/v2/bank_transaction_explanations/explanation" }] };
const explanation = { id: "explanation", url: bankTransaction.explanations[0].url, bankTransactionUrl: bankTransaction.url, grossValue: "-12.00", isLocked: false, attachment: null, type: "Payment", categoryUrl: "https://api.freeagent.com/v2/categories/250", datedOn: "2026-10-20", updatedAt: "now" };
const payload = { receiptId: "receipt", values, transactionId: "bank" };
function request(data: unknown) { return { auth: { uid: owner, token: { fidoOwner: true } }, data } as never; }
beforeEach(() => {
  fake.documents.clear();
  vi.clearAllMocks();
  process.env.FIDO_V2_FREEAGENT_TOKEN_ENCRYPTION_KEY = "test-only-key";
  fake.documents.set(receiptPath, { ownerUid: owner, status: "ready_for_extraction", storagePath: `receipts/${owner}/receipt/original.jpg`, processedStoragePath: `receipts/${owner}/receipt/processed-v1.jpg`, processedContentType: "image/jpeg", processedSize: 10, extraction: { state: "ready_for_verification" } });
  fake.documents.set(`freeAgentConnections/${owner}`, { status: "connected", accessToken: { data: "test" }, accessTokenExpiresAt: Timestamp.fromMillis(Date.now() + 3600000) });
  fake.documents.set(`${syncPath}/transactions/bank`, { ...bankTransaction, bankAccountName: "Business", currency: "GBP", fullDescription: "SHOP" });
  fake.fetchTransaction.mockResolvedValue(bankTransaction);
  fake.fetchExplanation.mockResolvedValue(explanation);
  fake.updateAttachment.mockImplementation(async () => {
    const sent = { ...explanation, attachment: { id: "attachment", url: "https://api.freeagent.com/v2/attachments/attachment", fileName: "fido-receipt-receipt.jpg", fileSize: 10, contentType: "image/jpeg" } };
    fake.fetchExplanation.mockResolvedValue(sent);
    return sent;
  });
});
describe("review and send callable flow", () => {
  it("matches and previews draft values without approving or writing to FreeAgent", async () => {
    const options = await getReceiptMatchOptions.run(request({ receiptId: "receipt", values }));
    expect(options.suggestions[0].id).toBe("bank");
    const preview = await getReceiptAttachmentPreview.run(request(payload));
    expect(preview.state).toBe("ready");
    expect(fake.documents.get(receiptPath)?.status).toBe("ready_for_extraction");
    expect(fake.documents.has(`${syncPath}/matchProposals/receipt`)).toBe(false);
    expect(fake.updateAttachment).not.toHaveBeenCalled();
    expect(fake.documents.get(previewPath)?.values).toEqual(values);
  });
  it("confirms once, saves values, attaches, audits and makes retries idempotent", async () => {
    const preview = await getReceiptAttachmentPreview.run(request(payload));
    if (preview.state !== "ready") throw new Error("Expected a ready preview");
    const confirmation = { receiptId: "receipt", confirmationToken: preview.confirmationToken };
    const response = await confirmReceiptAttachment.run(request(confirmation));
    expect(response.delivery.state).toBe("sent");
    expect(fake.documents.get(receiptPath)?.verifiedData).toEqual(values);
    expect(fake.documents.get(receiptPath)?.status).toBe("verified");
    expect(fake.updateAttachment).toHaveBeenCalledOnce();
    await confirmReceiptAttachment.run(request(confirmation));
    expect(fake.updateAttachment).toHaveBeenCalledOnce();
  });
  it("keeps legacy verified receipts and saved proposals usable", async () => {
    fake.documents.set(receiptPath, { ...fake.documents.get(receiptPath), status: "verified", verifiedData: values });
    await saveReceiptMatchProposal.run(request({ receiptId: "receipt", type: "transaction", transactionId: "bank" }));
    const preview = await getReceiptAttachmentPreview.run(request({ receiptId: "receipt" }));
    expect(preview.state).toBe("ready");
    expect(fake.updateAttachment).not.toHaveBeenCalled();
  });
  it("saves approved values for an unmatched receipt without a remote write", async () => {
    await saveReceiptMatchProposal.run(request({ receiptId: "receipt", type: "unmatched", values }));
    expect(fake.documents.get(receiptPath)?.verifiedData).toEqual(values);
    expect(fake.documents.get(`${syncPath}/matchProposals/receipt`)?.type).toBe("unmatched");
    expect(fake.updateAttachment).not.toHaveBeenCalled();
  });
  it("rejects an expired preview and changes to the live explanation", async () => {
    let preview = await getReceiptAttachmentPreview.run(request(payload));
    if (preview.state !== "ready") throw new Error("Expected ready");
    fake.documents.get(previewPath)!.expiresAt = Timestamp.fromMillis(0);
    await expect(confirmReceiptAttachment.run(request({ receiptId: "receipt", confirmationToken: preview.confirmationToken }))).rejects.toThrow(/expired/);
    preview = await getReceiptAttachmentPreview.run(request(payload));
    if (preview.state !== "ready") throw new Error("Expected ready");
    fake.fetchExplanation.mockResolvedValue({ ...explanation, categoryUrl: "https://api.freeagent.com/v2/categories/251" });
    await expect(confirmReceiptAttachment.run(request({ receiptId: "receipt", confirmationToken: preview.confirmationToken }))).rejects.toThrow(/changed after preview/);
    expect(fake.updateAttachment).not.toHaveBeenCalled();
  });
  it("blocks wrong amounts, another receipt's reserved transaction and another owner", async () => {
    await expect(getReceiptAttachmentPreview.run(request({ ...payload, values: { ...values, grossTotal: "13.00", netTotal: null, vatTotal: null } }))).rejects.toThrow(/does not match/);
    fake.documents.set(`${syncPath}/matchProposals/other`, { type: "transaction", transaction: { id: "bank" } });
    await expect(getReceiptAttachmentPreview.run(request(payload))).rejects.toThrow(/already used/);
    fake.documents.get(receiptPath)!.ownerUid = "someone-else";
    await expect(getReceiptAttachmentPreview.run(request(payload))).rejects.toThrow(/not found/);
    expect(fake.updateAttachment).not.toHaveBeenCalled();
  });
  it("detects an image change between preview and confirmation", async () => {
    const preview = await getReceiptAttachmentPreview.run(request(payload));
    if (preview.state !== "ready") throw new Error("Expected ready");
    fake.documents.get(receiptPath)!.processedStoragePath = `receipts/${owner}/receipt/processed-v1-12345678-1234-1234-1234-123456789abc.jpg`;
    await expect(confirmReceiptAttachment.run(request({ receiptId: "receipt", confirmationToken: preview.confirmationToken }))).rejects.toThrow(/changed after preview/);
    expect(fake.updateAttachment).not.toHaveBeenCalled();
  });
});
