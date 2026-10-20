# FreeAgent attachment delivery

Stage 8A can attach a verified receipt to one existing, fully explained FreeAgent bank transaction. It deliberately cannot create or recategorise an explanation.

## Reviewed write boundary

1. The combined review screen supplies validated draft values and a chosen transaction; no approval or FreeAgent write happens yet. Legacy saved transaction proposals are also supported.
2. Fido makes a live request for the selected bank transaction and its existing explanation.
3. Fido shows the transaction, explanation type, current category nominal code, amount, date, and exact receipt filename and size.
4. The owner chooses **Confirm & send** once.
5. Fido repeats the live checks, verifies a short-lived fingerprint binding the draft values, transaction and processed asset, saves the approved receipt values and match, downloads the exact asset, and sends an attachment-only `PUT`.
6. Fido reads the explanation back, verifies the deterministic filename, and records a private delivery audit.

The update body contains only `bank_transaction_explanation.attachment`. It does not contain category, amount, date, description, VAT, or other accounting fields. The category shown in the preview is therefore informational and remains controlled in FreeAgent.

## Safety checks

Delivery is blocked when:

- the transaction is not fully explained;
- it has no explanation or multiple explanations;
- the explanation does not cover the full transaction amount;
- FreeAgent has locked the explanation;
- another attachment is already present;
- the processed JPEG or complete PDF is missing, changed, empty, or larger than 5 MB; or
- the live transaction, explanation, attachment, or category changes between preview and confirmation.

The filename is deterministic: `fido-receipt-{receiptId}.jpg`. If a previous request succeeded remotely but its response was lost, a retry recognises that filename, reads the explanation back, and completes the local audit without uploading a duplicate.

## Stored state

- Short-lived preview tokens and fingerprints: `freeAgentSync/{ownerUid}/attachmentPreviews/{receiptId}`.
- Long-lived private delivery audit: `freeAgentDeliveryAudits/{ownerUid}/receipts/{receiptId}`.
- Browser-visible receipt summary: the sent state, resource type, label, and timestamp only.

Firestore browser rules deny access to preview and audit collections. Sent receipts are retained in Fido's **Sent** queue so their local source and audit are not accidentally removed. Disconnecting OAuth clears the synchronisation cache and previews but retains completed delivery audits.

Official API contracts:

- [Bank transaction explanations](https://dev.freeagent.com/docs/bank_transaction_explanations)
- [Attachments](https://dev.freeagent.com/docs/attachments)
- [Categories](https://dev.freeagent.com/docs/categories)
