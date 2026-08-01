# FreeAgent attachment delivery

Stage 8A can attach a verified receipt to one existing, fully explained FreeAgent bank transaction. It deliberately cannot create or recategorise an explanation.

## Reviewed write boundary

1. Stage 7 saves a private transaction proposal without changing FreeAgent.
2. Opening that proposal makes a live request for the bank transaction and its existing explanation.
3. Fido shows the transaction, explanation type, current category nominal code, amount, date, and exact JPEG filename and size.
4. The owner separately chooses **Attach receipt to FreeAgent**.
5. Fido repeats the live checks, verifies a short-lived preview fingerprint, downloads the exact processed asset, and sends an attachment-only `PUT`.
6. Fido reads the explanation back, verifies the deterministic filename, and records a private delivery audit.

The update body contains only `bank_transaction_explanation.attachment`. It does not contain category, amount, date, description, VAT, or other accounting fields. The category shown in the preview is therefore informational and remains controlled in FreeAgent.

## Safety checks

Delivery is blocked when:

- the transaction is not fully explained;
- it has no explanation or multiple explanations;
- the explanation does not cover the full transaction amount;
- FreeAgent has locked the explanation;
- another attachment is already present;
- the processed JPEG is missing, changed, empty, or larger than 5 MB; or
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
