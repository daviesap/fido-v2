import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./index";
import type { IngestPayload } from "./protocol";

const ENV = {
  FIDO_INGEST_ENDPOINT: "https://ingest.example.test/receipt",
  FIDO_PUBLIC_RECEIPT_ADDRESS: "receipts@flair.london",
  FIDO_PRIVATE_INGEST_ADDRESS: "private-token@ingest.flair.london",
  FIDO_INGEST_SHARED_SECRET: "test-secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("email worker", () => {
  it("sends an HTML-only receipt to Firebase as a generated PDF", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("{}", { status: 200 });
    }));
    const reject = vi.fn();
    const raw = `From: Customer <customer@example.com>\r
To: receipts@flair.london\r
Subject: Receipt from Middlesbrough FC\r
Message-ID: <html-receipt@example.com>\r
Date: Sat, 1 Aug 2026 14:55:51 +0100\r
MIME-Version: 1.0\r
Content-Type: text/html; charset=utf-8\r
\r
<html><body><h1>Receipt</h1><p>Amount paid: &pound;3.00</p></body></html>`;

    await worker.email(emailMessage(raw, reject), ENV);

    expect(reject).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    const payload = JSON.parse(String(requests[0].body)) as IngestPayload;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("email-receipt.pdf");
    expect(payload.attachments[0].declaredContentType).toBe("application/pdf");
    expect(atob(payload.attachments[0].contentBase64).slice(0, 5)).toBe("%PDF-");
  });

  it("keeps a supported attachment instead of also converting the body", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("{}", { status: 200 });
    }));
    const reject = vi.fn();
    const raw = `From: Customer <customer@example.com>\r
To: receipts@flair.london\r
Subject: Receipt with PDF\r
Message-ID: <pdf-receipt@example.com>\r
Date: Sat, 1 Aug 2026 14:55:51 +0100\r
MIME-Version: 1.0\r
Content-Type: multipart/mixed; boundary="fido-boundary"\r
\r
--fido-boundary\r
Content-Type: text/html; charset=utf-8\r
\r
<p>Amount paid: &pound;3.00</p>\r
--fido-boundary\r
Content-Type: application/pdf; name="receipt.pdf"\r
Content-Disposition: attachment; filename="receipt.pdf"\r
Content-Transfer-Encoding: base64\r
\r
JVBERi0xLjQK\r
--fido-boundary--`;

    await worker.email(emailMessage(raw, reject), ENV);

    expect(reject).not.toHaveBeenCalled();
    const payload = JSON.parse(String(requests[0].body)) as IngestPayload;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("receipt.pdf");
  });
});

function emailMessage(raw: string, setReject: (reason: string) => void): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    from: "customer@example.com",
    to: ENV.FIDO_PRIVATE_INGEST_ADDRESS,
    raw: stream,
    rawSize: bytes.byteLength,
    headers: new Headers({ "message-id": "<envelope@example.com>" }),
    setReject,
    forward: async () => ({ messageId: "unused-forward" }),
    reply: async () => ({ messageId: "unused-reply" }),
  };
}
