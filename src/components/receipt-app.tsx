"use client";

import { useEffect, useRef, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import {
  deleteObject,
  getBlob,
  ref,
  uploadBytesResumable,
  type StorageReference,
} from "firebase/storage";
import { useAuth } from "@/components/auth-provider";
import { ReceiptReview } from "@/components/receipt-review";
import { ReceiptVerification } from "@/components/receipt-verification";
import { db, functions, storage } from "@/lib/firebase";
import { PROCESSING_VERSION, type ProcessedReceiptImage } from "@/lib/image-processing";
import {
  displayStoragePath,
  formatBytes,
  hasProcessedAsset,
  receiptQueue,
  receiptStatusLabel,
  receiptContentType,
  safeFileName,
  validateReceiptFile,
  type ReadyForVerificationExtraction,
  type Receipt,
  type ReceiptQueue,
  type VerifiedReceiptValues,
} from "@/lib/receipt";

type AppMessage = { text: string; error?: boolean };
type EmailReviewReceipt = Extract<Receipt, { status: "needs_review" }>;
type ReviewTarget = { file: File; receipt?: EmailReviewReceipt };
type ReadyToVerifyReceipt = Extract<Receipt, { status: "ready_for_extraction" }> & {
  extraction: ReadyForVerificationExtraction;
};
type ReceiptFilter = "all" | ReceiptQueue;

const RECEIPT_FILTERS: { value: ReceiptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs_review", label: "Needs review" },
  { value: "extracting", label: "Extracting" },
  { value: "ready_to_verify", label: "Ready to verify" },
  { value: "verified", label: "Verified" },
  { value: "problems", label: "Problems" },
];

export function ReceiptApp() {
  const { user, signOut } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<AppMessage | null>(null);
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [verificationTarget, setVerificationTarget] = useState<ReadyToVerifyReceipt | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [openingReviewId, setOpeningReviewId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReceiptFilter>("all");
  const [emailCopied, setEmailCopied] = useState(false);
  const receiptEmailAddress = process.env.NEXT_PUBLIC_RECEIPT_EMAIL_ADDRESS ?? "receipts@flair.london";
  const filteredReceipts = filter === "all" ? receipts : receipts.filter((receipt) => receiptQueue(receipt) === filter);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      query(collection(db, "receipts"), where("ownerUid", "==", user.uid), orderBy("createdAt", "desc")),
      (snapshot) => {
        setReceipts(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Receipt));
        setLoading(false);
      },
      (error) => {
        setMessage({ text: error.message, error: true });
        setLoading(false);
      },
    );
  }, [user]);

  function selectFile(file?: File) {
    if (!file) return;
    const validationError = validateReceiptFile(file);
    if (validationError) {
      setMessage({ text: validationError, error: true });
      return;
    }
    setMessage(null);
    setReviewTarget({ file });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function uploadReviewedReceipt(processed: ProcessedReceiptImage) {
    const target = reviewTarget;
    const file = target?.file;
    if (!file || !user) return;
    setReviewTarget(null);
    setUploading(true);
    setProgress(0);
    setMessage(null);

    const receiptId = target.receipt?.id ?? crypto.randomUUID();
    const originalPath = target.receipt?.storagePath ?? `receipts/${user.uid}/${receiptId}/original-${safeFileName(file.name)}`;
    const processedPath = `receipts/${user.uid}/${receiptId}/processed-v${PROCESSING_VERSION}.jpg`;
    const originalRef = ref(storage, originalPath);
    const processedRef = ref(storage, processedPath);
    const uploadedObjects: StorageReference[] = [];
    const totalBytes = (target.receipt ? 0 : file.size) + processed.blob.size;

    try {
      if (!target.receipt) {
        await uploadObject(originalRef, file, {
          contentType: receiptContentType(file)!,
          receiptId,
          ownerUid: user.uid,
          assetType: "original",
        }, (transferred) => setProgress(Math.round((transferred / totalBytes) * 100)));
        uploadedObjects.push(originalRef);
      }

      await uploadObject(processedRef, processed.blob, {
        contentType: "image/jpeg",
        receiptId,
        ownerUid: user.uid,
        assetType: "processed",
      }, (transferred) => setProgress(Math.round((((target.receipt ? 0 : file.size) + transferred) / totalBytes) * 100)));
      uploadedObjects.push(processedRef);

      const reviewedFields = {
        status: "ready_for_extraction",
        processedStoragePath: processedPath,
        processedContentType: "image/jpeg",
        processedSize: processed.blob.size,
        processing: {
          version: PROCESSING_VERSION,
          rotation: processed.rotation,
          crop: {
            x: processed.crop.x,
            y: processed.crop.y,
            width: processed.crop.width,
            height: processed.crop.height,
          },
          sourceWidth: processed.sourceWidth,
          sourceHeight: processed.sourceHeight,
          outputWidth: processed.outputWidth,
          outputHeight: processed.outputHeight,
          sourcePage: processed.sourcePage,
          qualityWarnings: processed.qualityWarnings,
          processedAt: serverTimestamp(),
        },
      } as const;
      if (target.receipt) {
        await updateDoc(doc(db, "receipts", receiptId), {
          ...reviewedFields,
          reviewedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, "receipts", receiptId), {
        ownerUid: user.uid,
        storagePath: originalPath,
        originalFileName: file.name,
        contentType: receiptContentType(file),
        size: file.size,
        ...reviewedFields,
        createdAt: serverTimestamp(),
      });
      }
      setProgress(100);
      setMessage({ text: target.receipt
        ? "Emailed receipt reviewed. Extraction is queued in the background."
        : processed.qualityWarnings.length ? "Receipt stored with its quality notes and queued for extraction." : "Receipt stored and queued for extraction." });
    } catch (error) {
      await Promise.all(uploadedObjects.map((objectRef) => deleteObject(objectRef).catch(() => undefined)));
      setMessage({ text: error instanceof Error ? error.message : "Upload failed.", error: true });
    } finally {
      setUploading(false);
    }
  }

  async function reviewEmailedReceipt(receipt: EmailReviewReceipt) {
    setOpeningReviewId(receipt.id);
    setMessage(null);
    try {
      const blob = await getBlob(ref(storage, receipt.storagePath));
      setReviewTarget({
        receipt,
        file: new File([blob], receipt.originalFileName, { type: receipt.contentType }),
      });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "The emailed receipt could not be opened.", error: true });
    } finally {
      setOpeningReviewId(null);
    }
  }

  async function copyReceiptEmail() {
    try {
      await navigator.clipboard.writeText(receiptEmailAddress);
      setEmailCopied(true);
      window.setTimeout(() => setEmailCopied(false), 1800);
    } catch {
      setMessage({ text: `Send receipts to ${receiptEmailAddress}.` });
    }
  }

  async function remove(receipt: Receipt) {
    if (!window.confirm(`Delete ${receipt.originalFileName}? This removes the original and processed image and cannot be undone.`)) return;
    setMessage(null);
    try {
      const paths = [receipt.storagePath];
      if (hasProcessedAsset(receipt)) paths.push(receipt.processedStoragePath);
      await Promise.all(paths.map((path) => deleteObject(ref(storage, path)).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "storage/object-not-found") throw error;
      })));
      await deleteDoc(doc(db, "receipts", receipt.id));
      if (selected?.id === receipt.id) setSelected(null);
      if (verificationTarget?.id === receipt.id) setVerificationTarget(null);
      setMessage({ text: "Receipt and its derived image deleted." });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Delete failed.", error: true });
    }
  }

  async function verifyReceipt(receipt: ReadyToVerifyReceipt, values: VerifiedReceiptValues) {
    const next = receipts.find((candidate): candidate is ReadyToVerifyReceipt => candidate.id !== receipt.id && isReadyToVerify(candidate));
    await updateDoc(doc(db, "receipts", receipt.id), {
      status: "verified",
      verifiedData: values,
      verifiedAt: serverTimestamp(),
    });
    setVerificationTarget(next ?? null);
    setMessage({ text: next ? "Receipt verified. Here’s the next one." : "Receipt verified and ready for matching." });
  }

  async function retryExtraction(receipt: Extract<Receipt, { status: "ready_for_extraction" }>) {
    setRetryingId(receipt.id);
    setMessage(null);
    try {
      const retry = httpsCallable<{ receiptId: string }, { queued: boolean }>(functions, "retryReceiptExtraction");
      await retry({ receiptId: receipt.id });
      setMessage({ text: receipt.extraction ? "Extraction queued again." : "Extraction queued." });
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Extraction could not be retried.", error: true });
    } finally {
      setRetryingId(null);
    }
  }

  function openReceipt(receipt: Receipt) {
    if (receipt.status === "needs_review") {
      void reviewEmailedReceipt(receipt);
    } else if (isReadyToVerify(receipt)) {
      setVerificationTarget(receipt);
    } else {
      setSelected(receipt);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">F</span><span>Fido</span></div>
        <button className="text-button" onClick={() => void signOut()}>Sign out</button>
      </header>
      <main className="page">
        <section className="intro">
          <p className="eyebrow">Stage four · quiet automation</p>
          <h1>Receipts ready when you are.</h1>
          <p>Photograph, upload, or email a receipt. Fido keeps capture quick, extracts the useful totals in the background, and leaves a short verification queue for later.</p>
        </section>

        <section className="email-receipt-card">
          <div>
            <p className="eyebrow light">Email a receipt</p>
            <h2>Forward attachments straight to Fido.</h2>
            <p>Send a PDF or image attachment. It will arrive below as <strong>Needs review</strong>; email bodies and signatures are not stored.</p>
          </div>
          <button type="button" onClick={() => void copyReceiptEmail()}>
            <span>{receiptEmailAddress}</span>
            <strong>{emailCopied ? "Copied" : "Copy"}</strong>
          </button>
        </section>

        <section className="upload-card">
          <div className="upload-copy">
            <p className="eyebrow light">New receipt</p>
            <h2>{uploading ? "Saving both versions…" : "Photograph it before it disappears."}</h2>
            <p>Keep the full receipt in frame, or upload a digital copy. PDF, JPEG, PNG, WebP and HEIC files up to 20 MB are accepted.</p>
          </div>
          <input
            ref={inputRef}
            className="visually-hidden"
            id="receipt-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf,.heic,.heif"
            capture="environment"
            disabled={uploading}
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
          <label className={`upload-button ${uploading ? "disabled" : ""}`} htmlFor="receipt-file">
            <span aria-hidden="true">◎</span>{uploading ? `${progress}% saved` : "Scan a receipt"}
          </label>
          {uploading && <div className="progress"><span style={{ width: `${progress}%` }} /></div>}
        </section>

        {message && <p className={`message ${message.error ? "error" : ""}`} role="status">{message.text}</p>}

        <section className="library">
          <div className="library-heading">
            <div><p className="eyebrow">Review queue</p><h2>Your receipts</h2></div>
            <span className="count">{receipts.length}</span>
          </div>
          <div className="receipt-filters" aria-label="Filter receipts">
            {RECEIPT_FILTERS.map((item) => {
              const count = item.value === "all" ? receipts.length : receipts.filter((receipt) => receiptQueue(receipt) === item.value).length;
              return (
                <button
                  key={item.value}
                  type="button"
                  className={filter === item.value ? "active" : ""}
                  onClick={() => setFilter(item.value)}
                >
                  {item.label}<span>{count}</span>
                </button>
              );
            })}
          </div>
          {loading ? <div className="loading"><div className="spinner" /></div> : receipts.length === 0 ? (
            <div className="empty"><span>02</span><h3>No receipts yet</h3><p>Your first reviewed upload will appear here.</p></div>
          ) : filteredReceipts.length === 0 ? (
            <div className="empty"><span>—</span><h3>Nothing in this queue</h3><p>Choose another filter to see your receipts.</p></div>
          ) : (
            <div className="receipt-grid">
              {filteredReceipts.map((receipt) => (
                <ReceiptCard
                  key={receipt.id}
                  receipt={receipt}
                  opening={openingReviewId === receipt.id}
                  retrying={retryingId === receipt.id}
                  onOpen={() => openReceipt(receipt)}
                  onReview={() => receipt.status === "needs_review" ? void reviewEmailedReceipt(receipt) : undefined}
                  onVerify={() => isReadyToVerify(receipt) ? setVerificationTarget(receipt) : undefined}
                  onRetry={() => receipt.status === "ready_for_extraction" ? void retryExtraction(receipt) : undefined}
                  onDelete={() => void remove(receipt)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
      {reviewTarget && (
        <ReceiptReview file={reviewTarget.file} onCancel={() => setReviewTarget(null)} onApprove={(result) => void uploadReviewedReceipt(result)} />
      )}
      {verificationTarget && (
        <ReceiptVerification
          key={verificationTarget.id}
          receipt={verificationTarget}
          onCancel={() => setVerificationTarget(null)}
          onVerify={(values) => verifyReceipt(verificationTarget, values)}
        />
      )}
      {selected && <ReceiptViewer receipt={selected} onClose={() => setSelected(null)} onDelete={() => void remove(selected)} />}
    </div>
  );
}

function uploadObject(
  objectRef: StorageReference,
  blob: Blob,
  metadata: { contentType: string; receiptId: string; ownerUid: string; assetType: "original" | "processed" },
  onProgress: (transferred: number) => void,
) {
  const task = uploadBytesResumable(objectRef, blob, {
    contentType: metadata.contentType,
    cacheControl: "private, no-store, max-age=0",
    customMetadata: {
      receiptId: metadata.receiptId,
      ownerUid: metadata.ownerUid,
      assetType: metadata.assetType,
    },
  });
  return new Promise<void>((resolve, reject) => task.on(
    "state_changed",
    (snapshot) => onProgress(snapshot.bytesTransferred),
    reject,
    resolve,
  ));
}

function useReceiptImage(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path) return;
    let currentUrl: string | null = null;
    let active = true;
    void getBlob(ref(storage, path))
      .then((blob) => {
        if (!active) return;
        currentUrl = URL.createObjectURL(blob);
        setFailed(false);
        setUrl(currentUrl);
      })
      .catch(() => {
        if (active) {
          setUrl(null);
          setFailed(true);
        }
      });
    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [path]);
  return { url, failed };
}

function ReceiptCard({
  receipt,
  opening,
  retrying,
  onOpen,
  onReview,
  onVerify,
  onRetry,
  onDelete,
}: {
  receipt: Receipt;
  opening: boolean;
  retrying: boolean;
  onOpen(): void;
  onReview(): void;
  onVerify(): void;
  onRetry(): void;
  onDelete(): void;
}) {
  const needsReview = receipt.status === "needs_review";
  const queue = receiptQueue(receipt);
  const { url, failed } = useReceiptImage(needsReview && receipt.contentType === "application/pdf" ? null : displayStoragePath(receipt));
  const date = (receipt.createdAt as { toDate?: () => Date } | null)?.toDate?.();
  const extracted = receipt.status === "ready_for_extraction" && receipt.extraction?.state === "ready_for_verification"
    ? receipt.extraction.result
    : null;
  const values = receipt.status === "verified" ? receipt.verifiedData : extracted;
  const gbpAmountCharged = receipt.status === "verified" ? receipt.verifiedData.gbpAmountCharged ?? null : null;
  const displayName = values?.merchantName ?? receipt.originalFileName;
  return (
    <article className="receipt-card">
      <button className="receipt-preview" onClick={onOpen} aria-label={`View ${receipt.originalFileName}`} disabled={opening}>
        {needsReview && receipt.contentType === "application/pdf" ? (
          <span className="pdf-placeholder"><strong>PDF</strong>{opening ? "Opening…" : "Ready to review"}</span>
        ) : url ? (
          // Object URLs are private, authenticated blobs and should not use Next's server image optimizer.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" />
        ) : <span>{failed ? "Preview unavailable" : "Loading…"}</span>}
      </button>
      <div className="receipt-info">
        <span className={`status-pill ${queue}`}>
          {receiptStatusLabel(receipt)}
        </span>
        <strong title={receipt.originalFileName}>{displayName}</strong>
        {values && (
          <dl className="receipt-values">
            <div className="receipt-value-description">
              <dt>Description</dt>
              <dd>{values.purchaseDescription ?? "—"}</dd>
            </div>
            <div className="receipt-value-date">
              <dt>Receipt date</dt>
              <dd>{formatReceiptDate(values.receiptDate)}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{values.currency ?? "—"}</dd>
            </div>
            <div>
              <dt>Gross</dt>
              <dd>{values.grossTotal ?? "—"}</dd>
            </div>
            <div>
              <dt>Net</dt>
              <dd>{values.netTotal ?? "—"}</dd>
            </div>
            <div>
              <dt>VAT</dt>
              <dd>{values.vatTotal ?? "—"}</dd>
            </div>
            {values.currency && values.currency !== "GBP" && (
              <div className="receipt-value-gbp">
                <dt>GBP charged</dt>
                <dd>{gbpAmountCharged ?? "—"}</dd>
              </div>
            )}
          </dl>
        )}
        {needsReview && <small className="email-origin">From {receipt.email.sender}</small>}
        <small>Added {date ? date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "just now"} · {formatBytes(receipt.size)}</small>
      </div>
      <div className="receipt-card-actions">
        {needsReview && <button className="review-button" onClick={onReview} disabled={opening}>{opening ? "Opening…" : "Review receipt"}</button>}
        {queue === "ready_to_verify" && <button className="review-button" onClick={onVerify}>Verify values</button>}
        {queue === "problems" && <button className="review-button" onClick={onRetry} disabled={retrying}>{retrying ? "Queuing…" : "Try again"}</button>}
        {queue === "extracting" && receipt.status === "ready_for_extraction" && !receipt.extraction
          ? <button className="review-button" onClick={onRetry} disabled={retrying}>{retrying ? "Queuing…" : "Start extraction"}</button>
          : queue === "extracting" && <small className="background-note">You can leave this page</small>}
        <button className="delete-button" onClick={onDelete} aria-label={`Delete ${receipt.originalFileName}`}>Delete</button>
      </div>
    </article>
  );
}

function formatReceiptDate(value: string | null): string {
  if (!value) return "—";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function ReceiptViewer({ receipt, onClose, onDelete }: { receipt: Receipt; onClose(): void; onDelete(): void }) {
  const canShowProcessed = hasProcessedAsset(receipt);
  const [showOriginal, setShowOriginal] = useState(!canShowProcessed);
  const showingProcessed = hasProcessedAsset(receipt) && !showOriginal;
  const path = showingProcessed ? receipt.processedStoragePath : receipt.storagePath;
  const { url, failed } = useReceiptImage(path);
  const shownType = showingProcessed ? receipt.processedContentType : receipt.contentType;
  const shownSize = showingProcessed ? receipt.processedSize : receipt.size;
  return (
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={receipt.originalFileName} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="viewer">
        <div className="viewer-bar">
          <strong>{receipt.originalFileName}</strong>
          <div className="viewer-controls">
            {canShowProcessed && (
              <button className="text-button" onClick={() => setShowOriginal((value) => !value)}>
                {showOriginal ? "Show processed" : "Show original"}
              </button>
            )}
            <button className="text-button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="viewer-image">
          {url ? (
            !showingProcessed && receipt.contentType === "application/pdf" ? (
              <object className="viewer-pdf" data={url} type="application/pdf" aria-label={`Original ${receipt.originalFileName}`}>
                <a href={url} download={receipt.originalFileName}>Download the original PDF</a>
              </object>
            ) : (
              // Object URLs are private, authenticated blobs and should not use Next's server image optimizer.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={`${showingProcessed ? "Processed" : "Original"} ${receipt.originalFileName}`} />
            )
          ) : <span>{failed ? "This browser cannot preview the image, but it is stored." : "Loading image…"}</span>}
        </div>
        <div className="viewer-footer">
          <span>{showingProcessed ? "Processed" : "Original"} · {shownType} · {formatBytes(shownSize)}</span>
          <button className="danger-button" onClick={onDelete}>Delete receipt</button>
        </div>
      </div>
    </div>
  );
}

function isReadyToVerify(receipt: Receipt): receipt is ReadyToVerifyReceipt {
  return receipt.status === "ready_for_extraction" && receipt.extraction?.state === "ready_for_verification";
}
