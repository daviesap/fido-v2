export const INGEST_PROTOCOL_VERSION = 1;
// Cloudflare rejects inbound messages above 25 MiB before the Worker runs.
// Keeping attachments to 17 MiB leaves room for base64/MIME overhead.
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 17 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 17 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export type IngestAttachment = {
  filename: string;
  declaredContentType: string;
  contentBase64: string;
};

export type IngestPayload = {
  version: 1;
  eventId: string;
  envelopeFrom: string;
  envelopeTo: string;
  sender: string;
  originalRecipients: string[];
  subject: string;
  messageId: string;
  receivedAt: string;
  attachments: IngestAttachment[];
};

export function isSupportedAttachment(filename: string, mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(";", 1)[0].trim();
  if (["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(type)) {
    return true;
  }
  return /\.(pdf|jpe?g|png|webp|hei[cf])$/i.test(filename);
}

export function normaliseAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function signPayload(secret: string, timestamp: string, nonce: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
