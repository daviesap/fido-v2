import { describe, expect, it } from "vitest";
import { FREEAGENT_ATTACHMENT_MAX_BYTES, attachmentFileName, evaluateAttachmentEligibility } from "./delivery.js";

const transaction = {
  url: "https://api.freeagent.com/v2/bank_transactions/8",
  amount: "-3.58",
  unexplainedAmount: "0.00",
  explanations: [{ url: "https://api.freeagent.com/v2/bank_transaction_explanations/20" }],
};

const explanation = {
  url: "https://api.freeagent.com/v2/bank_transaction_explanations/20",
  bankTransactionUrl: transaction.url,
  grossValue: "-3.580",
  isLocked: false,
  lockedReason: null,
  attachment: null,
};

describe("FreeAgent attachment eligibility", () => {
  it("uses a PDF filename for complete document receipts", () => {
    expect(attachmentFileName("receipt-1", "application/x-pdf")).toBe("fido-receipt-receipt-1.pdf");
  });

  it("allows only a complete single existing explanation", () => {
    expect(evaluateAttachmentEligibility({
      transaction,
      explanation,
      assetSize: 1200,
      expectedFileName: attachmentFileName("receipt-1"),
    })).toEqual({ eligible: true, reconcileExisting: false, blockers: [] });
  });

  it("blocks unexplained, split, locked, oversized and already-attached targets", () => {
    const result = evaluateAttachmentEligibility({
      transaction: {
        ...transaction,
        unexplainedAmount: "-1.00",
        explanations: [...transaction.explanations, { url: "https://api.freeagent.com/v2/bank_transaction_explanations/21" }],
      },
      explanation: {
        ...explanation,
        grossValue: "-2.58",
        isLocked: true,
        lockedReason: "Filed VAT return",
        attachment: { fileName: "another-receipt.jpg" },
      },
      assetSize: FREEAGENT_ATTACHMENT_MAX_BYTES + 1,
      expectedFileName: attachmentFileName("receipt-1"),
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("5 MB"),
      expect.stringContaining("not fully explained"),
      expect.stringContaining("multiple explanations"),
      expect.stringContaining("full amount"),
      expect.stringContaining("Filed VAT return"),
      expect.stringContaining("will not replace"),
    ]));
  });

  it("recognises an earlier successful upload for idempotent reconciliation", () => {
    const fileName = attachmentFileName("receipt-1");
    expect(evaluateAttachmentEligibility({
      transaction,
      explanation: { ...explanation, attachment: { fileName } },
      assetSize: 1200,
      expectedFileName: fileName,
    })).toEqual({ eligible: true, reconcileExisting: true, blockers: [] });
  });
});
