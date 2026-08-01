import { describe, expect, it } from "vitest";

import { bytesToBase64, isSupportedAttachment, normaliseAddress, signPayload } from "./protocol";

describe("email worker protocol", () => {
  it("recognises supported receipt attachments", () => {
    expect(isSupportedAttachment("receipt.pdf", "application/octet-stream")).toBe(true);
    expect(isSupportedAttachment("photo", "image/jpeg")).toBe(true);
    expect(isSupportedAttachment("script.js", "application/javascript")).toBe(false);
  });

  it("normalises addresses and binary data", () => {
    expect(normaliseAddress(" Receipts@Flair.London ")).toBe("receipts@flair.london");
    expect(bytesToBase64(new Uint8Array([0, 1, 254, 255]))).toBe("AAH+/w==");
  });

  it("signs the exact timestamp, nonce, and body", async () => {
    await expect(signPayload("secret", "123", "nonce", "{\"ok\":true}"))
      .resolves.toBe("bc9a47da3d23eb56e2fede6e1b5450cde844295ae57d3159eae1931abf48de20");
  });
});
