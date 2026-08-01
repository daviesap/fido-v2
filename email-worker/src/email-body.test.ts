import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  MAX_EMAIL_BODY_CHARACTERS,
  createEmailBodyAttachment,
  emailBodyText,
  htmlToPlainText,
  sanitiseEmailHtml,
} from "./email-body";

const EMAIL_DETAILS = {
  sender: "customer@example.com",
  subject: "Receipt from Middlesbrough FC",
  receivedAt: "2026-08-01T13:55:51.000Z",
};

describe("email body receipt fallback", () => {
  it("uses the plain-text alternative when one is present", () => {
    expect(emailBodyText("Amount paid: £3.00", "<p>Wrong HTML value</p>"))
      .toBe("Amount paid: £3.00");
  });

  it("converts HTML to readable text without retaining executable or remote content", () => {
    const text = htmlToPlainText(`
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <h1>Receipt from Middlesbrough FC</h1>
          <table><tr><td>Amount paid</td><td>&pound;3.00</td></tr></table>
          <p>Boro v Espanyol &times; 1</p>
          <img src="https://tracking.example/pixel.png">
          <script>fetch("https://tracking.example/run")</script>
        </body>
      </html>
    `);

    expect(emailBodyText(undefined, text)).toContain("Receipt from Middlesbrough FC");
    expect(emailBodyText(undefined, text)).toContain("Amount paid £3.00");
    expect(emailBodyText(undefined, text)).toContain("Boro v Espanyol × 1");
    expect(text).not.toContain("tracking.example");
    expect(text).not.toContain("fetch");
  });

  it("removes encoded and malformed HTML openers after entity decoding", () => {
    const text = htmlToPlainText(`
      <p>Paid &pound;3.00</p>
      &lt;script&gt;alert(1)&lt;/script&gt;
      &lt;!-- hidden marker --&gt;
      <scr<script>ipt>nested opener</scr<script>ipt>
    `);

    expect(text).toContain("Paid £3.00");
    expect(text).not.toMatch(/[<>]/);
    expect(text.toLowerCase()).not.toContain("<script");
    expect(text).not.toContain("<!--");
  });

  it("keeps receipt layout while removing active and remote content", () => {
    const html = sanitiseEmailHtml(`
      <html><head><style>
        @import url(https://tracking.example/style.css);
        .total { color: #17352f; background: url(https://tracking.example/pixel.png) }
      </style></head><body onload="steal()">
        <table width="100%"><tr><td class="total" style="font-weight:bold; background-image:url('https://tracking.example/a')">Total</td><td>$119.91</td></tr></table>
        <img src="https://tracking.example/open.png" onerror="steal()">
        <script>fetch("https://tracking.example/run")</script>
        <iframe src="https://tracking.example/frame"></iframe>
      </body></html>
    `);

    expect(html).toContain("<table width=\"100%\">");
    expect(html).toContain("class=\"total\"");
    expect(html).toContain("font-weight:bold");
    expect(html).toContain("$119.91");
    expect(html).not.toContain("tracking.example");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
  });

  it("embeds only a matching, bounded CID image", () => {
    const html = sanitiseEmailHtml(`
      <p>Paid £12.00</p>
      <img src="cid:logo%40receipt">
      <img src="cid:missing@receipt">
    `, [{
      contentId: "<logo@receipt>",
      mimeType: "image/png",
      contentBase64: "iVBORw0KGgo=",
      size: 8,
    }]);

    expect(html).toContain("src=\"data:image/png;base64,iVBORw0KGgo=\"");
    expect(html).not.toContain("missing@receipt");
  });

  it("bounds the amount of body text converted", () => {
    const text = emailBodyText("x".repeat(MAX_EMAIL_BODY_CHARACTERS + 100));

    expect(text).toHaveLength(MAX_EMAIL_BODY_CHARACTERS + "\n\n[Email body shortened by Fido]".length);
    expect(text).toMatch(/\[Email body shortened by Fido\]$/);
  });

  it("does not create a body receipt when a supported attachment already exists", async () => {
    await expect(createEmailBodyAttachment({
      ...EMAIL_DETAILS,
      existingAttachmentCount: 1,
      html: "<p>Amount paid: £3.00</p>",
    })).resolves.toBeNull();
  });

  it("creates a valid PDF for an HTML-only receipt", async () => {
    const attachment = await createEmailBodyAttachment({
      ...EMAIL_DETAILS,
      existingAttachmentCount: 0,
      html: "<h1>Receipt</h1><p>Amount paid: &pound;3.00</p>",
    });

    expect(attachment?.filename).toBe("email-receipt.pdf");
    expect(attachment?.declaredContentType).toBe("application/pdf");
    const bytes = base64Bytes(attachment!.contentBase64);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("uses a rendered HTML PDF when the renderer succeeds", async () => {
    const renderedDocument = await PDFDocument.create();
    renderedDocument.addPage();
    const renderedBytes = await renderedDocument.save();
    let safeHtml = "";
    const attachment = await createEmailBodyAttachment({
      ...EMAIL_DETAILS,
      existingAttachmentCount: 0,
      html: "<table><tr><td>Total</td><td>£3.00</td></tr></table><script>bad()</script>",
      renderHtmlPdf: async (html) => {
        safeHtml = html;
        return renderedBytes;
      },
    });

    expect(safeHtml).toContain("<table>");
    expect(safeHtml).not.toContain("<script");
    expect(base64Bytes(attachment!.contentBase64)).toEqual(renderedBytes);
  });

  it("falls back to a valid text PDF when browser rendering fails", async () => {
    const attachment = await createEmailBodyAttachment({
      ...EMAIL_DETAILS,
      existingAttachmentCount: 0,
      html: "<p>Amount paid: &pound;3.00</p>",
      renderHtmlPdf: async () => { throw new Error("browser unavailable"); },
    });

    const bytes = base64Bytes(attachment!.contentBase64);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("rejects a body with no readable text", async () => {
    await expect(createEmailBodyAttachment({
      ...EMAIL_DETAILS,
      existingAttachmentCount: 0,
      html: "<html><head><style>.hidden { display: none; }</style></head><body><img src=\"logo.png\"></body></html>",
    })).resolves.toBeNull();
  });
});

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
