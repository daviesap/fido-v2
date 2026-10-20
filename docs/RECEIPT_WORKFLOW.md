# Combined receipt review

The normal flow is **Add → Review & send → Done**. The owner remains the only user. This changes the approval sequence, not FreeAgent accounting categories or VAT treatment.

## Capture and preparation

Clear browser images retain the complete image by default and go straight to upload/extraction. Quality warnings open the image check instead. **Adjust image** is available during review; it loads the original and allows cropping and rotation. Saving an adjustment creates a unique processed asset, clears previous extracted/verified values and the local match summary, and queues a new extraction generation. The trigger removes stale private proposals/previews. The previous processed image is retired after the new receipt metadata is saved. Sent images cannot be revised.

PDF uploads are validated and queued with all pages retained, without a separate document approval. Email ingestion normalises supported images with Sharp and counts PDF pages with pdf-lib, retaining the exact PDF bytes. Files that cannot be prepared automatically retain the original and fall back to manual review. Existing emailed receipts already in Needs review continue to work.

## One review and confirmation

The review screen shows the attachment alongside editable receipt fields, transaction candidates, and the live existing FreeAgent explanation/category. Valid draft fields are debounced before matching; changing fields, mode or transaction invalidates the previous preview immediately. The final send button remains disabled until the current preview is ready. Foreign receipts still require the actual GBP charge; suggested foreign transactions only copy that real bank value.

The preview stores validated draft values and the chosen transaction privately with the token hash, expiration and fingerprint. It does not mark values verified or write to FreeAgent. Confirmation reloads the receipt, checks transaction reservations and the live target, verifies the fingerprint, claims delivery, persists the approved values/match, and runs the existing attachment-only write/read-back/audit process. A failed send can leave approved values and a chosen match locally for retry; it does not imply successful delivery. Duplicate receipt submissions remain protected by the delivery claim and deterministic remote filename.

**Paid personally or cash** and **No match yet** remain explicit save-for-later routes. Out-of-pocket expense creation is outside this change. Existing verified receipts, legacy match proposals, sent receipts and the old callable request forms remain supported.

## Validation and manual deployment

Run root lint, typecheck, unit/component tests, production build and `npm run emulators`; run Functions typecheck, tests and build. Component tests cover a single confirmation, receipt/transaction preview invalidation, foreign charges and blocked explanations. Server tests cover read-only draft previews, approval on confirmation, retry idempotency, expired/changed previews, ownership, reserved transactions, image revisions and automatic email preparation. Rules tests cover revision permissions and sent-receipt protection.

Deploy Hosting, Functions and Firestore rules together using the repository's normal Firebase project configuration. This change adds Sharp and pdf-lib to Functions; install Functions dependencies before building. No email-worker deployment or data migration is needed. This PR does not deploy anything automatically.

```bash
npm ci
npm ci --prefix functions
npm run build --prefix functions
npx firebase deploy --only hosting,functions,firestore:rules
```
