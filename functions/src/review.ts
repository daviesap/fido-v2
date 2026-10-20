import { z } from "zod";

const money = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/);
const positiveMoney = money.pipe(z.string().refine((value) => minor(value) > 0n, "Enter an amount greater than zero."));
export const ReviewValuesSchema = z.object({
  merchantName: z.string().trim().min(1).max(160),
  purchaseDescription: z.string().trim().min(1).max(80),
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  currency: z.string().regex(/^[A-Z]{3}$/),
  grossTotal: positiveMoney,
  netTotal: money.nullable(),
  vatTotal: money.nullable(),
  gbpAmountCharged: positiveMoney.nullable(),
}).strict().superRefine((value, context) => {
  if (![value.grossTotal, value.netTotal, value.vatTotal, value.gbpAmountCharged].every((amount) => amount === null || money.safeParse(amount).success)) return;
  if (value.currency === "GBP" ? value.gbpAmountCharged !== null
    : value.gbpAmountCharged === null || value.netTotal !== null || value.vatTotal !== null) {
    context.addIssue({ code: "custom", message: "Foreign receipts need the actual GBP charge and cannot include UK VAT totals." });
  }
  if (value.netTotal !== null && value.vatTotal !== null
    && abs(minor(value.netTotal) + minor(value.vatTotal) - minor(value.grossTotal)) > 1n) {
    context.addIssue({ code: "custom", message: "Net plus VAT must match the gross total to within one penny." });
  }
});
export type ReviewValues = z.infer<typeof ReviewValuesSchema>;
function minor(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function abs(value: bigint) { return value < 0n ? -value : value; }

export function validProcessedImagePath(path: unknown, ownerUid: unknown, receiptId: string): boolean {
  return typeof path === "string" && typeof ownerUid === "string"
    && path.startsWith(`receipts/${ownerUid}/${receiptId}/`)
    && path.split("/").length === 4
    && /^processed-v1(?:-[a-f0-9-]{36})?\.jpg$/.test(path.split("/").at(-1) ?? "");
}
