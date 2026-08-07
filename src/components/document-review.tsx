"use client";

import { useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfReceipt, renderPdfReceiptPage } from "@/lib/pdf-processing";
import { formatBytes } from "@/lib/receipt";

export function DocumentReview({
  file,
  onApprove,
  onCancel,
}: {
  file: File;
  onApprove(pageCount: number): Promise<void>;
  onCancel(): void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [page, setPage] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageUrl = useObjectUrl(page);

  useEffect(() => {
    let active = true;
    let opened: PDFDocumentProxy | null = null;
    void loadPdfReceipt(file)
      .then(async (loaded) => {
        opened = loaded.document;
        const rendered = await renderPdfReceiptPage(loaded.document, 1);
        if (!active) return;
        setDocument(loaded.document);
        setPageCount(loaded.pageCount);
        setPage(rendered);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "The PDF could not be opened.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      if (opened) void opened.destroy();
    };
  }, [file]);

  async function showPage(nextPage: number) {
    if (!document || busy || nextPage < 1 || nextPage > pageCount || nextPage === pageNumber) return;
    setBusy(true);
    setError(null);
    try {
      setPage(await renderPdfReceiptPage(document, nextPage));
      setPageNumber(nextPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That PDF page could not be shown.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!pageCount) return;
    setSaving(true);
    setError(null);
    try {
      await onApprove(pageCount);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The complete PDF could not be queued.");
      setSaving(false);
    }
  }

  return (
    <div className="review-backdrop" role="dialog" aria-modal="true" aria-labelledby="document-review-title">
      <section className="review-dialog document-review-dialog">
        <header className="review-header">
          <div>
            <p className="eyebrow">PDF receipt</p>
            <h2 id="document-review-title">Keep the complete receipt.</h2>
            <p>{file.name} · {formatBytes(file.size)}</p>
          </div>
          <button className="text-button" type="button" onClick={onCancel} disabled={busy || saving}>Cancel</button>
        </header>

        <div className="document-review-workspace">
          <div className="document-page" aria-busy={busy}>
            {pageUrl ? (
              // This is a private local preview rendered from the complete PDF.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pageUrl} alt={`PDF page ${pageNumber} of ${pageCount}`} />
            ) : <div className="review-loading"><div className="spinner" /><span>Opening PDF…</span></div>}
          </div>
          <aside className="document-review-summary">
            <p className="eyebrow">Complete document</p>
            <h3>{pageCount ? `${pageCount} page${pageCount === 1 ? "" : "s"} will be kept` : "Checking the document…"}</h3>
            <p>Fido will read every page, preserve the original PDF, and send that same complete document to FreeAgent.</p>
            {pageCount > 1 && (
              <div className="page-controls">
                <label htmlFor="document-page">Preview page</label>
                <div>
                  <button type="button" aria-label="Previous PDF page" onClick={() => void showPage(pageNumber - 1)} disabled={busy || pageNumber === 1}>←</button>
                  <select id="document-page" value={pageNumber} onChange={(event) => void showPage(Number(event.target.value))} disabled={busy}>
                    {Array.from({ length: pageCount }, (_, index) => (
                      <option key={index + 1} value={index + 1}>Page {index + 1} of {pageCount}</option>
                    ))}
                  </select>
                  <button type="button" aria-label="Next PDF page" onClick={() => void showPage(pageNumber + 1)} disabled={busy || pageNumber === pageCount}>→</button>
                </div>
              </div>
            )}
          </aside>
        </div>

        {error && <p className="message error review-message" role="alert">{error}</p>}
        <footer className="review-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy || saving}>Leave in review</button>
          <button className="primary-button" type="button" onClick={() => void approve()} disabled={busy || saving || !pageCount}>
            {saving ? "Queuing…" : "Use complete PDF"}
          </button>
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
