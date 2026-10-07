# API

Security limits: nonempty JSON bodies require `application/json`; login is capped at
1 KiB, Blob callbacks at 16 KiB, other mutations at 64 KiB, and trip creation/plan
writes at 512 KiB. Binary ticket uploads remain 10 MiB. Oversize requests return
413, incorrect content types 415, and throttled requests 429 with `Retry-After`.
See [Security audit](SECURITY-AUDIT.md) for scope and outstanding edge controls.

Base URL: `/api/v1`. `/health` is public; trip data and API schemas require authentication. Responses use `Cache-Control: private, no-store`. Most trip mutations return `{trip, etag, warnings}`. Read responses also include an `ETag` header; mutations return the new version only in JSON. Validation errors contain `issues` with paths and messages.

## Authentication

Agents send `Authorization: Bearer <ITINERARY_API_TOKEN>`. Browsers POST `{key}` to `/session` with the same Origin to receive a signed HttpOnly cookie and `{expiresAt}`. GET `/session` checks access; DELETE clears the cookie. Browser mutations require same Origin. Shared browser access can change progress, bookings and tickets; structural plan editing/history/deletion requires the agent token. Do not expose agent tokens or server secrets under a `VITE_` environment name.

## Concurrency

Read the current version from the JSON `etag` field of GET `/trips/{id}` or `/trips/{id}/plan`. Use that field rather than the HTTP response header, which the hosting edge may weaken during compression. Send the version in `X-Trip-Version` on plan, progress, checklist, booking, ticket metadata and deletion mutations. This dedicated header avoids Vercel treating the standard `If-Match` as a condition on the response after a successful write. Blob storage still enforces its own atomic `ifMatch` internally. Missing header returns 428; outdated header returns 412. Re-read, merge and retry. Expected original checklist/progress values return 409 on conflicting edits. Rates and upload finalization manage their own concurrency; ticket upload bytes use previously authorized pending metadata.

| Endpoint                                   | Method | Body / behavior                                                                           |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `/trips`                                   | GET    | Trip summaries                                                                            |
| `/trips`                                   | POST   | `{id, plan}`, agent only                                                                  |
| `/trips/{id}`                              | GET    | Full document; `If-None-Match` supported                                                  |
| `/trips/{id}`                              | DELETE | Agent only; removes files and history                                                     |
| `/trips/{id}/plan`                         | GET    | `{plan, etag}`                                                                            |
| `/trips/{id}/plan`                         | PUT    | Complete Plan; `?dryRun=true` validates without writing                                   |
| `/trips/{id}/plan`                         | PATCH  | RFC 6902 JSON Patch array, max 200 operations; prototype mutation prohibited              |
| `/trips/{id}/history`                      | GET    | Available snapshot revision numbers, agent only                                           |
| `/trips/{id}/restore/{revision}`           | POST   | Restore plan only; agent only                                                             |
| `/trips/{id}/rates`                        | POST   | Refresh/cache EUR conversions, preserve original prices                                   |
| `/trips/{id}/progress/{stepId}`            | PATCH  | `{status: "pending"                                                                       | "done" | "skipped", expected?}` |
| `/trips/{id}/tasks/{taskId}`               | PATCH  | `{done: boolean, expected?: boolean}`                                                     |
| `/trips/{id}/reservations`                 | POST   | Complete Reservation                                                                      |
| `/trips/{id}/reservations/{reservationId}` | PATCH  | Partial Reservation excluding immutable `id`; null clears slot/paidAmount/currency/costId |
| `/trips/{id}/reservations/{reservationId}` | DELETE | Rejects remaining ticket references                                                       |
| `/trips/{id}/tickets`                      | POST   | Title, filename, stepId, travellerIds, optional reservationId, contentType, size          |
| `/trips/{id}/tickets/{ticketId}`           | PATCH  | Partial title/stepId/travellerIds/reservationId; null clears reservation link             |
| `/trips/{id}/tickets/{ticketId}`           | DELETE | Removes metadata and original binary                                                      |
| `/trips/{id}/tickets/{ticketId}/file`      | GET    | Authenticated original bytes; `?download=1` sets attachment disposition                   |
| `/trips/{id}/tickets/{ticketId}/file`      | PUT    | Raw bytes, local file-storage development only                                            |
| `/trips/{id}/tickets/{ticketId}/finalize`  | POST   | Idempotent private upload validation/finalization                                         |
| `/uploads/blob`                            | POST   | Vercel Blob SDK token generation and signed completion callbacks                          |
| `/openapi.json`                            | GET    | OpenAPI 3.1 plus JSON schemas                                                             |
| `/config`                                  | GET    | Storage driver for upload selection                                                       |

## Direct private upload

Production tickets upload directly to Blob so the 4.5 MB Vercel Function request limit does not constrain a 10 MB ticket. Use `@vercel/blob/client`:

1. Create pending ticket metadata with X-Trip-Version and retrieve its generated ID/pathname.
2. Call SDK `upload(pathname, file, {access:'private', contentType, handleUploadUrl:'/api/v1/uploads/blob', clientPayload:JSON.stringify({tripId,ticketId})})`.
3. For an agent, supply the Bearer header through the SDK `headers` option. Browsers use the same-origin cookie.
4. POST `/finalize`; signed callbacks may already have finalized the upload. The operation is idempotent.

