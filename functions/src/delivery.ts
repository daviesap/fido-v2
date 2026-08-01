export const FREEAGENT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type AttachmentTargetTransaction = {
  url: string;
  amount: string;
  unexplainedAmount: string;
  explanations: { url: string }[];
};

export type AttachmentTargetExplanation = {
  url: string;
  bankTransactionUrl: string;
  grossValue: string;
  isLocked: boolean;
  lockedReason: string | null;
  attachment: { fileName: string } | null;
};

export function evaluateAttachmentEligibility(input: {
  transaction: AttachmentTargetTransaction;
  explanation: AttachmentTargetExplanation | null;
  assetSize: number;
  expectedFileName: string;
}): { eligible: boolean; reconcileExisting: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (input.assetSize <= 0) blockers.push("The processed receipt image is empty.");
  if (input.assetSize > FREEAGENT_ATTACHMENT_MAX_BYTES) blockers.push("The processed receipt image exceeds FreeAgent's 5 MB attachment limit.");
  const unexplainedAmount = moneyToMinorUnits(input.transaction.unexplainedAmount);
  if (unexplainedAmount === null) {
    blockers.push("FreeAgent returned an invalid unexplained amount.");
  } else if (unexplainedAmount !== 0n) {
    blockers.push("The bank transaction is not fully explained in FreeAgent.");
  }
  if (input.transaction.explanations.length === 0) {
    blockers.push("This transaction does not have an existing FreeAgent explanation.");
  } else if (input.transaction.explanations.length > 1) {
    blockers.push("This transaction has multiple explanations. Split transactions are not supported in Stage 8A.");
  }

  const explanation = input.explanation;
  if (!explanation) return { eligible: false, reconcileExisting: false, blockers };
  if (explanation.bankTransactionUrl !== input.transaction.url) {
    blockers.push("The FreeAgent explanation no longer belongs to the proposed transaction.");
  }
  const explanationAmount = moneyToMinorUnits(explanation.grossValue);
  const transactionAmount = moneyToMinorUnits(input.transaction.amount);
  if (explanationAmount === null || transactionAmount === null) {
    blockers.push("FreeAgent returned an invalid transaction amount.");
  } else if (explanationAmount !== transactionAmount) {
    blockers.push("The explanation does not cover the transaction's full amount.");
  }
  if (explanation.isLocked) {
    blockers.push(explanation.lockedReason
      ? `FreeAgent has locked this explanation: ${explanation.lockedReason}`
      : "FreeAgent has locked this explanation.");
  }
  const reconcileExisting = explanation.attachment?.fileName === input.expectedFileName;
  if (explanation.attachment && !reconcileExisting) {
    blockers.push(`This explanation already has an attachment (${explanation.attachment.fileName}). Fido will not replace it.`);
  }
  return { eligible: blockers.length === 0, reconcileExisting, blockers };
}

export function attachmentFileName(receiptId: string): string {
  return `fido-receipt-${receiptId}.jpg`;
}

function moneyToMinorUnits(value: string): bigint | null {
  const match = value.match(/^(-?)(\d{1,12})(?:\.(\d{1,10}))?$/);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.slice(2).replace(/0/g, "")) return null;
  const minor = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  return sign === "-" ? -minor : minor;
}
