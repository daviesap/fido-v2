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
  where,
} from "firebase/firestore";
import {
  deleteObject,
  getBlob,
  ref,
  uploadBytesResumable,
  type StorageReference,
} from "firebase/storage";
import { useAuth } from "@/components/auth-provider";
import { ReceiptReview } from "@/components/receipt-review";
import { db, storage } from "@/lib/firebase";
import { PROCESSING_VERSION, type ProcessedReceiptImage } from "@/lib/image-processing";
import {
  displayStoragePath,
  formatBytes,
  receiptContentType,
  safeFileName,
  validateReceiptFile,
  type Receipt,
} from "@/lib/receipt";

type AppMessage = { text: string; error?: boolean };

export function ReceiptApp() {
  const { user, signOut } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<AppMessage | null>(null);
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [reviewFile, setReviewFile] = useState<File | null>(null);

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
    setReviewFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function uploadReviewedReceipt(processed: ProcessedReceiptImage) {
    const file = reviewFile;
    if (!file || !user) return;
    setReviewFile(null);
    setUploading(true);
    setProgress(0);
    setMessage(null);

    const receiptId = crypto.randomUUID();
    const originalPath = `receipts/${user.uid}/${receiptId}/original-${safeFileName(file.name)}`;
    const processedPath = `receipts/${user.uid}/${receiptId}/processed-v${PROCESSING_VERSION}.jpg`;
    const originalRef = ref(storage, originalPath);
    const processedRef = ref(storage, processedPath);
    const uploadedObjects: StorageReference[] = [];
    const totalBytes = file.size + processed.blob.size;

    try {
      await uploadObject(originalRef, file, {
        contentType: receiptContentType(file)!,
        receiptId,
        ownerUid: user.uid,
        assetType: "original",
      }, (transferred) => setProgress(Math.round((transferred / totalBytes) * 100)));
      uploadedObjects.push(originalRef);

      await uploadObject(processedRef, processed.blob, {
        contentType: "image/jpeg",
        receiptId,
        ownerUid: user.uid,
        assetType: "processed",
      }, (transferred) => setProgress(Math.round(((file.size + transferred) / totalBytes) * 100)));
      uploadedObjects.push(processedRef);

      await setDoc(doc(db, "receipts", receiptId), {
        ownerUid: user.uid,
        status: "ready_for_extraction",
        storagePath: originalPath,
        originalFileName: file.name,
        contentType: receiptContentType(file),
        size: file.size,
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
        createdAt: serverTimestamp(),
      });
      setProgress(100);
      setMessage({ text: processed.qualityWarnings.length ? "Receipt stored with its quality notes." : "Receipt cropped and stored safely." });
    } catch (error) {
      await Promise.all(uploadedObjects.map((objectRef) => deleteObject(objectRef).catch(() => undefined)));
      setMessage({ text: error instanceof Error ? error.message : "Upload failed.", error: true });
    } finally {
      setUploading(false);
    }
  }

  async function remove(receipt: Receipt) {
    if (!window.confirm(`Delete ${receipt.originalFileName}? This removes the original and processed image and cannot be undone.`)) return;
    setMessage(null);
    try {
      const paths = [receipt.storagePath];
      if (receipt.status === "ready_for_extraction") paths.push(receipt.processedStoragePath);
      await Promise.all(paths.map((path) => deleteObject(ref(storage, path)).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "storage/object-not-found") throw error;
      })));
      await deleteDoc(doc(db, "receipts", receipt.id));
      if (selected?.id === receipt.id) setSelected(null);
      setMessage({ text: "Receipt and its derived image deleted." });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Delete failed.", error: true });
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
          <p className="eyebrow">Stage two · image review</p>
          <h1>A clear view of every receipt.</h1>
          <p>Photograph or choose a receipt, then crop, rotate, and check it before Fido stores both the untouched original and a clean processing copy.</p>
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
            <div><p className="eyebrow">Reviewed images</p><h2>Your receipts</h2></div>
            <span className="count">{receipts.length}</span>
          </div>
          {loading ? <div className="loading"><div className="spinner" /></div> : receipts.length === 0 ? (
            <div className="empty"><span>02</span><h3>No receipts yet</h3><p>Your first reviewed upload will appear here.</p></div>
          ) : (
            <div className="receipt-grid">
              {receipts.map((receipt) => (
                <ReceiptCard key={receipt.id} receipt={receipt} onOpen={() => setSelected(receipt)} onDelete={() => void remove(receipt)} />
              ))}
            </div>
          )}
        </section>
      </main>
      {reviewFile && (
        <ReceiptReview file={reviewFile} onCancel={() => setReviewFile(null)} onApprove={(result) => void uploadReviewedReceipt(result)} />
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

function useReceiptImage(path: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
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

function ReceiptCard({ receipt, onOpen, onDelete }: { receipt: Receipt; onOpen(): void; onDelete(): void }) {
  const { url, failed } = useReceiptImage(displayStoragePath(receipt));
  const date = (receipt.createdAt as { toDate?: () => Date } | null)?.toDate?.();
  return (
    <article className="receipt-card">
      <button className="receipt-preview" onClick={onOpen} aria-label={`View ${receipt.originalFileName}`}>
        {url ? (
          // Object URLs are private, authenticated blobs and should not use Next's server image optimizer.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" />
        ) : <span>{failed ? "Preview unavailable" : "Loading…"}</span>}
      </button>
      <div className="receipt-info">
        <span className={`status-pill ${receipt.status === "ready_for_extraction" ? "ready" : "legacy"}`}>
          {receipt.status === "ready_for_extraction" ? "Reviewed" : "Original only"}
        </span>
        <strong title={receipt.originalFileName}>{receipt.originalFileName}</strong>
        <small>{date ? date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Just now"} · {formatBytes(receipt.size)}</small>
      </div>
      <button className="delete-button" onClick={onDelete} aria-label={`Delete ${receipt.originalFileName}`}>Delete</button>
    </article>
  );
}

function ReceiptViewer({ receipt, onClose, onDelete }: { receipt: Receipt; onClose(): void; onDelete(): void }) {
  const canShowProcessed = receipt.status === "ready_for_extraction";
  const [showOriginal, setShowOriginal] = useState(!canShowProcessed);
  const path = showOriginal ? receipt.storagePath : displayStoragePath(receipt);
  const { url, failed } = useReceiptImage(path);
  const shownType = showOriginal || receipt.status === "stored" ? receipt.contentType : receipt.processedContentType;
  const shownSize = showOriginal || receipt.status === "stored" ? receipt.size : receipt.processedSize;
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
            showOriginal && receipt.contentType === "application/pdf" ? (
              <object className="viewer-pdf" data={url} type="application/pdf" aria-label={`Original ${receipt.originalFileName}`}>
                <a href={url} download={receipt.originalFileName}>Download the original PDF</a>
              </object>
            ) : (
              // Object URLs are private, authenticated blobs and should not use Next's server image optimizer.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={`${showOriginal ? "Original" : "Processed"} ${receipt.originalFileName}`} />
            )
          ) : <span>{failed ? "This browser cannot preview the image, but it is stored." : "Loading image…"}</span>}
        </div>
        <div className="viewer-footer">
          <span>{showOriginal ? "Original" : "Processed"} · {shownType} · {formatBytes(shownSize)}</span>
          <button className="danger-button" onClick={onDelete}>Delete receipt</button>
        </div>
      </div>
    </div>
  );
}
