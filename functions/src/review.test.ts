import { describe, it, expect } from "vitest";
import { ReviewValuesSchema, validProcessedImagePath } from "./review.js";

const values = { merchantName: "Shop", purchaseDescription: "Coffee", receiptDate: "2026-10-20", currency: "GBP", grossTotal: "12.00", netTotal: "10.00", vatTotal: "2.00", gbpAmountCharged: null };
describe("receipt review boundary", () => {
  it("accepts complete GBP details and actual foreign charges", () => {
    expect(ReviewValuesSchema.safeParse(values).success).toBe(true);
    expect(ReviewValuesSchema.safeParse({ ...values, currency: "EUR", netTotal: null, vatTotal: null, gbpAmountCharged: "10.32" }).success).toBe(true);
  });
  it.each([
    { grossTotal: "0" }, { purchaseDescription: "" }, { receiptDate: "2026-02-30" },
    { netTotal: "9.50" }, { gbpAmountCharged: "12.00" },
    { currency: "EUR", netTotal: null, vatTotal: null },
    { currency: "EUR", gbpAmountCharged: "10.32" },
  ])("rejects incomplete or conflicting review values: %s", (changes) => {
    expect(ReviewValuesSchema.safeParse({ ...values, ...changes }).success).toBe(false);
  });
  it("accepts legacy and revised images only within the owner's receipt directory", () => {
    const path = "receipts/owner/receipt/processed-v1-12345678-1234-1234-1234-123456789abc.jpg";
    expect(validProcessedImagePath(path, "owner", "receipt")).toBe(true);
    expect(validProcessedImagePath("receipts/owner/receipt/processed-v1.jpg", "owner", "receipt")).toBe(true);
    expect(validProcessedImagePath(path, "other", "receipt")).toBe(false);
    expect(validProcessedImagePath(path, "owner", "other")).toBe(false);
    expect(validProcessedImagePath("receipts/owner/receipt/sub/processed-v1.jpg", "owner", "receipt")).toBe(false);
    expect(validProcessedImagePath("receipts/owner/receipt/original.jpg", "owner", "receipt")).toBe(false);
  });
});
