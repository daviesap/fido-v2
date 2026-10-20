import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { prepareEmailReceipt } from "./email-preparation.js";

describe("automatic email receipt preparation", () => {
  it("preserves the exact PDF bytes and every page", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage(); pdf.addPage(); pdf.addPage();
    const original = Buffer.from(await pdf.save());
    const prepared = await prepareEmailReceipt(original, "application/pdf");
    expect(prepared.bytes).toBe(original);
    expect(prepared.processing).toEqual({ version: 1, mode: "document", pageCount: 3 });
  });
  it("normalises images without cropping, with bounded size and a quality warning for small images", async () => {
    const original = await sharp({ create: { width: 400, height: 800, channels: 4, background: "#fff" } }).png().toBuffer();
    const prepared = await prepareEmailReceipt(original, "image/png");
    expect(prepared.contentType).toBe("image/jpeg");
    expect(prepared.processing).toMatchObject({ outputWidth: 400, outputHeight: 800, crop: { x: 0, y: 0, width: 100, height: 100 }, qualityWarnings: ["low-resolution"] });
    expect((await sharp(prepared.bytes).metadata()).format).toBe("jpeg");
  });
  it("retains the aspect ratio while resizing large images", async () => {
    const original = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    expect((await prepareEmailReceipt(original, "image/jpeg")).processing).toMatchObject({ outputWidth: 2400, outputHeight: 1200, qualityWarnings: [] });
  });
  it("rejects damaged attachments so ingestion can retain them for manual review", async () => {
    await expect(prepareEmailReceipt(Buffer.from("invalid"), "image/jpeg")).rejects.toThrow();
    await expect(prepareEmailReceipt(Buffer.from("invalid"), "application/pdf")).rejects.toThrow();
  });
});
