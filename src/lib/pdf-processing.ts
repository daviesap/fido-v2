import type { PDFDocumentProxy } from "pdfjs-dist";

const MAX_RENDERED_PAGE_EDGE = 2400;

export type LoadedPdfReceipt = {
  document: PDFDocumentProxy;
  pageCount: number;
};

export async function loadPdfReceipt(file: File): Promise<LoadedPdfReceipt> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: true,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) {
      await document.destroy();
      throw new Error("This PDF does not contain any pages.");
    }
    return { document, pageCount: document.numPages };
  } catch (cause) {
    await loadingTask.destroy().catch(() => undefined);
    if (cause instanceof Error && cause.name === "PasswordException") {
      throw new Error("Password-protected PDFs are not supported. Save an unlocked copy and try again.");
    }
    throw new Error("This PDF could not be opened. It may be damaged or use an unsupported format.");
  }
}

export async function renderPdfReceiptPage(document: PDFDocumentProxy, pageNumber: number): Promise<Blob> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
    throw new Error("Choose a valid PDF page.");
  }
  const page = await document.getPage(pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_RENDERED_PAGE_EDGE / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser cannot render PDF receipts.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const pdfjs = await loadPdfJs();
    await page.render({
      canvasContext: context,
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      background: "#ffffff",
    }).promise;
    return await canvasToJpeg(canvas);
  } finally {
    page.cleanup();
  }
}

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerPort && typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
      { type: "module" },
    );
  }
  return pdfjs;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The selected PDF page could not be rendered."));
    }, "image/jpeg", 0.94);
  });
}
