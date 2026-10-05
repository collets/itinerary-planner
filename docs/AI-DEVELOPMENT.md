# AI development and operation

Work lives on `feature/ai-assistance`, independently of the production release.
Follow [the implementation plan](AI-IMPLEMENTATION.md) and
[the security requirements](SECURITY-AUDIT.md#mandatory-design-before-paid-ai).

## Financial boundary

`AiBudgetService` writes a single private `ai/budget.json` ledger using strong
ETags and conditional writes. It starts disabled and persists limits, run IDs,
dispatch ownership, reservations, verified charges and explicit reconciliation.
Amounts use integer microdollars (one dollar = 1,000,000 microdollars).

The default ceilings are $10/month, $1/day, $0.25/run and twelve paid operations per
run. There is one active run across all trips and service instances. Limits are
operator-owned; a family login cannot change them. A reservation is an upper
bound, not the expected cost. Unknown prices, unavailable storage, malformed
ledgers and exhausted allowances stop dispatch.

Provider calls are claimed exactly once before dispatch. Automatic retries are
not allowed. Timeout or failed settlement leaves the reservation held; an
uncertain operation cannot be redispatched. Cancellation releases only operations
not yet dispatched. The durable disable switch stops future work, not a provider
request already accepted. Verified cross-midnight charges count conservatively
in both the reservation and settlement periods. Unresolved liabilities consume
new period limits too; changing a date cannot erase them.

Operator reconciliation requires checking the exact request's provider usage and
recording evidence. Lease expiry is insufficient. An invalid price bound disables
the workspace and retains the full known charge; it requires investigation before
re-enabling. The initial ledger supports 1,000 runs; exhaustion fails closed rather
than discarding idempotency records. Reviewed archival is future maintenance work.

Tests cover independent storage/service instances, duplicate IDs, competing
claims, simultaneous reservations, budget exhaustion, calendar rollover, kill,
cancellation during dispatch, corrupt storage, failures before/after provider
dispatch and operator reconciliation. No real provider calls are made.

## Feature branch deployment

The feature branch has a Vercel ignored-build command. Pushing it can run ordinary
GitHub CI, but skips the Vercel build until an isolated preview is explicitly
configured. Main and staging builds are unaffected.

Enabling an AI preview requires branch-specific `AI_PREVIEW_ENABLED=true`,
`APP_ENVIRONMENT=ai-preview`, `STORAGE_DRIVER=blob`, and a new private
`BLOB_STORE_ID` matching `AI_PREVIEW_STORE_ID`. Do not inherit the staging seed or
legacy token. Configure separate app/operator credentials too. Do not enable the
preview until the store is separately connected and the account scope reviewed.
Paid AI remains independently disabled until its live-use checks are complete.
