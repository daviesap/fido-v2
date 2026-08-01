# Background receipt extraction

Stage 4 keeps capture responsive by moving OpenAI work entirely off the browser request path.

## Flow

1. The owner approves a processed receipt JPEG.
2. Firestore stores the receipt as `ready_for_extraction` and immediately returns control to the browser.
3. `queueReceiptExtraction` notices the transition and enqueues a private, deterministic Cloud Task.
4. `extractReceipt` downloads only `processed-v1.jpg`, calls the OpenAI Responses API, validates the structured result, and updates the receipt.
5. The UI receives the state through its existing Firestore listener and moves the receipt to **Ready to verify** or **Problem**.
6. The owner corrects the values and saves a separate `verifiedData` object. The original model result remains unchanged for auditability.

Cloud Tasks supplies bounded concurrency, three attempts, and exponential backoff. OpenAI background mode is not needed because a normal receipt extraction should complete comfortably inside one task dispatch.

## Extracted values

Fido stores only:

- merchant name;
- receipt date;
- ISO 4217 currency;
- gross total;
- net and VAT totals only when explicitly printed on a UK VAT receipt;
- field confidence and short warnings;
- model, schema and prompt versions, token usage, and processing duration.

Money is stored as a decimal string, never a floating-point value. Foreign receipts keep their original currency and normally have `null` net/VAT values. Line items and unnecessary identifiers are neither requested nor retained.

## OpenAI configuration

Create an API key in the OpenAI project intended for Fido. Do not put it in `.env.local`, a `NEXT_PUBLIC_*` variable, GitHub Actions, or the repository.

Store it as a Firebase Functions secret:

```bash
npx firebase functions:secrets:set OPENAI_API_KEY
```

The default model is `gpt-5.6-luna`, selected for a bounded extraction workload. `OPENAI_RECEIPT_MODEL` is a server-side Firebase parameter with that default, so the model can be changed later without altering the browser bundle.

The API request uses:

- the Responses API;
- a base64 JPEG input with explicit high detail;
- Structured Outputs with a strict JSON Schema;
- explicit `reasoning: { effort: "none" }`;
- `store: false`;
- no raw response or receipt-text logging.

OpenAI references: [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md).

## Deploy

Run the full test suite first, then deploy the new functions, rules, and site:

```bash
npm run lint
npm run typecheck
npm test
npm run emulators
npm --prefix functions test
npm --prefix functions run typecheck
npm --prefix functions run build
npx firebase deploy --only functions:queueReceiptExtraction,functions:extractReceipt,functions:retryReceiptExtraction,firestore:rules,hosting
```

The first task-function deployment creates its Cloud Tasks queue. If enqueueing reports an IAM permission error, grant the runtime service account `roles/cloudtasks.enqueuer` and permission to invoke `extractReceipt`, following Firebase's [task queue IAM guidance](https://firebase.google.com/docs/functions/task-functions#iam_permissions).

Receipts approved before the Firestore trigger was deployed have no extraction state. They appear with **Start extraction** once, allowing the owner to queue them through the same authenticated, idempotent backend path.

## Production check

Use one UK VAT receipt and one foreign receipt:

1. Approve each image and confirm the app returns to the receipt queue immediately.
2. Confirm states move from **Extracting** to **Ready to verify** without refreshing.
3. Check the UK gross/net/VAT values and reconciliation warning behavior.
4. Confirm the foreign currency and gross total are retained while net/VAT remain blank.
5. Correct a field, select **Verify & next**, and confirm the corrected value persists.
6. Temporarily test a retryable failure only in a safe environment; confirm it becomes **Problem** after bounded attempts and **Try again** queues a new generation once.

Stage 4 should be marked complete only after representative real receipts meet the roadmap definition of done.
