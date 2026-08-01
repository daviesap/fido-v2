# Email receipt ingestion setup

Fido keeps `receipts@flair.london` in Google Mail. No MX records on the apex `flair.london` domain need to change.

The ingestion path is:

1. A receipt reaches `receipts@flair.london` in Gmail.
2. A Gmail filter forwards receipt messages to a long, private address on `ingest.flair.london`.
3. Cloudflare Email Routing sends only that private address to the `fido-receipt-email` Worker.
4. The Worker parses attachment MIME parts and applies size limits. If no supported attachment exists, it sanitises an HTML body, embeds bounded `cid:` images, and asks Cloudflare Browser Run to print it to PDF with JavaScript and external network requests disabled. Plain text and rendering failures use a simple text-to-PDF fallback.
5. Firebase verifies the signature and timestamp, validates file magic bytes, rate-limits, deduplicates, and stores each attachment as a `needs_review` receipt.
6. The owner reviews the attachment in Fido using the existing PDF page selection, crop, rotation, and quality workflow.

The Worker never sends raw email bodies or HTML to Firebase. For a body-only receipt, it sends only the generated PDF. Firebase otherwise stores minimal provenance: sender, subject, message ID, and received time.

## 1. Choose the private forwarding address

Create a long random local part and keep the full address private. For example:

```text
fido-REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS@ingest.flair.london
```

This address is an access credential. Do not put it in source control, browser environment variables, screenshots, or the public UI.

## 2. Configure Firebase secrets

Generate one random shared secret of at least 32 bytes. Set the same value in Firebase and Cloudflare; do not save it in a project file.

```bash
npx firebase functions:secrets:set FIDO_INGEST_SHARED_SECRET
npx firebase functions:secrets:set FIDO_EMAIL_CONFIG
```

`FIDO_EMAIL_CONFIG` is a JSON object:

```json
{
  "ownerUid": "YOUR_FIREBASE_OWNER_UID",
  "publicAddress": "receipts@flair.london",
  "allowedSenders": [],
  "dailyMessageLimit": 30
}
```

An empty `allowedSenders` list accepts any sender reaching the private forwarding alias. To restrict submission, add exact lower-case email addresses. The private alias, Cloudflare-to-Firebase HMAC, timestamp window, and original-recipient check still apply either way.

Deploy the backend and its rules:

```bash
npx firebase deploy --only functions:receiveReceiptEmail,firestore:rules,storage
```

The configured endpoint is:

```text
https://europe-west1-fido-ceb0e.cloudfunctions.net/receiveReceiptEmail
```

## 3. Configure the Cloudflare Email Worker

In Cloudflare Email Service, enable Email Routing only for the `ingest.flair.london` subdomain. Cloudflare supports routing subdomains independently, so the Google Mail MX records for `flair.london` remain untouched.

Set the two Worker secrets from the `email-worker` directory:

```bash
npx wrangler secret put FIDO_PRIVATE_INGEST_ADDRESS
npx wrangler secret put FIDO_INGEST_SHARED_SECRET
```

- `FIDO_PRIVATE_INGEST_ADDRESS`: the private address chosen in step 1.
- `FIDO_INGEST_SHARED_SECRET`: the exact value stored in the Firebase secret.

Deploy the Worker:

```bash
npm run deploy
```

The checked-in Worker configuration binds Cloudflare Browser Run as `BROWSER`. Browser Run is used only for attachment-free HTML receipts; supported PDF and image attachments continue through the existing ingestion path. If Browser Run is unavailable, times out, returns the wrong content type, or produces an oversized file, Fido falls back to its bounded plain-text PDF rather than rejecting a readable receipt.

In **Cloudflare → Email Service → Email Routing → ingest.flair.london**, create an exact routing rule for the private address and choose **Send to a Worker → fido-receipt-email**. Do not enable a catch-all rule.

## 4. Configure Gmail forwarding

Gmail requires confirmation before it will forward to a new address. Temporarily route the private Cloudflare address to a verified mailbox you control, then:

1. Open the Gmail settings for `receipts@flair.london`.
2. Under **Forwarding and POP/IMAP**, add the private `@ingest.flair.london` address.
3. Open and confirm Google's verification message in the temporary destination mailbox.
4. Change the Cloudflare rule for the private address from the temporary mailbox to `fido-receipt-email`.
5. In Gmail, create a filter matching `to:receipts@flair.london`.
6. Select **Forward it to** the private address and keep Gmail's copy.

Only new matching messages are forwarded by Gmail filters. Existing receipts can be forwarded manually after setup.

## 5. Test the complete path

1. Send a message with one small PDF or supported image attachment to `receipts@flair.london` from another account.
2. Confirm the message remains visible in Gmail.
3. Check Cloudflare Worker logs for a successful Firebase response.
4. Open Fido and confirm the attachment appears as **Needs review**.
5. Review it, save the processed image, and compare the processed version with the original.
6. Forward the same message again and confirm Fido does not create a duplicate.
7. Send an HTML-only receipt with no attachment and confirm that it appears as an `email-receipt.pdf` item with its table/layout and any embedded receipt images intact.
8. Confirm that remote tracking images are absent from the PDF and that a temporary Browser Run failure still produces a readable plain-text PDF.

## Limits and rejection behaviour

- Supported attachments: PDF, JPEG, PNG, WebP, HEIC, and HEIF.
- Maximum raw email size: 25 MiB (Cloudflare's inbound message limit, including MIME/base64 overhead).
- Maximum individual emailed attachment: 17 MiB.
- Maximum supported attachments per email: 10.
- Maximum combined supported attachment size: 17 MiB. Direct site uploads remain limited to 20 MB.
- For an attachment-free HTML receipt, inline JPEG, PNG, GIF, and WebP images referenced by `cid:` may be embedded in the generated PDF. Each image is limited to 2 MiB and all embedded images together are limited to 5 MiB. Unreferenced images, unsupported image types, and images beyond those limits are ignored.
- HTML rendering is limited to 500,000 source characters. The Worker allowlists display-oriented HTML and attributes, removes active and embedded content, sanitises CSS, applies a restrictive Content Security Policy, disables JavaScript, and blocks external requests. Remote images, fonts, links, tracking pixels, forms, frames, media, and scripts are therefore not fetched or activated.
- Plain-text fallback conversion is limited to 100,000 characters. Supported attachments take precedence, so an email cannot create both attachment receipts and a body receipt.
- File types are determined from magic bytes at Firebase, not trusted extensions or MIME headers.
- Password-protected PDFs reach the review queue but the browser will ask for an unlocked copy when review is attempted.
- Raw email bodies, HTML, and unrelated headers are not sent to or stored by Firebase. Only the generated PDF is sent through the existing attachment ingestion path.

Official setup references: [Cloudflare subdomain routing](https://developers.cloudflare.com/email-service/configuration/subdomains/), [Cloudflare Email Workers](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/), [Cloudflare Browser Run PDF rendering](https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/), [Cloudflare Browser Run pricing and limits](https://developers.cloudflare.com/browser-run/pricing/), and [Gmail forwarding](https://support.google.com/mail/answer/10957).
