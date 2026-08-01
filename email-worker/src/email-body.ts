import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

import {
  MAX_ATTACHMENT_BYTES,
  bytesToBase64,
  type IngestAttachment,
} from "./protocol";

export const MAX_EMAIL_BODY_CHARACTERS = 100_000;

type EmailBodyInput = {
  existingAttachmentCount: number;
  sender: string;
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
};

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 48;
const BODY_FONT_SIZE = 10;
const BODY_LINE_HEIGHT = 14;

/**
 * Creates a safe attachment fallback without ever rendering untrusted HTML.
 * Existing supported attachments always take precedence over the message body.
 */
export async function createEmailBodyAttachment(input: EmailBodyInput): Promise<IngestAttachment | null> {
  if (input.existingAttachmentCount > 0) return null;

  const body = emailBodyText(input.text, input.html);
  if (!body) return null;

  const bytes = await createEmailBodyPdf({
    sender: input.sender,
    subject: input.subject,
    receivedAt: input.receivedAt,
    body,
  });
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;

  return {
    filename: "email-receipt.pdf",
    declaredContentType: "application/pdf",
    contentBase64: bytesToBase64(bytes),
  };
}

export function emailBodyText(text?: string, html?: string): string {
  const plainText = normaliseText(text ?? "");
  const body = plainText || normaliseText(htmlToPlainText(html ?? ""));
  if (!body) return "";
  if (body.length <= MAX_EMAIL_BODY_CHARACTERS) return body;
  return `${body.slice(0, MAX_EMAIL_BODY_CHARACTERS).trimEnd()}\n\n[Email body shortened by Fido]`;
}

export function htmlToPlainText(html: string): string {
  const text = decodeHtmlEntities(html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|section|article|header|footer|table|tr|ul|ol|li|h[1-6]|blockquote|pre)\s*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, ""));
  // Entity decoding and malformed markup can reintroduce tag openers after
  // stripping. PDF text never needs angle brackets, so remove them at the
  // final trust boundary as defence in depth.
  return text.replace(/[<>]/g, "");
}

async function createEmailBodyPdf(input: {
  sender: string;
  subject: string;
  receivedAt: string;
  body: string;
}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regularFont = await document.embedFont(StandardFonts.Helvetica);
  const boldFont = await document.embedFont(StandardFonts.HelveticaBold);
  const title = pdfSafeText(input.subject || "Receipt email", boldFont);
  const sender = pdfSafeText(input.sender, regularFont);
  const receivedAt = pdfSafeText(input.receivedAt, regularFont);
  const body = pdfSafeText(input.body, regularFont);

  document.setTitle(title);
  document.setAuthor(sender);
  document.setCreator("Fido email receipt ingestion");
  document.setProducer("Fido email receipt ingestion");

  let page = document.addPage([A4_WIDTH, A4_HEIGHT]);
  let y = A4_HEIGHT - PAGE_MARGIN;
  const contentWidth = A4_WIDTH - (PAGE_MARGIN * 2);

  const ensureSpace = (height: number): PDFPage => {
    if (y - height >= PAGE_MARGIN) return page;
    page = document.addPage([A4_WIDTH, A4_HEIGHT]);
    y = A4_HEIGHT - PAGE_MARGIN;
    return page;
  };

  const drawLines = (lines: string[], options: {
    font: PDFFont;
    size: number;
    lineHeight: number;
    colour?: ReturnType<typeof rgb>;
  }) => {
    for (const line of lines) {
      ensureSpace(options.lineHeight);
      if (line) {
        page.drawText(line, {
          x: PAGE_MARGIN,
          y,
          font: options.font,
          size: options.size,
          color: options.colour ?? rgb(0.12, 0.16, 0.14),
        });
      }
      y -= options.lineHeight;
    }
  };

  drawLines(wrapText(title, boldFont, 16, contentWidth), {
    font: boldFont,
    size: 16,
    lineHeight: 21,
  });
  y -= 5;
  drawLines(wrapText(`From: ${sender}`, regularFont, 9, contentWidth), {
    font: regularFont,
    size: 9,
    lineHeight: 12,
    colour: rgb(0.38, 0.42, 0.40),
  });
  drawLines(wrapText(`Received: ${receivedAt}`, regularFont, 9, contentWidth), {
    font: regularFont,
    size: 9,
    lineHeight: 12,
    colour: rgb(0.38, 0.42, 0.40),
  });
  y -= 13;
  drawLines(wrapText(body, regularFont, BODY_FONT_SIZE, contentWidth), {
    font: regularFont,
    size: BODY_FONT_SIZE,
    lineHeight: BODY_LINE_HEIGHT,
  });

  return document.save();
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\t/g, "    ").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      const parts = breakLongWord(word, font, fontSize, maxWidth);
      lines.push(...parts.slice(0, -1));
      line = parts.at(-1) ?? "";
    }
    if (line) lines.push(line);
  }
  return lines;
}

function breakLongWord(word: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const parts: string[] = [];
  let part = "";
  for (const character of word) {
    const candidate = part + character;
    if (part && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      parts.push(part);
      part = character;
    } else {
      part = candidate;
    }
  }
  if (part) parts.push(part);
  return parts.length ? parts : [""];
}

function pdfSafeText(value: string, font: PDFFont): string {
  let result = "";
  for (const character of value.normalize("NFC")) {
    try {
      font.encodeText(character);
      result += character;
    } catch {
      result += "?";
    }
  }
  return result;
}

function normaliseText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    pound: "£",
    quot: "\"",
    raquo: "»",
    rdquo: "”",
    reg: "®",
    rsquo: "’",
    times: "×",
    trade: "™",
    euro: "€",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, token: string) => {
    if (token.startsWith("#")) {
      const hexadecimal = token[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return named[token.toLowerCase()] ?? entity;
  });
}
