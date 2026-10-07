# AI foundation evaluation

## Scope and reproducibility

Run the no-spend evaluation locally:

```sh
pnpm ai:eval
```

The report is written to ignored `local-data/ai-evaluation-contracts.json`.
The suite creates temporary private storage and fictional trips, and uses
scripted providers. It needs no provider credential, network access or enabled
remote ledger. `pnpm check` also runs these tests with the broader security,
provider-contract and storage tests. Mobile browser checks use the production
build and a separate zero-cost mock server.

`tests/fixtures/ai-conversations.json` contains 60 canonical requests: 15 each
for information, read-only answers, adaptations and boundary failures. Every
case has a stable ID, expected status and an oracle specifying the structured
provider decision. Do not send this fixture's fictional names to live providers.

These cases verify what the application does with correct or unsafe decisions.
**They do not verify that a model interprets each prompt correctly.** An Italian
prompt paired with a scripted response is a regression contract, not a language
quality score. No live success rate is claimed by this suite.

Local verification on 2026-10-07: `pnpm check` passed 229 tests, the native
Node server smoke and production build. The foundation command passed 82 tests
(60 canonical cases plus integration/UI regressions). All 24 mobile browser
checks passed across Chromium and WebKit. On this Debian workstation WebKit
used the existing temporary shared libraries/browser wrapper; CI installs the
required system packages using the unchanged workflow. These checks made no
paid provider calls and did not change the remote ledger.

## Coverage

| Interactions            | Deterministic checks                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information and guides  | Explicit/read-only research; general semantic research; missing coordinates; cited identity; unknown fields; unchanged overlay; unscheduled public place                           |
| Conversation            | Persisted target/goals after restart; “sì grazie”; owned choices; forged choice rejection before run creation; per-day cache; corrections supersede old previews                   |
| Public places           | Existing IDs preserved; sourced coordinate mapping; automatic missing-location lookup before routing; ambiguous candidates retained; no fabricated locations                       |
| Schedule                | Delay, shortening, add/replace/reorder through existing travel tests; booked/completed/fixed anchors; time window, finish, avoided place, walking and verified-opening constraints |
| Refinement              | Shortening before delay; failed schedule feedback; measured routes reused; three distinct bounded model operations; internal passes cannot relax constraints                       |
| Compound requests       | Research and schedule save together; one history entry; independent facts remain visible on infeasible proposal; no partial trip writes                                            |
| Costs and remaining day | Traveller count, original currency, unknown costs, dated FX, current date/timezone/progress, archived payments kept separate and excluded from model                               |
| Approval and undo       | Version/hash/expiry, exactly-once apply, superseded preview rejection, scope fingerprints, available history, no research/routing for undo                                         |
| Offline and security    | Cached advice and choices; disabled sending offline; reconnect does not dispatch; private fields excluded; provider inputs/URLs bounded; operator role and spend invariants        |

See `tests/ai-foundation.test.ts`, `tests/ai-foundation-ui.test.tsx`,
`tests/ai-information.test.ts`, `tests/ai.test.ts`, `tests/ai-providers.test.ts`,
`tests/travel.test.ts` and `tests/ai-budget.test.ts` for concrete assertions.

## Required live acceptance before advertising broader support

The owner approved and completed conservative maximum accounting for the
previous interrupted information operation on 2026-10-07. Its $0.119072 hold is
resolved without redispatch or a claim of confirmed invoice usage. The existing
$1 pilot remains the testing allowance; no caps or provider prices were changed.
The first new manual-stop information acceptance request failed JSON parsing
before research, with its known $0.001071 charge settled and no remaining hold.
The test script disabled AI. Broader live acceptance remains outstanding.

After reconciliation and explicit live approval, use a small batch in the
isolated protected preview, within the existing cap. Record request/operation
IDs, task and tool choices, elapsed time, safe outcome, actual usage and evidence
in ignored local data. Verify usage before advancing to another batch.

Start with these public-landmark interactions and variations:

1. Select a manually entered Wawel stop without coordinates; ask for admission
   and hours, then answer “sì grazie”. Expected: facts or a useful identity
   question, no routing-coordinate demand.
2. Ask to improve that stop's information and save the reviewed field changes.
   Expected: stable identity, no schedule or booking write.
3. Ask to add Wawel in the afternoon. Expected: reuse a matching place or resolve
   a sourced public location; measure affected connections; preview a feasible
   schedule or explain missing evidence.
4. Replace a flexible stop while keeping a booked visit and a finishing deadline.
   Expected: preserved anchors and the deadline, or an explicit conflict.
5. Ask about costs and remaining time, then request a shorter/less walking option.
   Expected: local totals with unknowns and dated FX; measured route constraints.
6. Refine an unapplied option, approve once, then request undo. Expected: obsolete
   preview rejected; current preview applied once; conflict-safe undo offered.

Cover paraphrases, aliases, corrections, mixed intent and provider failures before
release. Target 100% deterministic safety and at least 95% task success on the
representative advertised interactions; report unnecessary clarifications and
helpful partial outcomes separately. A successful isolated prompt is insufficient.

Coverage limits remain visible: Wikipedia is a landmark source, not a general
place directory; building coordinates do not guarantee an entrance. A day audit
uses stored facts and can research at most two places. Cross-day editing, transit,
weather, private documents and purchases are outside this release.
