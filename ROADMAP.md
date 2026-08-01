# Fido Receipt Manager roadmap

Fido's goal is to turn a photographed or emailed receipt into a reviewed, trustworthy match against a real FreeAgent bank transaction.

The roadmap is deliberately incremental. Each stage should leave the app usable, testable, and safe to deploy before the next integration is added. In particular, no match should change accounting data until the user has reviewed it.

## Status at a glance

| Stage | Outcome | Status |
| --- | --- | --- |
| 1 | Upload and privately store a receipt | Complete |
| 2 | Crop, rotate, and improve the receipt image | Complete |
| 3 | Email receipts into Fido | Complete |
| 4 | Extract structured receipt data with OpenAI | In progress |
| 5 | Connect a live FreeAgent account securely | Planned |
| 6 | Import and display FreeAgent bank transactions | Planned |
| 7 | Suggest transaction-to-receipt matches | Planned |
| 8 | Confirm matches and send receipts to FreeAgent | Planned |
| 9 | Harden, monitor, and prepare for regular use | Planned |

---

## Stage 1 — Upload and privately store a receipt

**Goal:** provide a small, secure foundation for capturing receipt images.

### Delivered

- Google sign-in restricted by the `fidoOwner` Firebase custom claim.
- Camera capture and file selection for PDF, JPEG, PNG, WebP, HEIC, and HEIF receipts.
- Client-side type and 20 MB size validation.
- Private originals in Firebase Storage, with metadata in Firestore.
- Receipt gallery, authenticated previews, and deletion.
- Firestore and Storage security rules with emulator tests.
- Installable static Next.js PWA deployed through Firebase Hosting.

### Follow-up before Stage 2

- Verify the production CORS, App Check, backup, and billing-alert configuration.
- Add an upload retry/recovery path for an image uploaded without its Firestore document.
- Record an explicit data-retention policy before storing extracted financial data.

### Definition of done

A permitted user can upload, view, and delete a receipt, while another or unauthenticated user cannot read or change it.

---

## Stage 2 — Crop, rotate, and improve the receipt image

**Goal:** create a clean, readable image before extraction without destroying the original.

### Scope

- Show a review screen immediately after capture.
- Render PDF receipts locally and allow page selection for multi-page files.
- Correct EXIF orientation and support manual 90-degree rotation.
- Offer conservative automatic receipt-bound detection with draggable crop handles as a fallback.
- Apply a standard crop, bounded output scaling, and conservative contrast/brightness improvements.
- Warn about blur, glare, very low resolution, or a receipt cut off by the frame.
- Let the user retake, keep the original, or approve the processed version.
- Store the processed image as a derived asset; always retain the immutable original.
- Record processing metadata such as source image, crop coordinates, dimensions, and processing version.

The shipped detector intentionally falls back to a near-full-image crop when the background is too similar to the paper. Four-corner perspective correction can be added later for skewed captures without changing the stored processing contract; it is not required for the Stage 2 definition of done.

### Suggested data changes

- Expand receipt status from only `stored` into a state machine such as `stored`, `processing`, `ready_for_extraction`, `failed`, and `deleted`.
- Add a derived image path and processing metadata to the receipt document.
- Make every processing operation idempotent so retries do not create duplicate assets.

### Definition of done

The user can approve a legible, correctly oriented receipt image, and both the untouched original and reproducible processing metadata remain available.

---

## Stage 3 — Email receipts into Fido

**Goal:** let the owner forward receipts to a private Fido email address and review them in the same inbox as camera uploads.

### Architecture first

`receipts@flair.london` remains hosted by Google Mail. A Gmail attachment filter forwards to a private address on the isolated `ingest.flair.london` subdomain, where a Cloudflare Email Worker parses attachments and sends an HMAC-signed payload to a Firebase HTTPS Function. This keeps the existing Google Mail MX records untouched and keeps the private forwarding address and shared secret out of the browser.

### Implemented

- Cloudflare Email Worker with MIME parsing, inline-image filtering, attachment/count/size limits, and exact-recipient checks.
- HMAC-SHA256 payload signing with a timestamp and nonce.
- Firebase HTTPS Function with signature verification, strict payload parsing, byte-level file detection, rate limiting, deterministic deduplication, and private original storage.
- `needs_review` receipt state with immutable email provenance and owner-only review transition rules.
- In-app email instructions, queue badges, PDF/image review, and removal.
- Separate Firebase and Cloudflare secret configuration with no committed credentials.
- Setup and end-to-end test instructions in `docs/EMAIL_INGESTION.md`.
- Production deployment using Gmail, Cloudflare Email Routing on the isolated `ingest.flair.london` subdomain, a Cloudflare Email Worker, and a Firebase HTTPS Function.
- End-to-end production verification: a PDF sent to `receipts@flair.london` was ingested exactly once, stored privately, shown as **Needs review**, and successfully opened in the review flow.

