import PostalMime, { type Address, type Attachment } from "postal-mime";
import {
  MAX_INLINE_IMAGE_BYTES,
  MAX_TOTAL_INLINE_IMAGE_BYTES,
  createEmailBodyAttachment,
  type EmailInlineImage,
} from "./email-body";
import {
  INGEST_PROTOCOL_VERSION,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_EMAIL_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  bytesToBase64,
  isSupportedAttachment,
  normaliseAddress,
  signPayload,
  type IngestAttachment,
  type IngestPayload,
} from "./protocol";

type Env = {
  FIDO_INGEST_ENDPOINT: string;
  FIDO_PUBLIC_RECEIPT_ADDRESS: string;
  FIDO_PRIVATE_INGEST_ADDRESS: string;
  FIDO_INGEST_SHARED_SECRET: string;
  BROWSER?: BrowserRun;
};

export default {
  async email(message, env): Promise<void> {
    if (normaliseAddress(message.to) !== normaliseAddress(env.FIDO_PRIVATE_INGEST_ADDRESS)) {
      message.setReject("Unknown receipt ingestion address");
      return;
    }
    if (message.rawSize > MAX_EMAIL_BYTES) {
      message.setReject("Receipt email is too large");
      return;
    }

    const parsed = await PostalMime.parse(message.raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 20,
      maxHeadersSize: 256 * 1024,
    });
    const originalRecipients = addresses(parsed.to);
    if (!originalRecipients.includes(normaliseAddress(env.FIDO_PUBLIC_RECEIPT_ADDRESS))) {
      message.setReject("Email was not addressed to the public receipt mailbox");
      return;
    }

    const attachments: IngestAttachment[] = [];
    const inlineImages: EmailInlineImage[] = [];
    let totalBytes = 0;
    let totalInlineImageBytes = 0;
    for (const attachment of parsed.attachments) {
      const filename = safeAttachmentName(attachment);
      const isPdf = attachment.mimeType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(filename);
      if (!isPdf && (attachment.related || attachment.disposition === "inline")) {
        const inlineImage = emailInlineImage(attachment);
        if (inlineImage && inlineImage.size <= MAX_INLINE_IMAGE_BYTES
          && totalInlineImageBytes + inlineImage.size <= MAX_TOTAL_INLINE_IMAGE_BYTES) {
          inlineImages.push(inlineImage);
          totalInlineImageBytes += inlineImage.size;
        }
        continue;
      }
      if (!isSupportedAttachment(filename, attachment.mimeType)) continue;
      const bytes = attachmentBytes(attachment);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES || attachments.length >= MAX_ATTACHMENTS) {
        message.setReject("Receipt attachments exceed the ingestion limits");
        return;
      }
      attachments.push({
        filename,
        declaredContentType: attachment.mimeType || "application/octet-stream",
        contentBase64: bytesToBase64(bytes),
      });
    }
    const sender = firstAddress(parsed.from) || normaliseAddress(message.from);
    const subject = (parsed.subject || "Receipt by email").trim().slice(0, 200);
    const receivedAt = normaliseDate(parsed.date);
    const bodyAttachment = await createEmailBodyAttachment({
      existingAttachmentCount: attachments.length,
      sender,
      subject,
      receivedAt,
      text: parsed.text,
      html: parsed.html,
      inlineImages,
      renderHtmlPdf: env.BROWSER ? (html) => renderHtmlPdf(env.BROWSER!, html) : undefined,
    });
    if (bodyAttachment) attachments.push(bodyAttachment);

    if (attachments.length === 0) {
      message.setReject("No supported PDF, image, or readable email receipt body was found");
      return;
    }

    const payload: IngestPayload = {
      version: INGEST_PROTOCOL_VERSION,
      eventId: crypto.randomUUID(),
      envelopeFrom: normaliseAddress(message.from),
      envelopeTo: normaliseAddress(message.to),
      sender,
      originalRecipients,
      subject,
      messageId: (parsed.messageId || message.headers.get("message-id") || "").trim().slice(0, 500),
      receivedAt,
      attachments,
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const signature = await signPayload(env.FIDO_INGEST_SHARED_SECRET, timestamp, nonce, body);
    const response = await fetch(env.FIDO_INGEST_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fido-timestamp": timestamp,
        "x-fido-nonce": nonce,
        "x-fido-signature": signature,
      },
      body,
      // Cloudflare Workers supports manual redirect handling, but not
      // `redirect: "error"`. Keeping redirects manual also prevents the
      // signed payload and shared authentication headers being forwarded.
      redirect: "manual",
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      if (response.status >= 400 && response.status < 500) {
        message.setReject(detail || "Receipt ingestion rejected the email");
        return;
      }
      throw new Error(`Receipt ingestion failed (${response.status}): ${detail}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function renderHtmlPdf(browser: BrowserRun, html: string): Promise<Uint8Array> {
  const response = await browser.quickAction("pdf", {
    html,
    setJavaScriptEnabled: false,
    allowRequestPattern: ["/^(?:data|about):/i"],
    rejectResourceTypes: ["script", "xhr", "fetch", "websocket", "eventsource", "media", "font"],
    cacheTTL: 0,
    actionTimeout: 30_000,
    pdfOptions: {
      format: "a4",
      printBackground: true,
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
    },
  });
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
    throw new Error(`HTML receipt rendering failed (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (attachment.content instanceof ArrayBuffer) return new Uint8Array(attachment.content);
  if (attachment.content instanceof Uint8Array) return attachment.content;
  if (attachment.encoding === "base64") {
    const binary = atob(attachment.content);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(attachment.content);
}

function emailInlineImage(attachment: Attachment): EmailInlineImage | null {
  const contentId = attachment.contentId?.trim();
  const mimeType = normaliseInlineImageType(attachment.mimeType);
  if (!contentId || !mimeType) return null;
  const bytes = attachmentBytes(attachment);
  if (!bytes.byteLength) return null;
  return {
    contentId,
    mimeType,
    contentBase64: bytesToBase64(bytes),
    size: bytes.byteLength,
  };
}

function normaliseInlineImageType(value: string): EmailInlineImage["mimeType"] | null {
  const type = value.toLowerCase().split(";", 1)[0].trim();
  if (type === "image/jpg") return "image/jpeg";
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)
    ? type as EmailInlineImage["mimeType"]
    : null;
}

function safeAttachmentName(attachment: Attachment): string {
  const fallbackExtension = extensionForMime(attachment.mimeType);
  return (attachment.filename || `receipt${fallbackExtension}`).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
}

function extensionForMime(mimeType: string): string {
  return ({
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  } as Record<string, string>)[mimeType.toLowerCase()] || "";
}

function firstAddress(address?: Address): string {
  if (!address) return "";
  if ("address" in address && address.address) return normaliseAddress(address.address);
  return address.group?.[0]?.address ? normaliseAddress(address.group[0].address) : "";
}

function addresses(values?: Address[]): string[] {
  return (values || []).flatMap((value) => {
    if ("address" in value && value.address) return [normaliseAddress(value.address)];
    return (value.group ?? []).map((member) => normaliseAddress(member.address));
  });
}

function normaliseDate(value?: string): string {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
