# Managing itinerary data

Catalogs and text fields have resource limits in `src/domain/schema.ts`, and plan
requests have a 512 KiB body limit. See [Security audit](SECURITY-AUDIT.md) for the
specific limits. Split unusually large imports into smaller trips.

## Agent workflow

1. Read this document and `src/domain/schema.ts`; obtain the authenticated `/api/v1/openapi.json` or `pnpm trip schema local-data/schema.json`.
2. Pull the latest plan and its ETag metadata. Use `local-data/` for all trip data, source documents and ticket files.
3. Edit JSON or YAML. Keep stable IDs when updating existing records. Preserve original-currency prices and uncertainty; do not invent coordinates, entrances, availability, reservations or source verification dates.
4. Validate, inspect the diff, and perform a dry run.
5. Push with the ETag from the pull. On HTTP 412, pull again and merge your changes; never blindly overwrite another device's changes.
6. Read back the result. Structural plan changes preserve live reservations, tickets, checklist state, progress and exchange rates.

```sh
pnpm trip pull my-trip local-data/my-trip.json
pnpm trip validate local-data/my-trip.json
pnpm trip diff my-trip local-data/my-trip.json
pnpm trip push my-trip local-data/my-trip.json --dry-run
pnpm trip push my-trip local-data/my-trip.json
```

A `.meta.json` file accompanies exports and contains the concurrency ETag. Do not replace it with a fresh ETag just to bypass a conflict. `--etag=<etag>` is available for deliberate API workflows.

## Document model

`Trip = { schemaVersion: "1", id, revision, updatedAt, plan, state }`. A plan-only JSON/YAML file is accepted by create/validate/push; the server owns `revision`, `updatedAt` and operational state. `create` initializes empty operational state, even if the input is a full export.

| Collection             | Purpose                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `plan.travellers`      | Configurable IDs and names; no fixed two-person assumption                                                         |
| `plan.days`            | Local date, title, summary, ordered `stepIds`                                                                      |
| `plan.steps`           | Discriminated `stop` or `leg` records; both have their own detail page                                             |
| `plan.places`          | Reusable addresses, descriptions, trivia, opening hours, entrance guidance, URLs and optional verified coordinates |
| `plan.sources`         | Evidence title, URL/description, verification date and status                                                      |
| `plan.costs`           | Original currency, min/max or null/null, person/group basis, base/optional/excluded inclusion, evidence status     |
| `plan.alternatives`    | Descriptive choices, optional replacement steps using existing IDs, cost inclusion changes                         |
| `plan.tasks`           | Shared preparation checklist, priorities, optional step and URL                                                    |
| `state.progress`       | Step ID → pending/done/skipped                                                                                     |
| `state.taskCompletion` | Task ID → boolean                                                                                                  |
| `state.reservations`   | Actual booked slots, group amount paid, references, notes and travelers                                            |
| `state.tickets`        | Private file metadata and traveler/step/reservation assignment                                                     |
| `state.exchangeRates`  | Original currency → EUR rate, reference date, fetch date and source                                                |

IDs use lowercase letters/digits/hyphens and must stay unique within a collection. Every step must appear exactly once in a day's ordered `stepIds`. Days are chronological and within the trip range. Timestamps require an explicit offset, e.g. `2026-11-12T09:00:00+01:00`. Set an IANA trip timezone and an optional per-step timezone for travel across zones. A step belongs to the date of its start in its own timezone; steps may cross midnight. Schedules within a day cannot overlap. All references are validated against the full document.

A `stop` references `placeId` and has category `visit`, `meal`, `logistics` or `free-time`. A `leg` references `fromPlaceId` and `toPlaceId`, has mode, duration, optional distance, street names and `pois`. Each POI references an existing place and records a note and extra detour minutes. Zero-detour POIs become Google Maps waypoints; other POIs remain optional discoveries. Divide routes into multiple legs when the transport mode changes. Include realistic walking time, leave buffers, and label estimates.

The overview and detailed views use the **same** ordered day sequence. Data array order itself is not navigation order; `days[].stepIds` is authoritative. Shortcuts never remove route legs.

## Evidence and costs

Evidence status: `verified_official`, `verified_secondary`, `estimate`, `unknown`, `user_provided`. Preserve user-provided historical prices until a reliable update is checked. Put uncertainty and practical caveats in notes/assumptions. Use `null/null` for unknown cost ranges. No automatic currency summing across unrelated currencies occurs: budgets are grouped by currency. Person-basis costs multiply by the configured traveler count; group-basis costs count once. Optional/excluded items stay outside the base budget.

EUR conversions are approximate, based on the saved ECB reference rate delivered by Frankfurter. Original prices remain authoritative. The server refreshes rates at most daily; on failure it uses the previous dated rate or shows original prices alone. Paid booking totals are independent of the estimated budget, so the app never adds them twice or silently subtracts them.

## Step operations

```sh
pnpm trip add-step my-trip local-data/stop.json --day=day-one --after=walk
pnpm trip update-step my-trip museum local-data/museum.json --dry-run
pnpm trip delete-step my-trip free-time --dry-run
pnpm trip reorder my-trip day-one --ids=square,walk,museum
pnpm trip apply-alternative my-trip art-museum --dry-run
```

