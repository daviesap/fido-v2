"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getBlob, ref } from "firebase/storage";
import { functions, storage } from "@/lib/firebase";
import type { Receipt } from "@/lib/receipt";

type VerifiedReceipt = Extract<Receipt, { status: "verified" }>;
type MatchMode = "transaction" | "out_of_pocket" | "unmatched";

type RankedTransaction = {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  currency: "GBP";
  datedOn: string;
  amount: string;
  description: string;
  fullDescription: string;
  unexplainedAmount: string;
  score: number;
  confidence: "high" | "medium" | "low";
  dayDifference: number;
  merchantSimilarity: number;
  factors: { amount: number; date: number; merchant: number };
  reasons: string[];
};

type SpendingCategory = {
  id: string;
  url: string;
  description: string;
  nominalCode: string;
  group: "Admin expenses" | "Cost of sales";
  groupDescription: string;
  allowableForTax: boolean | null;
  autoSalesTaxRate: string | null;
};

type MatchProposal = {
  type: MatchMode;
  state: "proposed";
  transaction?: RankedTransaction | null;
  expense?: {
    claimantName: string;
    category: SpendingCategory;
    datedOn: string;
    currency: string;
    grossValue: string;
    nativeGrossValue: string | null;
    description: string;
    vatTreatment: string;
    attachmentName: string;
  } | null;
  updatedAt: string | null;
};

type MatchOptions = {
  receipt: {
    id: string;
    merchantName: string;
    purchaseDescription: string;
    receiptDate: string;
    currency: string;
    grossTotal: string;
    netTotal: string | null;
    vatTotal: string | null;
    gbpAmountCharged: string | null;
  };
  suggestions: RankedTransaction[];
  otherTransactions: RankedTransaction[];
  existingProposal: MatchProposal | null;
  lastSyncCompletedAt: string | null;
  writeEnabled: false;
};

type CategoryResponse = { categories: SpendingCategory[]; writeEnabled: false };
type SaveRequest =
  | { receiptId: string; type: "transaction"; transactionId: string }
  | { receiptId: string; type: "out_of_pocket"; categoryUrl: string }
  | { receiptId: string; type: "unmatched" };
type SaveResponse = { proposal: MatchProposal; writeEnabled: false };

type AttachmentTarget = {
  transactionUrl: string;
  explanationUrl: string;
  explanationType: string;
  categoryUrl: string | null;
  categoryNominalCode: string | null;
  datedOn: string;
  grossValue: string;
};

type AttachmentDelivery = {
  state: "sent";
  operation: "attach_to_existing_explanation";
  target: AttachmentTarget;
  attachment: { fileName: string; fileSize: number; contentType: string };
  sentAt: string | null;
};

type AttachmentPreview = {
  state: "ready" | "blocked";
  receipt: { id: string; merchantName: string; processedSize: number };
  transaction: { id: string; description: string; datedOn: string; amount: string; bankAccountName: string };
  explanation: {
    id: string;
    type: string;
    description: string;
    categoryUrl: string | null;
    categoryNominalCode: string | null;
    datedOn: string;
    grossValue: string;
    isLocked: boolean;
    existingAttachment: { fileName: string; fileSize: number } | null;
  } | null;
  attachment: { fileName: string; fileSize: number; contentType: "image/jpeg" };
  blockers: string[];
  reconcileExisting: boolean;
  confirmationToken: string | null;
  writeEnabled: true;
};

type AttachmentPreviewResponse = AttachmentPreview | { state: "sent"; delivery: AttachmentDelivery; writeEnabled: true };
type AttachmentConfirmResponse = { delivery: AttachmentDelivery; writeEnabled: true };

