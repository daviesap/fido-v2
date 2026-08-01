import { describe, expect, it } from "vitest";

import {
  displayStoragePath,
  formatBytes,
  ReceiptSchema,
  receiptContentType,
  safeFileName,
  validateReceiptFile,
} from "@/lib/receipt";

describe("receipt file validation", () => {
  it("accepts supported receipt images", () => {
    const file = new File([new Uint8Array(1024)], "receipt.JPG", {
      type: "image/jpeg",
    });

    expect(validateReceiptFile(file)).toBeNull();
    expect(receiptContentType(file)).toBe("image/jpeg");
  });

  it("recognizes HEIC by extension when the browser omits a MIME type", () => {
    const file = new File(["image"], "phone-capture.heic");

    expect(validateReceiptFile(file)).toBeNull();
    expect(receiptContentType(file)).toBe("image/heic");
  });

  it("rejects unsupported and oversized files", () => {
    const text = new File(["not a receipt"], "notes.txt", {
      type: "text/plain",
    });
    const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.jpg", {
      type: "image/jpeg",
    });

    expect(validateReceiptFile(text)).toMatch(/PDF, JPEG/);
    expect(validateReceiptFile(oversized)).toMatch(/20 MB/);
  });

  it("accepts PDFs and preserves their extension", () => {
    const pdf = new File(["%PDF-1.7"], "Train Ticket.PDF", { type: "application/pdf" });

    expect(validateReceiptFile(pdf)).toBeNull();
    expect(receiptContentType(pdf)).toBe("application/pdf");
    expect(safeFileName(pdf.name)).toBe("train-ticket.pdf");
  });
});

describe("receipt display helpers", () => {
  it("sanitizes file names without losing the extension", () => {
    expect(safeFileName("My Tesco #1.JPG")).toBe("my-tesco-1.jpg");
    expect(safeFileName("...JPG")).toBe("receipt.jpg");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("uses a reviewed receipt's processed image for display", () => {
    const parsed = ReceiptSchema.parse({
      ownerUid: "owner",
      status: "ready_for_extraction",
      storagePath: "receipts/owner/id/original.jpg",
      originalFileName: "receipt.jpg",
      contentType: "image/jpeg",
      size: 2000,
      createdAt: null,
      processedStoragePath: "receipts/owner/id/processed-v1.jpg",
      processedContentType: "image/jpeg",
      processedSize: 1500,
      processing: {
        version: 1,
        rotation: 90,
        crop: { x: 2, y: 2, width: 96, height: 96 },
        sourceWidth: 3024,
        sourceHeight: 4032,
        outputWidth: 1800,
        outputHeight: 2400,
        qualityWarnings: [],
        processedAt: null,
      },
    });

    expect(displayStoragePath({ id: "id", ...parsed })).toBe("receipts/owner/id/processed-v1.jpg");
  });

  it("keeps an emailed receipt on its immutable original until review", () => {
    const parsed = ReceiptSchema.parse({
      ownerUid: "owner",
      status: "needs_review",
      source: "email",
      storagePath: "receipts/owner/id/original-receipt.pdf",
      originalFileName: "receipt.pdf",
      contentType: "application/pdf",
      size: 2000,
      contentHash: "a".repeat(64),
      email: {
        sender: "sender@example.com",
        subject: "Receipt",
        messageId: "<message@example.com>",
        receivedAt: null,
      },
      createdAt: null,
    });

    expect(displayStoragePath({ id: "id", ...parsed })).toBe("receipts/owner/id/original-receipt.pdf");
  });
});
