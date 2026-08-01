import { z } from "zod";

export const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

const ReceiptBaseSchema = z.object({
  ownerUid: z.string().min(1),
  storagePath: z.string().min(1),
  originalFileName: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive().max(MAX_RECEIPT_BYTES),
  createdAt: z.unknown(),
});

const EmailFieldsSchema = z.object({
  source: z.literal("email"),
  contentHash: z.string().length(64),
  email: z.object({
    sender: z.string().email(),
    subject: z.string().min(1).max(200),
    messageId: z.string().max(500),
    receivedAt: z.unknown(),
  }),
});

export const QualityWarningSchema = z.enum([
  "low-resolution",
  "blurry",
  "low-contrast",
  "too-dark",
  "overexposed",
  "possible-glare",
]);

const MoneySchema = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate);
const ConfidenceSchema = z.enum(["high", "medium", "low", "not_present"]);
const EXTRACTION_FIELDS = [
  "merchantName",
  "purchaseDescription",
  "receiptDate",
  "currency",
  "grossTotal",
  "netTotal",
  "vatTotal",
] as const;

export const ReceiptExtractionResultSchema = z.object({
  merchantName: z.string().trim().min(1).max(160).nullable(),
  purchaseDescription: z.string().trim().min(1).max(80).nullable().optional(),
  receiptDate: DateSchema.nullable(),
  currency: CurrencySchema.nullable(),
  grossTotal: MoneySchema.nullable(),
  netTotal: MoneySchema.nullable(),
  vatTotal: MoneySchema.nullable(),
  confidence: z.object({
    merchantName: ConfidenceSchema,
    purchaseDescription: ConfidenceSchema.optional(),
    receiptDate: ConfidenceSchema,
    currency: ConfidenceSchema,
    grossTotal: ConfidenceSchema,
    netTotal: ConfidenceSchema,
    vatTotal: ConfidenceSchema,
  }),
  warnings: z.array(z.string().min(1).max(160)).max(8),
}).superRefine((value, context) => {
  for (const field of EXTRACTION_FIELDS) {
    const absent = value[field] === null;
    if (absent !== (value.confidence[field] === "not_present")) {
      context.addIssue({ code: "custom", path: ["confidence", field], message: "Confidence must match field presence." });
    }
  }
});

const VerifiedReceiptValuesShape = {
  merchantName: z.string().trim().min(1, "Enter the merchant name.").max(160),
  purchaseDescription: z.string().trim().min(1, "Enter a short purchase description.").max(80),
  receiptDate: DateSchema,
  currency: CurrencySchema,
  grossTotal: MoneySchema.refine((value) => moneyToMinorUnits(value) > 0n, "Enter a total greater than zero."),
  netTotal: MoneySchema.nullable(),
  vatTotal: MoneySchema.nullable(),
  gbpAmountCharged: MoneySchema.refine((value) => moneyToMinorUnits(value) > 0n, "Enter a GBP amount greater than zero.").nullable(),
};

export const VerifiedReceiptValuesSchema = z.object(VerifiedReceiptValuesShape).superRefine((value, context) => {
  if (value.currency === "GBP" && value.gbpAmountCharged !== null) {
    context.addIssue({ code: "custom", path: ["gbpAmountCharged"], message: "Leave the GBP amount charged blank for GBP receipts." });
  }
  if (value.currency !== "GBP" && value.gbpAmountCharged === null) {
    context.addIssue({ code: "custom", path: ["gbpAmountCharged"], message: "Enter the final GBP amount charged by your card or bank." });
  }
  if (value.currency !== "GBP" && (value.netTotal !== null || value.vatTotal !== null)) {
    context.addIssue({ code: "custom", path: ["currency"], message: "VAT totals are only stored for GBP receipts." });
  }
});

const StoredVerifiedReceiptValuesSchema = z.object({
  merchantName: VerifiedReceiptValuesShape.merchantName,
  purchaseDescription: VerifiedReceiptValuesShape.purchaseDescription.optional(),
  receiptDate: VerifiedReceiptValuesShape.receiptDate,
  currency: VerifiedReceiptValuesShape.currency,
  grossTotal: VerifiedReceiptValuesShape.grossTotal,
  netTotal: VerifiedReceiptValuesShape.netTotal,
  vatTotal: VerifiedReceiptValuesShape.vatTotal,
  gbpAmountCharged: VerifiedReceiptValuesShape.gbpAmountCharged.optional(),
});

const ExtractionBaseSchema = z.object({
  generation: z.number().int().positive(),
  attemptCount: z.number().int().nonnegative(),
  queuedAt: z.unknown(),
});

export const ReadyForVerificationExtractionSchema = ExtractionBaseSchema.extend({
  state: z.literal("ready_for_verification"),
  startedAt: z.unknown(),
  completedAt: z.unknown(),
  durationMs: z.number().int().nonnegative(),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  promptVersion: z.union([z.literal(1), z.literal(2)]),
  model: z.string().min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
  result: ReceiptExtractionResultSchema,
}).superRefine((value, context) => {
  if (value.schemaVersion !== value.promptVersion) {
    context.addIssue({ code: "custom", path: ["promptVersion"], message: "Extraction versions must match." });
  }
  if (value.schemaVersion === 2) {
    if (value.result.purchaseDescription === undefined) {
      context.addIssue({ code: "custom", path: ["result", "purchaseDescription"], message: "Version 2 requires a purchase description field." });
    }
    if (value.result.confidence.purchaseDescription === undefined) {
      context.addIssue({ code: "custom", path: ["result", "confidence", "purchaseDescription"], message: "Version 2 requires purchase description confidence." });
    }
  }
});

