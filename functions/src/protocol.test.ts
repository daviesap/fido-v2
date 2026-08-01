import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeBase64, detectReceiptType, safeReceiptFileName, verifyIngestSignature } from "./protocol.js";

describe("signed ingestion protocol", () => {
  it("accepts a fresh valid signature and rejects stale or changed bodies", () => {
    const body = Buffer.from('{"ok":true}');
    const signature = createHmac("sha256", "secret").update("1000.nonce-with-enough-length.").update(body).digest("hex");
    const input = { secret: "secret", timestamp: "1000", nonce: "nonce-with-enough-length", body, signature, nowSeconds: 1000 };

    expect(verifyIngestSignature(input)).toBe(true);
    expect(verifyIngestSignature({ ...input, body: Buffer.from("changed") })).toBe(false);
    expect(verifyIngestSignature({ ...input, nowSeconds: 1400 })).toBe(false);
  });
});

describe("receipt attachment validation", () => {
  it("decodes strict base64 and recognises supported magic bytes", () => {
    const pdf = decodeBase64(Buffer.from("%PDF-1.7\n").toString("base64"));
    expect(detectReceiptType(pdf)).toBe("application/pdf");
    expect(detectReceiptType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectReceiptType(Buffer.from("not a receipt"))).toBeNull();
  });

  it("normalises filenames to the detected content type", () => {
    expect(safeReceiptFileName("Train Ticket.exe", "application/pdf")).toBe("train-ticket.pdf");
    expect(safeReceiptFileName("../../../", "image/jpeg")).toBe("emailed-receipt.jpg");
  });
});
