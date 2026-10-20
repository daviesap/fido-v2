// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReceiptMatching, type ReviewReceipt } from "@/components/receipt-matching";

const api = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ functions: {}, storage: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: (_: unknown, name: string) => (data: unknown) => api.call(name, data) }));
vi.mock("firebase/storage", () => ({ ref: vi.fn(), getBlob: () => new Promise(() => {}) }));

const values = { merchantName: "Shop", purchaseDescription: "Coffee", receiptDate: "2026-10-20", currency: "GBP", grossTotal: "12.00", netTotal: "10.00", vatTotal: "2.00", gbpAmountCharged: null };
const receipt = {
  id: "receipt", ownerUid: "owner", status: "ready_for_extraction", originalFileName: "receipt.jpg",
  storagePath: "original.jpg", processedStoragePath: "processed.jpg", processedContentType: "image/jpeg",
  processing: { qualityWarnings: [] },
  extraction: { model: "test", state: "ready_for_verification", result: { ...values, confidence: Object.fromEntries(Object.keys(values).map((field) => [field, "high"])), warnings: [] } },
} as unknown as ReviewReceipt;
const transaction = { id: "bank-1", description: "SHOP", bankAccountName: "Business", datedOn: "2026-10-20", amount: "-12.00", reasons: ["Exact amount"], confidence: "high", score: 100 };
const preview = { state: "ready", confirmationToken: "token", transaction, explanation: { type: "Payment", categoryNominalCode: "250" }, attachment: { fileName: "receipt.jpg", fileSize: 1000 }, blockers: [] };
let blocked = false;
let deferPreview = false;
beforeEach(() => {
  blocked = false;
  deferPreview = false;
  api.call.mockReset();
  api.call.mockImplementation(async (name) => {
    if (name === "getReceiptMatchOptions") return { data: { suggestions: [transaction, { ...transaction, id: "bank-2", description: "OTHER" }], otherTransactions: [], existingProposal: null, lastSyncCompletedAt: new Date().toISOString() } };
    if (name === "getReceiptAttachmentPreview") {
      if (deferPreview) return new Promise(() => {});
      return { data: blocked ? { ...preview, state: "blocked", confirmationToken: null, blockers: ["The bank transaction is not fully explained in FreeAgent."] } : preview };
    }
    if (name === "confirmReceiptAttachment") return { data: { delivery: { target: {}, attachment: {} } } };
    return { data: {} };
  });
});
afterEach(cleanup);
function openReview() {
  const onComplete = vi.fn();
  render(createElement(ReceiptMatching, { receipt, onClose: vi.fn(), onSaved: vi.fn(), onComplete, onAdjustImage: vi.fn() }));
  return onComplete;
}
async function readyButton() {
  const button = screen.getByRole("button", { name: "Confirm & send" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false), { timeout: 2500 });
  return button;
}
describe("combined receipt review", () => {
  it("prepares a draft and sends with one confirmation, then advances", async () => {
    const onComplete = openReview();
    fireEvent.click(await readyButton());
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(api.call).toHaveBeenCalledWith("getReceiptMatchOptions", { receiptId: "receipt", values });
    expect(api.call).toHaveBeenCalledWith("getReceiptAttachmentPreview", { receiptId: "receipt", transactionId: "bank-1", values });
    expect(api.call).toHaveBeenCalledWith("confirmReceiptAttachment", { receiptId: "receipt", confirmationToken: "token" });
    expect(api.call.mock.calls.some(([name]) => name === "saveReceiptMatchProposal")).toBe(false);
  });
  it("invalidates a prepared preview when receipt details change", async () => {
    openReview();
    const button = await readyButton();
    deferPreview = true;
    fireEvent.change(screen.getByLabelText("Merchant"), { target: { value: "Different shop" } });
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(api.call.mock.calls.some(([name]) => name === "confirmReceiptAttachment")).toBe(false);
    await waitFor(() => expect(api.call).toHaveBeenCalledWith("getReceiptAttachmentPreview", expect.objectContaining({ values: expect.objectContaining({ merchantName: "Different shop" }) })), { timeout: 2500 });
  });
  it("keeps invalid amount edits disabled without interrupting review", async () => {
    openReview();
    const button = await readyButton();
    fireEvent.change(screen.getByLabelText("Gross total"), { target: { value: "£12.00" } });
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.getByLabelText("Gross total")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Gross total"), { target: { value: "12.00" } });
    await readyButton();
  });
  it("invalidates the preview when a different transaction is selected", async () => {
    openReview();
    const button = await readyButton();
    deferPreview = true;
    fireEvent.click(screen.getByRole("radio", { name: /OTHER/ }));
    await waitFor(() => expect(button.disabled).toBe(true));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith("getReceiptAttachmentPreview", expect.objectContaining({ transactionId: "bank-2" })), { timeout: 2500 });
  });
  it("keeps a blocked transaction unsent and shows the reason", async () => {
    blocked = true;
    openReview();
    await screen.findByText("The bank transaction is not fully explained in FreeAgent.", {}, { timeout: 2500 });
    expect((screen.getByRole("button", { name: "Confirm & send" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("requires the real GBP charge for a foreign receipt", async () => {
    render(createElement(ReceiptMatching, { receipt: { ...receipt, extraction: { ...receipt.extraction, result: { ...receipt.extraction.result, currency: "EUR", netTotal: null, vatTotal: null } } } as ReviewReceipt, onClose: vi.fn(), onSaved: vi.fn(), onComplete: vi.fn(), onAdjustImage: vi.fn() }));
    expect((screen.getByRole("button", { name: "Confirm & send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("GBP amount charged"), { target: { value: "10.32" } });
    await readyButton();
    expect(api.call).toHaveBeenCalledWith("getReceiptMatchOptions", expect.objectContaining({ values: expect.objectContaining({ currency: "EUR", gbpAmountCharged: "10.32" }) }));
  });
});
