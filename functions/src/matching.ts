export type MatchingReceipt = {
  merchantName: string;
  receiptDate: string;
  currency: string;
  grossTotal: string;
  gbpAmountCharged: string | null;
};

export type MatchingTransaction = {
  id: string;
  datedOn: string;
  amount: string;
  description: string;
  fullDescription: string;
  unexplainedAmount: string;
  bankAccountId: string;
  bankAccountName: string;
};

export type MatchConfidence = "high" | "medium" | "low";

export type OutOfPocketReceipt = MatchingReceipt & {
  purchaseDescription: string;
  vatTotal: string | null;
};

export type OutOfPocketCategory = {
  id: string;
  url: string;
  description: string;
  nominalCode: string;
  group: string;
};

export type RankedTransaction = MatchingTransaction & {
  score: number;
  confidence: MatchConfidence;
  dayDifference: number;
  merchantSimilarity: number;
  factors: {
    amount: number;
    date: number;
    merchant: number;
  };
  reasons: string[];
};

const MAX_SUGGESTED_DAY_DIFFERENCE = 3;

export function receiptGbpMinorUnits(receipt: MatchingReceipt): bigint {
  const value = receipt.currency === "GBP" ? receipt.grossTotal : receipt.gbpAmountCharged;
  if (!value) throw new Error("receipt_missing_gbp_amount");
  const amount = moneyToMinorUnits(value);
  if (amount === null || amount <= 0n) throw new Error("receipt_invalid_gbp_amount");
  return amount;
}

export function rankTransactionMatches(
  receipt: MatchingReceipt,
  transactions: MatchingTransaction[],
): { suggestions: RankedTransaction[]; otherTransactions: RankedTransaction[] } {
  const receiptAmount = receiptGbpMinorUnits(receipt);
  const ranked = transactions
    .flatMap((transaction) => {
      const amount = moneyToMinorUnits(transaction.amount);
      if (amount === null || amount >= 0n) return [];
      return [rankTransaction(receipt, receiptAmount, transaction, -amount)];
    });

  const suggestions = ranked
    .filter((transaction) => transaction.factors.amount > 0 && transaction.dayDifference <= MAX_SUGGESTED_DAY_DIFFERENCE)
    .sort(compareRankedTransactions)
    .slice(0, 3);
  const suggestedIds = new Set(suggestions.map((transaction) => transaction.id));
  const otherTransactions = ranked
    .filter((transaction) => !suggestedIds.has(transaction.id))
    .sort((left, right) => {
      const leftAmount = moneyToMinorUnits(left.amount)!;
      const rightAmount = moneyToMinorUnits(right.amount)!;
      const leftDifference = absolute((-leftAmount) - receiptAmount);
      const rightDifference = absolute((-rightAmount) - receiptAmount);
      return compareBigInt(leftDifference, rightDifference)
        || left.dayDifference - right.dayDifference
        || right.datedOn.localeCompare(left.datedOn)
        || left.id.localeCompare(right.id);
    });

  return { suggestions, otherTransactions };
}

export function buildOutOfPocketExpenseDraft(input: {
  receipt: OutOfPocketReceipt;
  claimantUrl: string;
  claimantName: string;
  category: OutOfPocketCategory;
  attachmentName: string;
}) {
  return {
    claimantUrl: input.claimantUrl,
    claimantName: input.claimantName,
    category: input.category,
    datedOn: input.receipt.receiptDate,
    currency: input.receipt.currency,
    grossValue: negativeMoney(input.receipt.grossTotal),
    nativeGrossValue: input.receipt.currency === "GBP" ? null : negativeMoney(input.receipt.gbpAmountCharged!),
    description: input.receipt.purchaseDescription,
    vatTreatment: input.receipt.currency !== "GBP"
      ? "No UK VAT on this foreign-currency expense"
      : input.receipt.vatTotal ? "Receipt VAT present — confirm treatment in Stage 8" : "No VAT total printed on receipt",
    attachmentName: input.attachmentName,
  };
}

