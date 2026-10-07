# AI capability review and improvement roadmap

Date: 2026-10-07. The owner approved implementation of Phases 0–2. The analysis
below records the pre-implementation assessment; see the delivery addendum and
[implementation documentation](AI-DEVELOPMENT.md#phase-02-foundation) for current behavior.
This approval does not authorize reconciling an unknown charge or resuming paid evaluation.

## Recommendation

Develop a travel assistant that can answer, research, compare and propose changes
through one conversation. Make its capabilities explicit in code, enforce their
permissions independently, and evaluate complete conversations before release.
The immediate investment should be conversation continuity, public place
resolution and coordinated changes to the current day. These enable many useful
requests with the existing application and hosting arrangement.

This is a broad interaction inventory, not a promise to recognize every possible
utterance. Unknown requests should still produce useful assistance, an honest
limitation or a focused clarification. The traveler should not need to discover
which internal stage or command their wording happens to activate.

## Evidence and current position

Reviewed `src/domain/ai.ts`, `src/domain/ai-request.ts`, `src/server/ai.ts`,
`src/server/ai-live.ts`, `src/server/ai-enrichment.ts`,
`src/components/AiAssistant.tsx`, the domain/data documentation and the existing
evaluation fixtures. This is a capability assessment, not another security audit.

The application already provides:

- One Italian assistant dialog, contextual stop/leg entry points and proposal
  widgets. Follow-ups include up to three brief prior turns.
- Delay, timing, skip, reorder within a day and add intentions. Replacement is a
  validated skip/add batch. These are the AI's writable surface; the broader
  manual travel domain also has notes, cross-day moves and history operations.
- Named public landmark discovery and nearby suggestions using Wikipedia;
  measured walking routes using OpenRouteService. This has limited coverage for
  restaurants, shops, general addresses and entrances.
- A separate web research stage for sourced descriptions, trivia, entrance,
  opening hours, ticket prices and booking links. Saving information requires a
  reviewed proposal. Information research does not need routing coordinates.
- Private storage, capped spending reservations, durable dispatch claims,
  uncertain-charge holds, a kill switch, ETag-bound previews, protected anchors,
  idempotent application and undo.

Important limits:

- Request routing still uses keywords and a small confirmation recognizer.
  Mixed requests such as "aggiungi informazioni alla tappa" can conflict with
  the distinction between information and adaptation.
- The current stages follow a mostly fixed sequence. The planner cannot freely
  select a suitable sequence of approved application tools.
- Conversation history is brief text, without a durable representation of the
  unresolved question, selected candidate or compound task.
- Researching a landmark's identity does not automatically provide verified
  routing coordinates or a visitor entrance. These are distinct evidence needs.
- Whole-trip planning, general place search/geocoding, transport routing,
  weather, ticket interpretation and background monitoring are not implemented.
- Existing fixture tests exercise structured actions and invalid inputs; they do
  not establish broad Italian conversation quality. The latest manual-stop
  information follow-up reached research, but its live evaluation stopped with
  unverified provider usage. Full end-to-end validation of that case remains open.

The observed Wawel failure spans several boundaries: a follow-up must retain the
information task and its target; factual research must remain available without
coordinates; adding or rerouting a visit must separately obtain routing evidence.
A general solution needs all three properties.

## Product behavior contract

Every travel request should end in one or more of these outcomes:

1. **Answer:** explain current trip data or offer advice, clearly distinguishing
   facts, assumptions and estimates.
2. **Research:** return dated evidence and visible sources, with unknown fields
   left unknown.
3. **Compare:** present alternatives with time, walking, costs and trade-offs.
4. **Propose:** provide an inspectable change set, including affected connections
   and consequences for other stops. Save only after explicit approval.
5. **Clarify:** ask about genuine ambiguity, with selectable choices and natural
   language replies. Do not ask the traveler for coordinates the place tool can
   look up.
6. **Partially help:** explain which part is unavailable and complete independent
   read-only work where possible. Do not silently save a partial compound change.

An unsupported write action must not suppress a supported answer. A research
failure must not become a route error. Saying "sì" after a clarification confirms
the selected meaning; it never bypasses the explicit itinerary-apply control.

## Ranked interaction inventory

Scores are product judgments for a mobile itinerary used by a small travel group.
They are not measured probabilities or delivery guarantees.

- **U (usefulness):** 5 = frequent/core; 4 = broadly useful; 3 = occasional;
  2 = specialist/convenience; 1 = little expected benefit.
- **F (feasibility):** 5 = extension using existing data/providers; 4 = moderate
  domain/workflow work; 3 = new provider or substantial evidence model; 2 =
  background infrastructure or complex private-data handling; 1 = substantial
  external permissions, transaction risk or integration burden.
- **State:** partial = some parts exist with the limits above; new = proposed.
- **Priority:** P0 = foundations; P1 = next release; P2 = following releases;
  P3 = optional later; P4 = deliberately defer.

Order is recommended delivery priority, then usefulness and feasibility, adjusted
for dependencies. A high feasibility score does not mean a feature already works.

### P0 — conversational reliability

| #   | Interaction                                          | Italian example                                        | U   | F   | State   | Required behavior                                                                                       |
| --- | ---------------------------------------------------- | ------------------------------------------------------ | --- | --- | ------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Continue a question or select an option              | "Sì, quello"; "La seconda, ma più breve"               | 5   | 4   | Partial | Persist task, target, candidate IDs and pending question; resolve replies against that state.           |
| 2   | Ask freely about a selected stop, route, day or trip | "Questa visita vale il tempo che richiede?"            | 5   | 5   | Partial | Answer without forcing a schedule proposal; use current scope and evidence.                             |
| 3   | Combine facts and changes                            | "Se è aperto, aggiungilo dopo pranzo e dimmi il costo" | 5   | 4   | New     | Research identity/hours/price, preview a feasible change, expose missing prerequisites.                 |
| 4   | Correct, cancel or change direction                  | "No, intendevo domani"; "Lascia perdere"               | 5   | 4   | Partial | Amend the task and invalidate superseded proposals; cancellation stops future work.                     |
| 5   | Handle ambiguity without technical questions         | "Il castello"; "Un museo vicino"                       | 5   | 4   | Partial | Resolve public aliases, show choices when meaningful, preserve the existing stop identity.              |
| 6   | Explain failure and provide useful fallback          | "Non lo trovi? Cosa posso fare qui vicino?"            | 5   | 4   | Partial | Distinguish missing evidence, unavailable tools, stale trip and spending limits; never invent a result. |

### P1 — make the current trip dependable

| #   | Interaction                                     | Italian example                                          | U   | F   | State   | Work and constraints                                                                                             |
| --- | ----------------------------------------------- | -------------------------------------------------------- | --- | --- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| 7   | Improve a manually entered stop                 | "Completa questa tappa con orari, prezzi e curiosità"    | 5   | 5   | Partial | Resolve public identity, research requested fields, show a field-level diff; preserve authored data.             |
| 8   | Ask opening and admission questions             | "È aperto venerdì? Quale biglietto serve?"               | 5   | 5   | Partial | Exact visit date, exhibition, last entry and official evidence; distinguish schedule from live availability.     |
| 9   | Delay, shorten, skip or reorder visits          | "Siamo in ritardo di 40 minuti"                          | 5   | 5   | Partial | Keep fixed/booked/completed anchors, propagate travel and buffers, explain trade-offs.                           |
| 10  | Understand the day and remaining slack          | "Cosa ci resta e quanto margine abbiamo?"                | 5   | 5   | Partial | Deterministic timeline calculations; account for trip timezone, selected date and recorded progress.             |
| 11  | Add, replace or restore a visit autonomously    | "Sostituisci questa tappa con il Wawel"                  | 5   | 4   | Partial | Resolve/find public place, avoid duplicates, obtain coordinates/entrance and both connections; preserve history. |
| 12  | Check whether a spontaneous visit fits          | "Abbiamo 45 minuti: riusciamo a vedere qualcosa?"        | 5   | 4   | Partial | Candidate duration plus return travel, admission window and buffer; no guaranteed queue estimate.                |
| 13  | Adapt to multiple constraints                   | "Meno cammino, niente altri musei, cena ferma alle 20"   | 5   | 4   | New     | Explicit constraints and objective; compare two validated compromises, explain infeasibility.                    |
| 14  | Audit a day's feasibility                       | "Controlla orari, spostamenti e prenotazioni di domani"  | 5   | 4   | Partial | Find conflicts, missing routes, optimistic transitions and closing times; bounded batch research.                |
| 15  | Recompute walking routes and optional POIs      | "Passiamo lungo il fiume senza perdere più di 15 minuti" | 4   | 5   | Partial | Measured detour and estimated dwell time; allow zero-POI alternative; preserve ordered stop/leg sequence.        |
| 16  | Explain prices and compare euro estimates       | "Quanto costa per noi? E in euro?"                       | 4   | 5   | Partial | Distinguish person/group, paid/estimated, mandatory/optional; use dated stored FX and unknown totals.            |
| 17  | Give a concise local guide                      | "Cosa guardare qui? Raccontami una curiosità"            | 4   | 5   | Partial | Sourced short guide tied to selected stop; general explanatory background labeled when unverified.               |
| 18  | Explain or refine a proposal                    | "Perché hai tolto questa tappa? Tienila e salta l'altra" | 4   | 4   | Partial | Preserve requested constraints and proposal lineage; regenerate against fresh trip; preview before apply.        |
| 19  | Restore or undo an approved change through chat | "Torna alla versione prima del pranzo"                   | 4   | 4   | New     | Show history choices and deterministic conflict-safe undo; never infer an external booking cancellation.         |

### P2 — expand useful travel coverage

| #   | Interaction                                            | Italian example                                                   | U   | F   | State   | Work and constraints                                                                                                    |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------- | --- | --- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 20  | Move activities across days or rebalance the trip      | "Spostalo a sabato e alleggerisci venerdì"                        | 5   | 4   | New     | Bounded multi-day context, date-specific hours and atomic cross-day preview with anchors.                               |
| 21  | Discover restaurants, cafés and useful nearby services | "Una pausa caffè lungo il percorso"                               | 5   | 3   | Partial | General place directory/search, category and location evidence, opening hours; no availability promise.                 |
| 22  | Use current position for a plan                        | "Siamo qui: come riprendiamo il giro?"                            | 5   | 3   | New     | Optional one-time geolocation, permission/fallback, precision label; route from actual location.                        |
| 23  | Compare walking, transit and taxi                      | "Arriviamo prima in tram?"                                        | 5   | 3   | New     | Transport provider/timetable, date/time, transfers and accessibility; fare/ETA estimates separated.                     |
| 24  | Protect an airport/train deadline                      | "Quando dobbiamo smettere di visitare per arrivare in aeroporto?" | 5   | 3   | New     | Deterministic backward timing and user-visible safety buffers; live transport needed for verified transit advice.       |
| 25  | Plan around forecast weather                           | "Domani piove: proponi un piano al coperto"                       | 5   | 3   | New     | Weather adapter with forecast time/location; retain dry/rain alternatives and uncertainty.                              |
| 26  | Remember preferences and needs                         | "Pause frequenti; mia moglie preferisce arte, io storia"          | 4   | 4   | New     | Explicitly saved trip preferences, optional per-person differences, user control and minimal provider disclosure.       |
| 27  | Build preparation and booking tasks                    | "Cosa devo prenotare o scaricare prima di partire?"               | 4   | 4   | New     | Existing tasks model plus reviewed updates; official booking links, deadlines and ticket-offline status.                |
| 28  | Save notes, wishlist and practical reminders           | "Ricordami questo posto per un'altra giornata"                    | 4   | 4   | New     | Reviewable notes/tasks/catalog changes; a wishlist record need not occupy scheduled time.                               |
| 29  | Compare attraction alternatives                        | "Meglio museo A o B con poco tempo e 30 euro?"                    | 4   | 4   | Partial | Preferences, verified costs/hours, travel and duration estimates; explain subjective ranking.                           |
| 30  | Assemble a trip budget or cheaper alternative          | "Riduci il costo delle visite senza toccare i biglietti pagati"   | 4   | 4   | New     | Deterministic sums and explicit cost proposals; existing payments remain immutable.                                     |
| 31  | Make user-requested daily briefings                    | "Fammi il riepilogo di domani con le cose da controllare"         | 4   | 4   | New     | Cached/dated facts, unresolved risks, anchors and preparation; no background spend.                                     |
| 32  | Translate phrases and explain local customs            | "Come chiedo due biglietti?"                                      | 4   | 5   | New     | Text interaction with appropriate language/context; no claim of official policy without evidence.                       |
| 33  | Provide step-by-step walking explanations              | "Qual è la prossima svolta e cosa vediamo lungo la strada?"       | 4   | 3   | Partial | Use measured route instructions; optional location, safe mobile interaction; no navigation guarantee.                   |
| 34  | Evaluate accessibility and mobility needs              | "Un percorso senza scale e una visita con ascensore"              | 4   | 3   | New     | Accessibility evidence/provider coverage, entrance detail and explicit unknowns; shortest path is insufficient.         |
| 35  | Identify free periods and local events                 | "C'è qualcosa di interessante stasera?"                           | 3   | 3   | New     | Date-specific event sources, venue location and admission; respect published-source restrictions.                       |
| 36  | Recommend food with dietary constraints                | "Un posto vegetariano aperto lungo il tragitto"                   | 3   | 3   | New     | Menu/category evidence and verification dates; allergy safety needs direct venue confirmation.                          |
| 37  | Help when a venue closes or a plan fails               | "È chiuso: troviamo un'alternativa vicina"                        | 5   | 3   | Partial | Accept user-observed closure, find substitutes, check remaining constraints; do not rewrite official facts as verified. |

### P3 — planning, documents and richer interfaces

| #   | Interaction                                               | Italian example                                                  | U   | F   | State | Work and constraints                                                                                                                                      |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------- | --- | --- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 38  | Draft a new whole-trip itinerary                          | "Tre giorni a Praga, ritmi tranquilli"                           | 4   | 3   | New   | Trip draft schema, destinations/dates/preferences, bounded staged research and whole-plan validation.                                                     |
| 39  | Turn pasted notes or an itinerary into structured data    | "Trasforma questi appunti in un viaggio"                         | 4   | 3   | New   | Treat source text as untrusted; preview extraction, unresolved times/places and estimates before creation.                                                |
| 40  | Extract a selected ticket's visit slot and travelers      | "Collega questo PDF alla visita corretta"                        | 4   | 2   | New   | Explicit private-document consent, type/size limits, local extraction where possible, reviewed assignment; never expose QR/booking codes in general chat. |
| 41  | Answer questions about already stored tickets             | "Quale biglietto devo aprire per questa visita?"                 | 4   | 4   | New   | First match local metadata deterministically; show a private ticket widget without sending the document to the model.                                     |
| 42  | Support voice input                                       | "[Dettatura] Siamo in ritardo, aiutaci"                          | 3   | 3   | New   | Transcription/privacy/cost policy or evaluated device support; same text workflow and explicit apply.                                                     |
| 43  | Read a selected sign or menu image                        | "Cosa significa questo cartello?"                                | 3   | 3   | New   | Image consent and bounds; OCR/vision uncertainty, no authoritative dietary/medical guarantee.                                                             |
| 44  | Export a useful offline travel pack                       | "Prepara riepilogo, mappe, fonti e biglietti"                    | 3   | 3   | New   | Deterministic export plus optional summary; private device storage, provider map/cache terms and stale labels.                                            |
| 45  | Coordinate different traveler preferences or split visits | "Uno di noi va al museo, ci ritroviamo alle 16"                  | 3   | 2   | New   | Branching itinerary/per-traveler progress exceeds the current shared sequence; explicit rendezvous and ticket rules.                                      |
| 46  | Keep an expense record or split expenses                  | "Abbiamo pagato 25 euro a pranzo"                                | 3   | 3   | New   | Reviewed financial record schema, currency and person/group basis; no invented charge or conflation with entrance estimates.                              |
| 47  | Create a post-trip recap and reusable preferences         | "Cosa ci è piaciuto? Usa queste preferenze nel prossimo viaggio" | 3   | 4   | New   | Opt-in notes/history summary; no fabricated experiences and no private recap publication.                                                                 |
| 48  | Prepare messages to hosts or venues                       | "Scrivi una richiesta per cambiare orario"                       | 3   | 5   | New   | Draft/copy text using approved facts; sending remains a distinct permission and integration.                                                              |
| 49  | Proactively monitor closures, weather or delay            | "Avvisami se cambia qualcosa per domani"                         | 4   | 2   | New   | Scheduler, notification permissions, quotas, deduplication, retention and user-controlled research frequency.                                             |
| 50  | Produce an audio guide or rich visual explanation         | "Raccontamelo mentre camminiamo"                                 | 2   | 3   | New   | Audio generation/accessibility/cost; a sourced text guide should exist first.                                                                             |
| 51  | Import selected booking emails or calendar entries        | "Aggiungi le prenotazioni dalle mie email"                       | 3   | 1   | New   | Scoped external access and consent, hostile-content handling, deduplication and reviewed imports.                                                         |

### P4 — keep external transactions outside the initial agent

| #   | Interaction                                 | U   | F   | Recommendation                                                                                                                                         |
| --- | ------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 52  | Buy tickets, book a restaurant or pay       | 3   | 1   | Provide verified links and preparation advice first. External execution needs account/payment permissions and an independent transaction confirmation. |
| 53  | Cancel/refund/change an actual reservation  | 3   | 1   | Explain official policy or draft a request; itinerary edits must never imply a reservation was changed.                                                |
| 54  | Always-on autonomous optimization           | 2   | 1   | Defer. Notification-only suggestions are easier to review; unattended changes conflict with family coordination, spend control and anchors.            |
| 55  | Automated medical/emergency decision-making | 1   | 1   | Provide carefully sourced local contact/directions when appropriate; never diagnose, promise emergency availability or replace emergency services.     |

Priorities are adjustable. A short walking city trip favors P1; a mobility-focused
trip may move accessibility and transport earlier. Item 37 has high situational
value but depends on item 21's general discovery coverage.

## Implementation architecture

### 1. Explicit capabilities and typed application tools

Introduce a server-owned capability registry. Each entry declares its input/output
schema, required evidence, online dependency, read/propose permission, allowed
data fields, cost bound, timeout, failure outcomes and evaluation cases.

Initial tools should include:

- `read_itinerary`: bounded day/trip summary, anchors, progress and known facts.
- `resolve_public_place`: public name/area to candidate IDs with identity evidence.
- `research_place_information`: requested fact fields for an exact visit date.
- `resolve_route_location`: sourced coordinates/entrance with precision and
  provenance; separate from text research.
- `calculate_walking_route`: validated endpoints and approved detour constraints.
- `evaluate_schedule`: deterministic timing, slack and conflict calculations.
- `calculate_costs`: deterministic original-currency sums and saved FX estimates.
- `build_proposal`: compile validated schedule/information intentions into one
  version-bound change set; no direct trip write.

Keep apply, budget administration, credentials, arbitrary URL fetching and private
ticket retrieval outside model tools. Model schema conformance is an input
constraint, not evidence that a proposed operation is correct or authorized.

OpenAI function calling allows the application to execute typed tool requests and
return their results for further reasoning. Strict schemas support predictable
arguments; application validation still controls permissions and evidence.
[Function calling](https://developers.openai.com/api/docs/guides/function-calling).

### 2. Durable task and conversation state

Keep private application-managed state with:

- Active trip/day/step scope, timezone, current trip version and selected date.
- One or more subgoals: answer, research, compare, propose.
- Resolved public entity IDs, candidate IDs and requested information fields.
- Explicit constraints and preferences, with provenance: user instruction,
  booking anchor, inferred assumption or verified evidence.
- A pending clarification with typed response choices, not only the assistant's
  previous sentence.
- Current proposal IDs, superseded/applied status and unresolved prerequisites.
- A bounded conversation summary plus recent turns; explicit expiry/reset and
  controlled retention, without unrelated private trip data.

Follow-ups refer to this state. Clicking a choice and writing "la seconda"
resolve to the same validated candidate. "Sì" can resolve a pending clarification;
the separate apply widget is still required to save changes. Changing context
shows the active scope and carries only relevant state, so a day selector does
not silently abandon a task.

Application-managed history is supported by Responses and fits the existing
private storage approach. `store:false` does not itself establish zero provider
retention. [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state).

### 3. Bounded, resumable tool orchestration

Evolve the existing persisted stages so the model can select an appropriate
approved tool sequence. Avoid forcing factual questions through routing. Retain
one operation claim and spend reservation before each paid dispatch.

Each run has bounded model rounds, searches, candidates, route calls, output
sizes and elapsed time. Re-evaluate permissions, current version and budget at
each stage. A tool result is typed as found, ambiguous, unavailable, invalid,
stale or unknown; the assistant must respond to the actual outcome.

Before accepting a compound task, check whether its permitted workflow fits the
request cap. Reuse current evidence and deterministic calculations; expensive
research happens only when needed. If the permitted workflow cannot fit, explain
the limitation or offer a smaller explicitly requested task. Do not raise caps
or automatically queue paid work.

Keep native authenticated staged POST advancement and private checkpoints for
the first releases. These fit the current runtime design and do not require a
framework or hosting migration. Verify actual function-duration and storage
limits before broadening work. Notifications and unattended scheduled research
need a separate infrastructure review.

### 4. Evidence and public place resolution

Maintain separate evidence for public identity, geographic location, visitor
entrance, opening schedule, exhibition-specific prices and live availability.
Use provenance, checked date, applicable visit date and uncertainty for each.

- Start by improving existing landmark resolution and reuse stored verified data.
- Add an adapter for a general public place directory/geocoder. Evaluate local
  coverage, entrance quality, attribution, caching/license terms, quotas and
  pricing before selecting a vendor or asking the owner to create an account.
- Use geocoding evidence for routing; web prose or a model-generated coordinate
  is insufficient. A building centroid may need an estimated entrance warning.
- A closure or change reported by the traveler is useful operational input, with
  user-provided provenance; it is not newly verified official-source evidence.
- Keep research based on public names/areas. Private accommodation/address
  lookup needs a separate explicit data-sharing decision.

### 5. Coordinated proposals and mobile widgets

Reuse the full-screen hybrid dialog. Use consistent widgets for place choices,
constraint chips, sourced fact cards, comparisons, change previews and apply/undo.
Natural language remains available throughout.

Show concrete effects: added/removed/reordered stops, revised connections,
walking minutes, buffers, unknown costs and consequences for fixed slots. For
information changes, show precisely which fields will be saved. Later mixed
schedule/information changes should commit atomically with one history entry.

Preserve stable IDs, tickets, reservations, completed stops and immutable baseline.
An old proposal must be re-evaluated when another device changes the trip. Never
apply a partial schedule after a compound request without showing the revised
proposal and obtaining approval. Browser reconnect or opening a dialog must not
dispatch paid work automatically.

## Execution phases and acceptance criteria

### Phase 0 — secure operation and coverage baseline

1. Keep existing spend caps, private storage, dispatch deduplication and
   uncertain-charge holds intact. Resolve the current unverified live operation
   through the existing owner-approved reconciliation procedure before resuming
   paid evaluation. This roadmap does not authorize reconciliation or another run.
2. Catalog current tools, effects, limitations and evidence requirements in code.
3. Build the scenario matrix below using fictional/public fixtures. Record
   supported answer/research/propose outcomes rather than only command validity.
4. Add privacy-safe stage diagnostics and usable error/status messages. Track
   latency, tool choice, outcome and usage without raw conversations or secrets.

**Exit:** every advertised P1 interaction has a defined expected outcome and
failure outcome; spending and concurrency invariants remain tested.

### Phase 1 — conversation and public-place foundations

1. Add persisted task/clarification state and semantic intent handling. Retain
   deterministic guards; keyword matching must not be the primary capability
   boundary.
2. Separate answer/research/location/schedule tools and typed failures. Support
   one compound request with explicit subgoals and a bounded tool budget.
3. Support alias matching, existing-place reuse and place-choice widgets.
4. Complete the named manual-stop research flow and integration tests. Acquire
   route coordinates independently when needed; evaluate a broader place adapter.

**Exit:** the Wawel price question plus "sì grazie" is resolved as information;
no coordinates are requested for factual research. Adding the same landmark
either gets evidenced coordinates/routes or an accurate partial result. Ambiguous
identity asks a useful choice question. Rephrasing does not change permissions.

### Phase 2 — dependable assistance during a day

1. Implement timeline/slack/remaining-day answers and deterministic cost summaries.
2. Complete coordinated add/replace/shorten/reorder, constraint-based alternatives
   and field-level enrichment previews.
3. Add day feasibility checks, proposal refinement, history-based undo choices
   and contextual guide answers.
4. Release all P1 interactions together against the conversation suite; do not
   advertise broad capability based only on a successful single prompt.

**Exit:** protected anchors survive every proposal; compound requests either
produce a feasible reviewed change or explain which constraints conflict.
Information-only requests never change the schedule. Existing app offline edits
and proposal-conflict handling keep working.

### Phase 3 — multi-day planning and selected new providers

Add cross-day moves, preferences, tasks and notes first. Then select useful
providers for food/services, weather, geolocation and transit according to actual
trip needs. Review licensing, privacy, account setup and conservative spend bounds
per adapter. Obtain owner setup/approval only for concrete configured needs.

**Exit:** cross-day hours/anchors are checked, new provider failures yield honest
fallbacks, and an unavailable adapter is visible to both the assistant and UI.

### Phase 4 — optional documents, new trips and proactivity

Prioritize ticket metadata assistance and text import before private-document
interpretation. Add whole-trip drafts, voice/images and exports if they justify
their cost. Treat automated notifications as a separately budgeted, permissioned
feature; review scheduling, retries, retention and delivery infrastructure first.
Keep purchase/cancellation execution outside this release scope.

## Evaluation plan: remove the need for owner-driven edge-case discovery

Create at least 60 canonical conversation scenarios before the broader P1 release,
with multiple Italian paraphrases and realistic multi-turn variants. This is a
proposed coverage target, not a current test count. Include English/corrected input
where useful. Cover all priority capabilities and these cross-cutting dimensions:

| Dimension               | Cases to include                                                                                    | Expected invariant                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Context and reference   | Selected stop, general chat, alias, pronoun, "the second", wrong day, scope switch                  | Correct target and date; genuine ambiguity produces choices.                           |
| Conversation continuity | Yes/no, correction, new topic, interrupted request, previous applied proposal                       | Persist meaning without resurrecting a canceled or obsolete task.                      |
| Mixed intent            | Research then add; enrich existing stop; add a closed attraction; cost plus replace                 | Complete independent research; no silent partial write.                                |
| Place evidence          | Known coords, missing coords, stale coords, wrong city, duplicate, venue vs exhibition              | No invented identity, route or coordinates; factual research remains independent.      |
| Schedule                | Delay, limited gap, fatigue, fixed dinner, booked museum, completed stop, cross-midnight timezone   | Deterministic feasibility and preserved anchors.                                       |
| Fact quality            | Holiday closure, season, last entry, conflicting pages, unknown price, missing official evidence    | Exact applicable date, cited facts, unknowns retained; no live-availability guarantee. |
| Costs                   | Per-person vs group, multiple currencies, already paid, optional stops, missing FX                  | Correct deterministic sums, dated conversions and explicit incompleteness.             |
| Reliability             | Provider unavailable, timeout, unknown usage, retry, duplicate click, cancellation, device conflict | No duplicate charge/write; holds and stale-proposal protection remain intact.          |
| Privacy and injection   | Web instruction to reveal secrets, hostile pasted text, ticket/private note requests                | Evidence cannot authorize tools or expose private fields.                              |
| Offline                 | Cached advice, unsent question, queued manual edits, reconnect                                      | No silent paid dispatch; readable stale advice; resolve edits before generation.       |

Use three verification layers:

1. Deterministic domain/tool/security tests with no provider calls.
2. Conversation evaluation against expected task, tool choice, target, safe
   proposal and helpful failure behavior. Mock tests alone cannot establish model
   language quality. Grade the result and trace, not a specific phrasing.
3. Small, explicitly approved live batches in the isolated preview. Keep each
   regression as a permanent fixture, use a fixed spend ceiling, and require no
   unresolved charge before a subsequent batch.

Suggested release gates: 100% pass for deterministic safety invariants and at
least 95% task success on the representative advertised-capability suite. These
are targets, not a claim of zero future failures. Separately report unsupported
requests, fallback helpfulness, unnecessary clarifications, p95 latency and
measured usage; evaluate the selected model instead of assuming a larger model
will solve missing tool coverage.

OpenAI recommends evaluating ordinary, edge and adversarial cases and placing
evaluations where model decisions enter a workflow.
[Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

## Delivery recommendation

Approve Phases 0–2 as the next cohesive scope: conversation continuity, autonomous
public landmark handling, sourced enrichment, current-day flexibility and
deterministic schedule/cost explanations. Evaluate a general place adapter as
part of that work; do not make provider setup a prerequisite for the conversation
foundation. Treat Phases 3–4 as separately selected expansions.

The first development work is autonomous using existing code, fictional fixtures
and mock providers. Owner involvement becomes necessary for a new provider's
account/permissions, changes to spending allowances, private-document consent or
release promotion. The existing unknown-usage hold remains an independent gate
before further live evaluation.

## Phase 0–2 delivery addendum

Implemented in the feature worktree: declared capability/evidence/failure
contracts; semantic persisted task state and choice widgets; unified per-day
conversation; independent information and location research; stable manual-place
coordinate overlays; local schedule/cost summaries; hard constraints; coordinated
duration reductions and delays; bounded refinement using measured routes; compound
enrichment/schedule approval; superseded-proposal rejection; history-based undo;
field-level information previews and safe stage diagnostics.

The no-spend suite now has 60 canonical scenario contracts plus multi-turn,
privacy, budget, UI and scheduling regressions. These exercise scripted structured
provider decisions and application behavior; they do not measure the live model's
ability to choose those decisions from Italian prompts. The Phase 1 Wawel follow-up
and Phase 2 language-quality release gates remain pending approved live evaluation.
Do not advertise a measured 95% task-success rate yet.

Public place adapter decision: retain the current sourced Wikipedia landmark
adapter for this foundation. Its limited food/shop coverage and building centroids
remain explicit. A broader directory/geocoder needs a separately reviewed provider,
license, quota and account setup; there is no hidden fallback to an arbitrary URL
or invented coordinates. The day audit checks saved evidence and can request at
most two new information lookups, rather than claiming to refresh every stop.

Paid staging remains disabled while the existing interrupted operation is held.
Production/shared staging, provider credentials, prices and spending ceilings
are unchanged by this implementation.
