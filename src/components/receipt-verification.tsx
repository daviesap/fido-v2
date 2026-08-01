"use client";

import { useEffect, useState } from "react";
import { getBlob, ref } from "firebase/storage";
import { storage } from "@/lib/firebase";
import {
  VerifiedReceiptValuesSchema,
  type ReadyForVerificationExtraction,
  type Receipt,
  type VerifiedReceiptValues,
} from "@/lib/receipt";

type ReadyReceipt = Extract<Receipt, { status: "ready_for_extraction" }> & {
  extraction: ReadyForVerificationExtraction;
};

type FormValues = Record<keyof VerifiedReceiptValues, string>;

export function ReceiptVerification({
  receipt,
  onCancel,
  onVerify,
}: {
  receipt: ReadyReceipt;
  onCancel(): void;
  onVerify(values: VerifiedReceiptValues): Promise<void>;
}) {
  const result = receipt.extraction.result;
  const [values, setValues] = useState<FormValues>({
    merchantName: result.merchantName ?? "",
    purchaseDescription: result.purchaseDescription ?? "",
    receiptDate: result.receiptDate ?? "",
    currency: result.currency ?? "",
    grossTotal: result.grossTotal ?? "",
    netTotal: result.netTotal ?? "",
    vatTotal: result.vatTotal ?? "",
    gbpAmountCharged: "",
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void getBlob(ref(storage, receipt.processedStoragePath))
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (active) setImageFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [receipt.processedStoragePath]);

  function update(field: keyof FormValues, value: string) {
    setValues((current) => {
      if (field !== "currency") return { ...current, [field]: value };
      const currency = value.toUpperCase().slice(0, 3);
      return {
        ...current,
        currency,
        netTotal: currency && currency !== "GBP" ? "" : current.netTotal,
        vatTotal: currency && currency !== "GBP" ? "" : current.vatTotal,
        gbpAmountCharged: currency === "GBP" ? "" : current.gbpAmountCharged,
      };
    });
  }

  async function submit() {
    setError(null);
    const parsed = VerifiedReceiptValuesSchema.safeParse({
      merchantName: values.merchantName,
      purchaseDescription: values.purchaseDescription,
      receiptDate: values.receiptDate,
      currency: values.currency,
      grossTotal: values.grossTotal,
      netTotal: values.currency === "GBP" ? values.netTotal || null : null,
      vatTotal: values.currency === "GBP" ? values.vatTotal || null : null,
      gbpAmountCharged: values.currency !== "GBP" ? values.gbpAmountCharged || null : null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the receipt values.");
      return;
    }
    if (totalsConflict(parsed.data)) {
      setError("Net plus VAT must match the gross total to within one penny. Correct the values or leave net and VAT blank.");
      return;
    }
    setSaving(true);
    try {
      await onVerify(parsed.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The verified values could not be saved.");
      setSaving(false);
    }
  }

  return (
    <div className="verification-backdrop" role="dialog" aria-modal="true" aria-label={`Verify ${receipt.originalFileName}`}>
      <div className="verification-dialog">
        <header className="review-header">
          <div>
            <p className="eyebrow">Ready to verify</p>
            <h2>Check the values, not every word.</h2>
            <p>{receipt.originalFileName}</p>
          </div>
          <button className="text-button" type="button" onClick={onCancel} disabled={saving}>Close</button>
        </header>

        <div className="verification-workspace">
          <div className="verification-image">
            {imageUrl ? (
              // The private image is loaded through the authenticated Firebase SDK.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt={`Processed ${receipt.originalFileName}`} />
            ) : <span>{imageFailed ? "Preview unavailable" : "Loading receipt…"}</span>}
          </div>

          <form className="verification-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <p className="eyebrow">Receipt totals</p>
            <VerificationField
              label="Merchant"
              value={values.merchantName}
              uncertain={isUncertain(result.confidence.merchantName)}
              onChange={(value) => update("merchantName", value)}
              autoComplete="organization"
            />
            <VerificationField
              label="Purchase description"
              value={values.purchaseDescription}
              uncertain={isUncertain(result.confidence.purchaseDescription ?? "not_present")}
              onChange={(value) => update("purchaseDescription", value)}
              placeholder="Speaker stands"
              maxLength={80}
            />
            <div className="verification-row">
              <VerificationField
                label="Receipt date"
                type="date"
                value={values.receiptDate}
                uncertain={isUncertain(result.confidence.receiptDate)}
                onChange={(value) => update("receiptDate", value)}
              />
              <VerificationField
                label="Currency"
                value={values.currency}
                uncertain={isUncertain(result.confidence.currency)}
                onChange={(value) => update("currency", value)}
                inputMode="text"
                placeholder="GBP"
              />
            </div>
            <VerificationField
              label="Gross total"
              value={values.grossTotal}
              uncertain={isUncertain(result.confidence.grossTotal)}
              onChange={(value) => update("grossTotal", value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            {values.currency && values.currency !== "GBP" ? (
              <>
                <VerificationField
                  label="GBP amount charged"
                  value={values.gbpAmountCharged}
                  uncertain={false}
                  onChange={(value) => update("gbpAmountCharged", value)}
                  inputMode="decimal"
                  placeholder="0.00"
                />
                <p className="foreign-settlement-note">Enter the final GBP amount shown by your card or bank. Fido never estimates exchange rates.</p>
              </>
            ) : (
              <div className="verification-row">
                <VerificationField
                  label="Net total (if printed)"
                  value={values.netTotal}
                  uncertain={isUncertain(result.confidence.netTotal)}
                  onChange={(value) => update("netTotal", value)}
                  inputMode="decimal"
                  placeholder="Optional"
                />
                <VerificationField
                  label="VAT total (UK only)"
                  value={values.vatTotal}
                  uncertain={isUncertain(result.confidence.vatTotal)}
                  onChange={(value) => update("vatTotal", value)}
                  inputMode="decimal"
                  placeholder="Optional"
                />
              </div>
            )}

            {result.warnings.length > 0 && (
              <div className="extraction-warnings">
                <strong>Worth checking</strong>
                <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}
            {error && <p className="message error" role="alert">{error}</p>}
            <p className="extraction-meta">Extracted with {receipt.extraction.model}. No line-item data is retained.</p>
            <div className="verification-actions">
              <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>Later</button>
              <button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving…" : "Verify & next"}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function VerificationField({
  label,
  value,
  uncertain,
  onChange,
  ...inputProps
}: {
  label: string;
  value: string;
  uncertain: boolean;
  onChange(value: string): void;
} & Pick<React.InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "placeholder" | "autoComplete" | "maxLength">) {
  return (
    <label className={`verification-field ${uncertain ? "uncertain" : ""}`}>
      <span>{label}{uncertain && <em>Check</em>}</span>
      <input {...inputProps} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function isUncertain(confidence: "high" | "medium" | "low" | "not_present") {
  return confidence === "low" || confidence === "not_present";
}

function totalsConflict(values: VerifiedReceiptValues): boolean {
  if (!values.netTotal || !values.vatTotal) return false;
  const difference = toMinorUnits(values.netTotal) + toMinorUnits(values.vatTotal) - toMinorUnits(values.grossTotal);
  return difference < -1n || difference > 1n;
}

function toMinorUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
