# Security audit and AI launch requirements

Reviewed on 2026-10-05. Scope: the staging application, public repository history,
dependency lockfile, authentication, all API route families, ticket upload and
viewing, private storage, offline data, travel commands, deployment configuration
and CI. Four anonymous, read-only requests checked the current production site.

This is a source and architecture review with targeted regression and abuse tests.
It is not an independent penetration test or a guarantee that every exploit has
been found. No production load testing, credential extraction, preview-protection
bypass, account permission changes or paid service activation was performed.

## Assessment

The application has useful existing protections: strong generated shared keys,
separate browser and automation credentials, signed HttpOnly sessions, browser
origin checks, authenticated ticket reads, private Blob storage, schema validation,
conditional writes and protection of booked/completed activities.

Several gaps needed hardening. The changes below are intended for staging first;
the current production deployment does not receive them until promotion.

**Paid AI must remain disabled until the financial controls in this document are
implemented and tested.** The reviewed application has no OpenAI endpoint or
OpenAI credential, so its current code cannot be used to generate OpenAI charges.
Authentication alone would be insufficient once such an endpoint exists.

## Findings and changes

| Finding                                                  | Severity / context                                                                                                                                                                                           | Resolution                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Affected PDF.js dependency                               | High upstream advisory; exploitation depends on scripting configuration. Our custom viewer renders canvas and does not instantiate the full scripting viewer; arbitrary script execution was not reproduced. | Updated `pdfjs-dist` from 5.7.284 to patched 6.4.299. Added browser CSP and bounded PDF image/canvas allocations.                                                                                                                                 |
| Advisories in unused Vercel development SDK dependencies | High to low upstream severity; these packages were not imported into the runtime, and build-tool advisories are not equivalent to a remotely exploitable app.                                                | Removed `@vercel/node`, used native Node HTTP types, retained the real adapter integration test. Removed 79 packages.                                                                                                                             |
| One 11 MB body allowance, parsed before authentication   | Medium: unauthenticated requests could consume parsing/buffering resources; small mutations accepted unnecessarily large payloads.                                                                           | Private routes now authenticate and check browser origin first. Limits count actual streamed bytes, independently of `Content-Length`. Separate limits for login, callbacks, mutations, plans and files.                                          |
| Missing application throttles                            | Medium for current resource abuse; a future paid API would create financial exposure.                                                                                                                        | Added supplemental process-local throttles and Italian 429 handling. Distributed edge control remains a dashboard task below; local throttles are not a spending cap.                                                                             |
| No SPA Content Security Policy                           | Medium defense gap against injection and data exfiltration; no existing application XSS was demonstrated.                                                                                                    | Enforced CSP in Vercel configuration and local production previews. Blocks inline scripts, arbitrary outbound fetches, frames and objects. Allows local assets and Blob upload destinations.                                                      |
| Unbounded text/catalog data and exchange-rate fan-out    | Medium authenticated resource abuse.                                                                                                                                                                         | Bounded fields and catalogs, capped validation error output at 25 issues, limited rate refresh to eight non-EUR currencies and avoided unchanged document writes.                                                                                 |
| FileStorage accepted leading absolute paths              | Low: current routes construct storage paths internally, so no direct API exploit was demonstrated.                                                                                                           | Explicitly rejects absolute paths as well as traversal. Added escape-path tests.                                                                                                                                                                  |
| OIDC store uploads still used the legacy token helper    | Availability/configuration defect, with pressure to retain unnecessary long-lived credentials.                                                                                                               | Added the SDK's OIDC presigned upload flow, keeping legacy-token deployments compatible. Delegation is `put` only, for the exact pending ticket path, declared MIME type/size and ten minutes. Signed completion verification remains in the SDK. |
| Dependency advisories could recur unnoticed              | Maintenance gap.                                                                                                                                                                                             | CI rejects high/critical production dependency advisories; weekly Dependabot version PRs target staging. CI token permissions restricted to repository read access.                                                                               |

