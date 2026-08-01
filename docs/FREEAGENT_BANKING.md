# FreeAgent banking and out-of-pocket workflow

Stage 6 adds a private, read-only view of recent FreeAgent transactions. It does not create, update, explain, or delete accounting resources.

## Account selection

Fido requests the current bank-account list from FreeAgent and returns only:

- resource ID and URL;
- display name and account type;
- currency, active/hidden status, and personal flag.

Account numbers, sort codes, IBANs, and balances are neither returned to the browser nor stored. Only active GBP accounts can be selected because every participating account in this installation is GBP. Deselecting an account deletes its cached transactions.

## Transaction synchronisation

`syncFreeAgentTransactions` fetches an inclusive rolling 90-day window for each selected account. It requests up to 100 records per page and follows pages until FreeAgent's count is satisfied. Calls are sequential across accounts to avoid unnecessary bursts against FreeAgent's per-user limits.

The private cache retains only:

- stable transaction resource ID and URL;
- bank-account resource ID, URL, and display name;
- date and signed amount;
- description and full description;
- unexplained amount;
- provider transaction ID when present;
- provider `updated_at`, local sync run, and local sync time.

Currency is stored as GBP from the selected account context. The FreeAgent bank-transaction resource expresses `amount` in the company's native currency and does not include a separate currency attribute.

Each completed refresh upserts records by a hash of the stable FreeAgent URL and removes cached records that disappeared from the refreshed account/date window. Cached data is server-only under `freeAgentSync/{ownerUid}` and remains denied by Firestore browser rules. Disconnecting FreeAgent recursively removes the cache.

## Out-of-pocket receipts

A receipt may correctly have no matching participating bank transaction when it was paid in cash or from a personal/different account. Stage 7 will offer **Paid personally or cash** as a deliberate receipt disposition and require the owner to select a current FreeAgent spending category. OpenAI does not select accounting categories.

Stage 8 will show a separate final confirmation before calling `POST /v2/expenses`. The proposal will contain:

- the connected user's FreeAgent URL as claimant;
- the owner-selected category;
- receipt date and editable purchase description;
- negative gross value because the company owes the claimant;
- original currency and amount;
- negative native GBP value for a foreign receipt, using the owner-entered real GBP charge;
- explicitly reviewed VAT treatment;
- the processed JPEG as an attachment, kept within FreeAgent's 5 MB limit.

No out-of-pocket write is enabled during Stage 6. The official contracts are [Expenses](https://dev.freeagent.com/docs/expenses), [Categories](https://dev.freeagent.com/docs/categories), and [Attachments](https://dev.freeagent.com/docs/attachments).
