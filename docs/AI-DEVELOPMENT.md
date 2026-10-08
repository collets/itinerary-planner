# AI development and operation

Work lives on `feature/ai-assistance`, independently of the production release.
Follow [the implementation plan](AI-IMPLEMENTATION.md) and
[the security requirements](SECURITY-AUDIT.md#mandatory-design-before-paid-ai).
Next deployment steps and release gates are in the
[staging rollout plan](AI-STAGING-ROLLOUT.md).

## Implemented scope

The header button immediately before logout opens a full-screen Italian assistant.
On the home page it first offers a trip picker. Within a trip it offers a day
selector, a stop/route selector, direct/scenic walking preference, natural-language conversation and
proposal widgets with schedule comparisons, street names, POIs and sources.
Each stop card and detail page has a **Chiedi aiuto** action. Opening the header
assistant while viewing an active stop also selects that stop. **Sostituisci la
tappa** and **Accorcia la visita** prepare an editable request; sending remains
explicit. Conversations are shared within each day, including when the selected
stop changes. Older device caches remain readable through a migration fallback.
`Adatta → Mostra anteprima → Suggerisci percorso e luoghi` includes the unsaved
manual change in the same proposal. Follow-up turns use current itinerary data
and up to three brief prior turns, plus persisted task goals, targets, constraints
and pending clarification choices. A short answer such as “sì grazie” goes through
the semantic planner with that task. Selectable choices submit the persisted
choice ID; the server validates ownership before starting a new budget run.

The model can answer without a proposal, research up to two public places,
compare alternatives, propose a history-based undo, or suggest delay, timing, skip, reorder within one day, or add a stop
at an existing/discovered public place. Every change is validated server-side;
completed, fixed and booked activities remain protected. It cannot buy/cancel
bookings, change costs, read ticket documents or write directly to the trip.
Replacement uses a skip and add in one approved batch, with sourced connections
before and after the new stop. Temporary bypass routes needed to validate the
intermediate skip are excluded from the final route preview.
Approval applies the full batch through one conditional trip write and one travel
history entry, including combined information/location and schedule changes.
A retry does not apply it twice. A corrected conversation supersedes its parent's
unapplied proposal even if the trip version has not changed. A stale or expired proposal cannot
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

### Executable changes and landmark coordinates

Tasks now retain `changeIntent` (`add-stop`, `replace-stop`, `adjust-stops`,
`route`, `location-only`, `undo`, or null). It is required in new live replies;
older stored tasks remain readable. A requested change cannot complete with
prose or an unrelated partial preview. The server checks the option's actions,
preserves intent through internal research passes, and can request a corrected
structured reply within the existing three-pass ceiling. If no executable option
is produced, it reports failure with the itinerary unchanged. A new user turn
can still cancel or supersede the task; ordinary read-only answers remain valid.

Context distinguishes discovered candidates from itinerary places and lists
their scheduled stops. A sourced candidate with fresh coordinates can be used
directly in an add action. A public itinerary POI may receive a sourced location
overlay even if it is not a museum or an existing stop. Private logistics remain
excluded. Location association and schedule changes use the same reviewed
atomic proposal; there is no separate preliminary approval step.

Landmark coordinates do not certify a visitor entrance. Proposals explicitly
show that limitation. It does not prevent an estimated exterior visit and a
measured walk to the sourced point. A user requirement for verified interior
opening still needs applicable evidence. Optional automatic visitor research
requires a remaining reasoning pass; explicit research remains bounded by the
existing operation and spending limits.

`AiService` is a bounded application orchestrator, not an unrestricted agent loop.
Stages persist independently: optional nearby research, up to three structured
Responses reasoning passes, one named-place lookup round, one information round
for up to two places, up to six logical route requests, then validated proposal
construction. The planner chooses typed research/location/history requests and
subgoals; the application executes them through fixed authenticated stages.
This is strict JSON orchestration, not an unrestricted native tool loop. Each
provider stage has a 40-second timeout under the existing 60-second Vercel Function
limit. An explicit authenticated POST advances one stage; GET only reads progress.
No queue, database or new runtime is required for the pilot.

The live adapter uses native `fetch` with no retries, fixed HTTPS hosts, rejected
redirects and bounded bodies. Responses uses strict JSON output, `store:false`,
no hosted tools in the planner and a configured output ceiling including reasoning.
The separate bounded information stage can enable hosted search as described below. Explicit
`service_tier: default` avoids inheriting a costlier project tier; an unexpected
returned tier is treated as an unverified charge.
Every model request sends its persisted operation ID as `X-Client-Request-Id` for
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
GPS location, general address geocoding and guaranteed optimal routes are not implemented.

Nearby research queries public coordinates through Italian Wikipedia geosearch and
bounded extracts, at most two HTTP calls and three nearby candidates. Named
lookup accepts at most two public landmark names and city/area names from the
structured model output. The server validates those fields and queries the same
fixed Wikipedia host, at most two additional HTTP calls and six results. It
retrieves sourced primary coordinates and short excerpts without requiring the
user to create a place or enter coordinates. Results without Earth coordinates,
or more than 25 km from all known trip points, are excluded. The final evidence
pool is capped at six places/sources; requested places take priority.

Nearby suggestions are optional: a free provider or response-contract failure
returns an empty evidence pool and an uncertainty note, allowing the separate
named lookup to proceed. It does not retry, invent coordinates, swallow
cancellation, or alter paid-provider settlement and spending controls.

This sends public place/city search terms to Wikipedia, in addition to the public
coordinates used for nearby research. Raw user questions, traveler names, booking
references, private notes and credentials are not research query fields. Public
names can be sensitive when entered by a user: do not put private information in
place names or request a lookup of private accommodation. The model is instructed
to extract only public landmarks; server validation blocks URL/search operators,
not every possible semantic disclosure.

A named lookup is persisted before dispatch and can run only once. Every further
reasoning pass has a separate durable operation ID and must fit the original request,
daily and monthly limits, including earlier settled charges. Each model pass
reserves the entire configured context/output bound. An insufficient remainder
blocks further reasoning; there is no automatic retry, budget increase or recursive
search loop. Older saved outputs default to no lookup; the provider's strict
schema requires an explicit `lookups` array. Broader time windows such as
"nel pomeriggio" can produce estimated visit times/durations for review.
The provider-facing lookup schema uses plain bounded strings; the server-side
domain schema independently enforces the Unicode name allowlist before any
external lookup. JavaScript Unicode regexp syntax is not sent to the provider's
schema compiler. A rejected model call without usage remains an unresolved
liability; it is not automatically assumed free or retried.

Landmark points are not confirmed entrances or postal addresses. Interior access,
opening hours, tickets and prices remain unknown unless the bounded information
stage finds applicable evidence; ticket availability is never guaranteed.
Wikipedia coverage is limited: restaurants, shops and obscure attractions may
require another evidenced provider in a future change. Short
excerpts are attributed to Wikipedia contributors under CC BY-SA. Wikipedia is
secondary evidence; openings, access, prices and suggested pause duration need
verification. The research note and citations preserve that uncertainty. This
does not implement unrestricted web search. Official opening-hours research is
a separate, quoted stage documented below. No model-selected URL is fetched by
the application server.

Provider failures log only the allowlisted host, a fixed category and (for HTTP
rejections) the status code. Routing response contract failures use a fixed
category. OpenAI rejections can additionally log an allowlisted error code,
an allowlisted parameter name and a validated `req_` correlation ID. Error bodies
are read with an 8 KB ceiling; unknown metadata and all error messages are omitted.
Other headers, request URLs, payloads, provider error bodies and exception
messages are omitted. Diagnostics do not change dispatch ownership, settlement
or the prohibition on automatic provider retries.
Invalid model replies log only a fixed completion/JSON category. Contract
failures log the persisted stage, validation codes and allowlisted field paths;
values, unknown field names and validation messages are excluded. Known usage
is settled even when a reply cannot safely produce a proposal.
Research deadlines log only their configured duration; unverified usage contracts
log fixed categories, validation codes and allowlisted root fields. These logs
do not establish billing or release a spending reservation.

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
`BLOB_STORE_ID` matching `AI_PREVIEW_STORE_ID`. `AI_PREVIEW_PROJECT_ID` must match
the actual `VERCEL_PROJECT_ID`. Use a dedicated project connected only to its
own test store. Set its project/environment markers in all environments so
unrelated branches and Production targets skip builds. Assistance on `staging`
also requires `AI_STAGING_BRANCH_ENABLED=true`; keep that flag false until promotion.
Do not inherit the staging seed or
legacy token. Configure separate app/operator credentials too. Do not enable the
preview until the store is separately connected and the account scope reviewed.
Paid AI remains independently disabled until its live-use checks are complete.

For protected remote CLI access, set `ITINERARY_VERCEL_BYPASS_SECRET` only in the
ignored operator environment file. The CLI sends it as an HTTP header alongside
its independent app/operator credential. HTTPS, an exact API origin and rejected
redirects prevent forwarding credentials to another host. Do not put it in URLs.

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

## Sourced stop information

New/replacement stops can run one bounded information round (maximum two public
places), then replan within the three-pass ceiling with date-specific opening windows. Existing visit/meal/free-time
stops offer **Aggiorna informazioni con AI**. The shortcut prepares an explicit
request; it does not spend until sent. Explicit information shortcuts bypass the
initial planner when the public stop is selected. General chat uses semantic task
goals instead of keyword routing. The planner selects active public stop IDs in
`informationRequests`, or evidenced unscheduled candidate IDs in
`placeInformationRequests`. Its strict provider schema distinguishes those IDs.
Research can accompany a schedule proposal. Pending tasks survive server restart,
brief confirmations and switching the selected stop within the day. Only legacy
saved records without a task use the previous confirmation compatibility helper.
Information-only requests never alter the schedule, reservations or original
cost estimate, including for booked/completed activities. Every overlay is
reviewed before saving, with inline citations and a check date. Original manual
place descriptions remain intact; researched facts are a separate overlay.

Set optional `AI_PRICING_JSON.enrichment = {search, expiresAt}` only after checking
hosted-search pricing. `search` is integer microdollars per tool call (minimum
10,000); the earlier token/search quote expiry wins. Omit it to disable enrichment
without disabling existing itinerary assistance. No new account or runtime is
needed. Research uses the configured Responses model, fixed OpenAI endpoint,
`store:false`, standard tier, no redirects/retries, `parallel_tool_calls:false`,
`max_tool_calls:2`, low search context and the ordinary output/40-second ceilings.
Only public name, public destination, optional fresh verified position and visit
date enter its input; no raw user
question, itinerary, traveler, accommodation, booking or ticket data.
Manual stops need no coordinates for visitor information: hosted research resolves
the place from its name and destination. Without coordinates a cited `identifiedPlace`
is required and shown in the review and saved details. It does not invent or save
coordinates, replace the manual place or alter its routes. Genuine ambiguity leaves
the facts unverified. Walking route computation still requires verified coordinates.

The reservation covers three possible model passes with the documented 128k
hosted-search context ceiling (or the model ceiling if lower), the configured
output ceiling and two search fees. Returned usage and tool counts are independently
checked. All returned tool actions are conservatively counted as paid searches,
even page-open/find actions. Known usage settles before rejecting malformed,
incomplete or uncited facts. Unknown charges remain held for operator resolution.
All stages count against the existing request/day/month/operation limits. No
price/budget increase or failed-call retry occurs automatically.

If automatically researched facts are rejected after known usage is settled,
itinerary planning can continue with a visible warning and no information overlay.
The independent place and route evidence remains mandatory. An explicit information
update fails without changing the stop if no facts are acceptable. Unknown charges,
budget failures and cancellations still stop the request.

Citations must match actual hosted search sources or URL annotations. Public
HTTPS links have no credentials, query, fragment or local/IP destinations and
are only rendered, never fetched by our server. Official classification is a
researched assessment; extracted facts can be mistaken. Practical fields require
an official-classified source; conflicting or missing evidence stays unknown.
Prices name the admission product and never imply availability or purchase.
Check dates describe consultation, not a guarantee against subsequent closures.
The final projected schedule warns when it lies outside sourced opening windows.

Caches are private and reusable for 24 hours only for the same public identity
and visit date. A current approved overlay is reused without another provider
call; a repeated information update reports that it is already current.
Approval includes an information widget using the same renderer as stop details;
financial amounts remain untouched. General address geocoding, live booking
availability and private accommodation research remain outside this capability.

## Phase 0–2 foundation

The capability registry in `src/domain/ai-capabilities.ts` records permissions,
limits, input/output validators, evidence, effects and fallback contracts. The
planner only sees read/propose permissions; apply remains a separate authenticated
action. Diagnostics expose fixed stage names, outcome categories and bounded
elapsed milliseconds. They contain no raw provider errors or conversations.

`dayInsights` calculates remaining activities in the trip timezone, recorded
progress, walking minutes, gaps, route/booking/opening warnings and group estimates.
Known base costs are counted once per cost record; optional costs and unlinked
expenses are excluded. Missing prices keep the total incomplete. Dated saved FX
converts estimates; actual payments (including archived visits) appear only in
the local authenticated widget and are excluded from model context. Research
prices are saved as an information overlay and never added automatically to
financial estimates. Remaining activity minutes exclude idle gaps and queues.

Hard constraints support unchanged selected stops, avoided places, an evidenced
open visit, a maximum total day walking time, finishing deadline and visit time
window. Preferences remain advisory. The server checks the complete projected
change. Safe duration reductions run before delays; schedule conflicts or measured
route conflicts can trigger another bounded reasoning pass. Routes already
measured for identical endpoints and ordered POIs are reused. Internal passes
cannot relax hard constraints; a new user turn can request a change to them.
Each new pass still reserves its full quote and consumes the existing operation
and request budget. Unknown usage never triggers reconsideration or a retry.

Undo choices are drawn from the selected day's available history and current
fingerprints. Undo is one previewed command, cannot be mixed with other edits,
and does not invoke research or routing. Sourced location overlays preserve an
existing manual stop/place ID and are undone separately from information or
schedule edits. Coordinates describe a sourced building point unless a visitor
entrance is independently verified.

See [evaluation coverage and limitations](AI-EVALUATION.md) for the scripted
conversation suite and the separate live quality gate. Broader restaurant/shop
coverage needs a reviewed place provider; the current Wikipedia adapter is
useful for public landmarks but is not a general geocoder. Cross-day editing,
transit, weather, private documents and external transactions remain later phases.

Billing/context and tool contracts checked on 2026-10-07:
[Responses built-in call ceiling](https://developers.openai.com/api/reference/python/resources/responses/methods/create),
[Hosted search context, citations and actions](https://developers.openai.com/api/docs/guides/tools-web-search),
[Hosted-search pricing](https://developers.openai.com/api/docs/pricing).