function rankTransaction(
  receipt: MatchingReceipt,
  receiptAmount: bigint,
  transaction: MatchingTransaction,
  debitAmount: bigint,
): RankedTransaction {
  const exactAmount = debitAmount === receiptAmount;
  const dayDifference = differenceInDays(receipt.receiptDate, transaction.datedOn);
  const merchantSimilarity = Math.max(
    textSimilarity(receipt.merchantName, transaction.description),
    textSimilarity(receipt.merchantName, transaction.fullDescription),
  );
  const factors = {
    amount: exactAmount ? 50 : 0,
    date: dayScore(dayDifference),
    merchant: Math.round(merchantSimilarity * 25),
  };
  const score = factors.amount + factors.date + factors.merchant;
  const reasons = [
    exactAmount ? "Exact GBP amount" : "Different amount",
    dayDifference === 0 ? "Same date" : `${dayDifference} day${dayDifference === 1 ? "" : "s"} apart`,
    merchantSimilarity >= 0.65
      ? "Merchant closely matches"
      : merchantSimilarity >= 0.3 ? "Merchant partly matches" : "Merchant text differs",
  ];
  if (moneyToMinorUnits(transaction.unexplainedAmount) !== 0n) reasons.push("Transaction is unexplained");

  return {
    ...transaction,
    score,
    confidence: score >= 85 ? "high" : score >= 70 ? "medium" : "low",
    dayDifference,
    merchantSimilarity: Math.round(merchantSimilarity * 100),
    factors,
    reasons,
  };
}

function compareRankedTransactions(left: RankedTransaction, right: RankedTransaction): number {
  return right.score - left.score
    || left.dayDifference - right.dayDifference
    || right.merchantSimilarity - left.merchantSimilarity
    || right.datedOn.localeCompare(left.datedOn)
    || left.id.localeCompare(right.id);
}

function dayScore(dayDifference: number): number {
  if (dayDifference === 0) return 25;
  if (dayDifference === 1) return 20;
  if (dayDifference === 2) return 14;
  if (dayDifference === 3) return 8;
  return 0;
}

function differenceInDays(left: string, right: string): number {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Math.round((leftTime - rightTime) / 86_400_000));
}

function textSimilarity(left: string, right: string): number {
  const leftNormalised = normaliseText(left);
  const rightNormalised = normaliseText(right);
  if (!leftNormalised || !rightNormalised) return 0;
  if (leftNormalised === rightNormalised || rightNormalised.includes(leftNormalised)) return 1;

  const leftTokens = new Set(leftNormalised.split(" "));
  const rightTokens = new Set(rightNormalised.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = union ? intersection / union : 0;
  const compactScore = diceCoefficient(leftNormalised.replaceAll(" ", ""), rightNormalised.replaceAll(" ", ""));
  return Math.max(tokenScore, compactScore);
}

function normaliseText(value: string): string {
  const ignored = new Set(["and", "card", "contactless", "gbp", "limited", "ltd", "online", "payment", "the", "uk", "visa", "www"]);
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 1 && !ignored.has(token) && !/^\d+$/.test(token))
    .join(" ");
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const rightPairs = new Map<string, number>();
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    rightPairs.set(pair, (rightPairs.get(pair) ?? 0) + 1);
  }
  let matches = 0;
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    const count = rightPairs.get(pair) ?? 0;
    if (count) {
      matches += 1;
      rightPairs.set(pair, count - 1);
    }
  }
  return (2 * matches) / ((left.length - 1) + (right.length - 1));
}

function moneyToMinorUnits(value: string): bigint | null {
  const match = value.match(/^(-?)(\d{1,12})(?:\.(\d{1,10}))?$/);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.slice(2).replace(/0/g, "")) return null;
  const minor = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  return sign === "-" ? -minor : minor;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function negativeMoney(value: string): string {
  return value.startsWith("-") ? value : `-${value}`;
}
