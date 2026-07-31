"use client";

import { useEffect, useMemo, useState } from "react";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  normaliseReceiptForEditing,
  processReceiptImage,
  QUALITY_WARNING_MESSAGES,
  rotateReceiptImage,
  suggestReceiptCrop,
  type ProcessedReceiptImage,
} from "@/lib/image-processing";
import { loadPdfReceipt, renderPdfReceiptPage } from "@/lib/pdf-processing";
import { formatBytes, receiptContentType } from "@/lib/receipt";

const DEFAULT_CROP: PercentCrop = { unit: "%", x: 2, y: 2, width: 96, height: 96 };

export function ReceiptReview({
  file,
  onApprove,
  onCancel,
}: {
  file: File;
  onApprove(result: ProcessedReceiptImage): void;
  onCancel(): void;
}) {
  const [normalisedSource, setNormalisedSource] = useState<Blob | null>(null);
  const [rotatedSource, setRotatedSource] = useState<Blob | null>(null);
  const [crop, setCrop] = useState<PercentCrop>(DEFAULT_CROP);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [processed, setProcessed] = useState<ProcessedReceiptImage | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sourceUrl = useObjectUrl(rotatedSource);
  const previewUrl = useObjectUrl(processed?.blob ?? null);
  const isPdf = receiptContentType(file) === "application/pdf";

  useEffect(() => {
    let active = true;
    let openedPdf: PDFDocumentProxy | null = null;
    void (async () => {
      if (receiptContentType(file) === "application/pdf") {
        const loaded = await loadPdfReceipt(file);
        openedPdf = loaded.document;
        if (!active) {
          await loaded.document.destroy();
          return;
        }
        const blob = await renderPdfReceiptPage(loaded.document, 1);
        const suggestedCrop = await suggestReceiptCrop(blob);
        if (active) {
          setPdfDocument(loaded.document);
          setPdfPageCount(loaded.pageCount);
          setNormalisedSource(blob);
          setRotatedSource(blob);
          setCrop(suggestedCrop);
        }
        return;
      }
      const blob = await normaliseReceiptForEditing(file);
      const suggestedCrop = await suggestReceiptCrop(blob);
      if (active) {
        setNormalisedSource(blob);
        setRotatedSource(blob);
        setCrop(suggestedCrop);
      }
    })()
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "The receipt could not be prepared.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      if (openedPdf) void openedPdf.destroy();
    };
  }, [file]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel]);

  async function reviewCrop() {
    if (!rotatedSource || crop.width < 1 || crop.height < 1) return;
    setBusy(true);
    setError(null);
    try {
      setProcessed(await processReceiptImage(rotatedSource, crop, rotation, isPdf ? pdfPage : null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The crop could not be processed.");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(direction: "left" | "right") {
    if (!normalisedSource) return;
    const delta = direction === "right" ? 90 : 270;
    const nextRotation = ((rotation + delta) % 360) as 0 | 90 | 180 | 270;
    setBusy(true);
    setError(null);
    setProcessed(null);
    setCrop(DEFAULT_CROP);
    try {
      const rotated = await rotateReceiptImage(normalisedSource, nextRotation);
      setRotatedSource(rotated);
      setCrop(await suggestReceiptCrop(rotated));
      setRotation(nextRotation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The receipt could not be rotated.");
    } finally {
      setBusy(false);
    }
  }

  async function selectPdfPage(pageNumber: number) {
    if (!pdfDocument || pageNumber === pdfPage || pageNumber < 1 || pageNumber > pdfPageCount) return;
    setBusy(true);
    setError(null);
    setProcessed(null);
    try {
      const rendered = await renderPdfReceiptPage(pdfDocument, pageNumber);
      const suggestedCrop = await suggestReceiptCrop(rendered);
      setNormalisedSource(rendered);
      setRotatedSource(rendered);
      setRotation(0);
      setCrop(suggestedCrop);
      setPdfPage(pageNumber);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That PDF page could not be rendered.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-backdrop" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <section className="review-dialog">
        <header className="review-header">
          <div>
            <p className="eyebrow">Stage two · image review</p>
            <h2 id="review-title">{processed ? "Check the result" : "Frame the receipt"}</h2>
            <p>{file.name} · {formatBytes(file.size)}</p>
          </div>
          <button className="text-button" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </header>

        {processed ? (
          <div className="review-result">
            <div className="processed-preview">
              {previewUrl && (
                // This is a private, local object URL generated for the review step.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt="Processed receipt preview" />
              )}
            </div>
            <div className="quality-panel">
              <p className="eyebrow">Quality check</p>
              <h3>{processed.qualityWarnings.length ? "A quick check is needed" : "Looking good"}</h3>
              {processed.qualityWarnings.length ? (
                <ul className="quality-warnings">
                  {processed.qualityWarnings.map((warning) => (
                    <li key={warning}>{QUALITY_WARNING_MESSAGES[warning]}</li>
                  ))}
                </ul>
              ) : (
                <p>No obvious blur, exposure, contrast, or resolution problems were detected.</p>
              )}
              <dl className="image-facts">
                <div><dt>Output</dt><dd>{processed.outputWidth} × {processed.outputHeight}px</dd></div>
                <div><dt>File size</dt><dd>{formatBytes(processed.blob.size)}</dd></div>
              </dl>
            </div>
          </div>
        ) : (
          <div className="crop-workspace">
            <div className="crop-stage" aria-busy={busy}>
              {sourceUrl ? (
                <ReactCrop
                  crop={crop}
                  onChange={(_, percentageCrop) => setCrop(percentageCrop)}
                  keepSelection
                  minWidth={80}
                  minHeight={80}
                  ruleOfThirds
                >
                  {/* The cropper requires a browser object URL and controls the final accessible crop. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sourceUrl} alt="Receipt to crop" />
                </ReactCrop>
              ) : (
                <div className="review-loading"><div className="spinner" /><span>Preparing image…</span></div>
              )}
            </div>
            <aside className="crop-help">
              <p className="eyebrow">Crop guide</p>
              <h3>Keep every useful detail.</h3>
              <p>Fido suggests the paper edges when it can. Drag the corners to correct them, keeping the merchant, date, total, VAT details, and bottom edge.</p>
              {pdfPageCount > 1 && (
                <div className="page-controls">
                  <label htmlFor="pdf-page">PDF page</label>
                  <div>
                    <button type="button" aria-label="Previous PDF page" onClick={() => void selectPdfPage(pdfPage - 1)} disabled={busy || pdfPage === 1}>←</button>
                    <select id="pdf-page" value={pdfPage} onChange={(event) => void selectPdfPage(Number(event.target.value))} disabled={busy}>
                      {Array.from({ length: pdfPageCount }, (_, index) => (
                        <option key={index + 1} value={index + 1}>Page {index + 1} of {pdfPageCount}</option>
                      ))}
                    </select>
                    <button type="button" aria-label="Next PDF page" onClick={() => void selectPdfPage(pdfPage + 1)} disabled={busy || pdfPage === pdfPageCount}>→</button>
                  </div>
                </div>
              )}
              <div className="rotate-controls" aria-label="Rotate receipt">
                <button type="button" onClick={() => void rotate("left")} disabled={busy}>↶ Rotate left</button>
                <button type="button" onClick={() => void rotate("right")} disabled={busy}>Rotate right ↷</button>
              </div>
              <button className="reset-crop-button" type="button" onClick={() => setCrop(DEFAULT_CROP)} disabled={busy}>
                Reset crop
              </button>
            </aside>
          </div>
        )}

        {error && <p className="message error review-message" role="alert">{error}</p>}

        <footer className="review-actions">
          {processed ? (
            <>
              <button className="secondary-button" type="button" onClick={() => setProcessed(null)} disabled={busy}>Adjust crop</button>
              <button className="primary-button" type="button" onClick={() => onApprove(processed)} disabled={busy}>
                {processed.qualityWarnings.length ? "Use this image" : "Save receipt"}
              </button>
            </>
          ) : (
            <>
              <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>Choose another</button>
              <button className="primary-button" type="button" onClick={() => void reviewCrop()} disabled={busy || !sourceUrl}>
                {busy ? "Preparing…" : "Review crop"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => blob ? URL.createObjectURL(blob) : null, [blob]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}