The initial full dependency scan reported 19 advisories: six high, nine moderate
and four low. After the changes the full scan reported **zero known advisories**.
This does not assess undisclosed vulnerabilities, Vercel's internal build tooling,
the platform's Node runtime or browser decoders.

## Authentication and authorization review

- Setup generates 32 random bytes for each browser key and automation token.
  SHA-256 is appropriate for these high-entropy generated secrets; a human-chosen
  short password would not have the same protection. Keep generated credentials.
- Browser sessions use HS256 with issuer, audience and expiry checks, a server
  signing secret, HttpOnly cookies, HTTPS `Secure`, `SameSite=Strict` and a 30-day
  lifetime. Bearer authorization and browser cookies are distinct credentials.
- Forged and expired cookies and browser keys presented as agent tokens are
  rejected. Oversized credentials and malformed configured hashes fail closed.
- Changing the access-key hash invalidates existing online sessions. Changing the
  session secret also invalidates them; agent-token rotation is independent.
- Browser writes require an exact matching origin, including when a valid cookie
  is present. Missing origins and cross-site origins fail. The known local Vite
  exception is disabled in Vercel/production. CORS is not an authorization layer.
- Browser users can make travel adjustments and manage bookings/tickets; full plan
  replacement, trip creation/deletion and plan history restoration require agent
  access. The agent token is powerful: never hand it to an LLM or a browser.
- This is one trusted family workspace. Both people share access to every trip
  and ticket. Traveller labels are assignments, not separate access permissions.
- Logout removes the browser cookie online and clears local data. A copied JWT
  remains valid until expiry/key rotation: there is no per-session revocation
  registry. Offline logout cannot remove the remote session cookie immediately.

## API and storage review

| Request                                             | Maximum body |
| --------------------------------------------------- | ------------ |
| Login                                               | 1 KiB        |
| Blob token/presigned request or completion callback | 16 KiB       |
| Trip creation or plan replacement/patch             | 512 KiB      |
| Other JSON mutations, including travel commands     | 64 KiB       |
| Authenticated local binary ticket upload            | 10 MiB       |

Nonempty JSON bodies require `application/json`. Bodyless DELETE/POST requests
remain valid where supported. Requests over a limit return 413; incorrect media
types return 415. HTTP adapter integration and browser tests cover empty bodies.

Supplemental fixed-window limits, shared by clients of one running app instance:
20 login attempts/minute, 180 authenticated writes/minute and 30 currency
refreshes/minute. Counters have three fixed keys; attacker-controlled headers do
not create unlimited buckets. They reset on cold starts and differ across
instances. An attacker can exhaust one window and temporarily deny legitimate
requests. Offline queued edits remain queued on 429 and can retry later.

Catalog limits include 366 days, 2,000 steps/places/costs, 1,000 sources, 500 tasks
or reservations, 200 tickets and 50 travellers. General text is capped at 20,000
characters and HTTP(S) URLs at 2,048. A real itinerary's plan was measured at about
60 KB, comfortably below the plan body allowance. These limits are not aggregate
account storage quotas. Large catalogs still increase validation/history costs.

Ticket metadata paths are generated by the server, validated against the trip,
and not editable by the browser. Upload permission requires an existing pending
ticket and exact path match; overwriting is disabled. Files must have the declared
size and PDF/PNG/JPEG magic bytes before becoming ready. File signatures do not
prove that a document is harmless: there is no antivirus or content sanitization.
Only the patched canvas viewer should render PDFs in the app. Downloaded originals
are still original, untrusted documents.

Blob upload completion is a public route by necessity. Missing signatures are
rejected before SDK processing; invalid signatures cannot invoke finalization.
Legacy deployments use SDK HMAC verification; OIDC deployments use the configured
webhook public key. The browser receives a short-lived upload delegation, never
the store read/write credential. OIDC authorization tests mock provider issuance.
After the CSP correction, the owner confirmed a real staging PDF upload and
successful viewing through normal preview access on October 5.

