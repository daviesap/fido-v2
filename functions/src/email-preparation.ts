import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

/** Prepare a complete attachment; preserve the original PDF and all image edges. */
export async function prepareEmailReceipt(bytes: Buffer, contentType: string) {
  if (contentType === "application/pdf") {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pageCount = pdf.getPageCount();
    if (pageCount < 1 || pageCount > 1000) throw new Error("unsupported_pdf_pages");
    return { bytes, contentType: "application/pdf" as const, processing: { version: 1, mode: "document", pageCount } };
  }
  const image = sharp(bytes, { limitInputPixels: 50_000_000 }).rotate();
  const metadata = await image.metadata();
  const { data, info } = await image
    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  return {
    bytes: data, contentType: "image/jpeg" as const,
    processing: {
      version: 1, rotation: 0, crop: { x: 0, y: 0, width: 100, height: 100 },
      sourceWidth: metadata.width, sourceHeight: metadata.height,
      outputWidth: info.width, outputHeight: info.height, sourcePage: null,
      qualityWarnings: Math.min(info.width, info.height) < 600 ? ["low-resolution"] : [],
    },
  };
}
