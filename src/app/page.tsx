"use client";

import { useAuth } from "@/components/auth-provider";
import { ReceiptApp } from "@/components/receipt-app";

export default function HomePage() {
  const { user, loading, error, signIn } = useAuth();
  if (loading) return <main className="center"><div className="spinner" aria-label="Loading" /></main>;
  if (!user) {
    return (
      <main className="login-page">
        <section className="login-card">
          <span className="brand-mark large">F</span>
          <p className="eyebrow">Private receipt review</p>
          <h1>Keep the receipt.<br />Lose the clutter.</h1>
          <p>Fido helps you crop and check receipt photos, then stores the untouched original and clean processing copy in your own Firebase project.</p>
          {error && <p className="message error">{error}</p>}
          <button className="login-button" onClick={() => void signIn()}>Continue with Google</button>
          <small>Only the Firebase account marked as Fido’s owner is accepted.</small>
        </section>
      </main>
    );
  }
  return <ReceiptApp />;
}
