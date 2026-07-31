import type { PercentCrop } from "react-image-crop";

export const PROCESSING_VERSION = 1;
export const MAX_PROCESSED_EDGE = 2400;

export const QUALITY_WARNING_MESSAGES = {
  "low-resolution": "This crop may be too small for reliable text extraction.",
  blurry: "The image looks soft or blurred. A steadier retake may work better.",
  "low-contrast": "The receipt has low contrast, so faint text may be missed.",
  "too-dark": "The receipt looks very dark. Try taking it in brighter, even light.",
  overexposed: "The receipt looks overexposed. Check that text has not disappeared.",
  "possible-glare": "There may be glare on the receipt. Check that all totals are readable.",
} as const;

export type QualityWarning = keyof typeof QUALITY_WARNING_MESSAGES;

export type ImageQualityMetrics = {
  meanLuminance: number;
  contrast: number;
  sharpness: number;
  clippedHighlightRatio: number;
};

export type ProcessedReceiptImage = {
  blob: Blob;
  crop: PercentCrop;
  rotation: 0 | 90 | 180 | 270;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  qualityWarnings: QualityWarning[];
  qualityMetrics: ImageQualityMetrics;
  sourcePage: number | null;
};

export function analyseReceiptPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  naturalWidth: number,
  naturalHeight: number,
): { metrics: ImageQualityMetrics; warnings: QualityWarning[] } {
  const pixelCount = width * height;
  if (pixels.length < pixelCount * 4 || pixelCount === 0) {
    throw new Error("Image pixel data is incomplete.");
  }

  const luminance = new Float32Array(pixelCount);
  let sum = 0;
  let clippedHighlights = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const value = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
    luminance[index] = value;
    sum += value;
    if (pixels[offset] >= 252 && pixels[offset + 1] >= 252 && pixels[offset + 2] >= 252) {
      clippedHighlights += 1;
    }
  }

  const meanLuminance = sum / pixelCount;
  let variance = 0;
  for (const value of luminance) variance += (value - meanLuminance) ** 2;
  const contrast = Math.sqrt(variance / pixelCount);

  let laplacianSum = 0;
  let laplacianSquaredSum = 0;
  let laplacianCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian =
        luminance[index - width] +
        luminance[index - 1] -
        4 * luminance[index] +
        luminance[index + 1] +
        luminance[index + width];
      laplacianSum += laplacian;
      laplacianSquaredSum += laplacian ** 2;
      laplacianCount += 1;
    }
  }
  const laplacianMean = laplacianCount ? laplacianSum / laplacianCount : 0;
  const sharpness = laplacianCount
    ? laplacianSquaredSum / laplacianCount - laplacianMean ** 2
    : 0;
  const clippedHighlightRatio = clippedHighlights / pixelCount;

  const warnings: QualityWarning[] = [];
  if (Math.min(naturalWidth, naturalHeight) < 700 || naturalWidth * naturalHeight < 900_000) {
    warnings.push("low-resolution");
  }
  if (meanLuminance < 58) warnings.push("too-dark");
  if (meanLuminance > 238 && contrast < 28) warnings.push("overexposed");
  if (contrast < 24) warnings.push("low-contrast");
  if (sharpness < 45 && contrast >= 18) warnings.push("blurry");
  if (clippedHighlightRatio > 0.55 && contrast > 48) warnings.push("possible-glare");

  return {
    metrics: {
      meanLuminance: roundMetric(meanLuminance),
      contrast: roundMetric(contrast),
      sharpness: roundMetric(Math.max(0, sharpness)),
      clippedHighlightRatio: roundMetric(clippedHighlightRatio),
    },
    warnings,
  };
}

export async function normaliseReceiptForEditing(file: File): Promise<Blob> {
  if (!/image\/hei[cf]/i.test(file.type) && !/\.hei[cf]$/i.test(file.name)) return file;

  const { default: convertHeic } = await import("heic2any");
  const converted = await convertHeic({ blob: file, toType: "image/jpeg", quality: 0.94 });
  return Array.isArray(converted) ? converted[0] : converted;
}

export async function suggestReceiptCrop(source: Blob): Promise<PercentCrop> {
  const image = await loadImage(source);
  const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(20, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(20, Math.round(image.naturalHeight * scale));
  const context = requiredContext(canvas);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return detectReceiptBounds(pixels, canvas.width, canvas.height) ?? {
    unit: "%",
    x: 2,
    y: 2,
    width: 96,
    height: 96,
  };
}

export function detectReceiptBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): PercentCrop | null {
  if (width < 20 || height < 20 || pixels.length < width * height * 4) return null;
  const sampleSize = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  const corners = [
    [0, 0],
    [width - sampleSize, 0],
    [0, height - sampleSize],
    [width - sampleSize, height - sampleSize],
  ];
  const background = [0, 0, 0];
  let samples = 0;
  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + sampleSize; y += 1) {
      for (let x = startX; x < startX + sampleSize; x += 1) {
        const offset = (y * width + x) * 4;
        background[0] += pixels[offset];
        background[1] += pixels[offset + 1];
        background[2] += pixels[offset + 2];
        samples += 1;
      }
    }
  }
  background[0] /= samples;
  background[1] /= samples;
  background[2] /= samples;

  // A light background is indistinguishable from receipt paper with this conservative detector.
  // In that case the full-image crop is safer than accidentally trimming content.
  const backgroundLuminance = background[0] * 0.2126 + background[1] * 0.7152 + background[2] * 0.0722;
  if (backgroundLuminance > 195) return null;

  const rows = new Uint32Array(height);
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const colourDistance = Math.sqrt(
        (pixels[offset] - background[0]) ** 2 +
        (pixels[offset + 1] - background[1]) ** 2 +
        (pixels[offset + 2] - background[2]) ** 2,
      );
      if (colourDistance > 52) {
        rows[y] += 1;
        columns[x] += 1;
      }
    }
  }

  const rowThreshold = Math.max(3, Math.round(width * 0.08));
  const columnThreshold = Math.max(3, Math.round(height * 0.08));
  const top = firstIndex(rows, (value) => value >= rowThreshold);
  const bottom = lastIndex(rows, (value) => value >= rowThreshold);
  const left = firstIndex(columns, (value) => value >= columnThreshold);
  const right = lastIndex(columns, (value) => value >= columnThreshold);
  if (top < 0 || bottom < top || left < 0 || right < left) return null;

  const detectedWidth = right - left + 1;
  const detectedHeight = bottom - top + 1;
  if (detectedWidth < width * 0.25 || detectedHeight < height * 0.25) return null;
  if (detectedWidth * detectedHeight < width * height * 0.18) return null;

  const paddingX = width * 0.025;
  const paddingY = height * 0.025;
  const paddedLeft = Math.max(0, left - paddingX);
  const paddedTop = Math.max(0, top - paddingY);
  const paddedRight = Math.min(width, right + 1 + paddingX);
  const paddedBottom = Math.min(height, bottom + 1 + paddingY);
  return normaliseCrop({
    unit: "%",
    x: (paddedLeft / width) * 100,
    y: (paddedTop / height) * 100,
    width: ((paddedRight - paddedLeft) / width) * 100,
    height: ((paddedBottom - paddedTop) / height) * 100,
  });
}

