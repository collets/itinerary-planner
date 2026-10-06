# AI staging rollout plan

Date: 2026-10-06. Status: execution authorized by the owner; account attestations
and a paid pilot still require owner confirmation. This document is not a billing
authorization.

Goal: make stop replacement, day adjustments and walking/POI advice available
for private staging evaluation, with verified spending controls and a reversible
rollout. Keep the existing React/Vite, Hono, Node and private Blob architecture.
See [implementation and controls](AI-DEVELOPMENT.md) for the current contracts.

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
  is green. The CLI upload compatibility follow-up requires its own CI gate.
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
  limits; no live provider keys are present.
- Deployed checks passed: protected deployment, anonymous/admin role denials,
  same-origin browser login, hostile-origin rejection, no plan writes before
  approval, tampered proposal rejection, exactly-once approval, undo and the
  independent disable/re-enable switch. Ledger spending/reservations are zero.
- A generated test PDF uploaded privately through OIDC and opened through the
  authenticated API; anonymous reads were denied. One focused mobile Chromium
  smoke confirmed the full-screen dialog, selected museum and approval flow.
  The fictional itinerary was restored afterward; no real itinerary was imported.
- Next owner action: a real-phone acceptance check of the mock preview. Live
  provider setup and billing authorization remain subsequent gates.
- Automatic approval review rejected enabling automatic system-variable exposure
  as broader exposure without specific authorization. The setting remains
  unchanged. The actual Preview build passed the metadata checks without this
  change; no broader exposure setting was needed.

### Evaluated deployment metadata

| Item                   | Verified value                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Application commit     | `be471dbeff52cc4870162f02cd77971b29bddf24`                                                         |
| Project                | `itinerary-planner-ai-staging` / `prj_7fg1KNP9xQLGjN5Ve867CWyHAFe5`                                |
| Private store          | `store_vQCAyN5FShZAgVaq`, Frankfurt; one connected project, Preview only                           |
| Deployment             | `dpl_77KCzDFYRq7PyztsvfFBMjca3fSz`, ready, Preview                                                 |
| Stable feature preview | [Open preview](https://itinerary-planner-ai-staging-git-featur-33163c-collets-projects.vercel.app) |
| Data                   | Fictional Borgo Blu itinerary and generated test PDF                                               |
| AI                     | Mock; live/production flags false; no provider credentials                                         |

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
- [ ] Review authentication, origin checks, request limits, private Blob/OIDC
      scope, typed actions, booking protection and server-only provider secrets.
      Recheck duplicate dispatch, uncertain-charge holds and independent admin
      authorization where deployment changes affect them.
- [x] Keep the durable budget disabled until the target store and credentials
      are verified. Confirm the operator can read and disable it independently.
- [x] Propose these pilot limits: **$1/month, $1/day, $0.25/request**, twelve
      operations/request. This bounds the initial evaluation across requests;
      no automatic allowance increase or financial ledger reset.
- [ ] Verify the selected model's full-window reservation fits the request cap.
      Prices must include applicable token surcharges. If it does not fit, choose
      another verified compatible model or seek a separately approved cap change.
- [ ] For live operation, verify a dedicated OpenAI project's enforced hard spend
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
- [ ] Configure branch-scoped settings, preview protection and available firewall
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

- [ ] Create the dedicated OpenAI project/service credential with only required
      inference access; verify model/account availability, enforced cap and alerts.
- [ ] Provision an OpenRouteService key; verify free-plan quotas, attribution and
      storing route evidence. No paid fallback or automatic upgrade.
- [ ] Select one exact model compatible with Responses and strict Structured
      Outputs. Verify current prices/context window/output ceiling, then prepare
      `AI_PRICING_JSON` with a short expiry. Do not use illustrative prices.
- [ ] Prepare an isolated copy of the real itinerary without real tickets, booking
      references or traveler identities. Use synthetic booked anchors to test
      protection. Confirm permission to send its selected-day place/schedule
      context to providers. Verify sourced entrance coordinates before routing.
- [ ] First disable the mock ledger. Set server-only keys, `AI_MODE=live`,
      `AI_LIVE_ENABLED=true`, `AI_PROVIDER_SPEND_CAP_CONFIRMED=true`, and
      `AI_ROUTING_FREE_PLAN_CONFIRMED=true`; keep production permission false.
      Redeploy, validate configuration without inference, then explicitly enable
      the ledger with the approved limits. Preserve its financial history.
- [ ] Run at most eight deliberately selected requests, stopping at the $1 pilot
      limit or any safety failure. Cover replacement with two connecting routes,
      direct/scenic POIs and dwell time, delay around a booking, follow-up,
      unsuitable/unknown alternatives, protected-stop replacement refusal and
      stale approval. Use fresh plan reads and review proposals before applying.
- [ ] Compare route evidence and sources manually, check entrance suitability,
      and record request IDs, latency, failures, reserved/settled costs and provider
      usage privately. Never retry an uncertain charge; reconcile using evidence.
- [ ] Disable after evaluation and resolve findings before enabling regular
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

- [ ] Connect the new private Blob store if the connector cannot create the binding.
- [ ] Configure any deployment-protection automation credential needed by the CLI.
- [ ] Create the dedicated OpenAI project/key and verify hard spend enforcement.
- [ ] Create the routing account/key and confirm its free-plan/storage terms.
- [ ] Approve the $1 live pilot and the selected itinerary context.
- [ ] Complete a short phone acceptance check.

The implementation agent can investigate/fix CI, prepare gate/CLI changes, tests,
synthetic fixtures, configuration templates and PR material before provider setup.
Account creation, billing attestations and paid dispatch wait for owner input.
This planning step does not provision resources, enable AI, or promote branches.
