import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  MAX_EMAIL_BODY_CHARACTERS,
  createEmailBodyAttachment,
  emailBodyText,
  htmlToPlainText,
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
