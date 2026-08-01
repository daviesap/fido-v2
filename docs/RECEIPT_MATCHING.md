# Receipt matching and out-of-pocket proposals

Stage 7 compares verified receipts with the private, synchronised FreeAgent transaction cache and saves a reviewable proposal. It never changes FreeAgent accounting data.

## Matching boundary

The browser sends only a receipt ID to an owner-only Firebase callable. The server verifies ownership and `verified` status, reads the private transaction cache, and returns bounded ranked options. The cache and saved proposals remain denied by Firestore browser rules.

Suggestions require all of the following:

- a purchase/debit transaction;
- an exact GBP amount, using the receipt gross total for GBP receipts or the owner-entered final GBP charge for foreign receipts;
- a transaction date no more than three days from the receipt date.

The score is deterministic and totals 100 points:

- exact amount: 50;
- date proximity: up to 25;
- merchant similarity: up to 25.

The UI shows every factor and never auto-confirms a result. Transactions outside the suggestion rules remain available through manual search. A transaction already proposed for another receipt cannot be selected again.

## Out-of-pocket treatment

When a receipt was paid personally or with cash, the server fetches the current company categories from `GET /v2/categories`. Only `admin_expenses_categories` and `cost_of_sales_categories` are offered. The owner must choose the category; OpenAI is not involved.

The saved proposal contains:

- FreeAgent claimant identity;
- selected category;
- receipt date and description;
- original currency and negative gross value;
- owner-entered negative native GBP value for foreign receipts;
- an explicit VAT note;
- the processed JPEG attachment name.

Foreign receipts are always marked as having no UK VAT. Printed VAT on a GBP receipt is flagged for explicit Stage 8 confirmation rather than converted into a FreeAgent tax decision automatically.

## Storage and cleanup

Proposals are stored at `freeAgentSync/{ownerUid}/matchProposals/{receiptId}`. Browser rules deny direct reads and writes. The receipt contains only a small display summary for its queue badge.

Deleting a receipt removes its proposal. Disconnecting FreeAgent removes the transaction cache, all proposals, and receipt proposal summaries.

## Stage 8 hand-off

Stage 8 will read the private proposal, show the exact remote change, and require a separate confirmation before it makes a FreeAgent write. It must revalidate the transaction or category, attach the processed JPEG, use duplicate guards, and read the created or updated record back from FreeAgent.

Official API references:

- [Bank transactions](https://dev.freeagent.com/docs/bank_transactions)
- [Categories](https://dev.freeagent.com/docs/categories)
- [Expenses](https://dev.freeagent.com/docs/expenses)
- [Attachments](https://dev.freeagent.com/docs/attachments)
