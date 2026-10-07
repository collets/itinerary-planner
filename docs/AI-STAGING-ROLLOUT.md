# AI staging rollout plan

Date: 2026-10-06. Status: execution and a $1 synthetic live pilot authorized by
the owner. Account attestations and pilot evidence are recorded below; this
document does not authorize an expanded budget or use of real trip context.

Goal: make stop replacement, day adjustments and walking/POI advice available
for private staging evaluation, with verified spending controls and a reversible
rollout. Keep the existing React/Vite, Hono, Node and private Blob architecture.
See [implementation and controls](AI-DEVELOPMENT.md) for the current contracts.

## Phase 0–2 implementation update (2026-10-07)

The owner approved the conversation/day-assistance foundation on
`feature/ai-assistance`. See [current behavior](AI-DEVELOPMENT.md#phase-02-foundation)
and [evaluation boundaries](AI-EVALUATION.md). Local scripted coverage is separate
from live language-quality acceptance. Existing project/store isolation,
credentials, prices and caps are retained.

Paid staging remains disabled while operation
`2efcb334-4572-4967-8f07-746c0ee6524b-information-0` has unverified usage.
Its conservative held maximum is 119,072 microdollars ($0.119072). Owner-approved
reconciliation and usage verification are prerequisites to enabling paid testing;
approval to implement code does not release that hold. No provider calls or
ledger changes are needed for the local contract/browser suites.

## Current state and release blockers

- Feature branch: `feature/ai-assistance`; `448cb37` was the baseline before rollout preparation.
- Local verification after preparation passed: 105 unit/API tests, production
  build and all 24 mobile browser checks in Chromium and WebKit.
- [The baseline CI run](https://github.com/collets/itinerary-planner/actions/runs/37456102077)
  passed dependency audit and `pnpm check`, then failed two existing WebKit AI
  tests: proposal confirmation status and manual-draft route proposal generation.
  The other 22 browser tests passed. Local full-suite traces confirmed shared
  process throttles returned 429 for AI mutations and a later login. The test-only
  server now recreates its application between tests, preserving production limits
  and the durable ledger. A regression verifies the 30/minute AI mutation limit.
  [Remote CI for the evaluated application commit `be471db`](https://github.com/collets/itinerary-planner/actions/runs/37495318087)
  is green. [CI for the CLI upload compatibility follow-up `635b156`](https://github.com/collets/itinerary-planner/actions/runs/37497472091)
  is also green; its automatic Preview deployment is ready.
- The isolated feature Preview is ready and has SSO deployment protection enabled.
  The project's first Git deployment targeted Production and was correctly canceled
  by the guard. The evaluated deployment used the documented Preview request
  (omit `target`); its response confirms `target: null`.
- Real provider credentials, model/pricing selection, routing account terms,
  source coordinates and account-level spend enforcement still need verification.
- Runtime/build gates now require matching project and store IDs. The reviewed
  staging branch is supported behind a separate opt-in, currently false.
- Protected CLI transport and the visible AI-preview staging indicator are
  implemented and verified online. The CLI selects presigned OIDC uploads from
  `/config`, matching the browser, while retaining legacy token compatibility.
- Dedicated project and private Frankfurt store are created. Independent
  credentials and an automation bypass are prepared privately. The owner connected
  the store to this project for **Preview only**, with OIDC and no legacy token.
  Mock mode and the ledger are enabled with $1/month, $1/day and $0.25/request
  limits. Provider credentials were subsequently added as described below.
- Deployed checks passed: protected deployment, anonymous/admin role denials,
  same-origin browser login, hostile-origin rejection, no plan writes before
  approval, tampered proposal rejection, exactly-once approval, undo and the
  independent disable/re-enable switch. Ledger spending/reservations are zero.
- A generated test PDF uploaded privately through OIDC and opened through the
  authenticated API; anonymous reads were denied. One focused mobile Chromium
  smoke confirmed the full-screen dialog, selected museum and approval flow.
  The fictional itinerary was restored afterward; no real itinerary was imported.
- The owner confirmed the real-phone mock adjustment flow works. Mock acceptance
  is complete. The owner also supplied saved project-limit and edit-dialog evidence
  confirming a $5/month OpenAI project cap with hard enforcement enabled and a
  100% spend alert. Project identity and evidence are recorded privately.
- The owner confirmed the requested OpenAI credential setup. Vercel metadata
  verifies `OPENAI_API_KEY` is sensitive and **Preview only** in the isolated
  project. The secret was not decrypted and its scopes were not independently
  inspected. Only response creation is required (`api.responses.write`). No paid
  request has validated this credential; live mode remains disabled.
- The owner confirmed free routing setup and supplied the Basic Key quota screen:
  Directions V2 has 2,000 requests available and a 40/minute limit. Vercel metadata
  verifies `OPENROUTESERVICE_API_KEY` is sensitive and **Preview only**. Current
  [HeiGIT terms](https://account.heigit.org/info/tos) were read from the rendered
  account app: route results use CC BY-SA 4.0 and require HeiGIT/OpenStreetMap
  attribution. The adapter now preserves this attribution and license in proposal
  citations and approved leg details. Only public-place coordinates are sent.
- The owner published the edge API rate limit and supplied enabled-rule and
  settings screenshots: paths starting with `/api`, fixed-window 100 requests
  per 60 seconds per IP, returning 429, without an environment condition.
  This is dashboard evidence, not an independent API inspection of the project
  association. Configuration reads and the create attempt return
  `Seawall Config not found` (404) through the connector; the Vercel CLI is absent.
  No successful firewall mutation was reported. Use one fixed-window rule for
  paths starting with `/api`, 100 requests/60 seconds per IP, returning 429.
  This covers normal API paths and the direct function rewrite alias. Keep SSO
  protection enabled; do not add an environment condition. Hobby currently includes
  one rate limit rule and one million allowed requests; review the platform's pricing
  dialog and avoid upgrades. See [Vercel limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
- The owner approved the $1 synthetic live pilot and $0.30/request cap, retaining
  $1/day and $1/month. Live settings are scoped to `feature/ai-assistance` Preview;
  Production and staging branch gates remain disabled. The first deployed model
  test succeeded: a synthetic visit was shortened, approval applied exactly once,
  and undo restored the schedule. Nearby-place discovery and a clarification
  follow-up also succeeded. The free routing operation failed, without a plan
  write or monetary liability. The pilot ledger was disabled for investigation.
  Later direct replacement routes and a fully specified scenic route both passed.
  The earlier free routing failure remains unexplained; its operation was not
  redispatched. No provider key was decrypted and no real itinerary was sent.
- Provider failure diagnostics now log only an allowlisted hostname, fixed
  category and HTTP status, excluding URLs, credentials, bodies and exception
  messages. Tests verify HTTP/network diagnostics cannot leak request secrets.
- Automated evaluation finished after **eight paid requests**, including explicit
  clarification follow-ups. Verified timing approval/retry/undo, nearby Wikipedia
  discovery, scenic walking geometry and POI dwell separation, replacement with
  two measured connections and approval/retry/undo, stale approval rejection,
  delay around a simulated booking and refusal/clarification for booked-stop
  replacement. Undo restores the active ordered itinerary while retaining unused
  archived/catalog records as documented. Conservative settled usage is
  **$0.006514**, with zero active operations or reservations. The ledger is disabled
  awaiting the owner's OpenAI Usage check, then live phone acceptance.
  Provider invoice totals have not been independently inspected.
- [CI for the evaluated diagnostic commit `03de2c5`](https://github.com/collets/itinerary-planner/actions/runs/37532161016)
  is green; local checks passed all 107 unit/API tests and production builds.
- The owner's Data Controls screenshot shows all three sharing options disabled.
  Retain this setting. Discounted sharing is optional and does not eliminate paid
  overage/model exclusions. No setting was changed or inferred to be zero retention.
- Automatic approval review rejected enabling automatic system-variable exposure
  as broader exposure without specific authorization. The setting remains
  unchanged. The actual Preview build passed the metadata checks without this
  change; no broader exposure setting was needed.

### Evaluated deployment metadata

| Item                   | Verified value                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Application commit     | `03de2c52728fa83bdb13f5342748c979cbbc3b6c`                                                         |
| Project                | `itinerary-planner-ai-staging` / `prj_7fg1KNP9xQLGjN5Ve867CWyHAFe5`                                |
| Private store          | `store_vQCAyN5FShZAgVaq`, Frankfurt; one connected project, Preview only                           |
| Deployment             | `dpl_EmDCHFQpxTTodHxxHispUV4h9a5Q`, ready, Preview                                                 |
| Stable feature preview | [Open preview](https://itinerary-planner-ai-staging-git-featur-33163c-collets-projects.vercel.app) |
| Data                   | Fictional Borgo Blu, generated PDF and synthetic public-landmark pilot                             |
| AI                     | Live configuration; ledger disabled pending owner billing/phone acceptance; Production off         |

Private operator files, credentials and detailed validation evidence remain in
ignored `local-data/ai-staging/`. The browser key is `access-key.txt` there; it is
independent of production and the local development key. Keep Vercel protection
enabled and sign in with the authorized Vercel account when opening the preview.

## Deployment arrangement

Recommend a dedicated Vercel project, provisionally
`itinerary-planner-ai-staging`, connected to the same GitHub repository. Give it
one new private Blob store, independent app/session/agent/operator credentials,
and preview-only provider credentials. Do not connect the existing production or
staging stores to this project.

Initially deploy `feature/ai-assistance` as **Preview**. Keep it distinct from the
project's Production Branch: current preview gates reject Production-target
feature builds. Restrict this project's builds to the reviewed feature branch,
then explicitly admit `staging` when promoting. Existing app deployments continue
in their original project.

This is a recommendation to reduce configuration mistakes and separate project
identity; verify actual OIDC store bindings and access. A store-ID equality check
does not prove that a deployment cannot access another connected store.

| Deployment            | Branch                  | Data and credentials             | AI mode                           |
| --------------------- | ----------------------- | -------------------------------- | --------------------------------- |
| Existing production   | `main`                  | Existing production store        | Disabled                          |
| AI evaluation preview | `feature/ai-assistance` | New AI staging project/store     | Mock, then bounded live pilot     |
| Validated AI staging  | `staging`               | Same AI staging store and ledger | Reviewed live pilot configuration |

The existing project's `staging` preview can receive the reviewed code with AI
disabled. The dedicated project becomes the place to evaluate AI on that branch.

An additional project does not inherently require a paid tier under current
[Vercel project limits](https://vercel.com/docs/limits). Check the actual team's
plan and remaining deployment/storage/operation quotas before provisioning.
Separate projects are not a promise of separate infrastructure usage allowances.

## 1. Establish the security and spending release gates

Owner: implementation agent; provider account attestations belong to the owner.

- [x] Inspect CI traces/API responses and fix the two WebKit failures. Use focused
      checks locally; run the complete required pipeline on the release commit.
      Do not add retries or weaken approval assertions to hide an unknown failure.
- [x] Review authentication, origin checks, request limits, private Blob/OIDC
      scope, typed actions, booking protection and server-only provider secrets.
      Recheck duplicate dispatch, uncertain-charge holds and independent admin
      authorization where deployment changes affect them.
- [x] Keep the durable budget disabled until the target store and credentials
      are verified. Confirm the operator can read and disable it independently.
- [x] Propose these pilot limits: **$1/month, $1/day, $0.25/request**, twelve
      operations/request. This bounds the initial evaluation across requests;
      no automatic allowance increase or financial ledger reset.
- [x] Verify the selected model's full-window reservation fits the request cap.
      Prices must include applicable token surcharges. If it does not fit, choose
      another verified compatible model or seek a separately approved cap change.
- [x] For live operation, verify a dedicated OpenAI project's enforced hard spend
      limit and alerts before setting the account-attestation flag. Recommend a
      $5 provider cap as a separate account safeguard, subject to account settings.
      [Official OpenAI documentation](https://developers.openai.com/api/docs/guides/spend-limits)
      distinguishes enforced limits from notification-only alerts and notes that
      enforcement can lag. The application cap cannot protect a stolen key used
      outside the application, and neither cap is a total infrastructure invoice cap.

Pilot limit file, stored in ignored `local-data/ai-staging-limits.json`:

```json
{ "monthly": 1000000, "daily": 1000000, "request": 250000, "operations": 12 }
```

### Proposed live model and reservation

Current [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)
documents Responses, strict Structured Outputs, a 1,050,000-token context and
`reasoning.effort=none` for `gpt-6-luna`. GPT-5 mini was considered initially, but
its current page labels it deprecated. GPT-6 Luna is the proposed first pilot model;
account availability has not yet been verified by an inference request.

[Standard pricing](https://developers.openai.com/api/docs/pricing), verified on
2026-10-06, is $0.10/million input, $0.125/million cache writes and $0.50/million
output for short context. Long-context cache writes are $0.25/million and output
is $0.75/million. The proposed price file conservatively uses the latter pair for
all usage, without assuming caching discounts. API requests use default Standard
processing on the global endpoint, with no regional-processing or fast-mode premium.
Settled token costs in the application ledger therefore remain conservative
estimates rather than a reproduction of the provider invoice.

Reserve the complete documented context plus 4,096 output tokens:
`1,050,000 × $0.25 / 1,000,000 + 4,096 × $0.75 / 1,000,000 = $0.265572`.
The old $0.25/request limit correctly rejects this before dispatch. The owner
approved **$0.30/request**, retaining **$1/month and $1/day** and twelve
operations/request, and these exact limits were verified in the durable ledger.
The model schema now accepts its actual full context instead of
understating it; the 24 KB application context limit remains enforced.

Ignored `local-data/ai-staging/live-pricing.json` contains this seven-day price
verification and `proposed-live-limits.json` contains the approved limits.
The price configuration is enabled only on the isolated feature Preview. Hosted
search stays disabled and routing/research
must remain zero cost. Use only synthetic evaluation data with sourced public
landmark coordinates for the initial pilot. Seek separate approval before real
trip context or any allowance increase. Failed/uncertain operations are not
automatically redispatched; a settled clarification can receive an explicit new
follow-up request within the approved budget.

Exit gate: required CI green, security review findings resolved, and the operator
disable path verified without a provider call.

## 2. Prepare isolated staging infrastructure and tooling

Owner: implementation agent where connectors allow it; owner for account/UI steps.

- [x] Create the dedicated project and private European-region store. Connect
      only that store to its Preview environment using OIDC. New connections use
      [short-lived OIDC authentication](https://vercel.com/changelog/vercel-blob-now-supports-oidc-authentication);
      no copied legacy Blob token is needed.
- [x] Generate independent browser/agent/operator keys and session signing secret.
      Store raw credentials only in ignored local files or secret settings;
      store hashes in the application settings. Never use a `VITE_` prefix.
- [x] Configure branch-scoped settings, preview protection and available firewall
      rules for login and AI create/advance routes. App authentication and durable
      limits remain mandatory even behind deployment protection.
- [x] Add optional protected CLI access using an ignored automation secret in the
      `x-vercel-protection-bypass` header, restricted to the configured HTTPS
      deployment host with rejected redirects. Retain app/operator authentication.
      Keep the secret out of URLs, logs, exports and frontend code.
- [x] Verify provider upload callbacks still work with preview protection; retain
      private PDF storage and authenticated original-file access.
- [x] Make the UI visibly identify AI staging, including the `ai-preview`
      environment.
- [x] Build guard must skip this project's unrelated branches and reject
      Production targets, mismatched store IDs, legacy tokens and inherited seeds.

Initial feature-branch settings:

The project identity/environment markers are set in all target environments so
the dedicated project's Production and unrelated branch builds are also denied.
App credentials and mock/provider settings are Preview only.

| Setting                                                                                | Initial value                    |
| -------------------------------------------------------------------------------------- | -------------------------------- |
| `APP_ENVIRONMENT`                                                                      | `ai-preview`                     |
| `STORAGE_DRIVER`                                                                       | `blob`                           |
| `BLOB_STORE_ID`                                                                        | New OIDC-connected store ID      |
| `AI_PREVIEW_STORE_ID`                                                                  | Same new store ID                |
| `AI_PREVIEW_PROJECT_ID`                                                                | Actual dedicated project ID      |
| `AI_STAGING_BRANCH_ENABLED`                                                            | `false` until reviewed promotion |
| `AI_PREVIEW_ENABLED`                                                                   | `true`, after isolation review   |
| `AI_MODE`                                                                              | `mock`                           |
| `AI_LIVE_ENABLED`                                                                      | `false`                          |
| `AI_PRODUCTION_ENABLED`                                                                | `false`                          |
| `TRAVEL_EDITING_ENABLED`                                                               | `true`                           |
| `APP_ACCESS_KEY_HASH`, `AGENT_API_TOKEN_HASH`, `SESSION_SECRET`, `AI_ADMIN_TOKEN_HASH` | Independent generated values     |
| `BLOB_READ_WRITE_TOKEN`, `STAGING_SEED`                                                | Absent                           |
| `OPENAI_API_KEY`, `OPENROUTESERVICE_API_KEY`                                           | Absent during mock validation    |

Exit gate: deployment identity/store access verified and protected CLI status/import
works. Record only non-secret configuration metadata in the rollout notes.

## 3. Deploy and validate mock mode online

Owner: implementation agent; owner for a brief real-phone acceptance check.

- [x] Deploy the green feature commit. Start with an empty store and import only
      fictional test data through the authenticated API/CLI.
- [x] Enable the mock ledger with the independent operator CLI and the proposed
      pilot limits. No provider account is needed for this stage.
- [ ] Verify stop entry points/selection, timing changes, proposal comparison,
      explicit approval, undo, manual-draft inclusion and stale-plan rejection.
- [ ] Verify private PDF upload/open, offline draft/read behavior, reconnect without
      automatic requests, logout cleanup and protected booked/completed activities.
- [x] Verify unauthenticated AI/admin requests are rejected and ordinary family or
      itinerary-agent credentials cannot administer spending controls.
- [x] Demonstrate disable/status/re-enable using mock requests. Record the target
      commit, store identity and outcome. Keep phone/browser testing focused.

Exit gate: owner can use the preview on a phone, private storage works, and the
kill switch prevents subsequent dispatch. Mock replacement requests must explain
their limitation; they do not establish real replacement quality.

## 4. Configure live providers and perform a bounded evaluation

Owner: owner provisions accounts/accepts billing; implementation agent configures
and evaluates within the expressly approved pilot allowance.

- [x] Create the dedicated OpenAI project/service credential with only required
      inference access; verify model/account availability, enforced cap and alerts.
- [x] Provision an OpenRouteService key; verify free-plan quotas, attribution and
      storing route evidence. No paid fallback or automatic upgrade.
- [x] Select one exact model compatible with Responses and strict Structured
      Outputs. Verify current prices/context window/output ceiling, then prepare
      `AI_PRICING_JSON` with a short expiry. Do not use illustrative prices.
- [x] Prepare synthetic public-landmark itineraries without real tickets, booking
      references or traveler identities. The owner authorized only this synthetic
      context. Verify the source monument coordinates, label entrances/access as
      unverified, and use a clearly simulated booked anchor to test protection.
- [x] First disable the mock ledger. Set server-only keys, `AI_MODE=live`,
      `AI_LIVE_ENABLED=true`, `AI_PROVIDER_SPEND_CAP_CONFIRMED=true`, and
      `AI_ROUTING_FREE_PLAN_CONFIRMED=true`; keep production permission false.
      Redeploy, validate configuration without inference, then explicitly enable
      the ledger with the approved limits. Preserve its financial history.
- [x] Run at most eight deliberately selected requests, stopping at the $1 pilot
      limit or any safety failure. Cover replacement with two connecting routes,
      direct/scenic POIs and dwell time, delay around a booking, follow-up,
      unsuitable/unknown alternatives, protected-stop replacement refusal and
      stale approval. Use fresh plan reads and review proposals before applying.
- [ ] Compare route evidence and sources manually, check entrance suitability,
      and record request IDs, latency, failures, reserved/settled costs and provider
      usage privately. Never retry an uncertain charge; reconcile using evidence.
- [x] Disable after evaluation and resolve findings before enabling regular
      staging access. Do not spend additional funds just to rerun browser tests.

This pilot uses bounded Wikipedia discovery and verified walking routes. Official
opening-hours search, arbitrary web browsing, geocoding, transit optimization and
booking/payment remain outside the implemented scope. Unknown facts must be
shown as unknown; lack of evidence should produce clarification.

Exit gate: reviewed usable proposals, accurate evidence/uncertainty, preserved
protected activities, reconciled usage within limits and a working disable path.

## 5. Promote the validated release to the staging branch

Owner: implementation agent prepares the reviewed change; repository/account owner
handles any approval or permission gate that the available tools cannot satisfy.

- [ ] Generalize the runtime/build gates to explicitly allow `staging` in the
      dedicated project, requiring its expected project/store/environment and
      explicit enable flag. Keep arbitrary branches and Production targets denied.
      Add gate tests before promotion; changing the branch name is insufficient.
- [ ] Prepare the feature-to-staging PR with CI, mock/live evaluation evidence,
      limitations, settings and rollback instructions. Resolve any branch drift.
- [ ] Back up staging documents and original test tickets privately before any
      data import. Apply normal branch protections and required CI checks.
- [ ] Merge and deploy `staging` in the dedicated project with its reviewed store,
      credentials and **same financial ledger**. Start disabled; verify the actual
      deployment/commit/configuration, then explicitly enable the approved pilot.
- [ ] Keep existing-project AI settings disabled; confirm its staging and main
      deployments remain readable with their existing independent stores.
- [ ] Perform a small authenticated smoke check and owner phone acceptance check.
      Record the green commit, URL, remaining allowance and operator disable command.

Exit gate: stable private AI staging URL, green CI and accepted functionality under
the reviewed spending allowance. Production promotion requires a separate review.

## Rollback and stop conditions

1. Use the independent operator command to disable the ledger immediately.
2. Set `AI_MODE=disabled` and redeploy to hide assistance while keeping ordinary
   itinerary/manual editing available. Do not delete the ledger or unsettled jobs.
3. Disable the preview build flag if configuration/store scope is wrong. Revoke
   the provider credential if exposed; app configuration alone cannot contain it.
4. Undo approved itinerary changes only after checking the current shared version;
   retain financial records. Use compatible code when reverting a deployment.

Stop rollout for red required CI, uncertain charges, incorrect store permissions,
booking changes, invented evidence, unusable routes or failure of the kill switch.

## Owner checklist and implementation order

Owner actions, requested only when their phase is ready:

- [x] Connect the new private Blob store if the connector cannot create the binding.
- [x] Configure any deployment-protection automation credential needed by the CLI.
- [x] Create the dedicated OpenAI project/key and verify hard spend enforcement.
- [x] Create the routing account/key and confirm its free-plan/storage terms.
- [x] Approve the $1 live pilot and synthetic public-landmark context.
- [ ] Confirm OpenAI Usage for the dedicated project (eight requests; compare
      displayed spend with the conservative ledger estimate).
- [ ] Complete a short live phone acceptance check; mock phone acceptance passed.

The implementation agent can investigate/fix CI, prepare gate/CLI changes, tests,
synthetic fixtures, configuration templates and PR material before provider setup.
Account creation, billing attestations and paid dispatch wait for owner input.
This planning step does not provision resources, enable AI, or promote branches.
