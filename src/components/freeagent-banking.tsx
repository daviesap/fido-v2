"use client";

import { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

type BankAccount = {
  id: string;
  url: string;
  name: string;
  type: string;
  currency: string;
  isPersonal: boolean;
  status: "active" | "hidden";
};

type BankTransaction = {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  currency: "GBP";
  datedOn: string;
  amount: string;
  description: string;
  fullDescription: string;
  unexplainedAmount: string;
  updatedAt: string;
};

type BankingState = {
  accounts: BankAccount[];
  selectedAccountIds: string[];
  sync: {
    status: "ready" | "failed";
    windowDays: number;
    fromDate: string | null;
    toDate: string | null;
    lastCompletedAt: string | null;
    transactionCount: number;
  };
  transactions: BankTransaction[];
  outOfPocket: {
    supported: true;
    writeEnabled: false;
    message: string;
  };
};

type BusyAction = "load" | "save" | "sync";

export function FreeAgentBanking() {
  const [banking, setBanking] = useState<BankingState | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<BusyAction | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState("all");
  const [explanationFilter, setExplanationFilter] = useState<"all" | "unexplained" | "explained">("all");
  const [dayFilter, setDayFilter] = useState<7 | 30 | 90>(90);
  const [minimumAmount, setMinimumAmount] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const load = httpsCallable<void, BankingState>(functions, "getFreeAgentBanking");
    void load()
      .then((response) => {
        setBanking(response.data);
        setSelectedIds(response.data.selectedAccountIds);
        if (!response.data.selectedAccountIds.length) setExpanded(true);
      })
      .catch((cause) => setError(callableMessage(cause, "FreeAgent banking could not be loaded.")))
      .finally(() => setBusy(null));
  }, []);

  const filteredTransactions = useMemo(() => {
    const earliest = new Date();
    earliest.setHours(0, 0, 0, 0);
    earliest.setDate(earliest.getDate() - (dayFilter - 1));
    const earliestDate = localIsoDate(earliest);
    const minimum = minimumAmount === "" ? null : Number(minimumAmount);
    return (banking?.transactions ?? []).filter((transaction) => {
      if (accountFilter !== "all" && transaction.bankAccountId !== accountFilter) return false;
      const unexplained = Number(transaction.unexplainedAmount) !== 0;
      if (explanationFilter === "unexplained" && !unexplained) return false;
      if (explanationFilter === "explained" && unexplained) return false;
      if (transaction.datedOn < earliestDate) return false;
      return minimum === null || !Number.isFinite(minimum) || Math.abs(Number(transaction.amount)) >= minimum;
    });
  }, [accountFilter, banking, dayFilter, explanationFilter, minimumAmount]);

  async function saveSelection() {
    if (!selectedIds.length) {
      setError("Select at least one active GBP account.");
      return;
    }
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      const save = httpsCallable<{ accountIds: string[] }, BankingState>(functions, "saveFreeAgentBankAccounts");
      const response = await save({ accountIds: selectedIds });
      setBanking(response.data);
      setSelectedIds(response.data.selectedAccountIds);
      setMessage("Participating accounts saved. Synchronise when you are ready.");
    } catch (cause) {
      setError(callableMessage(cause, "The account selection could not be saved."));
    } finally {
      setBusy(null);
    }
  }

  async function syncTransactions() {
    setBusy("sync");
    setError(null);
    setMessage(null);
    try {
      const sync = httpsCallable<void, BankingState>(functions, "syncFreeAgentTransactions");
      const response = await sync();
      setBanking(response.data);
      setSelectedIds(response.data.selectedAccountIds);
      setMessage(`${response.data.transactions.length} recent transaction${response.data.transactions.length === 1 ? "" : "s"} synchronised.`);
    } catch (cause) {
      setError(callableMessage(cause, "FreeAgent transactions could not be synchronised."));
    } finally {
      setBusy(null);
    }
  }

  function toggleAccount(accountId: string) {
    setSelectedIds((current) => current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId]);
  }

  if (busy === "load") return <p className="freeagent-banking-loading">Loading bank accounts…</p>;
  if (!banking) return <p className="message error" role="alert">{error ?? "FreeAgent banking could not be loaded."}</p>;

  const selectableAccounts = banking.accounts.filter((account) => account.status === "active" && account.currency === "GBP");
  const excludedAccounts = banking.accounts.filter((account) => account.status !== "active" || account.currency !== "GBP");

  if (!expanded) {
    return (
      <div className="freeagent-banking compact">
        <div className="banking-summary">
          <div>
            <p className="eyebrow">Bank transactions</p>
            <h3>{banking.transactions.length} recent transaction{banking.transactions.length === 1 ? "" : "s"} ready</h3>
            <p>{banking.selectedAccountIds.length} participating account{banking.selectedAccountIds.length === 1 ? "" : "s"} · {banking.sync.lastCompletedAt ? `Synced ${formatDateTime(banking.sync.lastCompletedAt)}` : "Not synchronised yet"}</p>
          </div>
          <div className="banking-summary-actions">
            <button className="secondary-button" type="button" onClick={() => void syncTransactions()} disabled={busy !== null || !banking.selectedAccountIds.length}>
              {busy === "sync" ? "Synchronising…" : "Sync now"}
            </button>
            <button className="primary-button" type="button" onClick={() => setExpanded(true)}>View &amp; manage</button>
          </div>
        </div>
        {message && <p className="message">{message}</p>}
        {error && <p className="message error" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="freeagent-banking">
      <div className="freeagent-banking-heading">
        <div>
          <p className="eyebrow">Stage six · read only</p>
          <h3>Choose where Fido should look.</h3>
          <p>Only the selected GBP accounts are cached. Account numbers and balances are never retained.</p>
        </div>
        <div className="freeagent-banking-heading-actions">
          <span className="connection-pill connected">90 days</span>
          {banking.selectedAccountIds.length ? <button className="text-button" type="button" onClick={() => setExpanded(false)}>Collapse</button> : null}
        </div>
      </div>

      <fieldset className="bank-account-picker" disabled={busy !== null}>
        <legend className="visually-hidden">Participating FreeAgent accounts</legend>
        {selectableAccounts.map((account) => (
          <label key={account.id} className={selectedIds.includes(account.id) ? "selected" : ""}>
            <input
              type="checkbox"
              checked={selectedIds.includes(account.id)}
              onChange={() => toggleAccount(account.id)}
            />
            <span><strong>{account.name}</strong><small>{accountTypeLabel(account.type)}{account.isPersonal ? " · Personal" : ""}</small></span>
            <b>{account.currency}</b>
          </label>
        ))}
      </fieldset>

      {excludedAccounts.length ? (
        <p className="bank-account-note">{excludedAccounts.length} hidden or non-GBP account{excludedAccounts.length === 1 ? " is" : "s are"} excluded.</p>
      ) : null}

      <div className="banking-actions">
        <span>{banking.sync.lastCompletedAt ? `Last synced ${formatDateTime(banking.sync.lastCompletedAt)}` : "Not synchronised yet"}</span>
        <button className="secondary-button" type="button" onClick={() => void saveSelection()} disabled={busy !== null || !selectedIds.length}>
          {busy === "save" ? "Saving…" : "Save accounts"}
        </button>
        <button className="primary-button" type="button" onClick={() => void syncTransactions()} disabled={busy !== null || !banking.selectedAccountIds.length}>
          {busy === "sync" ? "Synchronising…" : "Sync transactions"}
        </button>
      </div>

      {message && <p className="message">{message}</p>}
      {error && <p className="message error" role="alert">{error}</p>}

      {banking.selectedAccountIds.length ? (
        <section className="transaction-browser">
          <div className="transaction-browser-heading">
            <div><p className="eyebrow">Recent activity</p><h3>FreeAgent transactions</h3></div>
            <span className="count">{filteredTransactions.length}</span>
          </div>
          <div className="transaction-filters" aria-label="Filter FreeAgent transactions">
            <label>Account<select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
              <option value="all">All selected</option>
              {banking.accounts.filter((account) => banking.selectedAccountIds.includes(account.id)).map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </select></label>
            <label>Status<select value={explanationFilter} onChange={(event) => setExplanationFilter(event.target.value as typeof explanationFilter)}>
              <option value="all">All</option><option value="unexplained">Unexplained</option><option value="explained">Explained</option>
            </select></label>
            <label>Period<select value={dayFilter} onChange={(event) => setDayFilter(Number(event.target.value) as 7 | 30 | 90)}>
              <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
            </select></label>
            <label>Minimum £<input type="number" min="0" step="0.01" inputMode="decimal" value={minimumAmount} onChange={(event) => setMinimumAmount(event.target.value)} placeholder="0.00" /></label>
          </div>

          {filteredTransactions.length ? (
            <div className="transaction-list">
              {filteredTransactions.map((transaction) => {
                const unexplained = Number(transaction.unexplainedAmount) !== 0;
                return (
                  <article key={`${transaction.bankAccountId}-${transaction.id}`}>
                    <div><strong>{transaction.description || transaction.fullDescription || "Bank transaction"}</strong><small>{transaction.bankAccountName} · {formatReceiptDate(transaction.datedOn)}</small></div>
                    <div className="transaction-amount"><strong>{formatGbp(transaction.amount)}</strong><span className={`transaction-status ${unexplained ? "unexplained" : ""}`}>{unexplained ? "Unexplained" : "Explained"}</span></div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="transaction-empty">No transactions match these filters. Synchronise again after new activity reaches FreeAgent.</p>
          )}
        </section>
      ) : null}

      <aside className="out-of-pocket-note">
        <span aria-hidden="true">↗</span>
        <div><strong>No matching bank transaction?</strong><p>Choose <b>Paid personally or cash</b> during matching. Fido will ask you for the FreeAgent category and show the complete out-of-pocket Expense before anything is sent.</p></div>
        <em>Stage 8 write</em>
      </aside>
    </div>
  );
}

function accountTypeLabel(value: string): string {
  if (value === "CreditCardAccount") return "Credit card";
  if (value === "StandardBankAccount") return "Bank account";
  if (value === "EcommerceAccount") return "E-commerce";
  return "FreeAgent account";
}

function formatGbp(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `GBP ${value}`;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(amount);
}

function formatReceiptDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function localIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function callableMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message;
  return fallback;
}