### Operational follow-ups

These are useful hardening improvements rather than blockers for the working single-owner flow, and can be completed as part of Stage 9:

- Add an in-app delivery activity/failure view and a retry or dead-letter recovery path.
- Add optional sender allowlist management and private-address rotation controls.
- Add abuse alerts and a minimal acknowledgement or rejection email.
- Test multiple attachments and common image formats against production routing in addition to the verified PDF path.

### Scope

- Create a private, revocable receipt address, preferably with a long random token rather than an easily guessed mailbox name.
- Let the owner manage an allowlist of sender addresses and rotate or disable the receipt address.
- Verify the inbound provider's webhook signature and reject replayed or expired events.
- Check available SPF, DKIM, and DMARC results, while treating the secret receipt address—not the visible sender alone—as the primary access control.
- Accept supported image attachments and PDF receipts with explicit limits on attachment count, per-file size, and total message size.
- Validate attachment content from its bytes rather than trusting its filename or declared MIME type.
- Treat attachments and HTML as untrusted input; isolate PDF/image conversion and never execute scripts, macros, or remote content.
- Create one receipt record per valid attachment and send it through the existing immutable-original, processing, quality-check, and review pipeline.
- Place emailed receipts in a **Needs review** queue so cropping, page selection, and quality warnings can be checked before extraction.
- Handle multiple attachments predictably and let the user group or discard non-receipt attachments such as logos and email signatures.
- Deduplicate deliveries using the provider event ID, email `Message-ID`, and attachment content hash.
- Record minimal provenance such as received time, sender, subject, and message ID; delete raw email bodies and headers once they are no longer needed.
- Show actionable delivery failures in the app and optionally send a minimal acknowledgement or rejection email without including receipt contents.
- Add rate limits, abuse monitoring, retry-safe processing, and a dead-letter/recovery path.

### Later enhancement

When a forwarded receipt has no usable attachment, Fido may offer to render a sanitised printable HTML email body as the original receipt. This should follow attachment ingestion because HTML email has a larger security and privacy surface.

### Definition of done

An email from an authorised sender to the private receipt address creates each valid attachment exactly once in the review queue, while forged, oversized, unsupported, duplicated, or unauthenticated deliveries are rejected safely and visibly.

---

## Stage 4 — Extract and review structured data with OpenAI

**Goal:** convert the approved image into validated receipt fields that a person can correct.

### Architecture first

Reuse the trusted server-side component introduced for email ingestion for OpenAI requests and later FreeAgent calls. OpenAI keys, OAuth secrets, and third-party tokens must never be shipped in `NEXT_PUBLIC_*` variables or called directly from the browser.

Receipt capture remains fast: approving the processed image creates the receipt and returns control to the browser. A Firestore trigger queues a private Firebase Cloud Task, which performs extraction independently with bounded concurrency, retries, and visible failure states. OpenAI background mode is intentionally not used for this short task because Cloud Tasks already provides the required asynchronous boundary.

### Implemented in the Stage 4 branch

- Background states for queued, processing, ready to verify, failed, and verified receipts.
- Private Cloud Task processing of the approved JPEG only, with the OpenAI key stored as a Firebase secret.
- OpenAI Responses API image input with Structured Outputs, `store: false`, and a versioned prompt/schema.
- Server validation of dates, ISO currencies, decimal-string totals, field confidence, and net/VAT reconciliation.
- Review-queue filters, uncertainty highlighting, retry controls, and **Verify & next**.
- Separation between immutable model extraction and owner-corrected verified values.

### Scope

- Queue extraction after the image is approved, with retry and failure states.
- Send the minimum required image data to an OpenAI vision-capable model.
- Require schema-constrained structured output and validate it server-side.
- Extract, where present:
  - merchant name;
  - receipt date;
  - currency, including non-GBP receipts;
  - gross total;
  - net total and VAT amount when they are explicitly shown on a UK VAT receipt;
