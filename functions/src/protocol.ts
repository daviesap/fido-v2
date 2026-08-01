import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

const AttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  declaredContentType: z.string().min(1).max(150),
  contentBase64: z.string().min(4).max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4),
});

export const IngestPayloadSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  envelopeFrom: z.string().min(1).max(320),
  envelopeTo: z.string().email().max(320),
  sender: z.string().email().max(320),
  originalRecipients: z.array(z.string().email().max(320)).min(1).max(20),
  subject: z.string().min(1).max(200),
  messageId: z.string().max(500),
  receivedAt: z.iso.datetime(),
  attachments: z.array(AttachmentSchema).min(1).max(MAX_ATTACHMENTS),
});

export const EmailConfigSchema = z.object({
  ownerUid: z.string().min(1).max(128),
  publicAddress: z.string().email().transform((value) => value.toLowerCase()),
  allowedSenders: z.array(z.string().email().transform((value) => value.toLowerCase())).max(50).default([]),
  dailyMessageLimit: z.number().int().min(1).max(500).default(30),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;

export type DetectedReceiptType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";

export function verifyIngestSignature(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  body: Buffer;
  signature: string;
  nowSeconds?: number;
}): boolean {
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_MAX_AGE_SECONDS) return false;
  if (!/^[0-9a-f]{64}$/i.test(input.signature) || input.nonce.length < 16 || input.nonce.length > 100) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.nonce}.`)
    .update(input.body)
    .digest();
  const supplied = Buffer.from(input.signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("invalid_base64");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("invalid_attachment_size");
  return buffer;
}

export function detectReceiptType(bytes: Uint8Array): DetectedReceiptType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  return null;
}

export function safeReceiptFileName(filename: string, contentType: DetectedReceiptType): string {
  const extension = ({
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  } as const)[contentType];
  const withoutExtension = filename.replace(/\.[a-z0-9]{1,8}$/i, "");
  const base = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${base || "emailed-receipt"}${extension}`;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