export function ReceiptMatching({
  receipt,
  onClose,
  onSaved,
}: {
  receipt: VerifiedReceipt;
  onClose(): void;
  onSaved(message: string): void;
}) {
  const [options, setOptions] = useState<MatchOptions | null>(null);
  const [mode, setMode] = useState<MatchMode>("transaction");
  const [selectedTransactionId, setSelectedTransactionId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<SpendingCategory[] | null>(null);
  const [selectedCategoryUrl, setSelectedCategoryUrl] = useState("");
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewResponse | null>(null);
  const [loadingAttachment, setLoadingAttachment] = useState(true);
  const [sendingAttachment, setSendingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const categoryRequestStarted = useRef(false);

  useEffect(() => {
    if (receipt.delivery) return;
    let active = true;
    const load = httpsCallable<{ receiptId: string }, MatchOptions>(functions, "getReceiptMatchOptions");
    void load({ receiptId: receipt.id })
      .then((response) => {
        if (!active) return;
        const next = response.data;
        setOptions(next);
        const existingMode = next.existingProposal?.type;
        setMode(existingMode ?? "transaction");
        setSelectedTransactionId(next.existingProposal?.transaction?.id ?? next.suggestions[0]?.id ?? "");
        setSelectedCategoryUrl(next.existingProposal?.expense?.category.url ?? "");
      })
      .catch((cause) => active && setError(callableMessage(cause, "Matching options could not be loaded.")));
    return () => { active = false; };
  }, [receipt.delivery, receipt.id]);

  useEffect(() => {
    if (!receipt.delivery && (!options?.existingProposal || options.existingProposal.type !== "transaction")) return;
    let active = true;
    const load = httpsCallable<{ receiptId: string }, AttachmentPreviewResponse>(functions, "getReceiptAttachmentPreview");
    void load({ receiptId: receipt.id })
      .then((response) => active && setAttachmentPreview(response.data))
      .catch((cause) => active && setAttachmentError(callableMessage(cause, "The FreeAgent attachment preview could not be loaded.")))
      .finally(() => active && setLoadingAttachment(false));
    return () => { active = false; };
  }, [options?.existingProposal, receipt.delivery, receipt.id]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void getBlob(ref(storage, receipt.processedStoragePath))
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [receipt.processedStoragePath]);

  async function loadCategories() {
    if (categories || categoryRequestStarted.current) return;
    categoryRequestStarted.current = true;
    setLoadingCategories(true);
    setError(null);
    const load = httpsCallable<void, CategoryResponse>(functions, "getFreeAgentSpendingCategories");
    await load()
      .then((response) => {
        setCategories(response.data.categories);
        setSelectedCategoryUrl((current) => current || response.data.categories[0]?.url || "");
      })
      .catch((cause) => {
        categoryRequestStarted.current = false;
        setError(callableMessage(cause, "FreeAgent categories could not be loaded."));
      })
      .finally(() => setLoadingCategories(false));
  }

  const manualTransactions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (options?.otherTransactions ?? []).filter((transaction) => !query
      || transaction.description.toLowerCase().includes(query)
      || transaction.fullDescription.toLowerCase().includes(query)
      || transaction.bankAccountName.toLowerCase().includes(query)
      || transaction.datedOn.includes(query)
      || transaction.amount.includes(query));
  }, [options, search]);

  const selectedCategory = categories?.find((category) => category.url === selectedCategoryUrl)
    ?? options?.existingProposal?.expense?.category
    ?? null;

  async function saveProposal() {
    let request: SaveRequest;
    if (mode === "transaction") {
      if (!selectedTransactionId) {
        setError("Choose a transaction, or select another treatment.");
        return;
      }
      request = { receiptId: receipt.id, type: mode, transactionId: selectedTransactionId };
    } else if (mode === "out_of_pocket") {
      if (!selectedCategoryUrl) {
        setError("Choose the FreeAgent spending category.");
        return;
      }
      request = { receiptId: receipt.id, type: mode, categoryUrl: selectedCategoryUrl };
    } else {
      request = { receiptId: receipt.id, type: mode };
    }

    setSaving(true);
    setError(null);
    try {
      const save = httpsCallable<SaveRequest, SaveResponse>(functions, "saveReceiptMatchProposal");
      await save(request);
      onSaved(mode === "transaction"
        ? "Transaction proposal saved. Nothing has been changed in FreeAgent."
        : mode === "out_of_pocket"
          ? "Out-of-pocket expense proposal saved. Nothing has been sent to FreeAgent."
          : "Receipt kept unmatched for later review.");
      onClose();
    } catch (cause) {
      setError(callableMessage(cause, "The proposal could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  async function confirmAttachment() {
    if (!attachmentPreview || attachmentPreview.state !== "ready" || !attachmentPreview.confirmationToken) return;
    setSendingAttachment(true);
    setAttachmentError(null);
    try {
      const confirm = httpsCallable<{ receiptId: string; confirmationToken: string }, AttachmentConfirmResponse>(functions, "confirmReceiptAttachment");
      const response = await confirm({ receiptId: receipt.id, confirmationToken: attachmentPreview.confirmationToken });
      setAttachmentPreview({ state: "sent", delivery: response.data.delivery, writeEnabled: true });
      onSaved("Receipt attached to the existing FreeAgent explanation. Its accounting category and amounts were unchanged.");
    } catch (cause) {
      setAttachmentError(callableMessage(cause, "The receipt could not be attached to FreeAgent."));
    } finally {
      setSendingAttachment(false);
    }
  }

  const attachmentSent = attachmentPreview?.state === "sent";

  return (
    <div className="matching-backdrop" role="dialog" aria-modal="true" aria-labelledby="matching-title">
      <div className="matching-dialog">
        <header className="review-header">
          <div>
            <p className="eyebrow">{attachmentSent ? "Stage eight · sent" : "Stage eight · preview, then confirm"}</p>
            <h2 id="matching-title">Match the money, then the merchant.</h2>
            <p>{receipt.verifiedData.merchantName} · {formatReceiptDate(receipt.verifiedData.receiptDate)}</p>
          </div>
          <button className="text-button" type="button" onClick={onClose}>Close</button>
        </header>

        <div className="matching-workspace">
          <aside className="matching-receipt">
            <div className="matching-image">
              {imageUrl ? (
                // Object URLs are private, authenticated blobs and should not use Next's server image optimizer.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt="Processed receipt" />
              ) : <span>Loading receipt…</span>}
            </div>
            <div className="matching-receipt-summary">
              <p className="eyebrow">Verified receipt</p>
              <h3>{receipt.verifiedData.merchantName}</h3>
              <p>{receipt.verifiedData.purchaseDescription}</p>
              <dl>
                <div><dt>Date</dt><dd>{formatReceiptDate(receipt.verifiedData.receiptDate)}</dd></div>
                <div><dt>Receipt total</dt><dd>{formatMoney(receipt.verifiedData.grossTotal, receipt.verifiedData.currency)}</dd></div>
                {receipt.verifiedData.currency !== "GBP" && (
                  <div><dt>GBP charged</dt><dd>{formatMoney(receipt.verifiedData.gbpAmountCharged ?? "", "GBP")}</dd></div>
                )}
                <div><dt>VAT</dt><dd>{receipt.verifiedData.vatTotal ? formatMoney(receipt.verifiedData.vatTotal, "GBP") : "Not printed"}</dd></div>
              </dl>
            </div>
          </aside>

          <section className="matching-panel">
            {loadingAttachment && (receipt.delivery || options?.existingProposal?.type === "transaction") && <p className="attachment-loading">Checking the live FreeAgent explanation…</p>}
            {attachmentPreview && (
              <AttachmentPanel
                preview={attachmentPreview}
                sending={sendingAttachment}
                onConfirm={() => void confirmAttachment()}
              />
            )}
            {attachmentError && <p className="message error" role="alert">{attachmentError}</p>}
            {!options && !error && !receipt.delivery ? <div className="matching-loading"><div className="spinner" /><p>Comparing recent transactions…</p></div> : null}
            {options ? (
              <>
                {!attachmentSent && <>
                {options.existingProposal && (
                  <p className="proposal-existing">A proposal is already saved. Saving below will replace it; FreeAgent remains unchanged.</p>
                )}
                <div className="matching-modes" role="tablist" aria-label="Receipt treatment">
                  <button type="button" role="tab" aria-selected={mode === "transaction"} className={mode === "transaction" ? "active" : ""} onClick={() => setMode("transaction")}>Bank transaction</button>
                  <button type="button" role="tab" aria-selected={mode === "out_of_pocket"} className={mode === "out_of_pocket" ? "active" : ""} onClick={() => { setMode("out_of_pocket"); void loadCategories(); }}>Paid personally or cash</button>
                  <button type="button" role="tab" aria-selected={mode === "unmatched"} className={mode === "unmatched" ? "active" : ""} onClick={() => setMode("unmatched")}>No match yet</button>
                </div>

                {mode === "transaction" && (
                  <div className="match-choice-panel">
                    <div className="matching-section-heading">
                      <div><p className="eyebrow">Best candidates</p><h3>{options.suggestions.length ? "Likely matches" : "No close match found"}</h3></div>
                      {options.lastSyncCompletedAt && <small>Synced {formatDateTime(options.lastSyncCompletedAt)}</small>}
                    </div>
                    {options.suggestions.length ? (
                      <div className="match-candidates">
                        {options.suggestions.map((transaction) => (
                          <TransactionChoice key={transaction.id} transaction={transaction} selected={selectedTransactionId === transaction.id} onSelect={() => setSelectedTransactionId(transaction.id)} />
                        ))}
                      </div>
                    ) : <p className="matching-empty">Try choosing another transaction below, synchronise FreeAgent, or use one of the other treatments.</p>}

                    <button className="choose-another" type="button" onClick={() => setShowAll((current) => !current)}>
                      {showAll ? "Hide other transactions" : "Choose another transaction"}
                    </button>
                    {showAll && (
                      <div className="manual-transactions">
                        <label>Search recent transactions<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Merchant, date, account or amount" /></label>
                        <div className="match-candidates compact">
                          {manualTransactions.slice(0, 60).map((transaction) => (
                            <TransactionChoice key={transaction.id} transaction={transaction} selected={selectedTransactionId === transaction.id} onSelect={() => setSelectedTransactionId(transaction.id)} compact />
                          ))}
                        </div>
                        {!manualTransactions.length && <p className="matching-empty">No recent purchase transactions match that search.</p>}
                      </div>
                    )}
                  </div>
                )}

                {mode === "out_of_pocket" && (
                  <div className="match-choice-panel">
                    <p className="eyebrow">Out-of-pocket expense</p>
                    <h3>Prepare it—don’t send it.</h3>
                    <p className="matching-explanation">Choose the accounting category yourself. Fido and OpenAI will never guess it.</p>
                    {loadingCategories ? <p>Loading current FreeAgent categories…</p> : categories ? (
                      <label className="category-picker">FreeAgent spending category
                        <select value={selectedCategoryUrl} onChange={(event) => setSelectedCategoryUrl(event.target.value)}>
                          {(["Admin expenses", "Cost of sales"] as const).map((group) => (
                            <optgroup key={group} label={group}>
                              {categories.filter((category) => category.group === group).map((category) => (
                                <option key={category.url} value={category.url}>{category.description} · {category.nominalCode}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                    ) : <button className="choose-another" type="button" onClick={() => void loadCategories()}>Load current categories</button>}
                    {selectedCategory && (
                      <dl className="expense-preview">
                        <div><dt>Category</dt><dd>{selectedCategory.description} ({selectedCategory.nominalCode})</dd></div>
                        <div><dt>Date</dt><dd>{formatReceiptDate(receipt.verifiedData.receiptDate)}</dd></div>
                        <div><dt>Original payment</dt><dd>−{formatMoney(receipt.verifiedData.grossTotal, receipt.verifiedData.currency)}</dd></div>
                        {receipt.verifiedData.currency !== "GBP" && <div><dt>Final GBP amount</dt><dd>−{formatMoney(receipt.verifiedData.gbpAmountCharged ?? "", "GBP")}</dd></div>}
                        <div><dt>Description</dt><dd>{receipt.verifiedData.purchaseDescription}</dd></div>
                        <div><dt>VAT treatment</dt><dd>{receipt.verifiedData.currency !== "GBP" ? "No UK VAT" : receipt.verifiedData.vatTotal ? "Confirm in Stage 8" : "No VAT printed"}</dd></div>
                        <div><dt>Attachment</dt><dd>Processed receipt JPEG</dd></div>
                      </dl>
                    )}
                  </div>
                )}

                {mode === "unmatched" && (
                  <div className="match-choice-panel unmatched-panel">
                    <span aria-hidden="true">—</span>
                    <h3>Keep this receipt unmatched.</h3>
                    <p>Use this when the transaction has not arrived yet or you need to investigate it. You can return and replace this choice later.</p>
                  </div>
                )}
                </>}
              </>
            ) : null}
            {error && <p className="message error" role="alert">{error}</p>}
          </section>
        </div>

        <footer className="matching-actions">
          <p>{attachmentSent
            ? <><strong>Attached.</strong> The existing explanation and category were left unchanged.</>
            : <><strong>Separate confirmation.</strong> Saving a proposal does not change FreeAgent.</>}</p>
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>Later</button>
          {!attachmentSent && <button className="primary-button" type="button" onClick={() => void saveProposal()} disabled={!options || saving || (mode === "transaction" && !selectedTransactionId) || (mode === "out_of_pocket" && !selectedCategoryUrl)}>
              {saving ? "Saving…" : mode === "transaction" ? "Save match proposal" : mode === "out_of_pocket" ? "Save expense proposal" : "Keep unmatched"}
            </button>}
        </footer>
      </div>
    </div>
  );
}

function AttachmentPanel({
  preview,
  sending,
  onConfirm,
}: {
  preview: AttachmentPreviewResponse;
  sending: boolean;
  onConfirm(): void;
}) {
  if (preview.state === "sent") {
    return (
      <section className="attachment-panel sent" aria-label="FreeAgent delivery complete">
        <div className="attachment-panel-heading">
          <div><p className="eyebrow">Delivery complete</p><h3>Receipt attached in FreeAgent.</h3></div>
          <span aria-hidden="true">✓</span>
        </div>
        <dl className="attachment-preview-values">
          <div><dt>Explanation</dt><dd>{preview.delivery.target.explanationType}</dd></div>
          <div><dt>Category</dt><dd>{categoryLabel(preview.delivery.target.categoryNominalCode)} · unchanged</dd></div>
          <div><dt>Amount</dt><dd>{formatMoney(String(Math.abs(Number(preview.delivery.target.grossValue))), "GBP")}</dd></div>
          <div><dt>Receipt file</dt><dd>{preview.delivery.attachment.fileName}</dd></div>
          <div><dt>Sent</dt><dd>{preview.delivery.sentAt ? formatDateTime(preview.delivery.sentAt) : "Just now"}</dd></div>
        </dl>
        <p className="attachment-assurance">Fido changed only the attachment on the existing explanation. The category, date, description, amount and VAT treatment were not submitted.</p>
      </section>
    );
  }

  const explanation = preview.explanation;
  return (
    <section className={`attachment-panel ${preview.state}`} aria-label="FreeAgent attachment confirmation">
      <div className="attachment-panel-heading">
        <div>
          <p className="eyebrow">Live FreeAgent check</p>
          <h3>{preview.state === "ready" ? "Ready for your confirmation." : "Attachment blocked safely."}</h3>
        </div>
        <span>{preview.state === "ready" ? "Attachment only" : "No write"}</span>
      </div>
      <dl className="attachment-preview-values">
        <div><dt>Transaction</dt><dd>{preview.transaction.description}</dd></div>
        <div><dt>Bank account</dt><dd>{preview.transaction.bankAccountName}</dd></div>
        <div><dt>Date</dt><dd>{formatReceiptDate(preview.transaction.datedOn)}</dd></div>
        <div><dt>Amount</dt><dd>{formatMoney(String(Math.abs(Number(preview.transaction.amount))), "GBP")}</dd></div>
        <div><dt>Explanation</dt><dd>{explanation?.type ?? "Not available"}</dd></div>
        <div><dt>Category</dt><dd>{categoryLabel(explanation?.categoryNominalCode ?? null)} · unchanged</dd></div>
        <div><dt>Receipt file</dt><dd>{preview.attachment.fileName} · {formatBytes(preview.attachment.fileSize)}</dd></div>
      </dl>
      {preview.blockers.length > 0 && (
        <ul className="attachment-blockers">
          {preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      )}
      <p className="attachment-assurance"><strong>Only the JPEG attachment will be sent.</strong> The existing category, date, description, amount and VAT treatment stay exactly as they are in FreeAgent.</p>
      {preview.state === "ready" && (
        <button className="attachment-confirm-button" type="button" onClick={onConfirm} disabled={sending || !preview.confirmationToken}>
          {sending ? "Attaching receipt…" : preview.reconcileExisting ? "Confirm existing attachment" : "Attach receipt to FreeAgent"}
        </button>
      )}
    </section>
  );
}

function TransactionChoice({ transaction, selected, onSelect, compact = false }: { transaction: RankedTransaction; selected: boolean; onSelect(): void; compact?: boolean }) {
  return (
    <label className={`match-candidate ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}>
      <input type="radio" name="transaction" checked={selected} onChange={onSelect} />
      <span className="candidate-main">
        <strong>{transaction.description || transaction.fullDescription || "Bank transaction"}</strong>
        <small>{transaction.bankAccountName} · {formatReceiptDate(transaction.datedOn)}</small>
        {!compact && <span className="candidate-reasons">{transaction.reasons.map((reason) => <em key={reason}>{reason}</em>)}</span>}
      </span>
      <span className="candidate-value">
        <strong>{formatMoney(String(Math.abs(Number(transaction.amount))), "GBP")}</strong>
        {!compact && <em className={`match-confidence ${transaction.confidence}`}>{transaction.confidence} · {transaction.score}</em>}
      </span>
    </label>
  );
}

function categoryLabel(nominalCode: string | null): string {
  return nominalCode ? `FreeAgent category ${nominalCode}` : "Existing FreeAgent category";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMoney(value: string, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${currency} ${value}`;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
}

function formatReceiptDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function callableMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message;
  return fallback;
}
