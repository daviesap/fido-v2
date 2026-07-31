import { describe, expect, it } from "vitest";

import { analyseReceiptPixels, detectReceiptBounds } from "@/lib/image-processing";

function imagePixels(width: number, height: number, colourAt: (x: number, y: number) => [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue] = colourAt(x, y);
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

describe("receipt edge suggestion", () => {
  it("finds a light receipt against a dark background with safe padding", () => {
    const pixels = imagePixels(100, 100, (x, y) =>
      x >= 20 && x < 80 && y >= 10 && y < 90 ? [245, 245, 240] : [30, 35, 32]);

    const crop = detectReceiptBounds(pixels, 100, 100);

    expect(crop).not.toBeNull();
    expect(crop?.x).toBeCloseTo(17.5, 1);
    expect(crop?.y).toBeCloseTo(7.5, 1);
    expect(crop?.width).toBeCloseTo(65, 1);
    expect(crop?.height).toBeCloseTo(85, 1);
  });

  it("falls back rather than guessing when paper and background are both light", () => {
    const pixels = imagePixels(100, 100, () => [245, 245, 245]);

    expect(detectReceiptBounds(pixels, 100, 100)).toBeNull();
  });
});

describe("receipt quality analysis", () => {
  it("flags a dark, low-contrast image", () => {
    const pixels = imagePixels(40, 40, () => [35, 35, 35]);

    const result = analyseReceiptPixels(pixels, 40, 40, 1600, 2400);

    expect(result.warnings).toContain("too-dark");
    expect(result.warnings).toContain("low-contrast");
  });

  it("flags an overexposed image and insufficient source resolution", () => {
    const pixels = imagePixels(40, 40, () => [250, 250, 250]);

    const result = analyseReceiptPixels(pixels, 40, 40, 500, 900);

    expect(result.warnings).toContain("overexposed");
    expect(result.warnings).toContain("low-resolution");
  });

  it("does not label a sharp, high-contrast image as blurry", () => {
    const pixels = imagePixels(40, 40, (x) => x % 4 < 2 ? [30, 30, 30] : [230, 230, 230]);

    const result = analyseReceiptPixels(pixels, 40, 40, 1600, 2400);

    expect(result.metrics.sharpness).toBeGreaterThan(45);
    expect(result.warnings).not.toContain("blurry");
  });
});