All trip/ticket reads and agent documentation endpoints require authentication.
Private API responses use `private, no-store`, no wildcard CORS, nosniff, frame
denial and a restrictive API CSP. The service worker caches the app shell, not
personal API responses. CAS/ETags prevent lost concurrent writes, and UUID command
IDs make travel application idempotent. JSON Patch rejects prototype writes.

The only existing server-side internet fetch outside Blob is a fixed HTTPS
Frankfurter endpoint with a constrained currency code and an eight-second timeout.
It does not accept a user-provided URL. Eight currencies bound per-request fan-out;
cached rates last 24 hours. Future URL-fetching agent tools need additional SSRF
protection and cannot inherit this assessment.

## Frontend, offline data and secrets

React escapes text; Markdown does not enable raw HTML. Domain website/source URLs
accept HTTP(S) only. Existing external links use `noopener noreferrer`. Browser
tests confirm CSP blocks an inserted inline script and an unexpected outbound
request, while normal navigation, tickets and offline operation remain usable.
Inline **styles** remain allowed for React layout/PDF rendering; inline scripts
and JavaScript `eval` remain disallowed. WebAssembly is allowed for local PDF
decoders. External Markdown images are blocked by the image policy. The Vercel
preview toolbar may be blocked too; it is not required by the product.

Staging browser diagnostics on October 5 identified a CSP regression: the
installed Blob SDK sends both legacy and presigned uploads to
`https://vercel.com/api/blob/`, not only the storage hostnames. The policy now
allows that specific path without permitting other Vercel API destinations.
Browser regression tests exercise the actual SDK with a synthetic provider
exchange and authenticated local persistence. A three-minute upload deadline
aborts stalled transfers and releases the form even during SDK retry backoff.
Pending records remain available for explicit verification or deletion; a timeout
alone does not prove whether the provider stored the file.

IndexedDB holds downloaded trips, ticket bytes and pending edits. It is not
separately encrypted. An unlocked device, browser extension or same-origin XSS
could access it. Offline availability means immediate remote erasure/revocation
is impossible. App session expiry is checked on startup and local data is cleared
on logout/401. Use device screen locks and remove copies from shared devices.

The targeted repository-history scan inspected 125 Git blobs, compared four
locally available private credentials, and checked common OpenAI/private-key
patterns. No matches or tracked private-data directories were found. This is not
a comprehensive entropy-based secret scan and does not cover account dashboards,
CI logs, screenshots, unreachable Git objects or secrets not available locally.
Secrets remain server-side and private operational files remain Git-ignored.
The two available browser keys were also compared against built JavaScript assets;
no matches were found, and production builds did not contain source maps. The real
private itinerary still passes the tightened schema.

## Hosting checks and remaining actions

Anonymous production inspection found HTTPS/HSTS, nosniff, referrer restrictions,
frame protection and 401 for `/api/v1/trips`. Production serves the older API,
so `/api/v2/trips` returned 404. Production HTML had no CSP before this change.
Wildcard CORS on the public app shell is not present on the private API.

Vercel project inspection confirmed preview SSO protection. The active firewall
configuration read returned `Seawall Config not found`; the project ID/team scope
was independently verified. **A custom edge rate-limit rule was not verified or
activated.** This does not mean Vercel's platform DDoS protection is absent.

