# AI development and operation

Work lives on `feature/ai-assistance`, independently of the production release.
Follow [the implementation plan](AI-IMPLEMENTATION.md) and
[the security requirements](SECURITY-AUDIT.md#mandatory-design-before-paid-ai).

## Implemented scope

The header button immediately before logout opens a full-screen Italian assistant.
On the home page it first offers a trip picker. Within a trip it offers a day
selector, a stop/route selector, direct/scenic walking preference, natural-language conversation and
proposal widgets with schedule comparisons, street names, POIs and sources.
Each stop card and detail page has a **Chiedi aiuto** action. Opening the header
assistant while viewing an active stop also selects that stop. **Sostituisci la
tappa** and **Accorcia la visita** prepare an editable request; sending remains
explicit. Conversations are kept separately for each day or selected step.
`Adatta → Mostra anteprima → Suggerisci percorso e luoghi` includes the unsaved
manual change in the same proposal. Follow-up turns use current itinerary data
and up to three brief prior turns.

The model can suggest delay, timing, skip, reorder within one day, or add a stop
at an existing/discovered public place. Every change is validated server-side;
completed, fixed and booked activities remain protected. It cannot buy/cancel
bookings, change costs, read ticket documents or write directly to the trip.
Replacement uses a skip and add in one approved batch, with sourced connections
before and after the new stop. Temporary bypass routes needed to validate the
intermediate skip are excluded from the final route preview.
Approval applies the full batch through one conditional trip write and one travel
history entry. A retry does not apply it twice. A stale or expired proposal cannot
overwrite newer changes. Undo restores the schedule; unused catalog records and
archived steps may remain, as with manual travel editing. Financial history is
separate and never undone with itinerary changes.

Drafts and the latest advice are private device data, readable offline. The last
ten conversation contexts are retained, with three earlier turns per context.
Logout clears them. Generation/application requires online access and a drained
offline edit journal. Reconnecting or reading a job never dispatches a provider
call. Closing the dialog stops client progression; it does not undo an accepted
provider request. Use **Annulla richiesta** to release unused work.

### Try it without accounts or API spending

From this feature worktree, after `pnpm install`:

```sh
pnpm ai:demo
```

This runs local setup, preserves existing local files, enables a file-backed mock
ledger and starts the app at http://localhost:5173. The key is in ignored
`local-data/access-key.txt`. Use the fictional example trip. Try “Siamo in ritardo
di 30 minuti”, “Accorcia la visita a 20 minuti”, then the route-assistance button
inside Adatta. Mock mode uses a small deterministic interpreter and existing
route facts; it is not a demonstration of real model quality. Replacement requests
explain that new visits/connections require the live service; they do not simulate
research or silently shorten a visit instead. It makes no provider
requests, including routing/research. Restart ordinary `pnpm dev` without an
`AI_MODE` setting to hide assistance again.

## Provider boundaries and limitations

`AiService` is a bounded application orchestrator, not an unrestricted agent loop.
Stages persist independently: optional research, one structured Responses call,
up to six logical route requests, then validated proposal construction. Each
provider stage has a 40-second timeout under the existing 60-second Vercel Function
limit. An explicit authenticated POST advances one stage; GET only reads progress.
No queue, database or new runtime is required for the pilot.

The live adapter uses native `fetch` with no retries, fixed HTTPS hosts, rejected
redirects and bounded bodies. Responses uses strict JSON output, `store:false`,
no hosted tools and a configured output ceiling including reasoning. Explicit
`service_tier: default` avoids inheriting a costlier project tier; an unexpected
returned tier is treated as an unverified charge.
Every model request sends its persisted job ID as `X-Client-Request-Id` for
provider-side correlation when a timeout hides the response. Sending only
a selected day's allowlisted fields excludes traveler identities, booking
references/notes/payments, tickets, private shared notes and unrelated trips.
User-provided source records are omitted; source query strings/fragments and URL
credentials are stripped. Public place descriptions and the user's question are
still sent: do not put private information in those fields. `store:false` does
not itself guarantee zero provider retention; review the provider data policy.

Walking uses the current HeiGIT OpenRouteService endpoint. It requires existing
verified coordinates (no more than 365 days old), refuses distant/unknown points
and measures direct versus scenic walking separately from estimated POI dwell
time. Each logical route uses at most five direction calls. Geometry, streets,
provider/date and attribution are saved with the approved leg. Manual changes to
leg duration invalidate its former routing evidence. Transit/flight rerouting,
GPS location, geocoding and guaranteed optimal routes are not implemented.

Research queries public coordinates through Italian Wikipedia geosearch and
bounded extracts, at most two HTTP calls and three nearby candidates. Short
excerpts are attributed to Wikipedia contributors under CC BY-SA. Wikipedia is
secondary evidence; openings, access, prices and suggested pause duration need
verification. The research note and citations preserve that uncertainty. This
does not implement unrestricted web search or official opening-hours lookup.
Hosted search stays disabled until its complete billing/context bound can be
proved and reserved. No model-selected URL is fetched.

Contracts were checked against primary documentation on 2026-10-05:
[Responses](https://developers.openai.com/api/reference/python/resources/responses/methods/create),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data),
[ORS directions](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/),
[HeiGIT endpoint migration](https://ask.openrouteservice.org/t/deprecating-api-openrouteservice-org-in-favour-of-api-heigit-org/7912),
[Wikimedia geosearch](https://www.mediawiki.org/wiki/API:Geosearch),
[TextExtracts](https://www.mediawiki.org/wiki/Extension:TextExtracts).

## Financial boundary

`AiBudgetService` writes a single private `ai/budget.json` ledger using strong
ETags and conditional writes. It starts disabled and persists limits, run IDs,
dispatch ownership, reservations, verified charges and explicit reconciliation.
Amounts use integer microdollars (one dollar = 1,000,000 microdollars).

The default ceilings are $10/month, $1/day, $0.25/run and twelve reserved operations per
run, including free routing/research. There is a durable limit of 60 new runs per
UTC day and one active run across all trips and service instances. Limits are
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

Live inference reserves the configured model's **entire verified context window**
at a verified upper input unit price plus the maximum output unit price. This is intentionally
conservative; an average prompt size is not a safe financial ceiling. Context
payloads are additionally limited to 24 KB. Cached-token discounts are ignored.
The configured unit prices must cover every applicable token rate, including any
cache-write or long-context surcharge; base rates alone may be insufficient.
Settlement uses those conservative unit rates, not a promise of the exact invoice.
Prices must be positive for inference and explicitly zero for the verified free
routing/research accounts. Verification expires after at most 31 days. A request
whose bound exceeds its cap cannot run, even when typical usage would cost less.
Choose a low-cost compatible model and verify its actual context window; do not
invent a smaller window simply to fit a budget.

For a purely illustrative price of $0.10/million input tokens and $0.40/million
output tokens, a 128,000-token context plus 2,048 maximum output tokens reserves
$0.01362. A real 5,000-input/1,000-output-token call would cost $0.00090 under those
fictional rates. These are arithmetic examples, not current model prices or a
quoted bill. Vercel/Blob quotas, taxes and other infrastructure charges are outside
this AI ledger. Review actual model rates before configuring live use.

Provider keys stolen outside this app bypass its ledger. A dedicated restricted
project and an independently enforced provider cap remain mandatory. Current
[OpenAI spend controls](https://developers.openai.com/api/docs/guides/spend-limits)
document project/organization limits with an **Enforce a hard limit** setting;
alerts alone let requests continue. Enforcement may lag and slightly exceed the
configured threshold. Verify that setting in the actual account before setting
`AI_PROVIDER_SPEND_CAP_CONFIRMED=true`. It is an operator attestation, not an API
audit of the account. No claim of an exact all-in dollar ceiling is made.

## Operator controls

The family session and ordinary itinerary agent token cannot administer AI.
Generate an independent random token of at least 32 characters, store only its
SHA-256 hash in server `AI_ADMIN_TOKEN_HASH`, and keep the token in an ignored
operator environment file as `ITINERARY_AI_ADMIN_TOKEN`. Never give the app an
OpenAI administrative key. The operator token cannot read or edit normal trips.

```sh
pnpm ai:admin status --local
AI_MODE=mock pnpm ai:admin enable --local
pnpm ai:admin disable --local
```

For a configured private deployment, set `ITINERARY_API_URL` and the independent
operator token in the ignored file chosen by `ITINERARY_ENV_FILE`, then omit
`--local`. Enable/disable optionally accepts `--limits=local-data/ai-limits.json`:

```json
{ "monthly": 10000000, "daily": 1000000, "request": 250000, "operations": 12 }
```

Amounts are microdollars. `pnpm ai:admin reconcile local-data/ai-evidence.json`
accepts `{runId, operationId, actualCost, evidence}`. Verify provider usage first,
including whether a timed-out call billed. Never reconcile to zero just to unblock
the app. The status command returns bounded job/operation summaries without raw
questions. An abandoned job can need cancellation even when it has no paid
liability; a financial uncertainty needs evidence-based reconciliation.

Private jobs/proposals contain user questions and advice under `ai/jobs/` and
`ai/proposals/`; the ledger is `ai/budget.json`. Proposal validity is 30 minutes.
No automatic deletion/archival of financial idempotency records is implemented;
the pilot fails closed at 1,000 runs. Trip deletion removes its normal itinerary
files, not the independent financial audit. Review retention and an operator-only
archive/redaction procedure before expanding beyond the personal pilot.

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

## Owner checklist before live evaluation

- [ ] Create/connect a **new private** AI preview Blob store scoped to this branch;
      remove inherited staging seeds and the legacy token from that branch only.
- [ ] Set the preview isolation values above and independent browser, agent,
      session and AI operator credentials. Retain preview access protection and apply
      reviewed edge rate limits to AI request/advance routes.
- [ ] First deploy with `AI_MODE=mock`, enable its ledger with the operator CLI,
      then verify login, proposal/undo, offline draft and that its store is isolated.
- [ ] Create a dedicated OpenAI project/service credential restricted to required
      inference permissions/models. Configure a low enforced hard spend cap and alerts;
      record enforcement and account ownership. Preview and production must be separate.
- [ ] Verify routing free-plan quotas, attribution and storage terms; provision
      its key. Confirm the relevant real itinerary has sourced entrance coordinates.
- [ ] Select an exact Structured Outputs-compatible model, verify current prices
      and its full context window. Set `AI_PRICING_JSON` (shape below), with a short
      verification expiry. The defaults remain $10/month, $1/day, $0.25/run.
- [ ] Set server-only `OPENAI_API_KEY`, `OPENROUTESERVICE_API_KEY`, `AI_MODE=live`,
      `AI_LIVE_ENABLED=true`, `AI_PROVIDER_SPEND_CAP_CONFIRMED=true` and
      `AI_ROUTING_FREE_PLAN_CONFIRMED=true`. Local live evaluation additionally requires
      `AI_LOCAL_LIVE_ENABLED=true`; leave production permission disabled.
- [ ] Approve a small live-evaluation allowance, test a few real requests, compare
      routes/sources and protected booking behavior, verify billed usage against the
      ledger and test the kill switch. Mock tests do not establish real model quality.
- [ ] Promote through a reviewed PR only after that evaluation. Production needs
      its own controls and explicit `AI_PRODUCTION_ENABLED=true`.

`AI_PRICING_JSON` is one JSON object with `model`, `contextWindow`,
`maxOutputTokens` (512–4,096), and `price`: `id`, `inputPerMillion`,
`outputPerMillion`, `search`, `route`, `expiresAt` (UTC ISO timestamp). Price fields
are microdollars, so $0.10 per million is `100000`; `search` and `route` must be
`0` for this adapter. Use verified real values, not the illustrative rates above.
Configuration errors fail closed and hide assistance; durable enabling is a
separate required action. There are no provider keys or paid calls in this branch's
tests, and no AI deployment has been enabled on production or shared staging.

## Verification boundaries

Unit/API tests cover typed intent rejection, safe and unsafe synthetic evaluation
cases, context privacy, follow-up isolation, discovered-stop approval, route
evidence, atomic application/undo, stale/expired/hash conflicts, job restarts,
storage failures, timeouts, budget races and independent operator access. HTTP
adapter tests stub fetch and check Responses usage settlement, refusal/truncation,
SSRF/redirect/size limits, source labeling, coordinate freshness and detour bounds.
Mobile browser tests use the production build with a temporary, zero-cost mock
store. No browser can directly access provider credentials or a provider API.
These are functional/security contract tests, not paid model evaluations or an
independent penetration test.