Updates use complete validated step records. For multi-record schedule/route changes, edit a pulled plan and push once so references remain consistent. Reorder must also respect timestamps. Deleting a step clears obsolete progress and associated tasks/cost references; attachments prevent deletion until reassigned or removed. Descriptive alternatives without replacement steps require a researched manual plan edit.

## Bookings and tickets

```sh
pnpm trip reservation my-trip local-data/reservation.json
pnpm trip upload-ticket my-trip museum traveller-one,traveller-two local-data/ticket.pdf --title="Ingresso museo"
```

Reservation example:

```json
{
  "id": "museum-booking",
  "stepId": "museum",
  "title": "Museo",
  "travellerIds": ["traveller-one", "traveller-two"],
  "status": "booked",
  "reference": "ABC123",
  "slot": "2026-11-12T10:15:00+01:00",
  "paidAmount": 30,
  "currency": "EUR",
  "notes": "Totale per entrambi"
}
```

Ticket upload creates pending metadata, uploads privately, validates file type/size and finalizes it. It does not mark a booking as paid or change the schedule. A shared group PDF has one file assigned to multiple people. For individual tickets, upload separate files assigned individually. Use the browser wallet or ticket PATCH API to link files to existing reservations. Failed uploads remain visible as incomplete; retry finalization when a file exists, or delete and re-upload. Ready files are immutable; replacing one creates a new ticket and then removes the old one.

If an actual slot differs from the schedule, the UI displays a warning. An agent must adjust all affected steps/routes explicitly. Plan validation protects existing attachments, and reservations cannot be removed while tickets still reference them.

## History and recovery

```sh
pnpm trip history my-trip
pnpm trip restore my-trip 4
pnpm trip export my-trip local-data/backup.json --include-state
pnpm trip delete my-trip --confirm=my-trip
```

The server retains the last 20 snapshots before plan edits. Restore changes the plan only and preserves current operational state; validation rejects a historical plan incompatible with current attachments. Progress and booking changes are not a permanent audit log. Full exports contain metadata, not binary ticket contents; download originals separately for a full backup. Deletion removes cloud data, but disconnected devices can retain their explicit downloads until they reconnect or users clear them.

## Travel editing (schema version 2)

The first travel command upgrades a version 1 trip in place. `plan` is the active schedule and a catalog of all retained stops, routes, and places. `plan.days[].stepIds` is the authoritative active sequence; catalog entries outside it are archived, with reservations and tickets still attached by stable IDs. A day may be empty. Both views and Maps use this same active schedule.

`travel.originalPlan` is the immutable authored baseline. `travel.notes` stores shared plain-text notes keyed by day/step ID; `travel.locks` stores manually fixed start instants; `travel.completedAt` records actual completion timestamps separately from the planned schedule. Booked reservations with a slot and flight legs are automatic anchors. `travel.appliedIds` retains acknowledged command IDs for retry deduplication. `travel.history` retains the last 20 commands with before snapshots and relevant after fingerprints for safe undo.

Do not remove catalog records or original days from a V2 document. To remove a visit from the active itinerary, use a `skip` command. Full agent plan edits preserve operational state and cannot change completed times, booked/fixed times, or the original baseline. They still need a fresh `X-Trip-Version`. Agent edits and restores can make old undo actions conflict; review instead of overwriting.

### Agent interface

```sh
pnpm trip original my-trip
pnpm trip travel-history my-trip
pnpm trip travel my-trip local-data/change.json --dry-run
pnpm trip travel my-trip local-data/change.json
```

A change file accepts `{action, routes?}`. Example:

```json
{
  "action": { "type": "delay", "dayId": "day-one", "stepId": "museum", "minutes": 30 },
  "routes": []
}
```

Supported action shapes (all IDs refer to existing catalog/day records unless adding):

| Type      | Fields                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `delay`   | `dayId`, `stepId`, `minutes` (positive integer)                                                                                  |
| `timing`  | `dayId`, `stepId`, `start?`, `durationMinutes?`, `following`; alternatively `leaveAt` closes the activity and records completion |
| `skip`    | `dayId`, `stepId`, `included`, `afterId?`, `acknowledgedBooking`                                                                 |
| `move`    | `dayId`, `stepId`, `toDayId`, `afterId?` (same day changes order)                                                                |
| `add`     | `dayId`, `stop` (complete Stop schema), `place?` (new Place), `afterId?`                                                         |
| `note`    | `targetId` (day or step), `text` (max 4000 characters)                                                                           |
| `lock`    | `dayId`, `stepId`, `fixed`                                                                                                       |
| `restore` | `dayId`                                                                                                                          |
| `undo`    | `historyId`                                                                                                                      |

Omitting `afterId` inserts at the beginning. A modified connection requires `routes: [{fromPlaceId,toPlaceId,mode,durationMinutes}]`, with mode `walk`, `transit`, `taxi`, or `train`. These are explicit provisional estimates. Generated routes contain no copied streets, POIs, coordinates, or source claims. Matching authored connections can be reused. Opening Maps still requires connectivity.

Delays preserve durations and absorb existing gaps before moving later activities. Fixed and completed activities cannot shift. Invalid overlaps, midnight crossings, or insufficient space before an anchor produce an error, with no partial write. Restore preserves notes, completed visits, reservations, payments and files; it can require route estimates for visits moved into another day. Undo is permitted only while the relevant day/note still matches its recorded after state. Original budget estimates remain labelled as such; a skipped visit does not imply a refund, and newly added stops have unknown cost.