Prepared [firewall-rule.json](firewall-rule.json) uses the Hobby plan's single
rate-limit slot: `/api` requests, including the native rewrite entry point, at
300/minute per IP, initially preview only. Publish it in the project's Firewall
dashboard, inspect ordinary two-device/offline sync traffic, then remove the
preview condition for production. Do not add paid managed rules or a plan upgrade.
The connector available in this session does not expose the separate firewall
activation endpoint, so a draft write would not establish deployed protection.
Vercel documents one rate-limit rule and one million allowed requests included
for Hobby; counters are regional and rotating IPs can evade an IP limit.
[Vercel WAF limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[Vercel rule template](https://github.com/vercel/firewall-templates/blob/main/api-rate-limit/rule.json).

The owner reported completing the dashboard checks and testing a rule without
an environment condition on October 5. That condition is optional: omitting it
allows the rule to cover both preview and production. Conditions in the same
group are combined with AND. The connector's active configuration read still
returned not found, so publication cannot be independently confirmed here.

Blob's optional custom firewall is separate from the application's API firewall.
Enabling it connects the store to the team-wide `vercel-blob-default-project`;
other stores that enable protection share its rules. Private stores already
require authentication, and Vercel provides baseline platform DDoS protection.
Do not use Challenge rules for SDK requests: server-side SDK calls cannot solve
the browser challenge. A rule targeting application `/api` paths is not a
substitute for rules scoped to Blob requests.
[Vercel Blob security](https://vercel.com/docs/vercel-blob/security).

Production still uses the supported legacy read/write token. Keep it until a
separate OIDC migration is deployed and production uploads, reads and deletes
are verified. The staging fix does not revoke or change production credentials.

Remaining account-level checks require the owner's normal dashboard access:
GitHub/Vercel MFA and recovery, repository collaborator scope, deployment/secret
edit permissions, unused tokens/integrations, Blob connection environment scope
and usage alerts. Keep production/preview credentials and private stores separate.
No environment values were decrypted during this audit. No keys need rotation
merely because this review occurred; rotate if exposure is suspected.

In particular, verify fork pull-request deployment approval and protection of the
staging/main branches. Preview authentication protects visitors, not secrets from
code running during a deployment. Untrusted PR/build code must not receive private
Blob access or paid provider credentials. Scope future AI secrets to trusted
branches/environments and use a separate small provider allowance for staging.

Promote only after staging upload verification and review. Main/production code
and its private store remain unchanged by the staging patch. Also refresh installed
PWAs after promotion: an old offline shell cannot gain a new CSP or patched viewer
until it loads the update.

## Mandatory design before paid AI

Threat model: assume the attacker has a valid family login or can operate the
browser session. IP limits, authentication, CSRF protection and proposal approval
do not stop them from buying model/search calls. Approval protects the itinerary;
it does not refund generation costs. The spending boundary must be independent
of the caller's identity and prompts.

1. **Fail closed by default.** AI disabled unless all budget/provider settings are
   valid. Missing/unavailable budget storage, unsupported models/prices, CAS
   failure or an exhausted allowance must prevent the provider request.
2. **Durable global budget.** Use one private, atomically updated workspace ledger
   for all trips, users, instances and regions. Reserve the worst-case priced
   model input/output, reasoning output, search and route calls before dispatch.
   Track integer cost units, spent amounts and outstanding reservations. Require
   `spent + reserved + new reservation <= configured cap` using Blob CAS or a
   transactional store. Never use an in-memory counter as the spending boundary.
3. **Several small limits.** Suggested starting policy: $10/month, $1/day,
   $0.25/request and one active generation for the entire workspace. Explicitly
   bound model rounds, input size, output tokens, web searches, routes, elapsed
   time and retries. Prices/model choices are server allowlists, not prompt input.
   Turn SDK automatic retries off unless each attempt has an accounted allowance.
4. **Idempotency and uncertainty.** Persist job IDs and reservation ownership
   before any provider call. Duplicate clicks, reconnects and retries cannot open
   another reservation or repeat completed work. A timed-out/crashed/cancelled
   provider request may still be billed: retain its maximum reserved cost until
   verified usage is reconciled. Do not release it merely because a lease expired.
   Reject/reconcile ambiguous jobs instead of blindly redispatching them.
5. **Provider-side ceiling and key restrictions.** Use a dedicated project/service
   account with restricted inference permissions and model access. Verify a real
   enforced provider spending limit where available. OpenAI now documents hard
   organization spend limits; those limits use monthly USD
   thresholds in cents and return an enforcement state. Check that state in the
   actual account. Spend **alerts** alone do not enforce a cap. Keep administration
   credentials outside the application and restrict production/preview separately.
   [OpenAI hard spend limit](https://developers.openai.com/api/reference/cli/resources/admin/subresources/organization/subresources/spend_limit/methods/update),
   [OpenAI spend controls](https://developers.openai.com/api/docs/guides/terraform/rate-limits-and-spend).
6. **Emergency stop.** A durable server-owned kill switch checked before each paid
   operation, short job deadlines and documented provider-key revocation. An
   environment variable alone does not stop calls already running in old instances.
7. **Narrow tools.** The LLM sees a minimal itinerary context and can propose typed
   changes. It cannot choose credentials/models, modify budgets, execute code,
   make arbitrary HTTP requests, book/pay or access ticket documents. Search
   results and website text are untrusted data. Provider hosts/operations and
   coordinate/query sizes are allowlisted; no generic fetch tool.
8. **Validate and approve writes.** Store proposals against a trip version, validate
   every change with existing domain constraints, protect booked/completed stops,
   require explicit confirmation and apply atomically with CAS. A budget ledger
   must be entirely outside the itinerary/agent-editable schema.
9. **Redacted monitoring.** Record request/job IDs, costs, limit rejections,
   provider errors and unusual volumes. Never log keys, session tokens, ticket
   bytes/QR codes or booking references. Observe ledger/provider billing drift and
   leave margin for taxes, rounding, price changes and uncertain in-flight calls.
10. **Prove the boundary with mocks first.** Hundreds of simultaneous authorized
    requests across simulated instances, forged costs/model/tool arguments,
    reused IDs, storage outages, crashed jobs, retries, delayed usage reports,
    month rollover, cancellations and injected website instructions. Assert that
    paid dispatch never occurs without sufficient durable reservations.

These controls bound abuse through the application. They cannot protect against
an attacker who steals the provider key and bypasses the application; that is why
the provider ceiling and account security are separate requirements. Do not promise
an exact dollar ceiling until provider enforcement/billing timing and the ledger's
worst-case accounting have been verified for the chosen APIs.

## Development autonomy

Development can proceed locally/staging with mock providers: agent UX, typed
tools, proposal validation, the durable budget design, concurrency/idempotency
tests and denial scenarios. No paid API key or funded account is needed for that
work. Before live integration the owner must configure restricted provider
credentials, confirm/enforce spending settings and approve the small live test
budget. Routing-account setup can also wait until the mocked flow is ready.

## Verification record

- `pnpm check`: TypeScript, ESLint, 36 unit/API tests, production build and native
  Node/Vercel adapter gate.
- Full `pnpm audit --json`: zero known vulnerabilities after dependency changes.
- Chromium Pixel 7 and WebKit iPhone 13: 18 production-build browser tests,
  covering CSP enforcement, normal navigation, dialogs, original PNG/PDF tickets,
  offline PDF assets, offline adjustments and concurrent-device conflicts,
  presigned SDK uploads under CSP and stalled-upload timeouts.
- Provider-scope regression test: OIDC upload issuance cannot target a different
  ticket path; allowed operation, MIME type, size and expiry are bounded.
- Anonymous production headers/access checks and targeted Git-history secret scan
  described above; no attempt to break preview SSO protection.

The OIDC issuance test uses provider mocks. The browser suite uses FileStorage,
including synthetic Blob exchanges through the installed browser SDK. This
does not replace provider integration checks. The owner confirmed the real
private-Blob PDF upload and viewing after the staging fix. The two synthetic
provider tests block service workers to ensure WebKit routes the mocked API
exchange consistently; the separate offline tests retain service workers.
Edge firewall verification and future AI budget controls remain explicit launch
gates, not completed protections.

## References

Review assumptions and fixes follow [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
The PDF dependency finding is documented by [Mozilla's security advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j).