- Do not extract or store line-item detail; Fido only needs receipt-level totals for accounting and transaction matching.
- Do not extract merchant addresses, receipt numbers, transaction times, VAT registration numbers, payment methods, card digits, or accounting categories; FreeAgent transaction matching does not require them.
- Treat missing VAT as valid for non-UK receipts. Preserve the original currency and gross total, and do not infer UK VAT or flag its absence as an extraction error.
- Store field-level confidence or warnings, model identifier, schema version, and prompt version.
- Add a review form that highlights missing or uncertain fields and lets the user correct them.
- Do not preserve the raw extraction response. Store only the validated fields, model/prompt/schema versions, token usage, and processing duration.

### Quality and safety

- When net and VAT are both present, validate that they plausibly add up to the gross total. Do not invent a net amount or VAT amount when the receipt does not state one.
- Parse money as decimal strings or integer minor units, never floating-point values.
- Treat model output as untrusted input and validate dates, currency codes, and field lengths.
- Build an anonymised test set covering crumpled, long, faded, handwritten, UK VAT, and foreign-currency receipts with no VAT.
- Make extraction repeatable from a chosen schema/prompt version without overwriting user corrections.

### Definition of done

For the test set, Fido reliably extracts merchant, date, currency, and gross total; captures net and VAT only when applicable; clearly marks uncertainty; and lets the user approve or correct every value.

---

## Stage 5 — Connect a live FreeAgent account

**Goal:** securely authorise Fido to read the owner's FreeAgent data.

### Scope

- Register a Fido application in the FreeAgent Developer Dashboard.
- Build and test OAuth against the FreeAgent sandbox before enabling the production API.
- Implement the server-side OAuth authorisation-code flow, including a short-lived, single-use `state` value and strict redirect URI validation.
- Keep the client secret, access token, and refresh token server-side only.
- Encrypt refresh tokens at rest and restrict access through the server's service identity.
- Refresh expired access tokens safely, handling rotation if returned.
- Add **Connect**, connection-status, reconnect, and **Disconnect** controls.
- On disconnect, revoke or remove stored credentials and stop synchronisation jobs.
- Fetch the authorised FreeAgent identity/company and show it before the user confirms the connection.
- Record token events and errors without logging token values.