export async function rotateReceiptImage(source: Blob, rotation: 0 | 90 | 180 | 270): Promise<Blob> {
  if (rotation === 0) return source;
  const image = await loadImage(source);
  const swapsDimensions = rotation === 90 || rotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swapsDimensions ? image.naturalHeight : image.naturalWidth;
  canvas.height = swapsDimensions ? image.naturalWidth : image.naturalHeight;
  const context = requiredContext(canvas);

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

  return canvasToBlob(canvas, editableOutputType(source.type), 0.94);
}

export async function processReceiptImage(
  rotatedSource: Blob,
  crop: PercentCrop,
  rotation: 0 | 90 | 180 | 270,
  sourcePage: number | null = null,
): Promise<ProcessedReceiptImage> {
  const image = await loadImage(rotatedSource);
  const safeCrop = normaliseCrop(crop);
  const sourceX = Math.round((safeCrop.x / 100) * image.naturalWidth);
  const sourceY = Math.round((safeCrop.y / 100) * image.naturalHeight);
  const sourceWidth = Math.max(1, Math.round((safeCrop.width / 100) * image.naturalWidth));
  const sourceHeight = Math.max(1, Math.round((safeCrop.height / 100) * image.naturalHeight));
  const outputScale = Math.min(1, MAX_PROCESSED_EDGE / Math.max(sourceWidth, sourceHeight));
  const outputWidth = Math.max(1, Math.round(sourceWidth * outputScale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * outputScale));

  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = outputWidth;
  rawCanvas.height = outputHeight;
  const rawContext = requiredContext(rawCanvas);
  rawContext.drawImage(
    image,
    sourceX,
    sourceY,
    Math.min(sourceWidth, image.naturalWidth - sourceX),
    Math.min(sourceHeight, image.naturalHeight - sourceY),
    0,
    0,
    outputWidth,
    outputHeight,
  );

  const quality = analyseCanvas(rawCanvas, sourceWidth, sourceHeight);

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = outputWidth;
  outputCanvas.height = outputHeight;
  const outputContext = requiredContext(outputCanvas);
  outputContext.filter = "contrast(1.06) brightness(1.02)";
  outputContext.drawImage(rawCanvas, 0, 0);
  outputContext.filter = "none";

  return {
    blob: await canvasToBlob(outputCanvas, "image/jpeg", 0.9),
    crop: safeCrop,
    rotation,
    sourceWidth: image.naturalWidth,
    sourceHeight: image.naturalHeight,
    outputWidth,
    outputHeight,
    qualityWarnings: quality.warnings,
    qualityMetrics: quality.metrics,
    sourcePage,
  };
}

function analyseCanvas(canvas: HTMLCanvasElement, naturalWidth: number, naturalHeight: number) {
  const scale = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
  const analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = Math.max(3, Math.round(canvas.width * scale));
  analysisCanvas.height = Math.max(3, Math.round(canvas.height * scale));
  const context = requiredContext(analysisCanvas);
  context.drawImage(canvas, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const imageData = context.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  return analyseReceiptPixels(
    imageData.data,
    analysisCanvas.width,
    analysisCanvas.height,
    naturalWidth,
    naturalHeight,
  );
}

function normaliseCrop(crop: PercentCrop): PercentCrop {
  const x = Math.min(99, Math.max(0, crop.x));
  const y = Math.min(99, Math.max(0, crop.y));
  const width = Math.min(100 - x, Math.max(1, crop.width));
  const height = Math.min(100 - y, Math.max(1, crop.height));
  return {
    unit: "%",
    x: roundCrop(x),
    y: roundCrop(y),
    width: roundCrop(width),
    height: roundCrop(height),
  };
}

function requiredContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser cannot process receipt images.");
  return context;
}

function loadImage(source: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image could not be decoded. Try converting it to JPEG first."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The processed receipt image could not be created."));
    }, type, quality);
  });
}

function editableOutputType(sourceType: string): string {
  if (sourceType === "image/png" || sourceType === "image/webp") return sourceType;
  return "image/jpeg";
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundCrop(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function firstIndex(values: Uint32Array, predicate: (value: number) => boolean): number {
  for (let index = 0; index < values.length; index += 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function lastIndex(values: Uint32Array, predicate: (value: number) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}
