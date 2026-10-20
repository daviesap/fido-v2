// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ReceiptReview } from "@/components/receipt-review";
import { DocumentReview } from "@/components/document-review";

const prepare = vi.hoisted(() => ({ image: vi.fn(), destroy: vi.fn() }));
vi.mock("@/lib/image-processing", () => ({
  normaliseReceiptForEditing: async () => new Blob(),
  suggestReceiptCrop: async () => ({ unit: "%", x: 2, y: 2, width: 96, height: 96 }),
  processReceiptImage: (...args: unknown[]) => prepare.image(...args),
  QUALITY_WARNING_MESSAGES: { blurry: "The image looks blurry." },
}));
vi.mock("@/lib/pdf-processing", () => ({
  loadPdfReceipt: async () => ({ document: { destroy: prepare.destroy }, pageCount: 3 }),
  renderPdfReceiptPage: async () => new Blob(),
}));
beforeEach(() => {
  prepare.image.mockReset().mockResolvedValue({ blob: new Blob(), qualityWarnings: [] });
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
const file = new File(["receipt"], "receipt.jpg", { type: "image/jpeg" });
describe("receipt intake", () => {
  it("prepares a clear image without crop or save confirmations and retains all edges", async () => {
    const onApprove = vi.fn();
    render(createElement(ReceiptReview, { file, onApprove, onCancel: vi.fn() }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledOnce());
    expect(prepare.image).toHaveBeenCalledWith(expect.any(Blob), { unit: "%", x: 0, y: 0, width: 100, height: 100 }, 0, null);
  });
  it("shows a quality warning for review instead of silently accepting a poor image", async () => {
    prepare.image.mockResolvedValue({ blob: new Blob(), qualityWarnings: ["blurry"] });
    const onApprove = vi.fn();
    render(createElement(ReceiptReview, { file, onApprove, onCancel: vi.fn() }));
    await screen.findByRole("button", { name: "Use this image" });
    expect(onApprove).not.toHaveBeenCalled();
  });
  it("leaves crop and rotation available when image adjustment is requested", async () => {
    const onApprove = vi.fn();
    render(createElement(ReceiptReview, { file, autoProcess: false, onApprove, onCancel: vi.fn() }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Review crop" }) as HTMLButtonElement).disabled).toBe(false));
    expect(onApprove).not.toHaveBeenCalled();
    expect(prepare.image).not.toHaveBeenCalled();
  });
  it("queues every PDF page without a separate approval", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(createElement(DocumentReview, { file: new File(["pdf"], "receipt.pdf", { type: "application/pdf" }), onApprove, onCancel: vi.fn() }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledExactlyOnceWith(3));
  });
});