Authorization restricts the generated path, MIME, maximum size and a 10-minute validity window. Finalization verifies exact file size and PDF/PNG/JPEG magic bytes. It does not perform malware scanning or guarantee that an uploaded document is a valid entry ticket. Originals have no public URLs. Use the CLI for an end-to-end example.

## Version 2 travel commands

The current browser and CLI use `/api/v2`; the existing endpoints retain their contracts. Version 1 requests to an upgraded trip return **426**, except authenticated binary ticket transfers, which remain compatible. V1 trip documents can be read through V2 and upgrade only on the first travel write. A caller cannot bypass version checks with a request header.

Authenticated browser sessions and agent tokens can access:

| Method | Path (under `/api/v2`)        | Result                               |
| ------ | ----------------------------- | ------------------------------------ |
| POST   | `/trips/{id}/travel/preview`  | Validated draft; no persistence      |
| POST   | `/trips/{id}/travel/apply`    | Committed trip and new `etag`        |
| GET    | `/trips/{id}/travel/original` | `{plan}` authored baseline           |
| GET    | `/trips/{id}/travel/history`  | Last 20 changes: `id`, `title`, `at` |

The command body is `{id, action, routes, expected, at}`. `id` is a unique stable UUID for retries; `at` is an ISO instant. See [DATA.md](DATA.md) for action shapes. Use `preconditions(trip, action)` from `src/domain/travel.ts` to construct `expected`, whose canonical fingerprints cover the involved day(s), active/archived steps, progress, manual locks, booked slots and baseline membership, or just the involved shared note. Independently changed notes/days can merge; a same-day change returns **409**. All applies require the current `X-Trip-Version` and storage CAS (**412** on a competing commit). A retry of an acknowledged command returns the current document without applying it again, even when its old version is stale. Validation/anchor conflicts return **422**. Browser writes require a same-origin `Origin` and the private session; raw plan editing remains agent-only.

`GET /api/v2/config` includes `editing` and `staging`. Setting server `TRAVEL_EDITING_ENABLED=false` rejects travel writes/previews while retaining V2 reads, tickets and existing operational controls. No database migration or data reset is required.

## Optional AI assistance (V2 only)

`GET /api/v2/config` also returns `ai: {enabled, mode}` where mode is `off`, `mock`
or `live`. AI is disabled unless both provider configuration and the independent
durable ledger allow it. Existing browser sessions/agent tokens can use:

| Method | Path under `/api/v2/trips/{id}/ai` | Behavior                                                                                                   |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| POST   | `/requests`                        | `{id, dayId, stepId?, parentJobId?, text, preference?, purpose?, draft?}`; current X-Trip-Version required |
| GET    | `/requests/{jobId}`                | Status, Italian message and validated proposals; read only                                                 |
| POST   | `/requests/{jobId}/advance`        | One claimed/reserved stage; `{}` body; no automatic provider retries                                       |
| POST   | `/requests/{jobId}/cancel`         | Stop future work; dispatched liabilities remain held                                                       |
| POST   | `/proposals/{proposalId}/apply`    | `{previewHash}` plus current X-Trip-Version; exact proposal approval and one atomic write                  |

Use a stable unique request ID for network retries. Create is idempotent only for
the same payload, trip and original version; different payloads with the same ID
return 409. `preference` is `fastest` (default) or `scenic`. The text is 1–2,000
characters. `purpose` is `adapt` (default) or `information`; information requests
require a selected public visit/meal stop, verified coordinates, configured web
research and no draft. A parent job must belong to the same trip/day and be terminal. Draft
is a validated TravelCommand, not a saved itinerary edit. Only flexible same-day
delay/timing/skip/move/add drafts are accepted; lock, restore, undo, shared notes,
actual-departure overrides and booking acknowledgments cannot enter this API.
Reading a job never
spends money. Unknown charges return an uncertain status requiring operator
verification; polling or lease expiry cannot trigger a repeat dispatch.

Proposal objects contain stable IDs, base version, 30-minute expiry, a preview
hash, typed commands, optional discovered catalog entries, dated field-level information overlays, route evidence and
citations. Inspect them in the job response. Apply rejects modified/stale/expired
proposals and revalidates all protected anchors. Repeated apply returns the
current committed trip even if the original version is stale. V1 access returns
426; disabled travel editing rejects AI mutations too. Offline drafts/advice are
local only, not jobs automatically purchased after reconnection.

`/api/v2/ai/admin/status` (GET), `/configure` (POST `{enabled, limits?}`) and
`/reconcile` (POST `{runId, operationId, actualCost, evidence}`) require an
independent bearer matching `AI_ADMIN_TOKEN_HASH`. Family cookies and itinerary
agent tokens are rejected, and this operator bearer cannot access ordinary trip
routes. Limits are `{monthly,daily,request,operations}` in integer microdollars;
reconciliation requires provider evidence. See [AI operation](AI-DEVELOPMENT.md)
for safe setup, the CLI, kill switch, retention and owner-only live gates.
The authenticated OpenAPI document includes AI request/proposal schemas and
operator security requirements.