export const ReceiptExtractionSchema = z.union([
  ExtractionBaseSchema.extend({
    state: z.literal("queued"),
    lastErrorCode: z.string().max(80).optional(),
  }),
  ExtractionBaseSchema.extend({
    state: z.literal("processing"),
    startedAt: z.unknown(),
  }),
  ReadyForVerificationExtractionSchema,
  z.object({
    state: z.literal("failed"),
    generation: z.number().int().positive(),
    attemptCount: z.number().int().nonnegative(),
    errorCode: z.string().min(1).max(80),
    failedAt: z.unknown(),
    queuedAt: z.unknown().optional(),
  }),
]);

const ProcessingFieldsSchema = z.object({
  processedStoragePath: z.string().min(1),
  processedContentType: z.literal("image/jpeg"),
  processedSize: z.number().int().positive().max(MAX_RECEIPT_BYTES),
  processing: z.object({
    version: z.literal(1),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    crop: z.object({
      x: z.number().min(0).max(100),
      y: z.number().min(0).max(100),
      width: z.number().positive().max(100),
      height: z.number().positive().max(100),
    }),
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    outputWidth: z.number().int().positive(),
    outputHeight: z.number().int().positive(),
    sourcePage: z.number().int().positive().nullable().optional(),
    qualityWarnings: z.array(QualityWarningSchema).max(6),
    processedAt: z.unknown(),
  }),
  source: z.literal("email").optional(),
  contentHash: z.string().length(64).optional(),
  email: EmailFieldsSchema.shape.email.optional(),
  reviewedAt: z.unknown().optional(),
});

const ProcessedReceiptSchema = ReceiptBaseSchema.merge(ProcessingFieldsSchema);

const ReceiptMatchingSummarySchema = z.object({
  state: z.literal("proposed"),
  type: z.enum(["transaction", "out_of_pocket", "unmatched"]),
  label: z.string().min(1).max(160),
  updatedAt: z.unknown(),
});

export const ReceiptSchema = z.discriminatedUnion("status", [
  ReceiptBaseSchema.extend({ status: z.literal("stored") }),
  ReceiptBaseSchema.merge(EmailFieldsSchema).extend({ status: z.literal("needs_review") }),
  ProcessedReceiptSchema.extend({
    status: z.literal("ready_for_extraction"),
    extraction: ReceiptExtractionSchema.optional(),
  }),
  ProcessedReceiptSchema.extend({
    status: z.literal("verified"),
    extraction: ReadyForVerificationExtractionSchema,
    verifiedData: StoredVerifiedReceiptValuesSchema,
    verifiedAt: z.unknown(),
    matching: ReceiptMatchingSummarySchema.optional(),
  }),
]);

export type Receipt = z.infer<typeof ReceiptSchema> & { id: string };
export type VerifiedReceiptValues = z.infer<typeof VerifiedReceiptValuesSchema>;
export type ReadyForVerificationExtraction = z.infer<typeof ReadyForVerificationExtractionSchema>;
export type ReceiptQueue = "needs_review" | "extracting" | "ready_to_verify" | "ready_to_match" | "proposed" | "problems" | "original";

export function displayStoragePath(receipt: Receipt): string {
  return hasProcessedAsset(receipt) ? receipt.processedStoragePath : receipt.storagePath;
}

export function hasProcessedAsset(receipt: Receipt): receipt is Extract<Receipt, { status: "ready_for_extraction" | "verified" }> {
  return receipt.status === "ready_for_extraction" || receipt.status === "verified";
}

export function receiptQueue(receipt: Receipt): ReceiptQueue {
  if (receipt.status === "needs_review") return "needs_review";
  if (receipt.status === "verified") return receipt.matching ? "proposed" : "ready_to_match";
  if (receipt.status === "stored") return "original";
  if (!receipt.extraction || receipt.extraction.state === "queued" || receipt.extraction.state === "processing") return "extracting";
  if (receipt.extraction.state === "ready_for_verification") return "ready_to_verify";
  return "problems";
}

export function receiptStatusLabel(receipt: Receipt): string {
  if (receipt.status === "ready_for_extraction" && !receipt.extraction) return "Ready to extract";
  const queue = receiptQueue(receipt);
  return {
    needs_review: "Needs image review",
    extracting: "Extracting",
    ready_to_verify: "Ready to verify",
    ready_to_match: "Ready to match",
    proposed: "Proposal ready",
    problems: "Problem",
    original: "Original only",
  }[queue];
}

export function receiptContentType(file: Pick<File, "type" | "name">): string | null {
  if (ACCEPTED_CONTENT_TYPES.includes(file.type as (typeof ACCEPTED_CONTENT_TYPES)[number])) return file.type;
  if (/\.hei[cf]$/i.test(file.name)) return "image/heic";
  if (/\.pdf$/i.test(file.name)) return "application/pdf";
  return null;
}

export function validateReceiptFile(file: Pick<File, "type" | "name" | "size">): string | null {
  if (file.size <= 0) return "The selected file is empty.";
  if (file.size >= MAX_RECEIPT_BYTES) return "Choose a receipt file smaller than 20 MB.";
  if (!receiptContentType(file)) return "Choose a PDF, JPEG, PNG, WebP, HEIC or HEIF receipt.";
  return null;
}

export function safeFileName(fileName: string): string {
  const extension = fileName.match(/\.(jpe?g|png|webp|hei[cf]|pdf)$/i)?.[0].toLowerCase() ?? "";
  const base = fileName
    .slice(0, extension ? -extension.length : undefined)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${base || "receipt"}${extension || ".jpg"}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round((size / 1024) * 10) / 10} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function moneyToMinorUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
