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

    const browserPdf = new TextEncoder().encode("%PDF-browser-rendered");
    const quickAction = vi.fn(async () => new Response(browserPdf, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    await worker.email(emailMessage(raw, reject), {
      ...ENV,
      BROWSER: { quickAction } as unknown as BrowserRun,
    });

    expect(reject).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    const payload = JSON.parse(String(requests[0].body)) as IngestPayload;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("email-receipt.pdf");
    expect(payload.attachments[0].declaredContentType).toBe("application/pdf");
    expect(atob(payload.attachments[0].contentBase64)).toBe("%PDF-browser-rendered");
    expect(quickAction).toHaveBeenCalledWith("pdf", expect.objectContaining({
      html: expect.stringContaining("<h1>Receipt</h1>"),
      setJavaScriptEnabled: false,
      cacheTTL: 0,
    }));
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

  it("embeds a related CID image without exposing it as another receipt", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("{}", { status: 200 });
    }));
    const quickAction = vi.fn(async (_action: string, options: { html: string }) => {
      expect(options.html).toContain("src=\"data:image/png;base64,iVBORw0KGgo=\"");
      expect(options.html).toContain("Content-Security-Policy");
      return new Response(new TextEncoder().encode("%PDF-rendered-with-logo"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    });
    const reject = vi.fn();
    const raw = `From: Airline <ticket@example.com>\r
To: receipts@flair.london\r
Subject: Flight receipt\r
Message-ID: <cid-receipt@example.com>\r
Date: Sat, 1 Aug 2026 14:55:51 +0100\r
MIME-Version: 1.0\r
Content-Type: multipart/related; boundary="related-boundary"\r
\r
--related-boundary\r
Content-Type: text/html; charset=utf-8\r
\r
<html><body><img src="cid:logo@receipt"><table><tr><td>Total</td><td>$119.91</td></tr></table></body></html>\r
--related-boundary\r
Content-Type: image/png\r
Content-Disposition: inline\r
Content-ID: <logo@receipt>\r
Content-Transfer-Encoding: base64\r
\r
iVBORw0KGgo=\r
--related-boundary--`;

    await worker.email(emailMessage(raw, reject), {
      ...ENV,
      BROWSER: { quickAction } as unknown as BrowserRun,
    });

    expect(reject).not.toHaveBeenCalled();
    expect(quickAction).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(requests[0].body)) as IngestPayload;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("email-receipt.pdf");
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
