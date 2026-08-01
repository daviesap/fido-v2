import { Parser } from "htmlparser2";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

import {
  MAX_ATTACHMENT_BYTES,
  bytesToBase64,
  type IngestAttachment,
} from "./protocol";

export const MAX_EMAIL_BODY_CHARACTERS = 100_000;
export const MAX_RENDERED_HTML_CHARACTERS = 500_000;
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export type EmailInlineImage = {
  contentId: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  contentBase64: string;
  size: number;
};

type HtmlPdfRenderer = (html: string) => Promise<Uint8Array>;

type EmailBodyInput = {
  existingAttachmentCount: number;
  sender: string;
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
  inlineImages?: EmailInlineImage[];
  renderHtmlPdf?: HtmlPdfRenderer;
};

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 48;
const BODY_FONT_SIZE = 10;
const BODY_LINE_HEIGHT = 14;

/**
 * Creates a safe attachment fallback without ever rendering raw untrusted HTML.
 * Existing supported attachments always take precedence over the message body.
 */
export async function createEmailBodyAttachment(input: EmailBodyInput): Promise<IngestAttachment | null> {
  if (input.existingAttachmentCount > 0) return null;

  const body = emailBodyText(input.text, input.html);
  if (!body) return null;

  let bytes: Uint8Array | null = null;
  if (input.html && input.renderHtmlPdf) {
    const safeHtml = sanitiseEmailHtml(input.html, input.inlineImages ?? []);
    if (safeHtml) {
      try {
        const rendered = await input.renderHtmlPdf(safeHtml);
        if (isPdf(rendered) && rendered.byteLength <= MAX_ATTACHMENT_BYTES) bytes = rendered;
      } catch {
        // Browser rendering is optional. The bounded plain-text PDF below is the safe fallback.
      }
    }
  }
  bytes ??= await createEmailBodyPdf({
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

export function sanitiseEmailHtml(html: string, inlineImages: EmailInlineImage[] = []): string {
  if (!html || html.length > MAX_RENDERED_HTML_CHARACTERS) return "";
  const images = new Map<string, EmailInlineImage>();
  let totalImageBytes = 0;
  for (const image of inlineImages) {
    const contentId = normaliseContentId(image.contentId);
    if (!contentId || image.size <= 0 || image.size > MAX_INLINE_IMAGE_BYTES
      || totalImageBytes + image.size > MAX_TOTAL_INLINE_IMAGE_BYTES) continue;
    images.set(contentId, image);
    totalImageBytes += image.size;
  }
  const suppressedTags = new Set(["script", "iframe", "object", "embed", "svg", "math", "canvas", "template", "noscript", "title"]);
  const allowedTags = new Set([
    "style",
    "div", "span", "p", "br", "hr", "pre", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    "ul", "ol", "li", "dl", "dt", "dd",
    "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "code",
    "a", "img",
  ]);
  const voidTags = new Set(["br", "hr", "img", "col"]);
  let suppressedDepth = 0;
  let styleDepth = 0;
  let output = "";
  const parser = new Parser({
    onopentag(name, attributes) {
      if (suppressedTags.has(name)) {
        suppressedDepth += 1;
        return;
      }
      if (suppressedDepth || !allowedTags.has(name)) return;
      if (name === "style") styleDepth += 1;
      const safeAttributes = sanitiseAttributes(name, attributes, images);
      output += `<${name}${safeAttributes}>`;
    },
    ontext(value) {
      if (suppressedDepth) return;
      output += styleDepth ? sanitiseCss(value) : escapeHtml(value);
    },
    onclosetag(name) {
      if (suppressedTags.has(name)) {
        suppressedDepth = Math.max(0, suppressedDepth - 1);
        return;
      }
      if (suppressedDepth || !allowedTags.has(name)) return;
      if (name === "style") styleDepth = Math.max(0, styleDepth - 1);
      if (!voidTags.has(name)) output += `</${name}>`;
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  if (!output) return "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${output}</body></html>`;
}

function sanitiseAttributes(
  tagName: string,
  attributes: Record<string, string>,
  images: Map<string, EmailInlineImage>,
): string {
  const globalAttributes = new Set(["class", "id", "style", "align", "dir", "lang", "title"]);
  const tagAttributes: Record<string, Set<string>> = {
    table: new Set(["width", "height", "border", "cellpadding", "cellspacing", "bgcolor", "align"]),
    tr: new Set(["height", "bgcolor", "align", "valign"]),
    td: new Set(["width", "height", "colspan", "rowspan", "bgcolor", "align", "valign"]),
    th: new Set(["width", "height", "colspan", "rowspan", "bgcolor", "align", "valign"]),
    col: new Set(["width", "span", "align", "valign"]),
    img: new Set(["src", "alt", "width", "height", "align"]),
  };
  const safe: string[] = [];
  for (const [name, rawValue] of Object.entries(attributes)) {
    if (!globalAttributes.has(name) && !tagAttributes[tagName]?.has(name)) continue;
    const value = rawValue.slice(0, 4_096);
    if (name === "style") {
      const css = sanitiseCss(value).trim();
      if (css) safe.push(`style="${escapeAttribute(css)}"`);
      continue;
    }
    if (name === "src") {
      const contentId = contentIdFromUrl(value);
      const image = contentId ? images.get(contentId) : undefined;
      if (tagName === "img" && image) {
        safe.push(`src="data:${image.mimeType};base64,${image.contentBase64}"`);
      }
      continue;
    }
    if (["width", "height", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "span"].includes(name)) {
      if (/^\d{1,4}(?:\.\d{1,2})?%?$/.test(value)) safe.push(`${name}="${value}"`);
      continue;
    }
    if (name === "class" || name === "id") {
      const identifier = value.replace(/[^A-Za-z0-9_ -]/g, "").trim().slice(0, 200);
      if (identifier) safe.push(`${name}="${escapeAttribute(identifier)}"`);
      continue;
    }
    if (name === "bgcolor") {
      if (/^(?:#[0-9a-f]{3,8}|[a-z]{1,24})$/i.test(value)) safe.push(`${name}="${value}"`);
      continue;
    }
    safe.push(`${name}="${escapeAttribute(value)}"`);
  }
  return safe.length ? ` ${safe.join(" ")}` : "";
}

function sanitiseCss(value: string): string {
  return value
    .replace(/@import\s+[^;]+;?/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/(?:expression|image-set|-webkit-image-set)\s*\([^)]*\)/gi, "none")
    .replace(/(?:behavior|-moz-binding|src)\s*:[^;}]+;?/gi, "")
    .replace(/javascript\s*:/gi, "")
    .slice(0, MAX_RENDERED_HTML_CHARACTERS);
}

function contentIdFromUrl(value: string): string {
  if (!/^cid:/i.test(value.trim())) return "";
  return normaliseContentId(value.trim().slice(4));
}

function normaliseContentId(value: string): string {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return "";
  }
  return decoded.replace(/^cid:/i, "").replace(/^<|>$/g, "").trim().toLowerCase().slice(0, 500);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

export function emailBodyText(text?: string, html?: string): string {
  const plainText = normaliseText(text ?? "");
  const body = plainText || normaliseText(htmlToPlainText(html ?? ""));
  if (!body) return "";
  if (body.length <= MAX_EMAIL_BODY_CHARACTERS) return body;
  return `${body.slice(0, MAX_EMAIL_BODY_CHARACTERS).trimEnd()}\n\n[Email body shortened by Fido]`;
}

export function htmlToPlainText(html: string): string {
  const suppressedTags = new Set(["script", "style", "head", "noscript", "svg", "canvas", "template"]);
  const blockTags = new Set(["p", "div", "section", "article", "header", "footer", "table", "tr", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]);
  let suppressedDepth = 0;
  let text = "";
  const parser = new Parser({
    onopentag(name) {
      if (suppressedTags.has(name)) {
        suppressedDepth += 1;
      } else if (!suppressedDepth && name === "br") {
        text += "\n";
      } else if (!suppressedDepth && name === "li") {
        text += "\n- ";
      }
    },
    ontext(value) {
      if (!suppressedDepth) text += value;
    },
    onclosetag(name) {
      if (suppressedTags.has(name)) {
        suppressedDepth = Math.max(0, suppressedDepth - 1);
      } else if (!suppressedDepth && blockTags.has(name)) {
        text += "\n";
      } else if (!suppressedDepth && (name === "td" || name === "th")) {
        text += "\t";
      }
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.end(html);
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
