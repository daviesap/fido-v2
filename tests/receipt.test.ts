import { describe, expect, it } from "vitest";

import {
  displayStoragePath,
  formatBytes,
  ReceiptSchema,
  ReadyForVerificationExtractionSchema,
  receiptQueue,
  receiptStatusLabel,
  receiptContentType,
  safeFileName,
  validateReceiptFile,
  VerifiedReceiptValuesSchema,
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

  it("uses the complete emailed PDF after document review", () => {
    const parsed = ReceiptSchema.parse({
      ownerUid: "owner",
      status: "ready_for_extraction",
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
      processedStoragePath: "receipts/owner/id/original-receipt.pdf",
      processedContentType: "application/pdf",
      processedSize: 2000,
      processing: { version: 1, mode: "document", pageCount: 2, processedAt: null },
      reviewedAt: null,
    });

    expect(displayStoragePath({ id: "id", ...parsed })).toBe("receipts/owner/id/original-receipt.pdf");
  });

  it("shows newly reviewed receipts as extracting", () => {
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
        rotation: 0,
        crop: { x: 0, y: 0, width: 100, height: 100 },
        sourceWidth: 1800,
        sourceHeight: 2400,
        outputWidth: 1800,
        outputHeight: 2400,
        qualityWarnings: [],
        processedAt: null,
      },
      extraction: { state: "queued", generation: 1, attemptCount: 0, queuedAt: null },
    });

    expect(receiptQueue({ id: "id", ...parsed })).toBe("extracting");
    expect(receiptStatusLabel({ id: "id", ...parsed })).toBe("Extracting");
  });

  it("accepts verified foreign totals without VAT", () => {
    expect(VerifiedReceiptValuesSchema.parse({
      merchantName: "Café de la Gare",
      purchaseDescription: "Dinner",
      receiptDate: "2026-07-30",
      currency: "EUR",
      grossTotal: "18.40",
      netTotal: null,
      vatTotal: null,
      gbpAmountCharged: "16.12",
    })).toBeTruthy();
  });

  it("moves verified receipts from ready to match into proposed", () => {
    const base = ReceiptSchema.parse({
      ownerUid: "owner",
      status: "verified",
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
        rotation: 0,
        crop: { x: 0, y: 0, width: 100, height: 100 },
        sourceWidth: 1800,
        sourceHeight: 2400,
        outputWidth: 1800,
        outputHeight: 2400,
        qualityWarnings: [],
        processedAt: null,
      },
      extraction: {
        state: "ready_for_verification",
        generation: 1,
        attemptCount: 1,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        durationMs: 100,
        schemaVersion: 2,
        promptVersion: 2,
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        result: {
          merchantName: "Shop",
          purchaseDescription: "Coffee",
          receiptDate: "2026-07-30",
          currency: "GBP",
          grossTotal: "4.20",
          netTotal: null,
          vatTotal: null,
          confidence: {
            merchantName: "high",
            purchaseDescription: "high",
            receiptDate: "high",
            currency: "high",
            grossTotal: "high",
            netTotal: "not_present",
            vatTotal: "not_present",
          },
          warnings: [],
        },
      },
      verifiedData: {
        merchantName: "Shop",
        purchaseDescription: "Coffee",
        receiptDate: "2026-07-30",
        currency: "GBP",
        grossTotal: "4.20",
        netTotal: null,
        vatTotal: null,
        gbpAmountCharged: null,
      },
      verifiedAt: null,
    });
    expect(receiptQueue({ id: "id", ...base })).toBe("ready_to_match");
    expect(receiptStatusLabel({ id: "id", ...base })).toBe("Ready to match");
    const proposed = ReceiptSchema.parse({
      ...base,
      matching: { state: "proposed", type: "transaction", label: "Coffee card payment", updatedAt: null },
    });
    expect(receiptQueue({ id: "id", ...proposed })).toBe("proposed");
    expect(receiptStatusLabel({ id: "id", ...proposed })).toBe("Proposal ready");
    const sent = ReceiptSchema.parse({
      ...base,
      matching: { state: "proposed", type: "transaction", label: "Coffee card payment", updatedAt: null },
      delivery: {
        state: "sent",
        resourceType: "bank_transaction_explanation",
        label: "Attached to Coffee card payment",
        sentAt: null,
      },
    });
    expect(receiptQueue({ id: "id", ...sent })).toBe("sent");
    expect(receiptStatusLabel({ id: "id", ...sent })).toBe("Sent to FreeAgent");
  });

  it("requires the real GBP charge only for foreign receipts", () => {
    const foreign = {
      merchantName: "Café de la Gare",
      purchaseDescription: "Dinner",
      receiptDate: "2026-07-30",
      currency: "EUR",
      grossTotal: "18.40",
      netTotal: null,
      vatTotal: null,
      gbpAmountCharged: null,
    };
    expect(() => VerifiedReceiptValuesSchema.parse(foreign)).toThrow(/final GBP amount/);
    expect(() => VerifiedReceiptValuesSchema.parse({ ...foreign, gbpAmountCharged: "16.12", netTotal: "15.00" })).toThrow(/VAT totals/);
    expect(() => VerifiedReceiptValuesSchema.parse({ ...foreign, currency: "GBP", gbpAmountCharged: "16.12" })).toThrow(/blank for GBP/);
  });

  it("keeps version-one extraction records readable", () => {
    expect(ReadyForVerificationExtractionSchema.parse({
      state: "ready_for_verification",
      generation: 1,
      attemptCount: 1,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      durationMs: 100,
      schemaVersion: 1,
      promptVersion: 1,
      model: "gpt-5.6-luna",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      result: {
        merchantName: "Legacy Shop",
        receiptDate: "2026-07-30",
        currency: "GBP",
        grossTotal: "10.00",
        netTotal: null,
        vatTotal: null,
        confidence: {
          merchantName: "high",
          receiptDate: "high",
          currency: "high",
          grossTotal: "high",
          netTotal: "not_present",
          vatTotal: "not_present",
        },
        warnings: [],
      },
    })).toBeTruthy();
  });

  it("rejects invalid dates, currencies, and numeric money values", () => {
    const values = {
      merchantName: "Shop",
      purchaseDescription: "Coffee",
      receiptDate: "2026-02-28",
      currency: "GBP",
      grossTotal: "10.00",
      netTotal: null,
      vatTotal: null,
      gbpAmountCharged: null,
    };
    expect(() => VerifiedReceiptValuesSchema.parse({ ...values, receiptDate: "2026-02-30" })).toThrow();
    expect(() => VerifiedReceiptValuesSchema.parse({ ...values, currency: "GB" })).toThrow();
    expect(() => VerifiedReceiptValuesSchema.parse({ ...values, grossTotal: 10 })).toThrow();
  });
});
