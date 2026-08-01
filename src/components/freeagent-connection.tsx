"use client";

import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

type FreeAgentConnection = {
  connected: true;
  environment: "production";
  profile: {
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    permissionLevel: number;
  };
  company: {
    name: string;
    subdomain: string;
    currency: string;
    type: string;
  };
  connectedAt: string | null;
  lastVerifiedAt: string | null;
};

type ConnectionStatus = FreeAgentConnection | { connected: false };

export function FreeAgentConnectionCard() {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "verify" | "disconnect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const result = params.get("freeagent");
    const feedbackTimer = result ? window.setTimeout(() => {
      if (result === "connected") setMessage("FreeAgent connected successfully.");
      if (result === "error") setError("FreeAgent could not be connected. Please try again.");
    }, 0) : null;
    if (result) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("freeagent");
      cleanUrl.searchParams.delete("reason");
      window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }

    const getConnection = httpsCallable<void, ConnectionStatus>(functions, "getFreeAgentConnection");
    void getConnection()
      .then((response) => setConnection(response.data))
      .catch((cause) => setError(callableMessage(cause, "FreeAgent status could not be loaded.")));
    return () => {
      if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
    };
  }, []);

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const start = httpsCallable<void, { authorizationUrl: string }>(functions, "startFreeAgentOAuth");
      const response = await start();
      window.location.assign(response.data.authorizationUrl);
    } catch (cause) {
      setError(callableMessage(cause, "FreeAgent authorisation could not be started."));
      setBusy(null);
    }
  }

  async function verify() {
    setBusy("verify");
    setError(null);
    setMessage(null);
    try {
      const check = httpsCallable<void, FreeAgentConnection>(functions, "verifyFreeAgentConnection");
      const response = await check();
      setConnection(response.data);
      setMessage("The live FreeAgent connection is working.");
    } catch (cause) {
      setError(callableMessage(cause, "FreeAgent could not be reached. Reconnect if this continues."));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect FreeAgent? Fido will delete its stored access and refresh tokens.")) return;
    setBusy("disconnect");
    setError(null);
    setMessage(null);
    try {
      const remove = httpsCallable<void, { connected: false }>(functions, "disconnectFreeAgent");
      await remove();
      setConnection({ connected: false });
      setMessage("FreeAgent disconnected. No accounting data was changed.");
    } catch (cause) {
      setError(callableMessage(cause, "FreeAgent could not be disconnected."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`freeagent-card ${connection?.connected ? "connected" : ""}`}>
      <div className="freeagent-heading">
        <div>
          <p className="eyebrow">Live FreeAgent</p>
          <h2>{connection?.connected ? connection.company.name : "Connect your accounts."}</h2>
          <p>{connection?.connected
            ? `${connection.profile.firstName} ${connection.profile.lastName} · ${connection.company.currency} company`
            : "Authorise Fido securely. Stages 5 and 6 use read-only API requests; no accounting records will be changed."}</p>
        </div>
        <span className={`connection-pill ${connection?.connected ? "connected" : ""}`}>
          {connection === null ? "Checking" : connection.connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {connection?.connected ? (
        <dl className="freeagent-details">
          <div><dt>Account</dt><dd>{connection.profile.email}</dd></div>
          <div><dt>Company</dt><dd>{connection.company.subdomain}.freeagent.com</dd></div>
          <div><dt>Last checked</dt><dd>{formatCheckedAt(connection.lastVerifiedAt)}</dd></div>
        </dl>
      ) : null}

      {message && <p className="message">{message}</p>}
      {error && <p className="message error" role="alert">{error}</p>}

      <div className="freeagent-actions">
        {connection?.connected ? (
          <>
            <button className="secondary-button" type="button" onClick={() => void verify()} disabled={busy !== null}>
              {busy === "verify" ? "Checking…" : "Check connection"}
            </button>
            <button className="secondary-button" type="button" onClick={() => void connect()} disabled={busy !== null}>
              {busy === "connect" ? "Opening…" : "Reconnect"}
            </button>
            <button className="delete-button" type="button" onClick={() => void disconnect()} disabled={busy !== null}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        ) : (
          <button className="primary-button" type="button" onClick={() => void connect()} disabled={connection === null || busy !== null}>
            {busy === "connect" ? "Opening FreeAgent…" : "Connect live FreeAgent"}
          </button>
        )}
      </div>
    </section>
  );
}

function formatCheckedAt(value: string | null): string {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function callableMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message;
  }
  return fallback;
}
