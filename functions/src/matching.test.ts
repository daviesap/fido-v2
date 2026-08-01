import { describe, expect, it } from "vitest";
import { buildOutOfPocketExpenseDraft, rankTransactionMatches, receiptGbpMinorUnits, type MatchingTransaction } from "./matching.js";

const receipt = {
  merchantName: "Mamma Dough",
  receiptDate: "2026-07-29",
  currency: "GBP",
  grossTotal: "179.72",
  gbpAmountCharged: null,
};

function transaction(overrides: Partial<MatchingTransaction> = {}): MatchingTransaction {
  return {
    id: "transaction-1",
    datedOn: "2026-07-30",
    amount: "-179.72",
    description: "MAMMA DOUGH LTD",
    fullDescription: "MAMMA DOUGH/OTHER/GBP 179.72",
    unexplainedAmount: "-179.72",
    bankAccountId: "account-1",
    bankAccountName: "Business card",
    ...overrides,
  };
}

describe("receipt transaction matching", () => {
  it("ranks exact nearby debits with transparent factors", () => {
    const result = rankTransactionMatches(receipt, [
      transaction(),
      transaction({ id: "same-day-other", datedOn: "2026-07-29", description: "OTHER SHOP", fullDescription: "OTHER SHOP" }),
      transaction({ id: "wrong-amount", amount: "-170.00" }),
      transaction({ id: "credit", amount: "179.72" }),
    ]);

    expect(result.suggestions.map((candidate) => candidate.id)).toEqual(["transaction-1", "same-day-other"]);
    expect(result.suggestions[0]).toMatchObject({
      score: 95,
      confidence: "high",
      dayDifference: 1,
      merchantSimilarity: 100,
      factors: { amount: 50, date: 20, merchant: 25 },
    });
    expect(result.suggestions[0]?.reasons).toContain("Transaction is unexplained");
    expect(result.otherTransactions.map((candidate) => candidate.id)).toEqual(["wrong-amount"]);
  });

  it("does not suggest exact amounts outside the three-day window", () => {
    const result = rankTransactionMatches(receipt, [transaction({ datedOn: "2026-08-05" })]);
    expect(result.suggestions).toHaveLength(0);
    expect(result.otherTransactions).toHaveLength(1);
  });

  it("uses the owner-entered GBP charge for foreign receipts", () => {
    expect(receiptGbpMinorUnits({ ...receipt, currency: "USD", grossTotal: "4.80", gbpAmountCharged: "3.72" })).toBe(372n);
    const result = rankTransactionMatches(
      { ...receipt, currency: "USD", grossTotal: "4.80", gbpAmountCharged: "3.72" },
      [transaction({ amount: "-3.72" })],
    );
    expect(result.suggestions).toHaveLength(1);
  });

  it("requires a valid positive GBP settlement amount", () => {
    expect(() => receiptGbpMinorUnits({ ...receipt, currency: "EUR", gbpAmountCharged: null })).toThrow("receipt_missing_gbp_amount");
    expect(() => receiptGbpMinorUnits({ ...receipt, grossTotal: "0.00" })).toThrow("receipt_invalid_gbp_amount");
  });

  it("prepares foreign out-of-pocket values without UK VAT", () => {
    expect(buildOutOfPocketExpenseDraft({
      receipt: {
        ...receipt,
        purchaseDescription: "Cloud hosting",
        currency: "USD",
        grossTotal: "4.80",
        gbpAmountCharged: "3.72",
        vatTotal: null,
      },
      claimantUrl: "https://api.freeagent.com/v2/users/1",
      claimantName: "Andrew Davies",
      category: {
        id: "285",
        url: "https://api.freeagent.com/v2/categories/285",
        description: "Internet and telephone",
        nominalCode: "285",
        group: "Admin expenses",
      },
      attachmentName: "receipt-1.jpg",
    })).toMatchObject({
      currency: "USD",
      grossValue: "-4.80",
      nativeGrossValue: "-3.72",
      vatTreatment: "No UK VAT on this foreign-currency expense",
      description: "Cloud hosting",
    });
  });

  it("flags printed UK VAT for explicit Stage 8 treatment", () => {
    expect(buildOutOfPocketExpenseDraft({
      receipt: { ...receipt, purchaseDescription: "Speaker stands", vatTotal: "54.17" },
      claimantUrl: "https://api.freeagent.com/v2/users/1",
      claimantName: "Andrew Davies",
      category: {
        id: "285",
        url: "https://api.freeagent.com/v2/categories/285",
        description: "Equipment",
        nominalCode: "285",
        group: "Admin expenses",
      },
      attachmentName: "receipt-2.jpg",
    })).toMatchObject({
      currency: "GBP",
      grossValue: "-179.72",
      nativeGrossValue: null,
      vatTreatment: "Receipt VAT present — confirm treatment in Stage 8",
    });
  });
});
