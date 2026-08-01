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

export const QualityWarningSchema = z.enum([
  "low-resolution",
  "blurry",
  "low-contrast",
  "too-dark",
  "overexposed",
  "possible-glare",
]);

export const ReceiptSchema = z.discriminatedUnion("status", [
  ReceiptBaseSchema.extend({
    status: z.literal("stored"),
  }),
  ReceiptBaseSchema.extend({
    status: z.literal("needs_review"),
    source: z.literal("email"),
    contentHash: z.string().length(64),
    email: z.object({
      sender: z.string().email(),
      subject: z.string().min(1).max(200),
      messageId: z.string().max(500),
      receivedAt: z.unknown(),
    }),
  }),
  ReceiptBaseSchema.extend({
    status: z.literal("ready_for_extraction"),
    source: z.literal("email").optional(),
    contentHash: z.string().length(64).optional(),
    email: z.object({
      sender: z.string().email(),
      subject: z.string().min(1).max(200),
      messageId: z.string().max(500),
      receivedAt: z.unknown(),
    }).optional(),
    reviewedAt: z.unknown().optional(),
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
  }),
]);

export type Receipt = z.infer<typeof ReceiptSchema> & { id: string };

export function displayStoragePath(receipt: Receipt): string {
  return receipt.status === "ready_for_extraction" ? receipt.processedStoragePath : receipt.storagePath;
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
