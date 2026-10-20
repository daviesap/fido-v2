"use client";

import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import {
  VerifiedReceiptValuesSchema,
  type ReadyForVerificationExtraction,
  type Receipt,
  type VerifiedReceiptValues,
} from "@/lib/receipt";

type ReadyReceipt = (Extract<Receipt, { status: "ready_for_extraction" }> & { extraction: ReadyForVerificationExtraction }) | Extract<Receipt, { status: "verified" }>;

type FormValues = Record<keyof VerifiedReceiptValues, string>;

type ForeignTransactionSuggestion = {
  id: string;
  bankAccountName: string;
  datedOn: string;
  amount: string;
  description: string;
  fullDescription: string;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

type ForeignSuggestionResponse = {
  suggestions: ForeignTransactionSuggestion[];
  lastSyncCompletedAt: string | null;
  writeEnabled: false;
};

export function ReceiptVerification({
  receipt,
  onDraftChange,
  disabled = false,
}: {
  receipt: ReadyReceipt;
  onDraftChange(values: VerifiedReceiptValues | null): void;
  disabled?: boolean;
}) {
  const foreignRequestVersion = useRef(0);
  const result = receipt.extraction.result;
  const initial = receipt.status === "verified" ? receipt.verifiedData : result;
  const [values, setValues] = useState<FormValues>({
    merchantName: initial.merchantName ?? "",
    purchaseDescription: initial.purchaseDescription ?? "",
    receiptDate: initial.receiptDate ?? "",
    currency: initial.currency ?? "",
    grossTotal: initial.grossTotal ?? "",
    netTotal: initial.netTotal ?? "",
    vatTotal: initial.vatTotal ?? "",
    gbpAmountCharged: receipt.status === "verified" ? receipt.verifiedData.gbpAmountCharged ?? "" : "",
  });
  const saving = disabled;
  const [foreignSuggestions, setForeignSuggestions] = useState<ForeignSuggestionResponse | null>(null);
  const [foreignSuggestionError, setForeignSuggestionError] = useState<string | null>(null);
  const [findingForeignTransaction, setFindingForeignTransaction] = useState(false);
  const [selectedForeignTransactionId, setSelectedForeignTransactionId] = useState("");

  function update(field: keyof FormValues, value: string) {
    const invalidatesSuggestion = ["merchantName", "receiptDate", "currency", "grossTotal"].includes(field);
    const clearsSuggestedGbp = invalidatesSuggestion && selectedForeignTransactionId !== "";
    if (invalidatesSuggestion) {
      foreignRequestVersion.current += 1;
      setForeignSuggestions(null);
      setForeignSuggestionError(null);
      setSelectedForeignTransactionId("");
    } else if (field === "gbpAmountCharged") {
      setSelectedForeignTransactionId("");
    }
    setValues((current) => {
      if (field !== "currency") return {
        ...current,
        [field]: value,
        ...(clearsSuggestedGbp ? { gbpAmountCharged: "" } : {}),
      };
      const currency = value.toUpperCase().slice(0, 3);
      return {
        ...current,
        currency,
        netTotal: currency && currency !== "GBP" ? "" : current.netTotal,
        vatTotal: currency && currency !== "GBP" ? "" : current.vatTotal,
        gbpAmountCharged: currency === "GBP" || clearsSuggestedGbp ? "" : current.gbpAmountCharged,
      };
    });
  }

  async function findForeignTransaction() {
    setForeignSuggestionError(null);
    if (!values.merchantName.trim() || !values.receiptDate || !values.currency || !values.grossTotal) {
      setForeignSuggestionError("Complete the merchant, date, currency and gross total first.");
      return;
    }
    const requestVersion = ++foreignRequestVersion.current;
    setFindingForeignTransaction(true);
    try {
      const find = httpsCallable<{
        receiptId: string;
        merchantName: string;
        receiptDate: string;
        currency: string;
        grossTotal: string;
      }, ForeignSuggestionResponse>(functions, "getForeignReceiptMatchOptions");
      const response = await find({
        receiptId: receipt.id,
        merchantName: values.merchantName.trim(),
        receiptDate: values.receiptDate,
        currency: values.currency,
        grossTotal: values.grossTotal,
      });
      if (requestVersion === foreignRequestVersion.current) setForeignSuggestions(response.data);
    } catch (cause) {
      if (requestVersion === foreignRequestVersion.current) setForeignSuggestionError(callableMessage(cause, "Recent transactions could not be checked."));
    } finally {
      setFindingForeignTransaction(false);
    }
  }

  function chooseForeignTransaction(transaction: ForeignTransactionSuggestion) {
    const amount = Math.abs(Number(transaction.amount));
    if (!Number.isFinite(amount) || amount <= 0) return;
    setValues((current) => ({ ...current, gbpAmountCharged: amount.toFixed(2) }));
    setSelectedForeignTransactionId(transaction.id);
    setForeignSuggestionError(null);
  }

  useEffect(() => {
    const parsed = VerifiedReceiptValuesSchema.safeParse({
      ...values,
      netTotal: values.currency === "GBP" ? values.netTotal || null : null,
      vatTotal: values.currency === "GBP" ? values.vatTotal || null : null,
      gbpAmountCharged: values.currency !== "GBP" ? values.gbpAmountCharged || null : null,
    });
    onDraftChange(parsed.success && !totalsConflict(parsed.data) ? parsed.data : null);
  }, [values, onDraftChange]);

  return (
    <fieldset className="verification-form receipt-fields" disabled={disabled}>
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
                <div className="foreign-match-assist">
                  <div>
                    <strong>Find it in FreeAgent</strong>
                    <p>Fido can compare merchant, date and a broad currency range. The bank debit—not an estimated rate—becomes the GBP value.</p>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => void findForeignTransaction()} disabled={findingForeignTransaction || saving}>
                    {findingForeignTransaction ? "Checking…" : "Find GBP transaction"}
                  </button>
                </div>
                {foreignSuggestions && (
                  <div className="foreign-suggestions" aria-live="polite">
                    <div className="foreign-suggestions-heading">
                      <strong>{foreignSuggestions.suggestions.length ? "Likely foreign matches" : "No likely match yet"}</strong>
                      {foreignSuggestions.lastSyncCompletedAt && <small>Synced {formatDateTime(foreignSuggestions.lastSyncCompletedAt)}</small>}
                    </div>
                    {foreignSuggestions.suggestions.length ? (
                      <div className="foreign-suggestion-list">
                        {foreignSuggestions.suggestions.map((transaction) => (
                          <button
                            key={transaction.id}
                            className={selectedForeignTransactionId === transaction.id ? "selected" : ""}
                            type="button"
                            aria-pressed={selectedForeignTransactionId === transaction.id}
                            onClick={() => chooseForeignTransaction(transaction)}
                          >
                            <span>
                              <strong>{transaction.description || transaction.fullDescription || "Bank transaction"}</strong>
                              <small>{transaction.bankAccountName} · {formatReceiptDate(transaction.datedOn)}</small>
                              <em>{transaction.reasons.join(" · ")}</em>
                            </span>
                            <span>
                              <strong>{formatGbpDebit(transaction.amount)}</strong>
                              <em className={`match-confidence ${transaction.confidence}`}>{transaction.confidence} · {transaction.score}</em>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : <p>No recent debit has a strong enough merchant, date and amount combination. Synchronise FreeAgent or enter the bank amount manually.</p>}
                    {selectedForeignTransactionId && <p className="foreign-selection-confirmed">The exact bank debit has been copied into GBP amount charged.</p>}
                  </div>
                )}
                {foreignSuggestionError && <p className="message error" role="alert">{foreignSuggestionError}</p>}
                <p className="foreign-settlement-note">You can always enter the final GBP amount shown by your card or bank yourself.</p>
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
            <p className="extraction-meta">Check the receipt details before sending.</p>
    </fieldset>
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

function formatGbpDebit(value: string): string {
  const amount = Math.abs(Number(value));
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(amount)
    : `GBP ${value}`;
}

function formatReceiptDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function callableMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message;
  return fallback;
}
