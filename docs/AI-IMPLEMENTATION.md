# AI assistance implementation plan

Date: 2026-10-05. Status: implementation proposal for review. This document starts
the AI work; it does not enable paid requests. See [feasibility](AI-FEASIBILITY.md)
and the [security requirements](SECURITY-AUDIT.md#mandatory-design-before-paid-ai).

## Working arrangement

- Branch: `feature/ai-assistance`, based on hardened staging commit
  `3bb879ac697ee718ba72f7944aaffb623dc1a09f`.
- Separate local worktree: `/tmp/itinerary-planner-ai`. The application worktree
  stays on `staging`; production stays on `main`.
- The temporary path is convenient in this workspace, not a durable backup.
  Preserve work in commits; move the worktree to a permanent directory when needed.
- Start with local FileStorage, fictional fixtures and deterministic providers.
  Do not copy personal source files, tickets, `.env` files or access keys.
- Keep commits small by milestone. Bring subsequent security fixes from staging
  into this branch before release; do not merge unfinished AI changes into staging.
- After staging passes CI, release its existing hardening independently of AI.
  CI is currently delayed by GitHub's runner-assignment incident.
- Do not push the feature branch until its preview configuration has been reviewed.
  A Vercel preview is a deployment of this same project, not a separate security
  boundary. It can inherit staging Blob access and environment variables.
- For an online AI preview, use branch-specific settings, a separate private test
  Blob store, separate credentials and fictional seed data. Keep paid mode disabled.
  Prevent the existing staging seed script from seeding that store unintentionally.
- Merge reviewed milestones to staging, verify them there, then merge to main.
  Publishing a branch does not by itself configure safe environment isolation.

## First release

Two entry points share the same proposal engine:

1. **Inside Adatta:** `Suggerisci percorso e luoghi` for affected connections.
   Show a direct walking route and, when useful, one scenic alternative with
   at most three POIs, detour time, visit allowance and cited information.
2. **Day assistance:** `Chiedi aiuto` accepts an Italian request such as
   “Siamo in ritardo di 40 minuti; mantieni la visita prenotata.” It produces
   up to two coordinated proposals, with an explanation and schedule comparison.

Every proposal is reviewed with `Applica queste modifiche`. The model cannot
apply a plan, change a booking, buy tickets or alter spending controls. Replies
can refine an existing proposal, subject to a new reservation and fresh context.

Initial scope is walking, selected/manual starting points and known stops with
nearby attractions. Transit optimization, GPS tracking, automatic background
replanning, voice, booking/payment and ticket interpretation are deferred.

Manual editing stays available offline. Save unsent questions as local drafts;
do not automatically purchase AI requests when connectivity returns. Previously
downloaded advice remains readable with its research date and stale-state label.
For the first release, applying an AI proposal requires connectivity. This avoids
presenting an unverified offline proposal as an accepted shared itinerary change.

## Architecture decisions

Keep React/Vite, Hono, Node 24, private Blob and the existing shared domain layer.
Use the OpenAI Responses API behind a provider interface, with explicit strict
function schemas and structured proposal output. Application code executes a
small allowlist of tools; it validates every result independently of the model.
[Function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Use a bounded application orchestrator initially; an agent framework, vector
database and infrastructure migration are unnecessary for this scope. The model
and its pricing table are server configuration. Final selection follows mocked
evaluations, verified account availability and a bounded live comparison.

Provider interfaces:

- `AssistantProvider`: interpret intent and return typed proposals/tool requests.
- `RoutingProvider`: sourced entrances, walking directions, distance and duration.
- `ResearchProvider`: bounded factual lookup and evidence for POIs/opening hours.
- `CostPolicy`: allowlisted models, verified prices and maximum billable usage.

First routing candidate is openrouteservice. Its actual account quotas, local
entrance quality, attribution and offline storage terms must be checked before
live use. Research is independently budgeted; model memory is not route evidence.

### Records and endpoints

Store AI records separately from trip documents. Proposed paths:

| Record                   | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `ai/control.json`        | Workspace kill switch and control revision                        |
| `ai/budget.json`         | Authoritative global spend/reservation ledger and dispatch claims |
| `ai/jobs/<id>.json`      | Bounded context, progress, checkpoints and proposal references    |
| `ai/proposals/<id>.json` | Reviewed actions, route evidence, preview hash and trip version   |

All records use private authenticated storage. The budget ledger is the authority
for paid dispatch; job snapshots cannot authorize spending. No compound operation
may assume a transaction across several Blob objects.

Proposed authenticated routes under `/api/v2/trips/:id/ai`:

| Method/path                         | Behavior                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| `POST /requests`                    | Create an idempotent job after validating intent and context |
| `GET /requests/:requestId`          | Read progress; never starts paid work                        |
| `POST /requests/:requestId/advance` | Advance one safely claimed, budgeted stage                   |
| `POST /requests/:requestId/cancel`  | Stop future stages without releasing uncertain charges       |
| `GET /proposals/:proposalId`        | Read a validated proposal and its stale status               |
| `POST /proposals/:proposalId/apply` | Confirm the exact proposal and atomically apply it           |

Names are provisional. Reuse authentication, same-origin checks, streamed body
limits, UUIDs and ETags. Read the actual trip before generation and application.
Pending offline edits must sync or be explicitly resolved before generating from
the shared plan. Tool inputs cannot select another credential, store or workspace.

### Domain extensions

`RouteInput` currently accepts endpoints, mode and duration only. Add a separately
validated route-evidence shape for streets, distance, coordinates, POIs, source
URLs, freshness, attribution and estimate status. Preserve compatibility with
existing manual/offline commands; never fabricate missing coordinates.

Add pure batch preview logic and a proposal apply operation in `TripService`:

- Validate the ordered actions against a cloned trip and final schedule.
- Preserve stable IDs, the authored baseline, tickets, bookings, completed stops
  and explicit locks. Research cannot silently waive these constraints.
- Store one trip commit using the original ETag and one reversible history entry.
  Never apply a coordinated proposal via a sequence of public mutation endpoints.
- Bind approval to proposal ID, content hash, base version and expiry. A changed
  trip requires renewed review; never attach a fresh ETag to an old proposal.
- Record the apply ID inside the trip commit. If the proposal-status write fails,
  a retry derives success from the trip instead of applying the changes twice.
- Keep budget accounting separate from trip undo/restore/delete operations.

## Financial and security controls

Treat a stolen family login as a valid caller. Authentication and confirmation
alone cannot protect against repeated generation charges.

Provisional pilot ceilings, requiring owner confirmation before live use:
**$10/month, $1/day, $0.25/request, one active generation across the workspace**.
These are maximum allowances, not a target bill or a guaranteed account feature.

1. Default `AI_MODE=disabled`. Local/test `mock` mode has no external provider
   access. Paid mode requires valid configuration and durable control storage.
2. Before every paid dispatch, reserve its provable worst-case cost with CAS in
   the global ledger. Use integer microdollars and account for model input/output,
   reasoning tokens, hosted tools and routing charges. Unknown prices, unsupported
   billing bounds, exhausted limits or unavailable storage must reject dispatch.
3. Bound context, conversation history, tool output, model rounds, output tokens,
   searches, route calls and elapsed time. Start with at most three model rounds,
   two searches and six route calls; tighten these after measured evaluations.
4. A typical-cost estimate is not a hard bound. Hosted search may introduce input
   tokens outside the locally constructed prompt. Verify an enforceable upper
   bound and reserve it; otherwise keep that adapter disabled or use a separately
   bounded research service. Deny any request that cannot fit the per-request cap.
5. Disable automatic provider retries. Persist dispatch ownership before calling
   the provider. Duplicate browser requests, polls and concurrent instances cannot
   start the same operation twice. Input changes cannot reuse an old idempotency ID.
6. Settle verified usage against its reservation. A crash, cancellation, timeout
   or expired lease does not prove that a call was free: retain uncertain amounts
   and block unsafe redispatch. Budget resets cannot erase outstanding liabilities.
7. Check the durable kill switch before every paid operation. Operator controls
   require a distinct administrative capability, not the family browser session.
   Document the unavoidable boundary: a provider request already accepted may bill.
8. Configure separate restricted provider projects/credentials for preview and
   production, with an independently enforced provider ceiling where available.
   Verify enforcement in the account; alerts alone are insufficient. Never put an
   administration credential or provider key in the client or agent context.
9. Tool permissions are read/research/preview only. No arbitrary URL fetch, shell,
   code execution, budget manipulation, booking or direct storage tool. Protect
   routing/research adapters against SSRF and excessive query sizes.
10. Exclude ticket bytes, QR codes, booking references, credentials and unrelated
    trips from prompts and logs. Send reservation constraints without private
    references. Treat web text as evidence, never as authorization or instructions.

Start with foreground requests and local conversation summaries. Review provider
data retention and explicit storage settings before live use. Do not claim zero
retention from disabling response storage alone.

## Execution milestones

### 1. Budget and request security, no provider accounts needed

Complete this milestone before AI domain features, the assistance UI or a live
provider integration. Build it around a fake counted provider so every attempted
dispatch is observable without making a paid request.

- Pure cost-policy, ledger, reservation, dispatch and control schemas.
- Server-owned, disabled-by-default configuration and operator-only controls.
- Durable workspace-wide budget service with CAS and integer cost arithmetic.
- Worst-case reservation and verified settlement for every billable operation.
- Daily/monthly/request caps, one active generation, bounded input and tool quotas.
- Idempotency, dispatch claims, retained uncertain charges and safe recovery.
- Durable kill switch, deadlines, explicit cancellation and disabled automatic retries.
- Authenticated API, same-origin enforcement, body limits and no secret logging.
- Tests against separate service instances sharing the same storage, plus failures
  injected between claim, dispatch, response and settlement.

Acceptance: simultaneous requests cannot overspend; duplicate IDs cannot
redispatch; a changed payload cannot reuse an ID; unavailable storage and unknown
prices block all paid dispatch; timeout/crash/rollover cannot erase liabilities.
The family browser session cannot increase limits or turn off these safeguards.
The fake provider's dispatch counter must remain zero for every rejected request.

### 2. Atomic proposals and complete mobile workflow using mocks

- Pure schemas for context, proposals, route evidence and jobs.
- Route enrichment and atomic batch preview/apply through existing domain rules.
- Private job/proposal storage with stale/version detection and bounded retention.
- Mock assistant/routing/research adapters with canned results and failures.

- Assistance within Adatta and a lightweight day-level `Chiedi aiuto` dialog.
- Italian progress, cancellation, clarification, two-option preview and sources.
- Schedule comparison with protected anchors and visible POI detour allowances.
- Request reuse/recovery on reload and explicit handling of expired/uncertain jobs.
- Offline drafts and cached advice; online-only proposal application with clear UI.
- Keep both overview and detailed modes using the shared itinerary sequence.

Acceptance: stale proposals cannot apply; a failed batch leaves the trip
unchanged; private information cannot appear in model context. Demonstrate both
requested features on mobile Chrome/Safari without keys, external calls or
changing the real itinerary. Keyboard/modal behavior, offline drafts and
conflicting edits remain usable. The budget controls from milestone 1 still gate
all provider dispatch, including refinements and retries.

### 3. Provider adapters and evaluation, still disabled by default

- Implement the OpenAI adapter and the bounded server tool loop against mocks.
- Implement walking-route and POI research adapters behind capability checks.
- Add a small evaluation corpus using fictional trips and checked route examples:
  delays, fixed bookings, lunch requests, ambiguous entrances, insufficient time,
  injected web instructions, malformed output and missing coordinates.
- Verify price calculations, token/tool bounds, cancellation and all retry paths.
- Keep each server stage comfortably inside the current 60-second function limit.
  Checkpoint between stages; paid advancement uses authenticated POST requests.
  Do not depend on `waitUntil`, an open browser stream or SDK memory for durability.
- Measure whether the existing duration suffices. Change it only if observed
  provider latency requires it and the Vercel project's supported limits are verified.

Acceptance: representative mocks pass; provider results always pass application
validation; tool limits and financial invariants remain enforced on every stage.
No live AI credentials or requests are required to reach this milestone.

### 4. Owner setup and explicitly bounded live pilot

Owner inputs are needed only here:

- Confirm the pilot budget and maximum detour/walking preferences.
- Provide a dedicated inference credential through server settings, not chat.
- Verify account model access, billing ceiling and key restrictions.
- Obtain the routing account and verify free allowance/storage terms.
- Connect an isolated AI preview store with branch-specific environment settings.
- Confirm a small live evaluation allowance before making paid requests.

Run a few representative requests, record usage/latency and check sources against
the actual provider output. Test private Blob ledger concurrency in this isolated
store. Failed checks leave paid mode disabled. Compare model quality and cost
before choosing the default; never silently fall back to a more expensive model.

### 5. Staging and production release

- Complete `pnpm check` and Chromium/WebKit production browser tests.
- Review abuse/concurrency tests and the bounded live evaluation record.
- Configure production's independent budget/provider/store settings.
- Roll out to staging, then main, with the kill switch initially off for paid work.
- Enable paid mode only after the live-use checklist passes. Verify the installed
  PWA update, cancellation and recovery. Document disabling/revoking credentials.
- Code rollback does not roll back or reset the financial ledger. Keep budget
  obligations and existing trip data compatible across versions.

## Review decisions

Recommended initial choices: walking first, explicit assistance actions, reviewed
atomic application, online application of AI proposals, and the provisional small
spending limits above. Provider/model selection follows account checks and evals.

The next implementation slice after review is milestone 1, followed immediately
by a mocked mobile workflow. No paid setup is needed while building those slices.
