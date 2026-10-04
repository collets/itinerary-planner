# API

Base URL: `/api/v1`. `/health` is public; trip data and API schemas require authentication. Responses use `Cache-Control: private, no-store`. Most trip mutations return `{trip, etag, warnings}`. Read responses also include an `ETag` header; mutations return the new version only in JSON to avoid the hosting edge rechecking the request's old `If-Match` against the newly written version. Validation errors contain `issues` with paths and messages.

## Authentication

Agents send `Authorization: Bearer <ITINERARY_API_TOKEN>`. Browsers POST `{key}` to `/session` with the same Origin to receive a signed HttpOnly cookie and `{expiresAt}`. GET `/session` checks access; DELETE clears the cookie. Browser mutations require same Origin. Shared browser access can change progress, bookings and tickets; structural plan editing/history/deletion requires the agent token. Do not expose agent tokens or server secrets under a `VITE_` environment name.

## Concurrency

Read the current version from the JSON `etag` field of GET `/trips/{id}` or `/trips/{id}/plan`. Use that field rather than the HTTP response header, which the hosting edge may weaken during compression. Set `If-Match` on plan, progress, checklist, booking, ticket metadata and deletion mutations. Missing header returns 428; outdated header returns 412. Re-read, merge and retry. Expected original checklist/progress values return 409 on conflicting edits. Rates and upload finalization manage their own concurrency; ticket upload bytes use previously authorized pending metadata.

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

1. Create pending ticket metadata with If-Match and retrieve its generated ID/pathname.
2. Call SDK `upload(pathname, file, {access:'private', contentType, handleUploadUrl:'/api/v1/uploads/blob', clientPayload:JSON.stringify({tripId,ticketId})})`.
3. For an agent, supply the Bearer header through the SDK `headers` option. Browsers use the same-origin cookie.
4. POST `/finalize`; signed callbacks may already have finalized the upload. The operation is idempotent.

Authorization restricts the generated path, MIME, maximum size and a 10-minute validity window. Finalization verifies exact file size and PDF/PNG/JPEG magic bytes. It does not perform malware scanning or guarantee that an uploaded document is a valid entry ticket. Originals have no public URLs. Use the CLI for an end-to-end example.