FreeAgent uses OAuth 2.0 and issues an access token plus refresh token for each authorised account. API access is over HTTPS and requests must identify the application with a user agent. See the official [OAuth documentation](https://dev.freeagent.com/docs/oauth) and [API introduction](https://dev.freeagent.com/docs/introduction).

### Definition of done

The owner can connect the intended sandbox account, then the live account, survive an access-token expiry, and disconnect without exposing any credentials to the browser or logs.

---

## Stage 6 — Import and display FreeAgent bank transactions

**Goal:** create a local, read-only view of the transactions that receipts may match.

### Scope

- Fetch accessible bank accounts and let the user choose which accounts participate.
- Import bank transactions for a bounded date window, handling pagination and rate limits.
- Normalise and store only the fields needed for matching, including:
  - stable FreeAgent URL/identifier and transaction ID;
  - bank account;
  - transaction date;
  - amount and currency;
  - description/full description;
  - unexplained amount and explanation state;
  - source `updated_at` value and local sync timestamp.
- Use `updated_since` for incremental sync after the initial import.
- Upsert idempotently and prevent the same FreeAgent transaction being duplicated locally.
- Provide manual refresh, last-sync status, and actionable error messages.
- Display transactions read-only with filters for account, date, amount, and explained state.
- Decide and document retention: local cache versus fetch-on-demand.

The FreeAgent API exposes bank accounts and date/updated-time filters for bank transactions. See the official [bank accounts](https://dev.freeagent.com/docs/bank_accounts) and [bank transactions](https://dev.freeagent.com/docs/bank_transactions) documentation.

### Definition of done

Fido can repeatedly synchronise the selected accounts without duplicates or data loss and shows the same relevant transactions as FreeAgent for the chosen period.

---

## Stage 7 — Suggest transaction-to-receipt matches

**Goal:** rank likely matches transparently while keeping the user in control.

### Candidate generation

Start with deterministic rules before considering another model call:

- exact currency and absolute amount match;
- purchase/debit sign appropriate to the selected account;
- transaction date close to the receipt date (initially the same day, then a configurable window such as ±3 days);
- merchant similarity against the transaction description;
- optional boost from masked card digits or known merchant aliases;
- exclude transactions already confirmed against another receipt unless explicitly allowed.

### Ranking and review

- Produce a score from independently visible factors: amount, date, merchant, and payment hints.
- Label results as high, medium, or low confidence using thresholds tuned on real examples.
- Show the best candidates and explain why each one scored as it did.
- Support **Confirm**, **Reject**, **Choose another transaction**, and **No matching transaction**.
- Learn owner-specific merchant aliases from confirmed matches without silently changing historical decisions.
- Detect duplicate receipt uploads using a content hash plus extracted fields.
- Never auto-confirm solely because there is one candidate.

### Evaluation

- Create labelled examples for exact matches, delayed card settlement, tips, refunds, split payments, foreign exchange, duplicate totals, and missing transactions.
- Measure top-1 accuracy, top-3 recall, false-positive rate, and the percentage requiring manual search.
- Optimise primarily for a very low false-positive rate; an omitted suggestion is safer than an incorrect accounting link.

### Definition of done

On a representative labelled set, likely matches appear near the top with understandable reasons, ambiguous cases remain unconfirmed, and one receipt cannot be silently linked to multiple transactions.

---

## Stage 8 — Confirm matches and send receipts to FreeAgent

**Goal:** turn a reviewed match into a useful accounting record, safely and reversibly.

### Scope

- Store a match as a separate auditable record rather than embedding mutable match state in the receipt.
- Record who confirmed it, when, the scoring inputs, and the FreeAgent identifiers involved.
- In the FreeAgent sandbox, validate the correct workflow for attaching the receipt to an existing bank transaction/explanation.
- Show the exact proposed write before sending anything to FreeAgent.
- Require explicit confirmation for the first production writes.
- Use idempotency/duplicate guards and reconcile the result by reading it back.
- Store the returned FreeAgent resource URL and upload status.
- Support retry for network failures without creating duplicate explanations or attachments.
- Define what **Unmatch** means locally and whether any remote change can or should be reversed.

FreeAgent represents categorisation through bank transaction explanations, which can include attachments. Its capabilities and required fields vary by explanation type, so the final write flow should be proven in the sandbox against the official [bank transaction explanations documentation](https://dev.freeagent.com/docs/bank_transaction_explanations) before production use.

### Definition of done

After explicit review, Fido can attach the intended receipt to the intended FreeAgent record exactly once, confirm the remote result, and retain a complete audit trail.

---

## Stage 9 — Production hardening and regular-use workflow

**Goal:** make Fido dependable enough for ongoing financial record keeping.

### Scope

- Dashboard queues: **Needs crop**, **Needs review**, **Ready to match**, **Matched**, and **Failed**.
- Background-job retries with exponential backoff and a dead-letter/recovery view.
- Structured monitoring for upload, inbound email, extraction, OAuth, sync, and FreeAgent write failures.
- Cost and usage limits for storage, model calls, and backend execution.
- End-to-end tests covering capture through confirmed sandbox match.
- Security review of Firebase rules, backend IAM, secret storage, OAuth callbacks, logs, and App Check.
- Export, account disconnect, and full data-deletion workflows.
- Documented backups and recovery procedure for metadata and match audit records.
- Accessibility, mobile-browser, offline/interrupted-upload, and PWA update testing.
- A concise privacy notice covering Firebase, the inbound email provider, OpenAI processing, and FreeAgent access.

### Definition of done

Failures are visible and recoverable, costs are bounded and observable, sensitive data has a documented lifecycle, and the complete workflow passes automated tests plus a live-account smoke test.

---

## Recommended delivery order

1. Ship manual crop/rotate and the new receipt status model.
2. Add the trusted backend and authenticated inbound-email endpoint.
3. Route emailed attachments into the receipt review queue.
4. Add the OpenAI extraction review loop.
5. Complete FreeAgent OAuth in the sandbox.
6. Add read-only bank-account and transaction sync.
7. Build and evaluate deterministic matching.
8. Trial confirmed matches, then enable gated FreeAgent attachment writes.
9. Harden monitoring, recovery, privacy, and deletion before relying on Fido as the system of record.

## Guiding principles

- **Originals are immutable.** Processing creates derived assets.
- **Secrets stay server-side.** The browser receives only the minimum data it needs.
- **Financial writes require review.** Suggestions are not accounting decisions.
- **Every operation is retry-safe.** Uploads, extraction, sync, and writes must be idempotent.
- **Email is untrusted input.** Authenticate delivery events, validate attachment bytes, and isolate conversion.
- **Uncertainty is visible.** Low-confidence extraction and matching should become review work, not hidden guesses.
- **Data is minimised.** Store only what is needed and make deletion complete and testable.
