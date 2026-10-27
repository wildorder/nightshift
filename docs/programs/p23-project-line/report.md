# Report: Give a project one development line where every program's landed work meets, composed and checked by a single line owner

Run `run_01M5XW8F0SCAAWKGW76RXXZQ98` of plan `fd37cc169b82`: **succeeded**. All four strands integrated: S-01 (one live run per program; landed after 3 examiner fix rounds incl. an arbiter-upheld finding), S-02 (project line in the plane; 2 fix rounds), S-03 (composition engine and resolver; 2 fix rounds), S-04 (line owner on a machine with e2e test; 2 fix rounds). No retries by the root orchestrator, nothing parked or deferred. Strand orchestrators recorded their departures from the plan as decisions (e.g. S-01 settles never-started runs inside RunStore.put; S-02 uses a separate LineDispatch record and inherits `line` into the program contract).

4 of 4 strands succeeded; 0 deferred; 0 parked. Wall clock 476 min 33 s.

## Completion histories

none recorded: nightshift completion create ... groups the runs that delivered one outcome. This run's own outcome is not completion.

GitHub has every landing: `program/p23-project-line` is at `cbd540b072fb`.

## Arbiter rulings — read these first

An arbiter ruled on these disputed findings. Each ruling is yours to reverse with
`nightshift ruling reverse <program> <decisionId> --reason …`. Reversing one records
your decision and replays nothing: an overturn's work stays landed and an uphold's ruling
stays carried out until the decision graph (P9); roll back by hand from the checkpoint named.

- **Upheld** by claude-fable-5-1 F-01 Settling an abandoned legacy holder admits a new run even when another legacy run is still running. Legacy discovery picks the lowest live run only when the marker is absent. If a program has two pre-marker runs (lowest ID pending without dispatch, another running), the first start adopts the pending one and refuses. After NEVER_STARTED_GRACE, the next start interrupts that holder and installs the new run without checking the remaining legacy running run. I reproduced this on memory, SQLite and DynamoDB FakeTable: each accepted the second start and listed statuses interrupted,running,pending. This breaks the one-live-run guard for existing programs. After settling a holder, account for other pre-existing live runs before granting the new claim, and add this multi-legacy settlement case to conformance. The previous examination's F-01 adoption/completion race is fixed by the transactional holder-status check and retry; this finding is a different defect. on node_01M5XX0PNYNAGJ17MNQ45995MS: The defect is real and I reproduced it in this checkout. On the memory store I seeded two pre-marker runs for one program (the lowest id pending with no dispatch, the other running), started a third run, got the expected refusal naming the pending one, advanced the store's clock past NEVER_STARTED_GRACE, and started again: the put was accepted and the program's runs read interrupted, running, pending. Two live runs of one program is exactly what acceptance criterion 1 forbids, and the one-live-run guard is the deliverable of S-01.

The cause is in the code as the examiner says. Legacy discovery (memory/index.ts around lines 397-405; aws/stores.ts findLegacyHolder) runs only when the marker is absent and picks one run. Settlement (memory/index.ts lines 412-435; aws/stores.ts settleNeverStarted) then interrupts that single holder and hands the marker to the incoming run with no check that another legacy run of the program is still live. The DynamoDB transaction conditions on the holder's status, the holder's missing dispatch, and the marker's claim, but nothing in it constrains any other run of the program, so the FakeTable result the examiner reports follows from the same logic.

This is not a theoretical race: it is a deterministic sequence of two ordinary starts against any existing program that had more than one open run before the marker was introduced, which is the population the legacy-adoption path exists to protect. The conformance suite covers two legacy running runs (adopt the lowest, refuse) but has no case where the adopted holder is settleable while a sibling stays live, so the gap is also a missing test, as the finding asks. The earlier adoption/completion race fix does not touch this path. The work should not land until settlement re-checks for other live runs of the program (or adoption prefers a holder that cannot be settled while a live sibling exists) on all three stores, with the multi-legacy case added to conformance.
  Decision `dec_01M5Y2M5F6CNCCK2GCK3VVDB06`, made against checkpoint `ckpt_01M5Y2JHPDCMD37KR1P5V3TNR7`.

## Stories

### US-01 Every program's landed strands are composed onto one project line as they land, checked together, and a conflict or brea: done

- **Who:** The owner of a project with several Nightshift programs running at once
- **Today:** Each program builds and lands on its own program branch in isolation, so two programs that change the same code only find out they break each other when their pull requests meet main, and the conflict lands on the owner by hand.
- **Afterwards:** Every program's landed strands are composed onto one project line as they land, checked together, and a conflict or break between programs is repaired by Nightshift and recorded, long before anything reaches main.
> "how far through pipkin do i need to get to be able to spin up many programs building at the same time?"

Criteria: SC-02 met, SC-03 met, SC-04 met, SC-05 met, SC-06 met. Strands: S-02, S-03, S-04.

### US-02 A program has at most one live run; a second is refused with the reason and the run that holds it, and a run that never : done

- **Who:** The owner starting runs of a program
- **Today:** Nothing stops two runs of one program writing its program branch at the same time, a forgotten local run beside a remote one, and a run that was recorded but never started stays pending forever.
- **Afterwards:** A program has at most one live run; a second is refused with the reason and the run that holds it, and a run that never started stops counting as live.

Criteria: SC-01 met. Strands: S-01.

## Departures from the plan

**S-01 One live run per program**

- **the plan says that at start, a pending run past the grace period with no attach and no dispatch is ended as interrupted first (D-07), which reads as a step in startRun before the new run is written. Instead the settlement happens inside the run store's put of the new run, in the same atomic operation that claims the program's live-run marker: when the marker's holder is pending, older than the grace by the new run's startedAt, and has no dispatch, the store ends it as interrupted ("never started"), moves the marker and writes the new run in one transaction. Dispatch creation becomes conditional on the run still being pending, and the store refuses moving a terminal run back to a live status, so neither attach nor dispatch can race the settlement.**
  Chose: Settle the never-started holder inside RunStore.put of the new run, atomically with the marker move; make dispatch creation conditional on the run being pending; refuse a terminal-to-live status regression in the store.
  Why: D-07 is a human decision about what happens (the next start settles it, no sweeper); doing it in the same atomic write as the marker claim is the only way to make it safe against attach and dispatch on all three stores, and the remote path through the HTTP stores gets it with no new route. The outcome is the same: the next start of the program ends the stale run as interrupted (never started) and proceeds.

**S-02 The project line in the plane**

- **The plan said 'a `line` dispatch kind' and 'fenced by generation like a run's'. Instead, a line dispatch is its own project-scoped LineDispatch record keyed by (project, line branch). The `line` kind appears in the dispatcher event, the machine tags and a new `line` token principal. Its generation keeps increasing across successive line dispatches. The line record itself is written by compare-and-swap on a version.**
  Chose: A separate LineDispatch record and line principal. The machine rules in core are shared, made generic over a structural type.
  Why: This is the smallest sound change: heartbeat, provisioning and the reconciler each get a line branch, and the run path is left untouched. A monotonic generation stops a dead owner's token from passing a later dispatch's fence.
- **The plan said composed commits carry 'their verification id'. Instead, each composition carries an embedded LineVerification (its own verificationId, phase `line`, commands, outcome). It is not a record in the run-scoped VerificationStore. `line` joins VERIFICATION_PHASES as a classification only: it names no job and is not landing evidence.**
  Chose: An embedded LineVerification with its own id, on the composition in the line record.
  Why: This keeps the verification id and the `line` phase the plan asks for without inventing a fake run for the line.
- **The plan's 'line setting in nightshift.config.json' needs a way to reach the plane, because the config never does. Instead, `line` is inherited into the program contract, like `compute`. The plane learns a project's line from the contract of the program whose branch it publishes, so a config change takes effect at the next ratification. The org's concurrency ceiling for line machines is checked when provisioning, not in the publisher: the publisher has no Query permission. Separately, a note outside this strand: S-01's transactional ConditionCheck in dispatch and run puts may need dynamodb:ConditionCheckItem, which no role in api-stack or runner-stack grants. This should be checked before any deploy.**
  Chose: Inherit `line` into the program contract (INHERITED_CONTRACT_FIELDS), and key lines by (projectId, branch).
  Why: It reuses the existing config-to-contract path, adds no new endpoint, and the field is optional, so existing plan hashes don't change.

## Gate health

Audit: **healthy** at `ec4bd064`, 2026-10-09T17:29:07.301Z.

### Verification time

1h 12m across 13 verifications and 0 landings.

Retained rerun time: 0.0s across 0 flaky first run(s) and failed rerun(s), included in the totals.

| Step | Runs | Total | Reruns | Per run | Quiet start | Queue / candidate / end | Forecast per run |
|------|------|-------|--------|---------|-------------|-------------------------|------------------|
| `setup:install` | 13 | 0.0s | none | 0.0s | 0.0s | 13 / 0 / 0 | — |
| `build` | 13 | 39.7s | none | 3.1s | 0.1s | 13 / 0 / 0 | — |
| `typecheck` | 13 | 31.6s | none | 2.4s | 0.1s | 13 / 0 / 0 | — |
| `lint` | 13 | 8.5s | none | 0.7s | 0.1s | 13 / 0 / 0 | — |
| `test` | 13 | 1h 06m | none | 5m 07s | 0.1s | 13 / 0 / 0 | — |
| `synth` | 13 | 4m 39s | none | 21.5s | 0.1s | 13 / 0 / 0 | — |
| `sterility` | 13 | 2.2s | none | 0.2s | 0.1s | 13 / 0 / 0 | — |

No recommendations: run `nightshift gates <program> --record` before a run to keep what the gates resolve to, and the report prices them here.

## Strands

### S-01 One live run per program: succeeded

**Departed from the plan's approach:**

- **the plan says that at start, a pending run past the grace period with no attach and no dispatch is ended as interrupted first (D-07), which reads as a step in startRun before the new run is written. Instead the settlement happens inside the run store's put of the new run, in the same atomic operation that claims the program's live-run marker: when the marker's holder is pending, older than the grace by the new run's startedAt, and has no dispatch, the store ends it as interrupted ("never started"), moves the marker and writes the new run in one transaction. Dispatch creation becomes conditional on the run still being pending, and the store refuses moving a terminal run back to a live status, so neither attach nor dispatch can race the settlement.**
  Chose: Settle the never-started holder inside RunStore.put of the new run, atomically with the marker move; make dispatch creation conditional on the run being pending; refuse a terminal-to-live status regression in the store.
  Why: D-07 is a human decision about what happens (the next start settles it, no sweeper); doing it in the same atomic write as the marker claim is the only way to make it safe against attach and dispatch on all three stores, and the remote path through the HTTP stores gets it with no new route. The outcome is the same: the next start of the program ends the stale run as interrupted (never started) and proceeds.

Acceptance, as planned:
- A second run of a program with a live run is refused by the control plane, atomically on every store, naming the live run, and the CLI says so
- A run pending with no attach and no dispatch beyond the grace period is ended as interrupted (never started) by the next start of that program, and the start proceeds
- A run that ends, however it ends, releases the program
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Make the run store itself guard one live run per program, atomically, on every adapter. Add a DomainError `ProgramRunLiv | merged | 17e4bba0 | 1 |
| Settle a never-started run at the next start (D-07), atomically with the start, and make dispatch unable to race it. (J1 | merged | 1ffa5f1f | 1 |
| Make the CLI say so when a program already has a live run. (J1, already merged, makes starting a run of a program with a | merged | 767f3960 | 1 |
| Fix two examiner findings in the one-live-run-per-program guard (S-01) in RunStore.put, in the memory adapter (packages/ | merged | 1c2c6fc3 | 1 |
| Fix an examiner finding in the DynamoDB adapter's legacy-marker adoption (packages/persistence/src/aws/stores.ts, around | merged | 417ad34c | 1 |
| Carry out an arbiter's ruling on the one-live-run guard in RunStore.put, in the memory adapter (packages/persistence/src | merged | d3877d3c | 1 |

- Make the run store itself guard one live run per program, atomically, on every adapter. Add a DomainError `ProgramRunLiv
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Settle a never-started run at the next start (D-07), atomically with the start, and make dispatch unable to race it. (J1
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Make the CLI say so when a program already has a live run. (J1, already merged, makes starting a run of a program with a
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix two examiner findings in the one-live-run-per-program guard (S-01) in RunStore.put, in the memory adapter (packages/
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix an examiner finding in the DynamoDB adapter's legacy-marker adoption (packages/persistence/src/aws/stores.ts, around
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Carry out an arbiter's ruling on the one-live-run guard in RunStore.put, in the memory adapter (packages/persistence/src
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

### S-02 The project line in the plane: succeeded

**Departed from the plan's approach:**

- **The plan said 'a `line` dispatch kind' and 'fenced by generation like a run's'. Instead, a line dispatch is its own project-scoped LineDispatch record keyed by (project, line branch). The `line` kind appears in the dispatcher event, the machine tags and a new `line` token principal. Its generation keeps increasing across successive line dispatches. The line record itself is written by compare-and-swap on a version.**
  Chose: A separate LineDispatch record and line principal. The machine rules in core are shared, made generic over a structural type.
  Why: This is the smallest sound change: heartbeat, provisioning and the reconciler each get a line branch, and the run path is left untouched. A monotonic generation stops a dead owner's token from passing a later dispatch's fence.
- **The plan said composed commits carry 'their verification id'. Instead, each composition carries an embedded LineVerification (its own verificationId, phase `line`, commands, outcome). It is not a record in the run-scoped VerificationStore. `line` joins VERIFICATION_PHASES as a classification only: it names no job and is not landing evidence.**
  Chose: An embedded LineVerification with its own id, on the composition in the line record.
  Why: This keeps the verification id and the `line` phase the plan asks for without inventing a fake run for the line.
- **The plan's 'line setting in nightshift.config.json' needs a way to reach the plane, because the config never does. Instead, `line` is inherited into the program contract, like `compute`. The plane learns a project's line from the contract of the program whose branch it publishes, so a config change takes effect at the next ratification. The org's concurrency ceiling for line machines is checked when provisioning, not in the publisher: the publisher has no Query permission. Separately, a note outside this strand: S-01's transactional ConditionCheck in dispatch and run puts may need dynamodb:ConditionCheckItem, which no role in api-stack or runner-stack grants. This should be checked before any deploy.**
  Chose: Inherit `line` into the program contract (INHERITED_CONTRACT_FIELDS), and key lines by (projectId, branch).
  Why: It reuses the existing config-to-contract path, adds no new endpoint, and the field is optional, so existing plan hashes don't change.

Acceptance, as planned:
- nightshift.config.json accepts an optional line setting; without it nothing changes
- The verification phase vocabulary gains `line`, classified as not landing evidence
- After the publisher pushes a remote run's program branch, its new range is queued for the line and exactly one line dispatch is live, fenced by generation
- The publisher pushes the line with a compare-and-swap and returns the outcome to the line owner; a refusal never blocks the run's own publication chain
- Self-started compute is held to the project's monthly cap; at the cap the queue waits and the reason is recorded
- `nightshift line status` shows head, queue, composed commits with their contents, verification and resolver decisions, and parked compositions
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Strand S-02 (Pipkin M1b, "the project line in the plane"), job J1: lay the foundation for the project line so that five  | merged | 09557ba8 | 1 |
| This is job J2 of strand S-02, the project line in the plane: DynamoDB implementations of the three stores J1 introduced | merged | 4918e156 | 1 |
| Strand S-02 (the project line in the plane), job J3: the HTTP API that the line owner (a machine holding a `line` princi | merged | aef0bbc0 | 1 |
| Strand S-02 (the project line in the plane), job J4: the publisher's two line paths, and the infra they need. J1 has alr | merged | 3d04156e | 1 |
| Strand S-02 (the project line in the plane), job J5: the line machine's lifecycle: provisioning, the reconciler and clea | merged | aae44b43 | 1 |
| Strand S-02 (the project line in the plane), job J6: the CLI command `nightshift line status [--repo <path>]`. J1 has al | merged | cb7ad8f7 | 1 |
| Fix landing finding F-02 in strand S-02, the project line in the plane. | merged | 69fc0284 | 1 |
| Fix landing finding F-01 in strand S-02 (the project line in the plane): a failed heartbeat retry permanently loses self | merged | 1546ac5b | 1 |
| Fix landing finding F-02 (round 2) in strand S-02, the project line in the plane: lost-lease recovery of a LINE dispatch | merged | 4458126b | 1 |
| Fix landing finding F-01 (round 2) in strand S-02, the project line in the plane: a lease replacement double-charges ear | merged | dc4aa677 | 1 |

- Strand S-02 (Pipkin M1b, "the project line in the plane"), job J1: lay the foundation for the project line so that five 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- This is job J2 of strand S-02, the project line in the plane: DynamoDB implementations of the three stores J1 introduced
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-02 (the project line in the plane), job J3: the HTTP API that the line owner (a machine holding a `line` princi
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-02 (the project line in the plane), job J4: the publisher's two line paths, and the infra they need. J1 has alr
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-02 (the project line in the plane), job J5: the line machine's lifecycle: provisioning, the reconciler and clea
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-02 (the project line in the plane), job J6: the CLI command `nightshift line status [--repo <path>]`. J1 has al
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix landing finding F-02 in strand S-02, the project line in the plane.
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix landing finding F-01 in strand S-02 (the project line in the plane): a failed heartbeat retry permanently loses self
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix landing finding F-02 (round 2) in strand S-02, the project line in the plane: lost-lease recovery of a LINE dispatch
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix landing finding F-01 (round 2) in strand S-02, the project line in the plane: a lease replacement double-charges ear
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

### S-03 Composition and the resolver: succeeded

Acceptance, as planned:
- Given a line head, main and queued program ranges, composition merges them into one candidate and runs the landing checks; green yields a line head to publish, recorded with the batch's members
- A failed batch is composed one range at a time, and the range that fails is the one given to the resolver
- The resolver repairs from the line head; its fix is checked and examined by a different model before it is published, and is recorded as a decision; three failed attempts or an hour parks the composition
- Line verifications use a `line` phase that is not landing evidence
- build, typecheck, lint and test are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Strand S-03 (composition and the resolver), job J1: foundation of the line composition engine in packages/execution/src/ | merged | fb223614 | 1 |
| Strand S-03 (composition and the resolver), job J6. Extend S-02's line plane so a batch can be settled with what the com | merged | f8d717f4 | 1 |
| Strand S-03 (composition and the resolver), job J2. Implement packages/execution/src/line/compose.ts, replacing J1's stu | merged | d121e6d2 | 1 |
| Strand S-03 (composition and the resolver), job J3. Implement packages/execution/src/line/resolver.ts, replacing J1's st | merged | 1c05821c | 1 |
| Strand S-03 (composition and the resolver), job J4. Implement packages/execution/src/line/verifier.ts, replacing J1's st | merged | 4206447e | 1 |
| Strand S-03 (composition and the resolver), job J5: an end-to-end offline test of the line engine, test/src/execution/li | merged | 16b3e906 | 1 |
| Strand S-03, follow-up to the line resolver: in packages/execution/src/line/resolver.ts (resolveLineFailure), the compos | merged | 20a1367f | 1 |
| Strand S-03, landing fix F-01 (plane side). Today a green batch can be lost for good. settleBatch (packages/core/src/rul | merged | fd806c39 | 1 |
| Strand S-03, landing fixes F-01 (engine side) and F-02, in packages/execution/src/line/ and its tests. | merged | 92c4a166 | 1 |
| Strand S-03, integration fix after two parallel fix jobs. `npm run typecheck` fails: test/src/execution/line-compose.tes | merged | 5afb7fb9 | 1 |
| Strand S-03, landing fix round 2, F-01: failed-push recovery can discard a newer queued head of the same program. | merged | ba747591 | 1 |

- Strand S-03 (composition and the resolver), job J1: foundation of the line composition engine in packages/execution/src/
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03 (composition and the resolver), job J6. Extend S-02's line plane so a batch can be settled with what the com
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03 (composition and the resolver), job J2. Implement packages/execution/src/line/compose.ts, replacing J1's stu
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03 (composition and the resolver), job J3. Implement packages/execution/src/line/resolver.ts, replacing J1's st
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03 (composition and the resolver), job J4. Implement packages/execution/src/line/verifier.ts, replacing J1's st
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03 (composition and the resolver), job J5: an end-to-end offline test of the line engine, test/src/execution/li
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03, follow-up to the line resolver: in packages/execution/src/line/resolver.ts (resolveLineFailure), the compos
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03, landing fix F-01 (plane side). Today a green batch can be lost for good. settleBatch (packages/core/src/rul
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03, landing fixes F-01 (engine side) and F-02, in packages/execution/src/line/ and its tests.
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03, integration fix after two parallel fix jobs. `npm run typecheck` fails: test/src/execution/line-compose.tes
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-03, landing fix round 2, F-01: failed-push recovery can discard a newer queued head of the same program.
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

### S-04 The line owner on a machine: succeeded

Acceptance, as planned:
- A line dispatch boots the runner as line owner, which fetches the line, main and the queued program heads, composes with S-03's engine, hands each green line head to the publisher and reads the outcome, recomposing on a refusal
- The owner works until the queue has been empty for the idle period, then exits and the machine stops; a replacement after a lost machine resumes the queue where it stood
- An end-to-end test drives two programs' landings through the plane, the publisher and a git server to a composed line, including a conflict the resolver repairs
- docs/architecture.md records the project line and the line owner
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Strand S-04 (the line owner on a machine), job J1: plane additions the line owner needs (Pipkin M1b). Everything is in p | merged | efef7d3d | 1 |
| Strand S-04 (the line owner on a machine), job J2: launch the line's resolver and examiner agents through the harness wi | merged | f63c7c3e | 1 |
| Strand S-04 (the line owner on a machine), job J3: docs for the project line and the line owner. Add a decision row to d | merged | 10779ecd | 1 |
| Strand S-04 (the line owner on a machine), job J4: the runner's line mode in apps/mcp. A line dispatch boots the runner  | merged | bb72c9a8 | 1 |
| Strand S-04 (the line owner on a machine), job J5: an end-to-end test of the project line, in a new directory test/src/l | merged | 0df43054 | 1 |
| Strand S-04, follow-up fix J6: `POST …/line/{branch}/settle` (`postLineSettle` in apps/api/src/operations/line.ts) recor | merged | ea18e2d3 | 1 |
| Strand S-04 landing fix, F-01 and F-02: the line owner must run all project code as the project user (D-P10-30) and give | merged | f5158890 | 1 |
| Strand S-04 landing fix, F-03: the first line dispatch fails when the configured line branch does not yet exist on GitHu | merged | 6eacc501 | 1 |
| Strand S-04 landing fix round 2, F-01: line agents cannot read file-based Codex credentials on a fresh line machine. In  | merged | cbd540b0 | 1 |

- Strand S-04 (the line owner on a machine), job J1: plane additions the line owner needs (Pipkin M1b). Everything is in p
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 (the line owner on a machine), job J2: launch the line's resolver and examiner agents through the harness wi
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 (the line owner on a machine), job J3: docs for the project line and the line owner. Add a decision row to d
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 (the line owner on a machine), job J4: the runner's line mode in apps/mcp. A line dispatch boots the runner 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 (the line owner on a machine), job J5: an end-to-end test of the project line, in a new directory test/src/l
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04, follow-up fix J6: `POST …/line/{branch}/settle` (`postLineSettle` in apps/api/src/operations/line.ts) recor
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 landing fix, F-01 and F-02: the line owner must run all project code as the project user (D-P10-30) and give
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 landing fix, F-03: the first line dispatch fails when the configured line branch does not yet exist on GitHu
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand S-04 landing fix round 2, F-01: line agents cannot read file-based Codex credentials on a fresh line machine. In 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

## Success criteria

| Criterion | State | By |
|---|---|---|
| SC-01 Starting a run of a program that already has a live run is refused, atomically in the control plane, naming the live run; a run still pending with no attach and no dispatch after a short grace period is ended as interrupted (never started) and no longer counts. | met | S-01 |
| SC-02 A project opts in with a line branch in nightshift.config.json; when a remote run's program branch is pushed to GitHub, the control plane queues its new range for the line and, if no line owner is live, starts exactly one. | met | S-02 |
| SC-03 The line owner takes everything queued (up to a cap), merges main and then each program branch's new range onto the line head, runs the landing checks on the result, and publishes the line with a compare-and-swap push; a failed batch is composed one range at a time; the queue and the owner survive the machine dying, and two owners never run at once. | met | S-03, S-04 |
| SC-04 When a composition conflicts or its checks go red, a resolver agent repairs it from the line head on the line owner's machine; its fix lands on the line after the same checks and an examination by a different model, and is recorded as a decision; after three failed attempts or an hour the composition is parked and reported, and the rest of the queue goes on. | met | S-03, S-04 |
| SC-05 Work the control plane starts by itself is held to a per-project monthly compute cap (default $25); at the cap the line stops composing and says why, and programs keep landing on their branches. | met | S-02 |
| SC-06 `nightshift line status` shows the line's head, what is queued, what each composed commit contains (program ranges, its verification, any resolver decision), and any parked composition; and the architecture records the project line. | met | S-02, S-04 |

## Parked

Nothing was parked.

## Deferred

Nothing was deferred.

## Human prerequisites still pending

None.

## Decision graph

Every decision the run recorded: what was weighed, what it produced, and whether you
reversed it. To reverse one: `nightshift decision reverse <program> <decisionId> --choice … --reason …`.

- **Plan:** D-01: Who composes onto the project line: each run for itself, or one line owner? (`dec_01M5XW8FENM6XGGWS8KK7S7XWG`)
  Chose: One line owner per line, started by the control plane when work is queued and stopped when idle. It removes the engine's need for GitHub mid-run and for push outcomes, outlives any one run, and is the one place batching and later bisection can live (PK-7).
  Weighed: Each run composes its own strands, with compare-and-swap pushes
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-02: When and in what units does the line owner compose? (`dec_01M5XW8FH4XRXFN2RP388YBHM4`)
  Chose: Natural batching: compose at once when idle, and take everything that arrived meanwhile as one batch, by program-branch range; a failed batch is composed one range at a time. No added latency at low volume, batches grow with load, a program's own strands are already proven together, and the fallback is the simple form of the bisection PK-7 brings.
  Weighed: Each strand on its own as it lands
  Weighed: Collect landings for a fixed time window
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-03: May the resolver land its own fix onto the line? (`dec_01M5XW8FM37PFDBJMHMFM0AMJF`)
  Chose: Yes, after the landing checks and an examination by a different model, recorded as a decision for later review. Runs fix and record rather than stop; nothing ships from the line in M1b, so a wrong fix costs a later repair.
  Weighed: No, it stops for the owner
  Weighed: Mechanical conflicts only; red checks wait for the owner
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-04: How is work the control plane starts by itself bounded? (`dec_01M5XW8FQ9PXN2EM4AB26KR2MK`)
  Chose: A per-project monthly compute cap (default $25), an hour per composition and three resolver attempts, under the org's ceilings. The first work that spends without the owner starting it; models run on the org's subscriptions, so the attempt and time limits bound quota and the cap bounds machine spend.
  Weighed: The org's ceilings only
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-05: How does main relate to the line in M1b? (`dec_01M5XW8FSWQ9FPHXWDQPY9K16Y`)
  Chose: Programs still reach main through their own pull requests, merged with a merge commit; the line takes main in before composing; a conflict the resolver fixed on the line is fixed again at the pull request, with the line's fix as reference. main only ever receives whole programs; a line pull request would carry half-finished programs. M2's candidates feed main from the line and close the gap.
  Weighed: A pull request from the line to main
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-06: Does a local run's work reach the line? (`dec_01M5XW8FW98471RNTAZ16NVJ6P`)
  Chose: Not in M1b: the line composes what reaches GitHub through the publisher, which is remote runs' program branches. The line composes what reaches GitHub through the publisher; a laptop pushing the line would be a new path trusting the owner's own credentials.
  Weighed: Yes: local runs push their program branch with the owner's credentials and queue it
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-07: How does a run that never started stop counting as live? (`dec_01M5XW8FYK67YZ5JPFVNZ134A2`)
  Chose: The next start of that program ends a run still pending with no attach and no dispatch after a grace period as interrupted (never started). The next start can settle it; a sweeper is more moving parts for the same case.
  Weighed: A periodic sweep in the control plane
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-08: What is the line setting called, and its default branch? (`dec_01M5XW8G7R3K29KKQPN4WQ8RK9`)
  Chose: `"line": { "branch": "nightshift/develop" }` in nightshift.config.json, absent meaning off; docs say "project line" to keep it apart from the provisional line. Opt-in and explicit, and the docs keep it apart from the provisional line.
  Weighed: A top-level `developBranch` string
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 1 — 3 jobs, 1 starting at once (`dec_01M5XX468Q7Z4QCETM64XYV9BN`)
  Chose: J1: Make the run store itself guard one live run per program, atomically, on every adapter. Add a DomainError `ProgramRunLiveError` (code `program_run_live`) to packages/core/src/errors.ts carrying `programId` and `liveRunId`, and document on `RunStore.put` in packages/core/src/ports/stores.ts: putting a run in a non-terminal status (pending/running) claims a per-program live-run marker in the same atomic operation as the run record, refused with ProgramRunLiveError naming the holder when another run of the same program holds it; putting a run in a terminal status (RUN_TERMINAL_STATUSES) writes the run and releases the marker if this run holds it, in the same atomic operation; a terminal put of a run that does not hold the marker leaves the marker alone. Implement it in the memory adapter (packages/persistence/src/memory/index.ts, inside its existing one-unit transaction so the local SQLite adapter inherits it atomically) and the DynamoDB adapter (packages/persistence/src/aws/stores.ts, a transactWrite of the run Put plus a conditional marker Put `attribute_not_exists(PK) OR runId = :runId` on claim, and a conditional marker Delete `runId = :runId` on release, mapping the condition failure to ProgramRunLiveError with the holder read back; keys in aws/keys.ts). Carry the error across HTTP: map `program_run_live` to 409 in apps/api/src/errors.ts and back to ProgramRunLiveError in packages/persistence/src/http/errors.ts with liveRunId and programId preserved (put them in the error body, not only the message), so a client using the HTTP stores gets the typed error naming the live run. Add the guard to the shared conformance suite (test/src/conformance/persistence-ports.ts), which already runs against memory, local SQLite and the fake-table DynamoDB adapter (apps/api/src/aws-conformance.test.ts). Fix any existing test, fixture or studio preview scenario that puts two live runs of one program (e.g. persistence-ports.ts around runOne/secondRunId, test/src/execution/world.ts, apps/studio/src/preview/scenarios.ts) so the suite stays green, without weakening what they test. Grep every code path that writes a Run record (stores.runs.put and any direct table write) and confirm each terminal ending goes through the store so it releases.
  depends on: nothing (starts at once)
  touches: packages/core/src/errors.ts, packages/core/src/ports/stores.ts, packages/persistence/src/memory/**, packages/persistence/src/local/**, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/keys.ts, packages/persistence/src/aws/stores.test.ts, packages/persistence/src/http/errors.ts, apps/api/src/errors.ts, apps/api/src/operations/projects.ts, test/src/conformance/**, test/src/execution/world.ts, apps/studio/src/preview/scenarios.ts
  - ProgramRunLiveError exists in core with code `program_run_live`, programId and liveRunId, and DOMAIN_ERROR_STATUS maps it to 409; the HTTP client maps it back to ProgramRunLiveError with liveRunId intact (a test in packages/persistence/src/http or apps/api shows a PUT of a second live run through the API yields ProgramRunLiveError whose liveRunId is the first run)
  - Conformance tests, passing on in-memory, in-memory deferred, local SQLite and fake-table DynamoDB: a second pending run of a program with a pending or running run is refused with ProgramRunLiveError naming the first and is not stored; a run of a different program is not affected; once the first run is put in each terminal status (succeeded, failed, cancelled, interrupted) a new run of the program is accepted; updating the live run itself (pending -> running, re-put of the same record) is accepted; a terminal put of a run that does not hold the marker does not release another run's marker
  - The DynamoDB adapter writes the run and the marker in one transactWrite (claim and release), shown by an aws/stores.test.ts test or by the conformance suite on the fake table
  - npm run build, npm run typecheck, npm run lint and npm run test are green

J2: Settle a never-started run at the next start (D-07). Add packages/core/src/rules/run-liveness.ts (exported from rules/index.ts) with a named grace constant `NEVER_STARTED_GRACE` of 15 minutes and a pure predicate `isNeverStartedRun(run, { dispatch, now, grace })`: true only when the run is `pending`, its `startedAt` is older than the grace, and no dispatch exists for it (pending already means no orchestrator attached, since attach moves the run to running). In packages/execution/src/start-run.ts, when `stores.runs.put(run)` is refused with ProgramRunLiveError, read the live run and its dispatch (`stores.dispatches.get`); if it is never-started, end it with transitionRun's `interrupt` event, outcomeReason `never started`, endedAt now, put it (which releases the program), emit nothing that requires an outbox, then retry the new run's put once; otherwise rethrow the ProgramRunLiveError unchanged. Do it before any other record of the new run (node, checkpoint, decisions, events) is written, so a refused start leaves nothing behind.
  depends on: J1
  touches: packages/core/src/rules/run-liveness.ts, packages/core/src/rules/run-liveness.test.ts, packages/core/src/rules/index.ts, packages/execution/src/start-run.ts, test/src/execution/start-run*.test.ts
  - Unit tests for isNeverStartedRun: pending past grace with no dispatch is true; within grace, running, terminal, or with a dispatch is false
  - Execution tests (with memory stores) show: a start of a program whose only run is pending past the grace with no dispatch ends that run as interrupted with outcomeReason `never started` and proceeds to create the new run; a start while the live run is running, or pending within the grace, or pending with a dispatch, throws ProgramRunLiveError naming it and writes no run, node, checkpoint, decision or event for the refused start
  - npm run build, npm run typecheck, npm run lint and npm run test are green

J3: Make the CLI say so. In apps/cli/src/commands/run-program.ts (`nightshift run`) and apps/cli/src/commands/remote.ts (`nightshift remote` dispatch, which starts a run before dispatching it), catch ProgramRunLiveError from starting the run and print a plain refusal naming the program and the live run id, e.g. `program <programId> already has a live run <runId>; wait for it to end or cancel it before starting another`, and exit non-zero without launching an orchestrator or creating a dispatch. Keep the existing error handling for everything else.
  depends on: J1
  touches: apps/cli/src/commands/run-program.ts, apps/cli/src/commands/remote.ts, apps/cli/src/commands/run.test.ts, apps/cli/src/commands/remote.test.ts
  - A CLI test for `nightshift run` and one for `nightshift remote` in which starting the run throws ProgramRunLiveError shows the message naming the program and the live run id, a non-zero exit, and that no orchestrator launch / dispatch request happened
  - npm run build, npm run typecheck, npm run lint and npm run test are green. The guard lives in the store's RunStore.put rather than in the API handler or the CLI, so every writer of a run (local CLI on SQLite, API on DynamoDB, orchestrator endings, shutdown, resume) claims and releases the marker with no path able to skip it, and the claim is atomic with the run record (the plan's approach). J1 is one job, not a core/memory/aws split, because the conformance suite already runs against the fake-table DynamoDB adapter in npm test: adding the conformance cases without the DynamoDB implementation would turn the suite red. The refusal names the live run through the error's liveRunId, which also lets startRun find the run to settle without a new store method or route. J2 (D-07 settle in startRun + core rule) and J3 (CLI messages) both need only J1's error class and guard, touch disjoint files, and run in parallel. apps/api/src/operations/dispatch.ts needs no change: it already refuses dispatching a non-pending run, and the run is started (and refused) before dispatch. apps/mcp/src/session.ts needs no change: attach moves pending->running, which keeps the marker it holds.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M5XX81KK731CSVJMQ3QR8RZE`)
  Chose: The store-level guard and J1 followed by parallel J2/J3 are a sensible split, but the specified stale-run settlement is not safe against attach or dispatch, and the DynamoDB release algorithm contradicts its required non-holder behavior. The plan also omits two required verification gates and misidentifies the remote start entry point.
- [MATERIAL] J2 reads pending/no-dispatch and later unconditionally puts an interrupted run. Attach can write running between those operations, or dispatch can be recorded after the no-dispatch read; J1 checks only marker ownership, so cleanup can interrupt a run that actually started and free its program for another run. apps/api/src/operations/dispatch.ts checks pending separately from dispatches.put, and apps/mcp/src/session.ts writes running through runs.put; neither serializes with cleanup. Require atomic conditional settlement coordinated with attach and dispatch, with interleaving tests on the store adapters. This changes the J1/J2 persistence seam and cannot be solved by the proposed pure predicate plus ordinary put. (J1, J2)
- [MATERIAL] The specified terminal transaction (run Put plus marker Delete conditioned on runId = :runId) aborts when the marker is absent or belongs to another run. That prevents the promised terminal write while leaving another holder untouched, and also fails repeated terminal writes after release. Specify a race-safe non-holder/absent-marker path that still persists the terminal record, and test both cases; mapping all such condition failures to ProgramRunLiveError does not implement the stated RunStore contract. (J1)
- [MATERIAL] No job acceptance includes npm run synth or npm run check:sterility, although strand acceptance 4 explicitly requires both and package.json configures them separately from build/typecheck/lint/test. Assign the complete final verification to a job or explicit strand integration step. (J1, J2, J3)
- [minor] There is no nightshift remote start/dispatch command: cli.ts exposes remote status|cancel|resume, while run-program.ts starts both local and --remote runs before calling remote.ts dispatchRun. Target the shared start error handling and test nightshift run plus nightshift run --remote; a catch in remote.ts cannot catch the startRun failure because dispatchRun has not been called yet. (J3). An independent examiner reviewed decision dec_01M5XX468Q7Z4QCETM64XYV9BN against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** DEPARTURE: the plan says that at start, a pending run past the grace period with no attach and no dispatch is ended as interrupted first (D-07), which reads as a step in startRun before the new run is written. Instead the settlement happens inside the run store's put of the new run, in the same atomic operation that claims the program's live-run marker: when the marker's holder is pending, older than the grace by the new run's startedAt, and has no dispatch, the store ends it as interrupted ("never started"), moves the marker and writes the new run in one transaction. Dispatch creation becomes conditional on the run still being pending, and the store refuses moving a terminal run back to a live status, so neither attach nor dispatch can race the settlement. (`dec_01M5XX986HQYHXCH0TKQR2S43S`)
  Chose: Settle the never-started holder inside RunStore.put of the new run, atomically with the marker move; make dispatch creation conditional on the run being pending; refuse a terminal-to-live status regression in the store.. D-07 is a human decision about what happens (the next start settles it, no sweeper); doing it in the same atomic write as the marker claim is the only way to make it safe against attach and dispatch on all three stores, and the remote path through the HTTP stores gets it with no new route. The outcome is the same: the next start of the program ends the stale run as interrupted (never started) and proceeds.
  Weighed: Settle in startRun: read the holder, check pending and no dispatch, put it interrupted, retry, rejected because Not atomic: an attach or a dispatch can land between the read and the write, so a run that really started gets interrupted and its program freed (plan review finding). It would also need a new HTTP route for a conditional settle on the remote path.
  Weighed: A conditional settle as a separate store method plus a new API route, rejected because Two calls where one transaction does it, and a route that exists only to be called just before a put.
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 2 — 3 jobs, 1 starting at once (`dec_01M5XXA6N4Q5CCBRXBWWRKT4M1`)
  Chose: J1: Make the run store itself guard one live run per program, atomically, on every adapter. Add a DomainError `ProgramRunLiveError` (code `program_run_live`) to packages/core/src/errors.ts carrying `programId` and `liveRunId`, and document on `RunStore.put` in packages/core/src/ports/stores.ts: (a) putting a run in a non-terminal status (pending/running) claims a per-program live-run marker in the same atomic operation as the run record, refused with ProgramRunLiveError naming the holder when another run of the same program holds it, writing nothing; (b) putting a run in a terminal status (RUN_TERMINAL_STATUSES) always persists the run, and releases the marker in the same atomic operation if and only if this run holds it; a terminal put of a run that does not hold the marker (absent, or held by another run, or a repeated terminal write after release) persists the run and leaves the marker untouched; (c) a put that would move a stored terminal run back to a non-terminal status is refused with IllegalTransitionError (so an attach cannot revive a run ended under it). Implement in the memory adapter (packages/persistence/src/memory/index.ts, inside its existing one-unit transaction, so the local SQLite adapter inherits it atomically) and the DynamoDB adapter (packages/persistence/src/aws/stores.ts; marker keys in aws/keys.ts). For DynamoDB: claim = transactWrite of the run Put (conditioned against a stored terminal status for (c)) plus a marker Put conditioned `attribute_not_exists(PK) OR runId = :runId`, a marker-condition failure read back and mapped to ProgramRunLiveError naming the holder; release = read the marker, and if this run holds it transactWrite the run Put plus a marker Delete conditioned `runId = :runId`, otherwise transactWrite the run Put plus a ConditionCheck that the marker is absent or not held by this run; on a condition failure re-read and retry a bounded number of times, never mapping a release race to ProgramRunLiveError. Carry the error across HTTP: map `program_run_live` to 409 in apps/api/src/errors.ts and back to ProgramRunLiveError in packages/persistence/src/http/errors.ts with liveRunId and programId preserved (in the error body, not only the message). Add the guard to the shared conformance suite (test/src/conformance/persistence-ports.ts), which already runs against memory, local SQLite and the fake-table DynamoDB adapter (apps/api/src/aws-conformance.test.ts). Fix any existing test, fixture or studio preview scenario that puts two live runs of one program or revives a terminal run (e.g. persistence-ports.ts around runOne/secondRunId, test/src/execution/world.ts, apps/studio/src/preview/scenarios.ts), without weakening what they test. Grep every code path that writes a Run record and confirm each terminal ending goes through RunStore.put so it releases.
  depends on: nothing (starts at once)
  touches: packages/core/src/errors.ts, packages/core/src/ports/stores.ts, packages/persistence/src/memory/**, packages/persistence/src/local/**, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/keys.ts, packages/persistence/src/aws/stores.test.ts, packages/persistence/src/http/errors.ts, apps/api/src/errors.ts, apps/api/src/http-adapter.test.ts, test/src/conformance/**, test/src/execution/world.ts, apps/studio/src/preview/scenarios.ts
  - ProgramRunLiveError exists in core with code `program_run_live`, programId and liveRunId; DOMAIN_ERROR_STATUS maps it to 409; a test shows a PUT of a second live run through the API via the HTTP stores yields ProgramRunLiveError whose liveRunId is the first run
  - Conformance tests, passing on in-memory, in-memory deferred, local SQLite and fake-table DynamoDB: a second run (pending or running) of a program with a pending or running run is refused with ProgramRunLiveError naming the first and is not stored; another program is unaffected; once the first run is put in each terminal status (succeeded, failed, cancelled, interrupted) a new run of the program is accepted; updating the live run itself (pending -> running, re-put of the same record) is accepted; a terminal put of a run that does not hold the marker is persisted and does not release another run's marker; a repeated terminal put after release is persisted; a put moving a terminal run back to running is refused with IllegalTransitionError
  - The DynamoDB adapter writes the run and the marker claim/release in one transactWrite, shown by the conformance suite on the fake table or an aws/stores.test.ts test
  - npm run build, typecheck, lint, test, `npm --workspace @nightshift/cdk run synth` and `npm run check:sterility` are green

J2: Settle a never-started run at the next start (D-07), atomically with the start, and make dispatch unable to race it. Add packages/core/src/rules/run-liveness.ts (exported from rules/index.ts) with `NEVER_STARTED_GRACE` (15 minutes) and a pure predicate `isNeverStartedRun(holder, { hasDispatch, at, grace })`: true only when the holder is `pending`, `at` (the new run's startedAt) is later than holder.startedAt plus the grace, and it has no dispatch (pending already means no orchestrator attached, since attach moves a run to running, and J1 refuses reviving a terminal run). Extend RunStore.put's claim (port doc + memory adapter + DynamoDB adapter): when the marker is held by another run that isNeverStartedRun at the new run's startedAt, the same atomic operation ends the holder as interrupted (endedAt = new run's startedAt, outcomeReason `never started`, via core's transitionRun), moves the marker to the new run and writes the new run. In DynamoDB that is one transactWrite: holder Put conditioned on its stored status still `pending` and startedAt unchanged, ConditionCheck that the holder's dispatch item does not exist, marker Put conditioned on runId = holder, new run Put; on a condition failure re-read and decide again (bounded), refusing with ProgramRunLiveError naming the holder if it is no longer never-started. Make DispatchStore.put of a new dispatch atomic with its run being pending (memory: in one unit; DynamoDB: transactWrite with a ConditionCheck on the run item's status = pending), refused with IllegalTransitionError (or the existing typed refusal the API maps to 409 `run_not_pending`) otherwise, so a dispatch and a settlement cannot both commit. packages/execution/src/start-run.ts already writes the run before any other record; keep that so a refused start leaves nothing behind, and add an execution-level test.
  depends on: J1
  touches: packages/core/src/rules/run-liveness.ts, packages/core/src/rules/run-liveness.test.ts, packages/core/src/rules/index.ts, packages/core/src/ports/stores.ts, packages/persistence/src/memory/index.ts, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/stores.test.ts, apps/api/src/operations/dispatch.ts, packages/execution/src/start-run.ts, test/src/conformance/persistence-ports.ts, test/src/execution/start-run*.test.ts
  - Unit tests for isNeverStartedRun: pending past the grace with no dispatch is true; within the grace, running, terminal, or with a dispatch is false
  - Conformance tests on in-memory, local SQLite and fake-table DynamoDB: putting a new run while the holder is pending past the grace with no dispatch ends the holder as interrupted with outcomeReason `never started` and stores the new run as the holder; while the holder is running, pending within the grace, or pending with a dispatch, the put is refused with ProgramRunLiveError naming it and the holder is unchanged; a new dispatch for a run that is no longer pending (e.g. settled as never started) is refused and not stored
  - An interleaving test on the DynamoDB fake table (and memory) shows that a dispatch committed between the settle's read and its write makes the settle fail its condition and the start be refused, not interrupt the dispatched run
  - An execution test (startRun on memory stores) shows a start of a program whose only run is stale-pending proceeds and ends the old run as interrupted (never started), and a start refused by a live run writes no run, node, checkpoint, decision or event
  - npm run build, typecheck, lint, test, `npm --workspace @nightshift/cdk run synth` and `npm run check:sterility` are green

J3: Make the CLI say so. `nightshift run` (apps/cli/src/commands/run-program.ts) starts both local runs and `--remote` runs with startRun before remote.ts's dispatchRun is ever called, so handle it there, in the shared start path: catch ProgramRunLiveError from starting the run and print a plain refusal naming the program and the live run id, e.g. `program <programId> already has a live run <runId>; wait for it to end or cancel it before starting another`, and exit non-zero without launching an orchestrator or requesting a dispatch. Keep the existing error handling for everything else.
  depends on: J1
  touches: apps/cli/src/commands/run-program.ts, apps/cli/src/commands/run.test.ts, apps/cli/src/commands/remote.test.ts
  - CLI tests for `nightshift run` and `nightshift run --remote` in which starting the run throws ProgramRunLiveError show the message naming the program and the live run id, a non-zero exit, and that no orchestrator launch and no dispatch request happened
  - npm run build, typecheck, lint, test, `npm --workspace @nightshift/cdk run synth` and `npm run check:sterility` are green. Revised after review (departure recorded as dec_01M5XX986HQYHXCH0TKQR2S43S): the never-started settlement moves into the store's put of the new run, atomic with the marker move and conditioned on the holder still pending with no dispatch; dispatch creation is made conditional on the run being pending; the store refuses a terminal->live regression so a late attach cannot revive a settled run. The terminal release path is specified race-safe for absent/foreign markers. J1 (marker guard, all adapters, HTTP error) must come first; J2 (settle + conditional dispatch) also changes memory/aws stores and the conformance suite, so it waits for J1 rather than conflict with it. J3 (CLI message in run-program.ts, which handles both local and --remote starts) needs only J1's error and runs beside J2 on disjoint files. Each job's acceptance carries all six gates. apps/mcp/src/session.ts needs no change: attach's pending->running keeps the marker it holds, and a revived terminal run is refused by the store.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 2 of 2 — sound (`dec_01M5XXBPQSRSE6B3AMTKXKPFAV`)
  Chose: The revised split covers all four acceptance criteria: atomic store enforcement and terminal release, race-safe never-started settlement, typed HTTP conflicts, and refusal messages for both CLI start modes. J1 must precede J2 because they change the same persistence paths and conformance suite; J3 can then run beside J2 on separate CLI files, with each job responsible for the six verification gates. The inspected start, attach, terminal-write and dispatch paths support the proposed integration without an additional job.. An independent examiner reviewed decision dec_01M5XXA6N4Q5CCBRXBWWRKT4M1 against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Landing fix round 1: the examiner found (F-01) that runs persisted before the marker existed are invisible to the guard, and (F-02) that the never-started decision and its endedAt trust the incoming run's client-supplied startedAt. (`dec_01M5Y0NZ8S56ZEYW9MTC121TMS`)
  Chose: F-01: when the marker is absent, the store looks for a live (non-terminal) run of the program already stored, inside the same atomic unit (memory/SQLite) or with a conditional create of the marker on its behalf (DynamoDB), adopts it as the holder, and then decides exactly as if it had held the marker. F-02: the stores take a trusted clock (the control plane's, injectable for tests, defaulting to the system clock); the marker records `claimedAt` from that clock when it is claimed (and an adopted legacy run is stamped with the adoption time), staleness is trusted-now minus claimedAt against the grace, and the settled run's endedAt is trusted-now. The client's startedAt plays no part.. Both fixes stay inside the one atomic put the strand is built on, so the remote path through the API gets them without new routes, and neither depends on a client's clock or on a migration being run before deploy. Stamping an adopted legacy run with the adoption time errs toward not interrupting it: at worst it is settled one grace period later.
  Weighed: A one-off migration that backfills markers for every existing live run before deploy, rejected because Deploying is forbidden in this program and a separate migration step can be skipped or run late; adopting lazily inside the same atomic put needs no ordering with deploy.
  Weighed: Have the API refuse a new run whose startedAt is far from the server clock, rejected because Still decides staleness from a client field and would break every caller and test with a fixed clock; recording the trusted claim time in the marker removes the client field from the decision altogether.
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** The arbiter's ruling on finding F-01 of examination exam_01M5Y2FVFBEYTQGWMEA66D6SK6. (`dec_01M5Y2M5F6CNCCK2GCK3VVDB06`)
  Chose: uphold. The defect is real and I reproduced it in this checkout. On the memory store I seeded two pre-marker runs for one program (the lowest id pending with no dispatch, the other running), started a third run, got the expected refusal naming the pending one, advanced the store's clock past NEVER_STARTED_GRACE, and started again: the put was accepted and the program's runs read interrupted, running, pending. Two live runs of one program is exactly what acceptance criterion 1 forbids, and the one-live-run guard is the deliverable of S-01.

The cause is in the code as the examiner says. Legacy discovery (memory/index.ts around lines 397-405; aws/stores.ts findLegacyHolder) runs only when the marker is absent and picks one run. Settlement (memory/index.ts lines 412-435; aws/stores.ts settleNeverStarted) then interrupts that single holder and hands the marker to the incoming run with no check that another legacy run of the program is still live. The DynamoDB transaction conditions on the holder's status, the holder's missing dispatch, and the marker's claim, but nothing in it constrains any other run of the program, so the FakeTable result the examiner reports follows from the same logic.

This is not a theoretical race: it is a deterministic sequence of two ordinary starts against any existing program that had more than one open run before the marker was introduced, which is the population the legacy-adoption path exists to protect. The conformance suite covers two legacy running runs (adopt the lowest, refuse) but has no case where the adopted holder is settleable while a sibling stays live, so the gap is also a missing test, as the finding asks. The earlier adoption/completion race fix does not touch this path. The work should not land until settlement re-checks for other live runs of the program (or adoption prefers a holder that cannot be settled while a live sibling exists) on all three stores, with the multi-legacy case added to conformance.
  Weighed: overturn, rejected because the arbiter chose to uphold
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Landing fix round 3 (arbiter ruling F-01): when a program has several runs stored before the live-run marker existed, settling the adopted never-started holder admitted the new run while another of those runs was still live. (`dec_01M5Y2N8TXDNRRDRVHVARKT1HD`)
  Chose: Adoption prefers a holder that cannot be settled (running, or pending with a dispatch), falling back to the lowest id. Settlement re-checks the program's other non-terminal runs. If any remain, it still ends the never-started holder, hands the marker to one of them (running or dispatched first) with claimedAt set to the trusted now, and refuses naming that run. The new run is admitted only when no other live run of the program remains. On DynamoDB the hand-over is one transactWrite: it is conditioned on the holder still pending with no dispatch, the marker unchanged, and the new holder still non-terminal, and any condition failure re-reads and decides again.. Every start makes progress: each leftover pending legacy run is adopted, then settled after its own grace period, so the program is eventually freed and is never left with two live runs. Runs without a marker can only move toward terminal (no new run is created without the marker, and the store refuses revival), so a snapshot of the program's runs taken at settlement, checked by conditions in the write, is sound.
  Weighed: At settlement, refuse naming the other live legacy run and write nothing, rejected because With two stale pending legacy runs the second is never adopted, so it never gets a claim time and is never settled: the program would be blocked for good.
  Weighed: Backfill markers for every program before accepting starts, rejected because Needs a migration step tied to deploy, which this program may not do, and the store already has the atomic put to do it lazily.
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN: round 1 — 6 jobs, 1 starting at once (`dec_01M5Y4CR5FDDA28687GB8B9YSC`)
  Chose: J1: Foundation for the project line, so the other jobs can build in parallel. (1) Contracts: `LineConfigSchema {branch, monthlyUsd?}` as optional `line` on NightshiftConfigSchema and ProgramContractSchema, added to INHERITED_CONTRACT_FIELDS (plan hash of contracts without it unchanged). New packages/contracts/src/v1/line.ts with LineRecordSchema {schemaVersion, projectId, branch, repositoryUrl, version, head?, queue:[{program, upTo, enqueuedAt}], batch?:{batchId, entries, takenAt, generation}, compositions:[{compositionId, commit, parent, ranges:[{program, from?, upTo}], verification: LineVerification (own verificationId, phase 'line', commitSha, baseSha, commands, outcome, startedAt, endedAt), resolver?:{decision none|resolved|gave_up, attempts 0..3, detail?}, composedAt, pushed?}] (newest 50 kept), parked:[...] (newest 50), push?: LinePush {head, expectedPredecessor, bundleKey, generation, status pending|published|conflict|protected|forbidden|error, requestedAt, resolvedAt?, detail?}, selfStarted:{month, meteredUsd, capUsd, reachedAt?}, waiting?:{reason monthly_cap|org_month_ceiling|org_concurrency|not_configured, detail, since}, updatedAt}; LineDispatchSchema (project-scoped, keyed by branch, reusing DispatchStatus/Attempt/Spend/Cleanup/Progress/Workspace schemas, generation, engineAgentId, failure with codes incl. line_cap); request/response body schemas for the line routes (take batch, compose, park, push request, heartbeat reuse, view = {record, dispatch?, programs: branch name per queued program}). `line` added to VERIFICATION_PHASES with HAS_JOB false; core LANDING_EVIDENCE.line=false. Line principal {kind:'line', projectId, branch, agentId, generation} in PrincipalSchema and as an alternative in ExecutionTokenClaims. (2) Core: pure rules in packages/core/src/rules/line.ts (appendQueueEntry idempotent by program+upTo, takeBatch, compose, park, requestPush, resolvePush, meterSelfStarted with month rollover, capReached, newLineDispatch with generation=prev+1, constants DEFAULT_LINE_MONTHLY_USD=25, LINE_COMPOSITION_SECONDS=3600, LINE_RESOLVER_ATTEMPTS=3); dispatch machine rules (transitionDispatch, leaseLost, beginReplacement, runnerStopped, foldProgress, foldStages, nextGeneration, attemptsExhausted) made generic over a structural machine type with no behaviour change; `ensureLineDispatch({stores, clock, ids, startMachine})` (checks the cap and the org month ledger by get, records `waiting` when reached, else conditional start then startMachine; never lists); ports LineStore {get, update(change) CAS on version} and LineDispatchStore {get, start(next)->'started'|'live', put (refuses lower generation), listByStatus} added to ProjectStores; LineDispatchLiveError if needed; optional `signKey` on the upload signer port. Authorize: add line.* operations to Operation, forbidden in every existing table, and a deny-all branch for kind 'line' (J3 opens it). (3) Persistence: memory (and so SQLite) implementations with real CAS and the one-live guard; http client stores (get via routes, writes controlPlaneOwns); routes.line*(projectId, branch) with the branch encodeURIComponent-ed; aws/stores.ts gets throwing placeholders only. (4) API plumbing: RequestPrincipal/verify.ts accept the line principal; enforce refuses it (403) for now; tokens/mint.ts gains mintLineToken; http.ts Dispatcher gains optional provisionLine/publishLine; route-table test exempts line.* temporarily if needed.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line.ts, packages/contracts/src/v1/config.ts, packages/contracts/src/v1/program-contract.ts, packages/contracts/src/v1/verification.ts, packages/contracts/src/v1/principal.ts, packages/contracts/src/v1/index.ts, packages/contracts/src/index.ts, packages/core/src/rules/line.ts, packages/core/src/rules/verification.ts, packages/core/src/rules/dispatch.ts, packages/core/src/rules/authorize.ts, packages/core/src/line/**, packages/core/src/errors.ts, packages/core/src/ports/stores.ts, packages/core/src/ports/artifact-bodies.ts, packages/core/src/index.ts, packages/core/src/rules/index.ts, packages/persistence/src/memory/index.ts, packages/persistence/src/http/stores.ts, packages/persistence/src/http/routes.ts, packages/persistence/src/aws/stores.ts, apps/api/src/auth/principal.ts, apps/api/src/auth/enforce.ts, apps/api/src/tokens/verify.ts, apps/api/src/tokens/mint.ts, apps/api/src/http.ts, apps/api/src/route-table.test.ts
  - npm run build, typecheck, lint and the full test suite are green
  - nightshift.config.json and a program contract accept an optional `line: {branch}`; a contract without it parses and hashes exactly as before; inheritFromConfig carries `line`
  - VERIFICATION_PHASES contains `line`, VERIFICATION_PHASE_HAS_JOB.line is false and isLandingEvidence('line') is false, with unit tests
  - Unit tests for rules/line.ts: idempotent append, batch take/compose/park, resolver attempts above 3 refused, push request/resolve, month rollover and cap reached, generation continuing across dispatches
  - Memory store tests: concurrent lines.update calls both apply (CAS retry); lineDispatches.start returns 'started' exactly once of two concurrent starts and 'live' while one is non-terminal; ensureLineDispatch records `waiting` at the cap and does not start
  - Existing dispatch rule tests pass unchanged after the generics
  - A line-principal token minted by mintLineToken verifies and is refused by enforce for every operation

J2: DynamoDB implementation of LineStore and LineDispatchStore, with conformance on every adapter. Keys in packages/persistence/src/aws/keys.ts: line (PROJ#<id>, LINE#<branch>), lineDispatch (PROJ#<id>, LINEDISPATCH#<branch>) with a status index on the node GSI like dispatchIndex. lines.update is a conditional put on version with re-read and retry (the putVersioned/programContracts.update pattern). lineDispatches.start is a single-item conditional put: attribute_not_exists OR (status in stopped/failed AND generation = :prev). No transactWrite (the publisher role has only GetItem/PutItem). A new test/src/conformance/line-ports.ts suite, registered for memory, local SQLite and the AWS FakeTable conformance.
  depends on: J1
  touches: packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/keys.ts, packages/persistence/src/aws/keys.test.ts, test/src/conformance/line-ports.ts, test/src/conformance/memory.test.ts, test/src/conformance/local.test.ts, apps/api/src/aws-conformance.test.ts
  - The line conformance suite passes on memory, SQLite and DynamoDB FakeTable: CAS retry with concurrent updates, exactly one 'started' of concurrent starts, 'live' while non-terminal, a start after a terminal one requires generation prev+1, put refuses a lower generation, listByStatus
  - keys.test.ts covers the new keys; no transactWrite in the line stores
  - npm run build, typecheck, lint and test are green

J3: The API the line owner and humans use. New apps/api/src/operations/line.ts, with routes in handler.ts under /projects/{projectId}/lines/{branch} (branch URL-encoded as one segment): GET (view: record, dispatch, branch name of each queued program; users of the org, and the line principal for its own line); POST batch (take everything queued as one batch, or answer empty); POST compositions; POST parked; POST push (records a LinePush pending, then deps.dispatcher.publishLine); POST bundle-upload-url (key <projectId>/line/<branch>/<generation>/<id>.pack via signKey); POST heartbeat (generation fence, metering like the run heartbeat into both the org compute ledger and line.selfStarted, stop with failure line_cap and `waiting` monthly_cap when the cap, maxUsdPerRun or maxRunHours is crossed, park a batch older than LINE_COMPOSITION_SECONDS, return renewed line token, provider credentials, project secrets and a GitHub read token for the line's repository like the run heartbeat; on a `stopped` report re-read the queue and call ensureLineDispatch so an append racing the idle stop is not lost); POST dispatch/cancel (users only). rules/authorize.ts: authorizeLine allowing only line.* except cancel, same project and branch, every write fenced by the line dispatch's current generation; AuthorizationTarget gains branch; enforce.ts resolves it. lambda/api.ts wires provisionLine/publishLine to the dispatch and publisher Lambdas (async invoke with a line event). operations/dispatch.ts: the org concurrency count (liveRunsOf or equivalent) also counts live line dispatches. Remove any J1 route-table exemption.
  depends on: J1
  touches: apps/api/src/operations/line.ts, apps/api/src/handler.ts, apps/api/src/handler-line.test.ts, packages/core/src/rules/authorize.ts, packages/core/src/rules/authorize-line.test.ts, apps/api/src/auth/enforce.ts, apps/api/src/lambda/api.ts, apps/api/src/operations/dispatch.ts, apps/api/src/operations/uploads.ts, apps/api/src/route-table.test.ts, apps/api/src/aws/s3-bundles.ts
  - handler tests: a stale generation is refused 403; another project's or branch's line principal is refused; a user of another org is refused; cancel by a line principal is refused
  - heartbeat moves line.selfStarted.meteredUsd and the org ledger; crossing the cap stops the machine and records `waiting` with reason; a batch older than an hour is parked; resolver attempts above 3 are refused 409
  - a `stopped` heartbeat with a non-empty queue starts exactly one new line dispatch with the next generation
  - the route table test covers every line.* operation
  - npm run build, typecheck, lint and test are green

J4: The publisher's two line paths and their infra. (a) In apps/api/src/runner/publisher.ts, after publishAll's loop, if any step was published or already_published and the program contract names a line: lines.update appends {program, upTo: publication.head} idempotently (creating the record with repositoryUrl and head from the advertisement), then ensureLineDispatch with PublisherDeps.startLineMachine. Errors there are logged and never change the run's counts or chain. (b) publishLine(deps, {projectId, branch}) under the publish lock, keyed for the line: advertise; already at push.head is published; not at expectedPredecessor is a conflict recorded with the remote head and never forced; else push with expectedOld = expectedPredecessor (ZERO_OID when the line branch does not exist yet), classify refusals as for intents, retry `error` up to PUBLISH_ATTEMPTS; on success set head and mark the composition pushed. The outcome is written only to line.push, never to a run's dispatch. (c) lambda/runner-publisher.ts accepts RunScope | {kind:'line', projectId, branch} and wires startLineMachine as an async invoke of NIGHTSHIFT_DISPATCH_FUNCTION_ARN; aws/publish-lock.ts takes a line key. (d) infra/cdk runner-stack: grant the publisher invoke on the dispatch function plus the env var; make sure the reconciler may invoke the publisher for a pending line push; update the stack tests.
  depends on: J1
  touches: apps/api/src/runner/publisher.ts, apps/api/src/runner/publisher.test.ts, apps/api/src/runner/publisher-line.test.ts, apps/api/src/lambda/runner-publisher.ts, apps/api/src/aws/publish-lock.ts, apps/api/src/config.ts, infra/cdk/src/lib/runner-stack.ts, infra/cdk/src/lib/runner-stack.test.ts, infra/cdk/src/lib/api-stack.ts, infra/cdk/src/lib/api-stack.test.ts
  - publisher tests over the local git server: a published and an already_published program push each enqueue {program, upTo} once (a repeat does not duplicate) and start exactly one line dispatch; a project without a line is untouched
  - a failure in the line enqueue or start leaves the run's publish counts and intents unchanged
  - publishLine: a moved line ref records `conflict` with the remote head and does not push; a successful push sets line.head; a protection refusal records `protected`; the run's dispatch is never written
  - cdk synth is green; runner-stack tests assert the publisher can invoke the dispatch function and still has no dynamodb:Query
  - npm run build, typecheck, lint, test and synth are green

J5: The line machine's lifecycle. Extract the launch core of apps/api/src/runner/provision.ts (image, subnets, warm snapshot, launch, describe, failure cleanup) into a shared function with no behaviour change for runs, and add apps/api/src/runner/provision-line.ts provisionLineDispatch(deps, {projectId, branch}): same image, the project's warm snapshot, subnets hashed by engineAgentId, first token from mintLineToken written to firstTokenParameterName(stage, engineAgentId, generation), tags nightshift-kind=line, nightshift-project, nightshift-line=<branch>, nightshift-agent, nightshift-generation, nightshift-stage, nightshift-api; refuses to launch over the org's concurrency ceiling (live run dispatches plus live line dispatches), leaving it requested with `waiting` org_concurrency. lambda/runner-dispatch.ts accepts the line event. The reconciler (lambda/runner-reconciler.ts, runner/recover.ts made generic over the save) also walks lineDispatches.listByStatus: provisions stale requested ones, replaces a lost lease with the next generation within the attempt limit, sends stopping/stopped/failed ones to a new runner/line-cleanup.ts that terminates the instance and deletes the volume with no snapshot, and asks the publisher for a pending line push.
  depends on: J1
  touches: apps/api/src/runner/provision.ts, apps/api/src/runner/provision-line.ts, apps/api/src/runner/recover.ts, apps/api/src/runner/cleanup.ts, apps/api/src/runner/line-cleanup.ts, apps/api/src/runner/line-runner.test.ts, apps/api/src/lambda/runner-dispatch.ts, apps/api/src/lambda/runner-reconciler.ts
  - new tests over fakes: a line dispatch launches the same image with the project's warm snapshot and the line tags, and writes its token at the expected parameter
  - a lost lease is replaced and the generation increases; exhausted attempts end it failed; cleanup terminates and deletes the volume without a snapshot
  - at the org concurrency ceiling the line dispatch stays requested with `waiting` recorded
  - existing runner.test.ts and provisioning tests pass unchanged
  - npm run build, typecheck, lint and test are green

J6: `nightshift line status [--repo <path>]` in apps/cli: read nightshift.config.json for projectId and line.branch (no line: say so and exit 1), GET the line view through routes.line, and print head and the last push outcome, the line dispatch's status, generation and spend, self-started spend against the cap and any `waiting` reason, the queue entries, each composition with commit, program ranges (from..upTo), verification outcome and id, resolver decision and attempts, and parked compositions with their reasons. Formatting in a pure describeLine(view) function. Register in apps/cli/src/cli.ts (switch and usage) and any completion/route listing that enumerates commands.
  depends on: J1
  touches: apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts, apps/cli/src/cli.ts, apps/cli/src/commands/completion.ts
  - unit tests of describeLine for empty, queued, composed with a resolver decision, parked, cap reached and push conflict
  - no line configured prints a clear message and exits 1
  - the command appears in usage and shell completion
  - npm run build, typecheck, lint and test are green. Design (from reading the code): the plane learns a project's line from the program contract, which inherits `line` from nightshift.config.json like `compute` (the config itself never reaches the plane). The publisher already reads the contract. A line is keyed by (projectId, branch).

A line dispatch is a separate, project-scoped `LineDispatch` record, not a `Dispatch` with a synthetic run scope. `Dispatch` is run-scoped throughout: its put is a transaction conditioned on the run being pending, it carries baseSha and planHash, the token mint needs run.rootNodeId, and cleanup snapshots into the run's warm cache. The `line` kind shows up in the dispatcher event, the machine tags and a new `line` principal; the engine ExecutionPrincipal requires runId and nodeId, so it can't be reused.

The line record is versioned (compare-and-swap with re-read and retry). The publisher, the heartbeat and the owner all write it, so it can't be a plain put. The one-live-line-dispatch guard is a single-item conditional put on the LineDispatch item: absent, or stored terminal with generation = prev. The generation keeps increasing across successive line dispatches, so a dead machine's token can never pass a new dispatch's fence. No transactWrite is used: the publisher role holds only GetItem/PutItem.

Line verifications are embedded in the composition, carrying their own verificationId. `VerificationSchema` and its store are run-scoped. The `line` phase joins the vocabulary as a classification, with no job and not landing evidence.

The org's concurrency ceiling is checked at provisioning, not in the publisher, because the publisher has no Query. The monthly cap and the org month spend are GetItem reads and are checked before a start.

Split and ordering: J1 lands the shared foundation alone, because everything else imports it: contracts, core rules, ports, memory/http adapters, token mint, principal plumbing and the deny-by-default authorize entries. After it, J2 (Dynamo + conformance), J3 (API operations + auth), J4 (publisher + line push + infra), J5 (provisioning/reconciler/cleanup) and J6 (CLI) run in parallel on disjoint files.

Ownership of shared files:
- J1: stores.ts, the contracts/core index barrels, http/routes.ts, http.ts (Dispatcher gains provisionLine?/publishLine?), tokens/mint.ts.
- J2: aws/stores.ts.
- J3: handler.ts, rules/authorize.ts, auth/enforce.ts, lambda/api.ts, operations/dispatch.ts (one-function edit).
- J4: publisher.ts, runner-publisher.ts, publish-lock.ts, every infra file.
- J5: provision.ts, recover.ts, cleanup.ts, runner-dispatch.ts, runner-reconciler.ts.
- J6: cli.ts.

J1 is large, but it's one coherent seam, and splitting it would only serialise more. Not touched: packages/execution/src/line/** (S-03) and apps/mcp/** (S-04). S-04 consumes J3's routes and J5's tags and token parameter.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** DEPARTURE: The plan said 'a `line` dispatch kind' and 'fenced by generation like a run's'. Instead, a line dispatch is its own project-scoped LineDispatch record keyed by (project, line branch). The `line` kind appears in the dispatcher event, the machine tags and a new `line` token principal. Its generation keeps increasing across successive line dispatches. The line record itself is written by compare-and-swap on a version. (`dec_01M5Y4CZDFWYF0KB5HS9AK9PTS`)
  Chose: A separate LineDispatch record and line principal. The machine rules in core are shared, made generic over a structural type.. This is the smallest sound change: heartbeat, provisioning and the reconciler each get a line branch, and the run path is left untouched. A monotonic generation stops a dead owner's token from passing a later dispatch's fence.
  Weighed: Reuse Dispatch with kind 'line' under a synthetic run scope, rejected because Dispatch is run-scoped throughout. Its store put is a transaction conditioned on the run being pending, it requires baseSha and planHash, token minting needs the run's root node, and cleanup snapshots into the run's warm cache. A line has none of these.
  Weighed: Reuse the engine ExecutionPrincipal for the line owner, rejected because It requires runId and nodeId, and the engine's access table is run-scoped.
  **Compensatable**: its effects reach outside the repository.
  Produced: nothing that landed.
- **Strand S-02:** DEPARTURE: The plan said composed commits carry 'their verification id'. Instead, each composition carries an embedded LineVerification (its own verificationId, phase `line`, commands, outcome). It is not a record in the run-scoped VerificationStore. `line` joins VERIFICATION_PHASES as a classification only: it names no job and is not landing evidence. (`dec_01M5Y4D25FWE6YK8HPGTH3FZM4`)
  Chose: An embedded LineVerification with its own id, on the composition in the line record.. This keeps the verification id and the `line` phase the plan asks for without inventing a fake run for the line.
  Weighed: Store line verifications in VerificationStore, rejected because VerificationSchema is runScoped and needs an executionNodeId and an agentId; log artifacts live under the run's prefix. A line owner has no run.
  **Compensatable**: its effects reach outside the repository.
  Produced: nothing that landed.
- **Strand S-02:** DEPARTURE: The plan's 'line setting in nightshift.config.json' needs a way to reach the plane, because the config never does. Instead, `line` is inherited into the program contract, like `compute`. The plane learns a project's line from the contract of the program whose branch it publishes, so a config change takes effect at the next ratification. The org's concurrency ceiling for line machines is checked when provisioning, not in the publisher: the publisher has no Query permission. Separately, a note outside this strand: S-01's transactional ConditionCheck in dispatch and run puts may need dynamodb:ConditionCheckItem, which no role in api-stack or runner-stack grants. This should be checked before any deploy. (`dec_01M5Y4D6NJXPZAPWDPAV7S07VS`)
  Chose: Inherit `line` into the program contract (INHERITED_CONTRACT_FIELDS), and key lines by (projectId, branch).. It reuses the existing config-to-contract path, adds no new endpoint, and the field is optional, so existing plan hashes don't change.
  Weighed: Store the line on the Project record via a new project-settings route, rejected because That needs a new sync path from the CLI. The contract already carries config-inherited settings to the plane, and the publisher already reads it.
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M5Y4F92DS1PW24GGA7V3YTGX`)
  Chose: The foundation followed by parallel storage, API, publisher, lifecycle and CLI jobs is a workable split, and the main ownership boundaries are clear. However, the planned publication handoff and dispatch replacement can lose durable work or cleanup state, and the proposed spending ledger does not enforce the settled per-project cap.
- [MATERIAL] The enqueue handoff can permanently lose a successfully published range. J4 enqueues only when this invocation reports published/already_published, and logs enqueue/start failures without retaining retryable work. In the current publisher, the publication intent is already marked published before this handoff; a later invocation returns nothing_pending, and runner-reconciler asks the publisher again only for pending intents. A crash or failed lines.update after the push therefore leaves no path to queue that range; an enqueue followed by a failed dispatch start can likewise leave a queue with no dispatch for J5 to discover. Assign durable recovery of both gaps and test recovery after publication has already settled. (J4, J5)
- [MATERIAL] A terminal dispatch can be overwritten before its machine and volume are cleaned up. J2 permits replacement as soon as status is stopped/failed, and J3 immediately calls ensureLineDispatch on a stopped heartbeat with queued work. J5 relies on later reconciliation of that same single lineDispatch item to terminate/delete resources. Existing cleanup explicitly treats stopped as preceding asynchronous termination and volume deletion. Replacing the item with a fresh generation can discard the resource and cleanup state and leak compute, defeating the cap. Preserve recoverable cleanup obligations across replacement or prevent replacement until cleanup is safely retained/completed, with an idle-stop/enqueue race test. (J1, J2, J3, J5)
- [MATERIAL] D-04 requires a per-project monthly compute cap, but selfStarted.meteredUsd and capUsd live on records keyed by (projectId, branch), and ensureLineDispatch checks only that line's spend. Different program contracts can name different line branches for the same project; changing the configured branch then supplies another independent allowance in the same month. Define and enforce a shared project-month budget across those dispatches, including concurrent metering/admission, and test that changing branches cannot reset the project's allowance. (J1, J3, J5)
- [minor] Acceptance criterion 7 includes sterility, but no job acceptance runs npm run check:sterility (the root package defines it separately from build, typecheck, lint, test and synth). Assign the final combined verification, including sterility, explicitly. (J1, J2, J3, J4, J5, J6). An independent examiner reviewed decision dec_01M5Y4CR5FDDA28687GB8B9YSC against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN: round 2 — 6 jobs, 1 starting at once (`dec_01M5Y4JBRBWC7HFQMRPNKAKEG9`)
  Chose: J1: Foundation for the project line, so the other jobs can build in parallel.

(1) Contracts.
- `LineConfigSchema {branch, monthlyUsd?}` becomes an optional `line` on NightshiftConfigSchema and ProgramContractSchema, and is added to INHERITED_CONTRACT_FIELDS. A contract without it must hash exactly as before.
- New packages/contracts/src/v1/line.ts with LineRecordSchema:
  - schemaVersion, projectId, branch, repositoryUrl, version, head?
  - queue: [{program, upTo, enqueuedAt}]
  - batch?: {batchId, entries, takenAt, generation}
  - compositions: [{compositionId, commit, parent, ranges: [{program, from?, upTo}], verification: LineVerification (its own verificationId, phase 'line', commitSha, baseSha, commands, outcome, startedAt, endedAt), resolver?: {decision none|resolved|gave_up, attempts 0..3, detail?}, composedAt, pushed?}], newest 50 kept
  - parked: [...], newest 50 kept
  - push?: LinePush {head, expectedPredecessor, bundleKey, generation, status pending|published|conflict|protected|forbidden|error, requestedAt, resolvedAt?, detail?}
  - waiting?: {reason monthly_cap|org_month_ceiling|org_concurrency|not_configured, detail, since}
  - updatedAt
- ProjectSelfStartedUsageSchema {schemaVersion, projectId, month, meteredUsd, capUsd, reachedAt?, version, updatedAt}.
- LineDispatchSchema: project-scoped, keyed by branch. It reuses the DispatchStatus, Attempt, Spend, Cleanup, Progress and Workspace schemas, and has generation, engineAgentId and a failure whose codes include line_cap. The cleanup gains `settledAt`.
- The run Dispatch's publication gains optional `lineOwed` and `lineQueuedUpTo`.
- Request and response body schemas for the line routes: take batch, compose, park, push request, heartbeat (reusing the run heartbeat's), and the view = {record, dispatch?, usage?, programs: the branch name of each queued program}.
- `line` is added to VERIFICATION_PHASES with HAS_JOB false, and core's LANDING_EVIDENCE.line is false.
- A line principal {kind:'line', projectId, branch, agentId, generation} joins PrincipalSchema and is an alternative in ExecutionTokenClaims.

(2) Core.
- Pure rules in packages/core/src/rules/line.ts: appendQueueEntry (idempotent by program+upTo), takeBatch, compose, park, requestPush, resolvePush, meterProjectUsage (with month rollover), capReached, newLineDispatch (generation = prev+1), lineQueueOwed(dispatch), lineHasWork(record). Constants: DEFAULT_LINE_MONTHLY_USD=25, LINE_COMPOSITION_SECONDS=3600, LINE_RESOLVER_ATTEMPTS=3.
- The dispatch machine rules (transitionDispatch, leaseLost, beginReplacement, runnerStopped, foldProgress, foldStages, nextGeneration, attemptsExhausted) become generic over a structural machine type, with no behaviour change.
- `ensureLineDispatch({stores, clock, ids, startMachine})`:
  - checks the project ledger's cap and the org month ledger, by get only;
  - records `waiting` when either is reached;
  - otherwise does a conditional start, then startMachine;
  - never lists.
- New ports, added to ProjectStores:
  - LineStore {get, update(change) by CAS on version, listWithWork()}
  - LineDispatchStore {get, start(next) -> 'started'|'live', put (refuses a lower generation), listByStatus}. start succeeds only when no dispatch is stored, or the stored one is terminal with cleanup.settledAt set, and next.generation = prev+1.
  - ProjectSelfStartedUsageStore {get(projectId, month), update(change) by CAS}
- An optional `signKey` on the upload signer port.
- Authorize: add the line.* operations to Operation, forbidden in every existing table, plus a deny-all branch for kind 'line' (J3 opens it).

(3) Persistence.
- Memory (and so SQLite) implementations with real CAS, the start guard and listWithWork.
- HTTP client stores: gets go through the routes; writes are controlPlaneOwns.
- routes.line*(projectId, branch), with the branch encodeURIComponent-ed.
- aws/stores.ts gets throwing placeholders only.

(4) API plumbing.
- RequestPrincipal and verify.ts accept the line principal; enforce refuses it (403) for now.
- tokens/mint.ts gains mintLineToken.
- http.ts: Dispatcher gains optional provisionLine and publishLine.
- The route-table test exempts line.* temporarily if needed.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line.ts, packages/contracts/src/v1/config.ts, packages/contracts/src/v1/program-contract.ts, packages/contracts/src/v1/verification.ts, packages/contracts/src/v1/principal.ts, packages/contracts/src/v1/dispatch.ts, packages/contracts/src/v1/index.ts, packages/contracts/src/index.ts, packages/core/src/rules/line.ts, packages/core/src/rules/verification.ts, packages/core/src/rules/dispatch.ts, packages/core/src/rules/authorize.ts, packages/core/src/line/**, packages/core/src/errors.ts, packages/core/src/ports/stores.ts, packages/core/src/ports/artifact-bodies.ts, packages/core/src/index.ts, packages/core/src/rules/index.ts, packages/persistence/src/memory/index.ts, packages/persistence/src/http/stores.ts, packages/persistence/src/http/routes.ts, packages/persistence/src/aws/stores.ts, apps/api/src/auth/principal.ts, apps/api/src/auth/enforce.ts, apps/api/src/tokens/verify.ts, apps/api/src/tokens/mint.ts, apps/api/src/http.ts, apps/api/src/route-table.test.ts
  - npm run build, typecheck, lint, test and check:sterility are green
  - nightshift.config.json and a program contract accept an optional `line: {branch, monthlyUsd?}`; a contract without it parses and hashes exactly as before; inheritFromConfig carries `line`
  - VERIFICATION_PHASES contains `line`, VERIFICATION_PHASE_HAS_JOB.line is false and isLandingEvidence('line') is false, with unit tests
  - Unit tests for rules/line.ts: idempotent append; batch take, compose and park; resolver attempts above 3 refused; push request and resolve; project-usage month rollover and cap reached; generation continuing across dispatches; lineQueueOwed and lineHasWork
  - Memory store tests: concurrent lines.update calls both apply (CAS retry); of two concurrent lineDispatches.start calls exactly one returns 'started'; start returns 'live' while the stored dispatch is non-terminal, and also while it is terminal but cleanup.settledAt is unset
  - ensureLineDispatch refuses to start once the PROJECT ledger is at its cap, even for a different line branch of the same project, and records `waiting`
  - Existing dispatch rule tests pass unchanged after the generics
  - A line-principal token minted by mintLineToken verifies, and enforce refuses it for every operation

J2: DynamoDB implementation of LineStore, LineDispatchStore and ProjectSelfStartedUsageStore, with conformance on every adapter.

- Keys in packages/persistence/src/aws/keys.ts:
  - line (PROJ#<id>, LINE#<branch>), with a sparse GSI key on the node index that is present only while lineHasWork(record);
  - lineDispatch (PROJ#<id>, LINEDISPATCH#<branch>), with a status index on the node GSI like dispatchIndex;
  - projectSelfStartedUsage (PROJ#<id>, SELFSTARTED#<month>).
- Both updates are a conditional put on version, with re-read and retry (the putVersioned/programContracts.update pattern).
- lineDispatches.start is a single-item conditional put: attribute_not_exists OR (status in stopped/failed AND cleanup.settledAt exists AND generation = :prev).
- No transactWrite: the publisher role has only GetItem and PutItem.
- A new test/src/conformance/line-ports.ts suite, registered for memory, local SQLite and the AWS FakeTable conformance.
  depends on: J1
  touches: packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/keys.ts, packages/persistence/src/aws/keys.test.ts, test/src/conformance/line-ports.ts, test/src/conformance/memory.test.ts, test/src/conformance/local.test.ts, apps/api/src/aws-conformance.test.ts
  - The line conformance suite passes on memory, SQLite and DynamoDB FakeTable. It covers: CAS retry with concurrent updates on the line record and the project usage ledger; exactly one 'started' of concurrent starts; 'live' while non-terminal or terminal-but-unsettled; a start after a settled terminal dispatch requires generation prev+1; put refuses a lower generation; listByStatus; listWithWork returns exactly the lines with queue, batch or pending push
  - keys.test.ts covers the new keys, and the line stores use no transactWrite
  - npm run build, typecheck, lint, test and check:sterility are green

J3: The API the line owner and humans use: a new apps/api/src/operations/line.ts, with routes in handler.ts under /projects/{projectId}/lines/{branch} (the branch is URL-encoded as one segment).

Routes:
- GET: the view, with record, dispatch, the project's self-started usage for the month, and the branch name of each queued program. Readable by users of the org, and by the line principal for its own line.
- POST batch: take everything queued as one batch, or answer empty.
- POST compositions and POST parked.
- POST push: records a pending LinePush, then calls deps.dispatcher.publishLine.
- POST bundle-upload-url: key <projectId>/line/<branch>/<generation>/<id>.pack, via signKey.
- POST heartbeat:
  - generation fence;
  - metering like the run heartbeat, into the org compute ledger and the PROJECT self-started ledger;
  - stops the machine with failure line_cap, and records `waiting` monthly_cap on the line, when the project's cap, maxUsdPerRun or maxRunHours is crossed;
  - parks a batch older than LINE_COMPOSITION_SECONDS;
  - returns, like the run heartbeat, a renewed line token, provider credentials, the project's secrets and a GitHub read token for the line's repository;
  - on a `stopped` report, calls ensureLineDispatch when the queue is non-empty. That answers 'live' until cleanup settles, and J5 restarts after it.
- POST dispatch/cancel: users only.

Authorization:
- rules/authorize.ts: authorizeLine allows only the line.* operations except cancel, only for the same project and branch, and fences every write by the line dispatch's current generation.
- AuthorizationTarget gains branch, and enforce.ts resolves it.

Other changes:
- lambda/api.ts wires provisionLine and publishLine to the dispatch and publisher Lambdas, as async invokes with a line event.
- operations/dispatch.ts: the org concurrency count (liveRunsOf or its equivalent) also counts live line dispatches.
- Remove any route-table exemption J1 added.
  depends on: J1
  touches: apps/api/src/operations/line.ts, apps/api/src/handler.ts, apps/api/src/handler-line.test.ts, packages/core/src/rules/authorize.ts, packages/core/src/rules/authorize-line.test.ts, apps/api/src/auth/enforce.ts, apps/api/src/lambda/api.ts, apps/api/src/operations/dispatch.ts, apps/api/src/operations/uploads.ts, apps/api/src/route-table.test.ts, apps/api/src/aws/s3-bundles.ts
  - Handler tests: a stale generation is refused 403; another project's or branch's line principal is refused; a user of another org is refused; cancel by a line principal is refused
  - A heartbeat moves the project's self-started ledger and the org ledger; crossing the project cap, including spend made under a different line branch of the same project, stops the machine and records `waiting` with its reason; a batch older than an hour is parked; resolver attempts above 3 are refused 409
  - Idle-stop race: a `stopped` heartbeat while an entry is queued does not create a second dispatch before cleanup has settled. Once cleanup.settledAt is set, ensureLineDispatch starts exactly one, with the next generation
  - The route-table test covers every line.* operation
  - npm run build, typecheck, lint, test and check:sterility are green

J4: The publisher's two line paths, and their infra.

(a) Queueing, in apps/api/src/runner/publisher.ts.
- When an intent resolves published or already_published and the program contract names a line, the same dispatch put sets publication.lineOwed.
- Then, in publishAll, whenever lineQueueOwed(dispatch) holds (even with no intent pending, so a crashed earlier attempt is finished):
  - lines.update appends {program, upTo: publication.head} idempotently, creating the record with repositoryUrl and with head from the advertisement;
  - lineQueuedUpTo is set to that head on the run's dispatch, which clears the obligation;
  - ensureLineDispatch is called with PublisherDeps.startLineMachine.
- Errors in this path are logged. They never change the run's counts, intents or blocked state.

(b) publishLine(deps, {projectId, branch}), under the publish lock keyed for the line:
- Advertise. If the line ref is already at push.head, the push is published.
- If the ref is not at expectedPredecessor, record a conflict with the remote head; never force.
- Otherwise push with expectedOld = expectedPredecessor (ZERO_OID when the line branch does not exist yet).
- Classify refusals as for intents, and retry `error` up to PUBLISH_ATTEMPTS.
- On success, set head and mark the composition pushed.
- The outcome is written only to line.push, never to a run's dispatch.

(c) Lambda wiring.
- lambda/runner-publisher.ts accepts RunScope | {kind:'line', projectId, branch}.
- startLineMachine is an async invoke of NIGHTSHIFT_DISPATCH_FUNCTION_ARN.
- aws/publish-lock.ts takes a line key.

(d) Infra, in infra/cdk runner-stack:
- grant the publisher invoke on the dispatch function, and set the env var;
- add the reconciler's read of the new sparse line index if its grant does not already cover it;
- update the stack tests.
  depends on: J1
  touches: apps/api/src/runner/publisher.ts, apps/api/src/runner/publisher.test.ts, apps/api/src/runner/publisher-line.test.ts, apps/api/src/lambda/runner-publisher.ts, apps/api/src/aws/publish-lock.ts, apps/api/src/config.ts, infra/cdk/src/lib/runner-stack.ts, infra/cdk/src/lib/runner-stack.test.ts, infra/cdk/src/lib/api-stack.ts, infra/cdk/src/lib/api-stack.test.ts
  - Publisher tests over the local git server: a published and an already_published program push each enqueue {program, upTo} once (a repeat does not duplicate) and start exactly one line dispatch; a project without a line is untouched
  - Recovery: when lines.update fails after the intent is already published, lineQueueOwed stays true; a later publishAll with no pending intent queues the range and clears it
  - A failure in the line enqueue or start leaves the run's publish counts, intents and blocked state unchanged
  - publishLine: a moved line ref records `conflict` with the remote head and does not push; a successful push sets line.head; a protection refusal records `protected`; the run's dispatch is never written by it
  - cdk synth is green; the runner-stack tests assert that the publisher can invoke the dispatch function and still has no dynamodb:Query
  - npm run build, typecheck, lint, test, synth and check:sterility are green

J5: The line machine's lifecycle.

- Extract the launch core of apps/api/src/runner/provision.ts (image, subnets, warm snapshot, launch, describe, failure cleanup) into a shared function, with no behaviour change for runs.
- Add apps/api/src/runner/provision-line.ts with provisionLineDispatch(deps, {projectId, branch}):
  - the same image and the project's warm snapshot;
  - subnets hashed by engineAgentId;
  - a first token from mintLineToken, written to firstTokenParameterName(stage, engineAgentId, generation);
  - tags nightshift-kind=line, nightshift-project, nightshift-line=<branch>, nightshift-agent, nightshift-generation, nightshift-stage and nightshift-api;
  - it refuses to launch over the org's concurrency ceiling (live run dispatches plus live line dispatches), leaving the dispatch requested with `waiting` org_concurrency.
- lambda/runner-dispatch.ts accepts the line event.
- The reconciler (lambda/runner-reconciler.ts, with runner/recover.ts made generic over the save):
  - (i) asks the publisher for every run dispatch where hasPendingIntent OR lineQueueOwed;
  - (ii) walks lineDispatches.listByStatus: it provisions stale requested dispatches, and replaces a lost lease with the next generation within the attempt limit;
  - it sends stopping, stopped and failed dispatches to a new runner/line-cleanup.ts, which terminates the instance and deletes the volume with no snapshot, then sets cleanup.settledAt and calls ensureLineDispatch if the line still has work;
  - (iii) walks lines.listWithWork and calls ensureLineDispatch for each line with no live dispatch. This re-admits a line after a lost start or a month rollover;
  - it asks the publisher about any line with a pending push.
  depends on: J1
  touches: apps/api/src/runner/provision.ts, apps/api/src/runner/provision-line.ts, apps/api/src/runner/recover.ts, apps/api/src/runner/cleanup.ts, apps/api/src/runner/line-cleanup.ts, apps/api/src/runner/line-runner.test.ts, apps/api/src/lambda/runner-dispatch.ts, apps/api/src/lambda/runner-reconciler.ts
  - New tests over fakes: a line dispatch launches the same image with the project's warm snapshot and the line tags, and writes its token at the expected parameter
  - A lost lease is replaced and the generation increases; exhausted attempts end the dispatch failed; cleanup terminates the instance and deletes the volume without a snapshot, sets settledAt, and then starts exactly one new dispatch when the queue is non-empty
  - A queue entry whose dispatch start failed (no dispatch stored) gets a dispatch at the next reconcile; a run dispatch with lineQueueOwed and no pending intent has the publisher asked
  - At the org concurrency ceiling, the line dispatch stays requested with `waiting` recorded
  - The existing runner.test.ts and provisioning tests pass unchanged
  - npm run build, typecheck, lint, test and check:sterility are green

J6: `nightshift line status [--repo <path>]` in apps/cli.

- Read nightshift.config.json for projectId and line.branch. With no line, say so and exit 1.
- GET the line view through routes.line.
- Print:
  - head and the last push outcome;
  - the line dispatch's status, generation and spend;
  - the project's self-started spend this month against the cap, and any `waiting` reason;
  - the queue entries;
  - each composition with its commit, program ranges (from..upTo), verification outcome and id, and resolver decision and attempts;
  - parked compositions with their reasons.
- Formatting goes in a pure describeLine(view) function.
- Register the command in apps/cli/src/cli.ts (switch and usage), and in any completion or command listing that enumerates commands.
  depends on: J1
  touches: apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts, apps/cli/src/cli.ts, apps/cli/src/commands/completion.ts
  - Unit tests of describeLine for: empty, queued, composed with a resolver decision, parked, cap reached, and push conflict
  - No line configured prints a clear message and exits 1
  - The command appears in usage and in shell completion
  - npm run build, typecheck, lint, test, synth and check:sterility are green. Round 2. Changes made in response to the review:

(1) A published range is queued durably.
- J1 adds `publication.lineQueuedUpTo` and `publication.lineOwed` to the run's Dispatch, plus a core predicate `lineQueueOwed(dispatch)`.
- J4 marks `lineOwed` together with the intent it resolves as published, when the contract has a line.
- J4 then appends to the line and clears the obligation by setting `lineQueuedUpTo` to the head it queued. publishAll performs a still-owed enqueue even when no intent is pending.
- J5's reconciler asks the publisher for every dispatch where hasPendingIntent OR lineQueueOwed. A crash after the push is therefore retried, and the run's chain is never blocked.
- The gap between a queue append and a failed dispatch start is closed by a sparse index of line records that have work: a non-empty queue, a batch, or a pending push. The reconciler walks that index every minute and calls ensureLineDispatch on each. The same sweep re-admits a line that was waiting on the cap once the month rolls over.

(2) No dispatch is replaced before its machine is cleaned up.
- lineDispatches.start succeeds only when no dispatch exists, or when the stored one is terminal AND its cleanup has completed (`cleanup.settledAt`: instance terminated and volume deleted, or nothing was ever launched).
- A stopped heartbeat with queued work calls ensureLineDispatch, which answers 'live' until cleanup is done. J5's cleanup sets settledAt and then calls ensureLineDispatch itself. J3 and J5 test the idle-stop/enqueue race.

(3) The cap is per project, not per line.
- A new ProjectSelfStartedUsage ledger keyed by (projectId, month) holds meteredUsd, capUsd and reachedAt. It is written by compare-and-swap, and every line heartbeat of the project adds to it.
- Admission (ensureLineDispatch) and the heartbeat's stop both check the project ledger, so changing the line branch cannot reset the project's allowance.
- The cap applied is `line.monthlyUsd ?? 25` from the admitting contract. The line record shows the reason it is waiting, and the view shows the project ledger.

(4) Every job's acceptance now includes check:sterility, and J6 also runs the full gate set: build, typecheck, lint, test, synth, sterility.

The rest is unchanged from round 1:
- The departures are already recorded as decisions: a separate LineDispatch with a line principal and a monotonic generation; an embedded LineVerification; `line` inherited into the contract.
- J1 lands the foundation alone. J2–J6 then run in parallel on disjoint files.
- Ownership of shared files: J1 owns stores.ts, the barrels, http/routes.ts, http.ts and tokens/mint.ts. J2 owns aws/stores.ts and keys. J3 owns handler.ts, authorize.ts, enforce.ts, lambda/api.ts and operations/dispatch.ts. J4 owns publisher*, runner-publisher.ts, publish-lock.ts and infra. J5 owns provision*, recover.ts, cleanup*, runner-dispatch.ts and runner-reconciler.ts. J6 owns the CLI.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN REVIEW: round 2 of 2 — revise (`dec_01M5Y4NZT0895C81TJ2HQJR2JV`)
  Chose: The foundation followed by parallel implementation jobs is a reasonable split, and the durable enqueue and settled-cleanup changes address important recovery gaps. However, the remaining launch/admission and upload wiring gaps can prevent the line from running or violate its single-owner and spend guarantees; they need explicit coverage before building.
- [MATERIAL] The bundle upload path has no concrete signKey implementation assigned. J1 adds only an optional method to the port, while J3 calls it; the deployed createArtifactUploadSigner in packages/persistence/src/aws/artifact-bodies.ts currently implements only sign, and apps/api/src/local/server.ts does likewise. apps/api/src/aws/s3-bundles.ts, listed for J3, is a download-only BundleStore. Assign implementation and wiring of the line upload signer (including the local plane seam needed by S-04) and test an actual signed line bundle upload; otherwise all jobs can pass with optional-method mocks while the owner cannot upload the pack needed for acceptance 4. (J1, J3)
- [MATERIAL] J5's new provisioning concurrency check queries run and line dispatches by status, but the dispatch Lambda role in infra/cdk/src/lib/runner-stack.ts grants dynamodb:Query only on the table ARN, not the node-index ARN. Existing dispatch listByStatus queries that index. J4 names only the reconciler's index grant, which already exists. Assign the dispatch-role index grant and its stack assertion to J4 so J5's normal async invocation does not fail with AccessDenied. (J4, J5)
- [MATERIAL] The conditional lineDispatches.start guards the record, but does not make machine provisioning single-owner. J5 reuses the current launch core: provision.ts reads requested, launches, then writes the machine; ec2-compute.ts supplies no RunInstances ClientToken. Duplicate async deliveries or a reconciler racing the dispatch Lambda can therefore both launch the same generation, minting equally authorized owners, while only one instance survives in the record. Assign an atomic/idempotent provisioning mechanism and a concurrent-provision test proving one machine and one effective owner per generation. (J1, J5)
- [MATERIAL] The concurrency waiting policy can deadlock queued line dispatches. The existing liveRunsOf counts every nonterminal status, including requested; J3 extends it to line dispatches, while J5 leaves capacity-blocked lines requested. With more waiting lines than the org ceiling, each can count the other waiters as occupied capacity and none can launch even after every actual machine stops (excluding only itself does not solve this). Define admission accounting that distinguishes waiting requests from occupied/reserved slots, and test multiple waiting lines draining after capacity is released. (J3, J5)
- [MATERIAL] Cap admission is checked only by ensureLineDispatch, but J5 provisions an already-requested dispatch directly on reconciliation and replaces lost leases directly. A line can be admitted below the project/org cap, wait on concurrency, and launch after another line or run has exhausted that cap; ensureLineDispatch cannot prevent this because its start guard sees an existing live request. Require fresh project and org monthly-cap checks before delayed launches and replacements, retaining queued work and recording the waiting reason, with a test where spend reaches the cap while the dispatch waits. (J1, J5). An independent examiner reviewed decision dec_01M5Y4JBRBWC7HFQMRPNKAKEG9 against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** Round 2 plan review: five material findings (signKey implementation, dispatch-role index grant, idempotent line provisioning, concurrency accounting that deadlocks waiting lines, cap re-check before delayed launch and replacement). (`dec_01M5Y4PH08GP8RDMG55VQY550T`)
  Chose: All five are folded into the delegated jobs, with the same split.

- J1 implements signKey in the AWS signer and the local plane's signer. It also adds a CAS `update` (on a version) to LineDispatchStore, a core `occupiesComputeSlot`, and `lineAdmission`, the cap check shared by every launch path.
- J3 tests a real signed line upload, and counts a line dispatch toward concurrency only once it occupies a slot.
- J4 grants the dispatch role Query on the node index.
- J5 claims requested→provisioning by CAS before launching, passes an EC2 ClientToken of agent+generation, and re-checks the project and org monthly caps before a delayed launch or a lease replacement.. Each change is local to the job that owns the file, so the parallel split and file ownership are unchanged.
  Weighed: Keep the round-2 plan as written, rejected because All five findings are correct against the code.
  Reversible.
  Produced: nothing that landed.
- **Job node_01M5Y4QRGZN9F64RE07QEPB4P3:** The brief says the line principal is an alternative in ExecutionTokenClaims' nightshift claim, but apps/mcp (off limits) reads ExecutionTokenClaimsSchema.parse(...).nightshift.role/programId/runId in runner/bootstrap.ts, which would stop compiling if that claim became a union. (`dec_01M5Y6BBNVP17CHSMJ13MM1W6S`)
  Chose: Added LineTokenClaimsSchema and TokenClaimsSchema (union); ExecutionTokenClaimsSchema is unchanged. verifyExecutionToken parses the union, so a line token verifies as a line principal.. Same token envelope and verification outcome as briefed, without breaking the engine bootstrap in apps/mcp or touching it.
  Weighed: Make ExecutionTokenClaimsSchema.nightshift a union (as briefed) and edit apps/mcp to narrow — forbidden path.
  Weighed: Keep ExecutionTokenClaimsSchema execution-only and add LineTokenClaimsSchema plus a TokenClaimsSchema union the verifier parses.
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** F-01 fix: the project's self-started ledger is now charged idempotently per dispatch. The org compute ledger, which the line heartbeat also adds to, keeps its existing add-the-difference behaviour. (`dec_01M5Y9R7TV8F505A93C9CD12GQ`)
  Chose: Leave the org ledger as it is. The per-project monthly cap, which acceptance criterion 5 requires, is enforced from the repaired, idempotent project ledger.. F-01 and acceptance criterion 5 concern the project's self-started cap. The org ledger's fragility already exists for runs and should get its own follow-up.
  Weighed: Also make the org compute ledger idempotent per dispatch, rejected because It is shared with runs and keeps no per-dispatch record. Repairing it means changing its shape and how runs meter it, which is outside this strand. Runs' metering has the same pre-existing behaviour.
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** STRAND PLAN: round 1 — 6 jobs, 2 starting at once (`dec_01M5YBWR0E5V9E5PAYST4QZNWG`)
  Chose: J1: Foundation of the line composition engine in packages/execution/src/line/: the ports, the shared types, the real-git checkout adapter, export stubs for the later jobs' functions, and a real-git test fixture.

(1) packages/execution/src/line/ports.ts, with no imports from apps/ or the plane's stores. Use contract types from @nightshift/contracts (LineBatch, LineRange, LineVerification, LineResolver, LineCompositionBody, LineParkBody, CommitSha, ProgramId) and Clock from @nightshift/core:
- LineWorktree { readonly path: string }
- LineMergeOutcome = { kind: 'merged'; head: CommitSha } | { kind: 'conflict'; paths: string[]; detail: string }
- LineCheckoutPort { open(base): Promise<LineWorktree> (a fresh detached worktree at base); merge(wt, commit, message): Promise<LineMergeOutcome> (a no-ff merge commit, or a fast-forward when wt's head is an ancestor of commit is NOT allowed: always a real merge unless commit is already contained, in which case 'merged' at the unchanged head; on conflict it aborts the merge and leaves wt at its previous head); head(wt): Promise<CommitSha>; isAncestor(ancestor, descendant): Promise<boolean>; close(wt): Promise<void> }
- LineVerifierPort { verify(input: { worktree; commit; base }): Promise<LineVerification> } (phase 'line')
- LineSettlement { batchId; composition?: Omit<LineCompositionBody,'batchId'>; parked: Omit<LineParkBody,'batchId'>[] }
- LineQueuePort { takeBatch(): Promise<LineBatch|undefined>; lastComposed(program): Promise<CommitSha|undefined> (the upTo of the newest composed range of that program); settle(s: LineSettlement): Promise<void> }
- LinePublisherPort { publish(input: { head; expectedPredecessor }): Promise<{ status: 'published' } | { status: 'rejected'; detail: string }> }
- LineUnit = { kind: 'main'; commit } | { kind: 'range'; range: LineRange }
- LineFailure { unit; base (the head the unit was merged onto); cause: { kind: 'conflict'; paths; detail } | { kind: 'red'; candidate: CommitSha; verification: LineVerification } }
- LineResolution = { kind: 'resolved'; commit; verification; resolver: LineResolver; decision: LineResolverDecision } | { kind: 'parked'; reason: string; resolver: LineResolver; commit?; verification? }
- LineResolverAgentPort { resolve(input: { brief: string; worktree; deadline: string /*ISO*/ }): Promise<{ model: string; status: 'finished'|'failed'; summary?: string }>; examine(input: { brief; worktree; commit; base; verification; avoidModel: string; deadline }): Promise<{ model: string; verdict: 'approved'|'rejected'; findings: string[] }> }
- LineResolverDecision (project scoped, not the run-scoped Decision): { authority: 'line'; unit; base; commit; context; alternatives: {summary; rejectedBecause?}[]; choice; rationale; reversibility: 'reversible'; resolverModel; examinerModel; attempts; verificationId; decidedAt }
- LineDecisionPort { record(d: LineResolverDecision): Promise<void> }
- LineResolverPorts { checkout; verifier; agents; decisions; clock; limits?: { attempts?: number; seconds?: number } } (defaults from core's LINE_RESOLVER_ATTEMPTS and LINE_COMPOSITION_SECONDS)
- LineComposerPorts { queue; checkout; verifier; publisher; resolve: (failure: LineFailure) => Promise<LineResolution>; clock }
- LineBatchOutcome { batchId; head: CommitSha (the line head after the batch); composed: LineRange[]; parked: { ranges: LineRange[]; reason: string }[]; resolutions: LineResolution[]; published?: { status; detail? } }
(2) packages/execution/src/line/git.ts: createLineCheckout({ runner: GitRunner, repo: string, scratchDir?: string }) implementing LineCheckoutPort with the helpers in packages/execution/src/git/ (addDetachedWorktree, removeWorktree, …), worktrees in fresh temporary directories.
(3) Stubs with their final signatures, each throwing Error('not implemented') so later jobs only replace their own file: line/compose.ts exporting composeLineBatch(ports: LineComposerPorts, input: { lineHead: CommitSha; mainHead: CommitSha; batch: LineBatch }): Promise<LineBatchOutcome> and drainLine(ports: LineComposerPorts, heads: () => Promise<{ lineHead: CommitSha; mainHead: CommitSha }>): Promise<LineBatchOutcome[]>; line/resolver.ts exporting resolveLineFailure(ports: LineResolverPorts, failure: LineFailure): Promise<LineResolution>; line/verifier.ts exporting createLineVerifier(options: LineVerifierOptions): LineVerifierPort with LineVerifierOptions declared there as an open interface (J4 shapes it).
(4) line/index.ts re-exporting all five files, and packages/execution/src/index.ts re-exporting line/index.js.
(5) test/src/execution/line-repo.ts, a fixture for later tests: creates a real git repository in a temp dir with an initial commit on main, a line branch and program branches, with helpers to commit files on a branch, read a file at a commit, and get the createLineCheckout over it, plus cleanup. test/src/execution/line-git.test.ts tests the adapter against it.
  depends on: nothing (starts at once)
  touches: packages/execution/src/line/ports.ts, packages/execution/src/line/git.ts, packages/execution/src/line/compose.ts, packages/execution/src/line/resolver.ts, packages/execution/src/line/verifier.ts, packages/execution/src/line/index.ts, packages/execution/src/index.ts, test/src/execution/line-repo.ts, test/src/execution/line-git.test.ts
  - packages/execution/src/line/ports.ts declares every port and type listed in the objective; nothing under line/ imports from apps/ or from the persistence stores
  - createLineCheckout passes tests on a real repository: open gives a detached worktree at base; merge of a non-conflicting commit makes a two-parent merge commit; merge of an already-contained commit is 'merged' at the unchanged head; a conflicting merge reports the conflicted paths and leaves the worktree clean at its previous head; isAncestor is right both ways; close removes the worktree
  - compose.ts, resolver.ts and verifier.ts exist with exactly the exported signatures in the objective, and line/index.ts plus the package index export them
  - test/src/execution/line-repo.ts fixture exists and is used by line-git.test.ts
  - npm run build, typecheck, lint and the touched tests pass

J2: Implement packages/execution/src/line/compose.ts (replacing J1's stubs): composeLineBatch and drainLine over LineComposerPorts.
composeLineBatch(ports, { lineHead, mainHead, batch }):
1. Group batch.entries by program, programs ordered by their first enqueuedAt; a program's range is { program, from: await queue.lastComposed(program) (omitted when undefined), upTo: the upTo of its last entry }. Drop a range whose upTo is already an ancestor of lineHead.
2. Batch attempt: open a worktree at lineHead; merge mainHead (message names main), then each range in order (message names the program and range). If every merge succeeds, verify the result (base = lineHead). Outcome 'passed' means green.
3. Green: settle with one composition { commit: head, parent: lineHead, ranges, verification } and no parked; publish { head, expectedPredecessor: lineHead }.
4. Any conflict, or an outcome other than 'passed': compose one unit at a time from lineHead in a fresh worktree. First main (unless already contained), then each range: merge it onto the current head and verify. A pass advances the current head. A conflict or non-pass builds a LineFailure { unit, base: current head, cause } and calls ports.resolve(failure). On 'resolved' the current head becomes resolution.commit and the range counts as composed. On 'parked' the range is parked with resolution.reason and the composition goes on with the next range. If main itself parks, every range in the batch is parked with a reason saying main does not compose onto the line.
5. Settle once per batch: the composition, if the head moved, carries the composed ranges, the verification of the final head, and the resolver of the last resolution that fixed something (LineResolver; its detail names every unit the resolver fixed), plus the parked entries (each with its ranges, reason, resolver, and commit/verification when present). Then publish only if the head moved from lineHead. Return a LineBatchOutcome. Close every worktree it opened, including on a throw.
drainLine(ports, heads): loop { batch = queue.takeBatch(); stop when undefined; read heads(); composeLineBatch }. Stop after a batch whose publication was rejected, and return the outcomes.
Tests in test/src/execution/line-compose.test.ts drive real git repositories through J1's fixture (test/src/execution/line-repo.ts) and createLineCheckout, with an in-memory queue, a recording publisher, a fake verifier that fails when a chosen file contains a chosen marker, and a fake resolve function.
  depends on: J1
  touches: packages/execution/src/line/compose.ts, test/src/execution/line-compose.test.ts
  - A batch of two programs plus new main commits, all compatible, gives one composition whose commit contains main and both upTo commits as ancestors, whose parent is the line head and whose verification passed; it is settled with both ranges and published with expectedPredecessor = the old line head
  - Several queue entries of one program become one range whose upTo is the last entry and whose from is queue.lastComposed
  - When the batch merge conflicts, or when it verifies red, the ranges are composed one at a time, and resolve is called exactly once, with the range that fails (not a range that composes cleanly) and base = the head with the earlier good ranges merged
  - A resolved failure's commit becomes the head and the settled composition carries its resolver; a parked failure's range is in settlement.parked and the remaining ranges still compose
  - Verification is never given a commit for the main-plus-ranges candidate after a conflict, and every worktree opened is closed
  - drainLine drains several batches until takeBatch returns undefined
  - npm run build, typecheck, lint and the new tests pass

J3: Implement packages/execution/src/line/resolver.ts (replacing J1's stub): resolveLineFailure(ports: LineResolverPorts, failure: LineFailure): Promise<LineResolution>, the resolver of D-03 and D-04.
The limits come from ports.limits, defaulting to core's LINE_RESOLVER_ATTEMPTS (3) and LINE_COMPOSITION_SECONDS (3600), measured from the call with ports.clock. Each attempt:
(a) Open a fresh worktree at failure.base, which is the line head the unit failed on.
(b) Write a brief: what failed (the unit: main or a program's range with from/upTo shas; for a conflict, the conflicted paths and detail; for red, each failed command with its exit code and output tail from the LineVerification), the instruction to merge the unit's commit into this worktree and leave a commit that makes the landing checks pass without dropping either side's work, and the findings of earlier attempts.
(c) Call agents.resolve with the brief, the worktree and the deadline.
(d) The attempt fails, and the next one is told why, when: the agent failed; the worktree's head is unchanged; or the head does not contain both failure.base and the unit's commit (checkout.isAncestor).
(e) Verify the head with base = failure.base. Anything but 'passed' fails the attempt.
(f) Call agents.examine with avoidModel = the resolver's model. The attempt fails if the examiner's model equals the resolver's, or if the verdict is 'rejected' (its findings go into the next brief).
(g) If approved, build a LineResolverDecision (authority 'line', context naming the failure, choice/rationale from the agent's summary and the examiner's approval, alternatives including parking the range, reversibility 'reversible', both models, the attempt count, the verificationId), record it through decisions.record, and return { kind: 'resolved', commit, verification, resolver: { decision: 'resolved', attempts }, decision }.
Close each worktree. Before each attempt, and after each agent call, if the deadline has passed or the attempts are spent, return { kind: 'parked', reason (which limit, and the last failure), resolver: { decision: 'gave_up', attempts }, commit/verification of the last checked candidate when there is one }. A throw from an agent port counts as a failed attempt, not a crash.
Tests in test/src/execution/line-resolver.test.ts use real git through J1's fixture (test/src/execution/line-repo.ts) and createLineCheckout, a fake agent port that writes and commits a resolution in the given worktree (or does not), a fake examiner, a fake verifier, and a controllable clock.
  depends on: J1
  touches: packages/execution/src/line/resolver.ts, test/src/execution/line-resolver.test.ts
  - A conflict failure whose fake agent merges and fixes is verified, examined by a different model, recorded as a decision with authority 'line', and returned resolved with attempts = 1 and a commit containing both base and the unit's commit
  - The resolver works from failure.base: the worktree given to the agent is at that commit
  - Three failed attempts (any mix of red verification, rejected examination, agent failure, unchanged head) park with decision 'gave_up', attempts 3, and no decision recorded; a fourth agent call is never made
  - Once the clock passes an hour from the start, no further attempt starts and the failure parks with a reason naming the time limit
  - An examiner whose model equals the resolver's model never approves a fix
  - A rejected examination's findings appear in the next attempt's brief
  - npm run build, typecheck, lint and the new tests pass

J4: Implement packages/execution/src/line/verifier.ts (replacing J1's stub): createLineVerifier(options) returning a LineVerifierPort, the real adapter that runs a project's landing checks on a line candidate and returns a LineVerification with phase 'line'.
It runs the setup steps and then only the landing steps, using landingSteps from gate-repair.ts, so a step declared at: 'end' never runs. It runs them in the given worktree, reusing the execution package's existing step-running primitives (see runCheckoutSteps and the scratch and project-env helpers that verify.ts uses) rather than a new shell runner where that is practical. It needs no RunSession and no run-scoped store.
The record: verificationId minted from options.ids; commitSha and baseSha from the input; commands as VerificationCommandResult; outcome = outcomeOfCommands; start and end times from options.clock. It is parsed with LineVerificationSchema. A step's environment is told the commit and base the way run verifications are told (NIGHTSHIFT_BASE_SHA and the like, via verificationFacts) where that applies. Shape LineVerifierOptions (gates: GateDefinitions; ids; clock; env and limits as needed) and document it.
Tests in test/src/execution/line-verifier.test.ts run real trivial shell steps in a temporary git checkout.
  depends on: J1
  touches: packages/execution/src/line/verifier.ts, test/src/execution/line-verifier.test.ts
  - A gate set whose steps all exit 0 yields a LineVerification with phase 'line', outcome 'passed', that LineVerificationSchema accepts
  - A failing landing step yields outcome 'failed', with that command's exit code and output
  - A step declared at: 'end' is never run and does not appear in commands
  - The verifier needs no run-scoped store or RunSession
  - core's isLandingEvidence('line') is false, and a test asserts it alongside the verifier
  - npm run build, typecheck, lint and the new tests pass

J5: An end-to-end offline test of the line engine: test/src/execution/line-engine.test.ts. It drives drainLine (compose.ts) with resolve wired to the real resolveLineFailure (resolver.ts), over a real git repository from test/src/execution/line-repo.ts and the real createLineCheckout. The queue, publisher, decision port and resolver/examiner agents are in-memory fakes. The verifier is a fake that fails on a marker file, or the real createLineVerifier with shell steps, whichever is simpler. A controllable clock. It proves the strand's acceptance together:
(1) Green batch → one published composition recording the batch's members.
(2) A batch with one conflicting range and one clean range → composed one at a time; the resolver gets the conflicting range from the line head with the clean range merged, fixes it on attempt 1, the fix is checked and examined by a different model, a 'line' decision is recorded, and the published head contains everything.
(3) A range the resolver cannot fix → parked after 3 attempts, and the queue moves on to the next batch.
(4) An hour elapsing parks the composition.
Fix small defects in compose.ts or resolver.ts that this integration exposes, and report what you changed.
  depends on: J2, J3, J4
  touches: test/src/execution/line-engine.test.ts, packages/execution/src/line/compose.ts, packages/execution/src/line/resolver.ts
  - The four scenarios in the objective are tests that pass against real git
  - Every settlement recorded in the tests passes the contract's LineCompositionBody/LineParkBody schemas for its composition and parked entries
  - npm run build, typecheck, lint and test pass

J6: Extend S-02's line plane so a batch can be settled with what the composition engine produces. Today composeBatch and parkBatch (packages/core/src/rules/line.ts) each settle the batch, so a batch that has both a composition and a parked range (D-02's one-at-a-time fallback) cannot be recorded. Add the following, and keep the existing compositions/parked routes and rules working as they are:
(1) In packages/contracts/src/v1/line.ts: LineSettleBodySchema = { batchId, composition?: LineCompositionBody without batchId, parked: array of LineParkBody without batchId } (strict). It may carry neither a composition nor parked entries: a batch whose ranges were all already on the line.
(2) In packages/core/src/rules/line.ts: settleBatch(record, body, ids: { compositionId?, parkedIds: string[] }, at), with the same stale-batch and resolver-attempt refusals, appending the composition (if any) and each parked entry (bounded by MAX_LINE_COMPOSITIONS and MAX_LINE_PARKED) and clearing the batch, all in one change.
(3) The batch cap the plan asks for: takeBatch moves at most MAX_LINE_BATCH_ENTRIES (export it; 25) of the oldest queue entries into a batch and leaves the rest queued.
(4) The route POST …/line/{branch}/settle in apps/api/src/operations/line.ts, registered like the compositions route with the same line-principal authorization, generation fencing and store compare-and-swap. Add the client method wherever the existing compositions/parked routes have one (for example persistence's http client), so S-04 can call it.
Tests: unit tests of the rule and the cap beside the existing line rule tests, and a route test beside the existing line route tests.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line.ts, packages/contracts/src/v1/line.test.ts, packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, apps/api/src/operations/line.ts, apps/api/src/handler.ts, packages/persistence/src/http/**, test/src/**/line*.test.ts (api route tests only)
  - LineSettleBodySchema exists and accepts composition-only, parked-only, both, and neither
  - settleBatch records the composition and every parked entry in one record change and clears the batch; a stale batchId or more than 3 resolver attempts is refused
  - takeBatch takes at most MAX_LINE_BATCH_ENTRIES oldest entries and leaves the rest in the queue
  - POST …/line/{branch}/settle works for the line owner and is refused to other principals and stale generations, as the compositions route is
  - The existing compositions and parked routes and their tests still pass
  - npm run build, typecheck, lint and test pass. S-02 is already merged on this branch. It added the `line` verification phase (isLandingEvidence('line') = false), LineVerification, LineComposition/LineParked/LineResolver, and the plane's line API. So acceptance criterion 4 is mostly a matter of producing LineVerification records, and J4 asserts it.

Split: J1 lays the foundation. It writes every port and shared type, the real-git checkout adapter, a real-git test fixture, and stub files with the final signatures, so J2 (composer), J3 (resolver) and J4 (real verifier) can then run in parallel, each touching only its own file and its own test. J5 is the integrated end-to-end proof of acceptance 1-3 and depends on all three. J6 is independent and runs in parallel from the start. It extends S-02's plane: S-02's composeBatch/parkBatch each settle the batch, so the fallback's "some ranges composed, one parked" result cannot be recorded. J6 adds a combined settle body/rule/route and the batch cap ("every queued entry up to a cap"), which belongs where the batch is taken.

Interpretations:
- One settlement and at most one publication per batch. The publication goes from the old line head to the final head, which fits the plane's single push in flight.
- The hour is measured per resolver hand-off (per failing unit).
- The resolver's decision is a project-scoped LineResolverDecision with authority 'line', recorded through a port. The run-scoped Decision contract cannot hold it, and S-04 wires the port. The composition's `resolver` field also records it.
- Main is merged first. If main itself cannot be composed even by the resolver, the whole batch parks.
- The resolver works from the line head: it gets a worktree at the head the unit failed on and must produce a commit that contains both that head and the unit.

Risk: J1-J5 medium (the engine S-04 relies on); J6 medium (plane API, other strand's code).
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M5YBZ8V1SQNWNGV0XA2X542V`)
  Chose: The foundation followed by parallel composer, resolver and verifier jobs is a workable split, and the combined settlement extension is necessary. However, the specified interfaces and algorithms leave material gaps in the composition deadline, schema-valid settlement, failure diagnostics and verification of the actual commit; these need to be resolved before the jobs build against the shared ports.
- [MATERIAL] The hour is explicitly restarted for each resolver hand-off, contrary to D-04's hour per composition. J2 can spend time on batch checks and then give each failing range another full hour; its resolve port cannot pass a shared composition deadline, and the verifier has no remaining-budget contract. packages/core/src/rules/line.ts also describes LINE_COMPOSITION_SECONDS as the allowance for one batch. Establish and enforce one composition deadline across batch checks, fallback and resolver calls, with a test involving multiple failing units rather than only one resolver timeout. (J1, J2, J3, J5)
- [MATERIAL] J2 can produce compositions that the existing schemas reject: LineCompositionBodySchema and LineCompositionSchema require ranges.min(1). If main advances successfully but every program range parks, J2 settles the moved head with composed ranges []; the same issue arises when all queued ranges are dropped as already contained (the green path still specifies a composition). J6's optional composition only supports a no-op settlement, not a main-only composition with an advanced head. Specify a schema-compatible treatment of these cases across J2/J6 and cover both in the integration proof; otherwise ordinary batches fail settlement instead of publishing or clearing correctly. (J2, J5, J6)
- [MATERIAL] J3 requires failed-command output tails from LineVerification and J4 requires recording output, but VerificationCommandResultSchema is strict and carries only logArtifactId, not output. J1's verifier/failure/resolver ports provide neither diagnostic output nor a way to retrieve logs, and J4 has no specified log sink. Thus J3 and J4 cannot implement their objectives against J1's final interfaces without changing the shared foundation during parallel work. Define the diagnostic/log hand-off before J1 finishes, keeping large output outside the persisted line record, and test a real failing command reaching the resolver brief. (J1, J3, J4)
- [MATERIAL] The resolver checks the agent's head ancestry but then verifies the same agent-modified worktree without requiring it to be pristine at that commit. J4's suggested runCheckoutSteps helper only runs setup/checks; it does not reset or clean. Existing verify.ts explicitly requires a clean checkout and git/operations.ts provides pristineCheckout for this reason. An agent can commit a still-broken merge and leave an uncommitted or ignored repair that makes checks pass, causing publication of an unchecked commit. Require verification from a clean checkout of the exact candidate and test that dirty/untracked agent repairs cannot make that candidate pass. (J3, J4, J5). An independent examiner reviewed decision dec_01M5YBWR0E5V9E5PAYST4QZNWG against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** STRAND PLAN: round 2 — 6 jobs, 2 starting at once (`dec_01M5YC1QMQG2FJXPVKX3Q88R2Q`)
  Chose: J1: Foundation of the line composition engine in packages/execution/src/line/: the ports, the shared types, the real-git checkout adapter, export stubs for the later jobs' functions, and a real-git test fixture.

(1) packages/execution/src/line/ports.ts, with no imports from apps/ or the plane's stores. Use contract types from @nightshift/contracts (LineBatch, LineRange, LineVerification, LineResolver, LineCompositionBody, LineParkBody, CommitSha, ProgramId) and Clock from @nightshift/core:
- LineWorktree { readonly path: string }
- LineMergeOutcome = { kind: 'merged'; head: CommitSha } | { kind: 'conflict'; paths: string[]; detail: string }
- LineCheckoutPort { open(base): Promise<LineWorktree> (a fresh detached worktree at base); merge(wt, commit, message): Promise<LineMergeOutcome> (always a real no-ff merge commit, unless commit is already contained, which gives 'merged' at the unchanged head; on conflict it aborts the merge and leaves wt at its previous head); head(wt): Promise<CommitSha>; isAncestor(ancestor, descendant): Promise<boolean>; close(wt): Promise<void> }
- LineCommandLog { stepId: string; command: string; exitCode?: number; tail: string } (the last LINE_LOG_TAIL_CHARS = 4000 characters of the step's output; exported constant). It is diagnostics held in memory and never persisted on the line record.
- LineVerificationResult { verification: LineVerification; logs: LineCommandLog[] }
- LineVerifierPort { verify(input: { worktree; commit; base }): Promise<LineVerificationResult> }. CONTRACT, documented on the interface: the verifier first returns the worktree to exactly `commit` with nothing else (reset --hard plus clean -fdx, as pristineCheckout does), so uncommitted, untracked or ignored files can never decide a verification. verification.phase is 'line'.
- LineSettlement { batchId; composition?: Omit<LineCompositionBody,'batchId'>; parked: Omit<LineParkBody,'batchId'>[] }
- LineQueuePort { takeBatch(): Promise<LineBatch|undefined>; lastComposed(program): Promise<CommitSha|undefined> (the upTo of that program's newest composed range); settle(s: LineSettlement): Promise<void> }
- LinePublisherPort { publish(input: { head; expectedPredecessor }): Promise<{ status: 'published' } | { status: 'rejected'; detail: string }> }
- LineUnit = { kind: 'main'; commit } | { kind: 'range'; range: LineRange }
- LineFailure { unit; base (the head the unit was merged onto); deadline: string (ISO, the composition's single deadline); cause: { kind: 'conflict'; paths; detail } | { kind: 'red'; candidate: CommitSha; verification: LineVerification; logs: LineCommandLog[] } }
- LineResolution = { kind: 'resolved'; commit; verification; resolver: LineResolver; decision: LineResolverDecision } | { kind: 'parked'; reason: string; resolver: LineResolver; commit?; verification? }
- LineResolverAgentPort { resolve(input: { brief: string; worktree; deadline: string }): Promise<{ model: string; status: 'finished'|'failed'; summary?: string }>; examine(input: { brief; worktree; commit; base; verification; avoidModel: string; deadline }): Promise<{ model: string; verdict: 'approved'|'rejected'; findings: string[] }> }
- LineResolverDecision (project scoped, not the run-scoped Decision): { authority: 'line'; unit; base; commit; context; alternatives: {summary; rejectedBecause?}[]; choice; rationale; reversibility: 'reversible'; resolverModel; examinerModel; attempts; verificationId; decidedAt }
- LineDecisionPort { record(d: LineResolverDecision): Promise<void> }
- LineResolverPorts { checkout; verifier; agents; decisions; clock; limits?: { attempts?: number } } (attempts defaults to core's LINE_RESOLVER_ATTEMPTS). The deadline comes from failure.deadline, not from the resolver.
- LineComposerPorts { queue; checkout; verifier; publisher; resolve: (failure: LineFailure) => Promise<LineResolution>; clock; limits?: { seconds?: number } } (seconds defaults to core's LINE_COMPOSITION_SECONDS; one deadline per batch, from when composeLineBatch starts)
- LineBatchOutcome { batchId; head: CommitSha (the line head after the batch); composed: LineRange[]; parked: { ranges: LineRange[]; reason: string }[]; resolutions: LineResolution[]; published?: { status; detail? } }
(2) packages/execution/src/line/git.ts: createLineCheckout({ runner: GitRunner, repo: string, scratchDir?: string }) implementing LineCheckoutPort with the helpers in packages/execution/src/git/ (addDetachedWorktree, removeWorktree, …), worktrees in fresh temporary directories.
(3) Stubs with their final signatures, each throwing Error('not implemented') so later jobs only replace their own file: line/compose.ts exporting composeLineBatch(ports: LineComposerPorts, input: { lineHead: CommitSha; mainHead: CommitSha; batch: LineBatch }): Promise<LineBatchOutcome> and drainLine(ports: LineComposerPorts, heads: () => Promise<{ lineHead: CommitSha; mainHead: CommitSha }>): Promise<LineBatchOutcome[]>; line/resolver.ts exporting resolveLineFailure(ports: LineResolverPorts, failure: LineFailure): Promise<LineResolution>; line/verifier.ts exporting createLineVerifier(options: LineVerifierOptions): LineVerifierPort with LineVerifierOptions declared there as an open interface (J4 shapes it).
(4) line/index.ts re-exporting all five files, and packages/execution/src/index.ts re-exporting line/index.js.
(5) test/src/execution/line-repo.ts, a fixture for later tests: creates a real git repository in a temp dir with an initial commit on main, a line branch and program branches. Helpers: commit files on a branch; read a file AT A COMMIT via git show (so fake verifiers decide from a commit's content, never from a worktree's files); get the createLineCheckout over the repo; and a fake LineVerifierPort, built from a predicate over the commit's files, that returns a schema-valid LineVerification and logs. Plus cleanup. test/src/execution/line-git.test.ts tests the adapter against it.
  depends on: nothing (starts at once)
  touches: packages/execution/src/line/ports.ts, packages/execution/src/line/git.ts, packages/execution/src/line/compose.ts, packages/execution/src/line/resolver.ts, packages/execution/src/line/verifier.ts, packages/execution/src/line/index.ts, packages/execution/src/index.ts, test/src/execution/line-repo.ts, test/src/execution/line-git.test.ts
  - packages/execution/src/line/ports.ts declares every port and type listed in the objective, with the verifier's pristine-checkout contract documented; nothing under line/ imports from apps/ or from the persistence stores
  - createLineCheckout passes tests on a real repository: open gives a detached worktree at base; merge of a non-conflicting commit makes a two-parent merge commit; merge of an already-contained commit is 'merged' at the unchanged head; a conflicting merge reports the conflicted paths and leaves the worktree clean at its previous head; isAncestor is right both ways; close removes the worktree
  - compose.ts, resolver.ts and verifier.ts exist with exactly the exported signatures in the objective, and line/index.ts plus the package index export them
  - The fixture test/src/execution/line-repo.ts, including the commit-content fake verifier, exists and line-git.test.ts uses it
  - npm run build, typecheck, lint and the touched tests pass

J2: Implement packages/execution/src/line/compose.ts (replacing J1's stubs): composeLineBatch and drainLine over LineComposerPorts.
composeLineBatch(ports, { lineHead, mainHead, batch }):
0. ONE DEADLINE for the whole batch (D-04: an hour per composition): deadline = clock at start + (limits.seconds ?? LINE_COMPOSITION_SECONDS). Pass it as failure.deadline to every resolve call. Check it before each unit's merge/verify in the fallback: once it has passed, every range not yet composed is parked with a reason naming the composition's time limit, and no further verification or resolve call is made.
1. Group batch.entries by program, programs ordered by their first enqueuedAt; a program's range is { program, from: await queue.lastComposed(program) (omitted when undefined), upTo: the upTo of its last entry }. Drop a range whose upTo is already an ancestor of lineHead.
2. If no range is left, settle with neither a composition nor parked entries, publish nothing, and return with head = lineHead.
3. Batch attempt: open a worktree at lineHead; merge mainHead (message names main), then each range in order (message names the program and range). If every merge succeeds, verify the result (base = lineHead). Green means outcome 'passed'. Green: settle with one composition { commit: head, parent: lineHead, ranges, verification } and no parked; publish { head, expectedPredecessor: lineHead }.
4. Any conflict, or any outcome other than 'passed': compose one unit at a time from lineHead in a fresh worktree. First main (unless already contained), then each range: merge it onto the current head and verify. A pass advances the current head. A conflict or a non-pass builds a LineFailure { unit, base: current head, deadline, cause (a 'red' cause carries the verifier's logs) } and calls ports.resolve(failure). On 'resolved', the current head becomes resolution.commit and the range counts as composed. On 'parked', the range is parked with resolution.reason and the composition continues from the unchanged head with the next range. If main itself parks, every range is parked with a reason saying main does not compose onto the line.
5. SCHEMA RULE: a composition is recorded and published only when at least one range was composed (LineCompositionBody.ranges is min(1)). If no range composed, then even if main merged cleanly the head does not move: settle with only the parked entries, publish nothing, head = lineHead. Otherwise settle once with the composition, carrying the composed ranges, the verification of the final head, and the resolver of the last resolution that fixed something (its detail names every unit the resolver fixed), plus the parked entries (each with ranges, reason, resolver, and commit/verification when present). Then publish { head, expectedPredecessor: lineHead }. Every settlement must pass LineCompositionBodySchema/LineParkBodySchema for its parts. Close every worktree it opened, including on a throw. Return a LineBatchOutcome.
drainLine(ports, heads): loop { batch = queue.takeBatch(); stop when undefined; read heads(); composeLineBatch }. Stop after a batch whose publication was rejected, and return the outcomes.
Tests in test/src/execution/line-compose.test.ts drive real git repositories through J1's fixture (test/src/execution/line-repo.ts) and createLineCheckout. They use an in-memory queue, a recording publisher, the fixture's commit-content fake verifier, a fake resolve function and a controllable clock.
  depends on: J1
  touches: packages/execution/src/line/compose.ts, test/src/execution/line-compose.test.ts
  - A batch of two programs plus new main commits, all compatible, gives one composition whose commit contains main and both upTo commits as ancestors, whose parent is the line head and whose verification passed; it is settled with both ranges and published with expectedPredecessor = the old line head
  - Several queue entries of one program become one range whose upTo is the last entry and whose from is queue.lastComposed
  - When the batch merge conflicts, or when it verifies red, the ranges are composed one at a time, and resolve is called exactly once, with the range that fails (not one that composes cleanly), base = the head with the earlier good ranges merged, and for red the failing logs
  - A resolved failure's commit becomes the head and the composition carries its resolver; a parked range is in settlement.parked and the remaining ranges still compose
  - A batch whose ranges are all already on the line settles with nothing and publishes nothing; a batch where main merges but every range parks settles only parked entries, publishes nothing, and keeps head = lineHead; every recorded settlement part passes the contract schemas
  - With two failing ranges, resolve receives the same deadline both times, and once the clock passes it the remaining ranges are parked with no further resolve or verify calls
  - Every worktree opened is closed
  - drainLine drains several batches until takeBatch returns undefined
  - npm run build, typecheck, lint and the new tests pass

J3: Implement packages/execution/src/line/resolver.ts (replacing J1's stub): resolveLineFailure(ports: LineResolverPorts, failure: LineFailure): Promise<LineResolution>, the resolver of D-03 and D-04.
Limits: at most ports.limits.attempts (default core's LINE_RESOLVER_ATTEMPTS = 3) attempts, and nothing after failure.deadline (the composition's single deadline set by the composer), read with ports.clock. Each attempt:
(a) Open a fresh worktree at failure.base, the line head the unit failed on.
(b) Write a brief: what failed (the unit: main or a program's range with from/upTo shas; for a conflict, the conflicted paths and detail; for red, each failed command with its exit code and its log tail from failure.cause.logs), the instruction to merge the unit's commit into this worktree and leave a commit that makes the landing checks pass without dropping either side's work, and the findings or failures of earlier attempts (including log tails of an earlier red verification of the agent's candidate).
(c) Call agents.resolve with the brief, the worktree and the deadline.
(d) The attempt fails, and the next brief says why, when: the agent failed; the worktree's head is unchanged; or the head does not contain both failure.base and the unit's commit (checkout.isAncestor).
(e) Verify the candidate commit in a FRESH worktree opened at that commit (checkout.open(head)), never in the agent's worktree, with base = failure.base. Anything but 'passed' fails the attempt.
(f) Call agents.examine with avoidModel = the resolver's model. The attempt fails if the examiner's model equals the resolver's, or if the verdict is 'rejected'; its findings go into the next brief.
(g) If approved, build a LineResolverDecision (authority 'line', context naming the failure, choice and rationale from the agent's summary and the examiner's approval, alternatives including parking the range, reversibility 'reversible', both models, the attempt count, the verificationId), record it through decisions.record, and return { kind: 'resolved', commit, verification, resolver: { decision: 'resolved', attempts }, decision }.
Close every worktree. Before each attempt and after each agent call, if the deadline has passed or the attempts are spent, return { kind: 'parked', reason (naming the limit and the last failure), resolver: { decision: 'gave_up', attempts }, commit/verification of the last checked candidate when there is one }. A throw from an agent port counts as a failed attempt, not a crash.
Tests in test/src/execution/line-resolver.test.ts use real git through J1's fixture (test/src/execution/line-repo.ts) and createLineCheckout. Fakes: an agent port that writes and commits a resolution in the given worktree (or does not), an examiner, the fixture's commit-content fake verifier, and a controllable clock.
  depends on: J1
  touches: packages/execution/src/line/resolver.ts, test/src/execution/line-resolver.test.ts
  - A conflict failure whose fake agent merges and fixes is verified, examined by a different model, recorded as a decision with authority 'line', and returned resolved with attempts = 1 and a commit containing both base and the unit's commit
  - The resolver works from failure.base: the worktree given to the agent is at that commit
  - The candidate is verified in a worktree other than the agent's, opened at the candidate commit
  - A red failure's log tails appear in the first brief
  - Three failed attempts (any mix of red verification, rejected examination, agent failure, unchanged head) park with decision 'gave_up', attempts 3, and no decision recorded; a fourth agent call is never made
  - Once the clock passes failure.deadline, no further attempt starts and the failure parks with a reason naming the time limit
  - An examiner whose model equals the resolver's model never approves a fix
  - A rejected examination's findings appear in the next attempt's brief
  - npm run build, typecheck, lint and the new tests pass

J4: Implement packages/execution/src/line/verifier.ts (replacing J1's stub): createLineVerifier(options) returning a LineVerifierPort, the real adapter that runs a project's landing checks on a line candidate and returns { verification: LineVerification (phase 'line'), logs: LineCommandLog[] }.
It first makes the worktree exactly `commit` with pristineCheckout (git/operations.ts: reset --hard plus clean -fdx), so uncommitted, untracked or ignored files left by an agent can never decide the outcome. Then it runs the setup steps and only the landing steps (landingSteps from gate-repair.ts), so a step declared at: 'end' never runs. It reuses the execution package's existing step-running primitives (runCheckoutSteps, the scratch and project-env helpers verify.ts uses) where practical, and needs no RunSession and no run-scoped store.
The record: verificationId from options.ids; commitSha and baseSha from the input; commands as VerificationCommandResult (logArtifactId only when an optional options.recordLog sink returns one; full output is never inlined in the record); outcome = outcomeOfCommands; times from options.clock; parsed with LineVerificationSchema. logs: each step's last LINE_LOG_TAIL_CHARS characters of output, held in memory for the resolver's brief. Each step is told the commit and base as run verifications are (verificationFacts: NIGHTSHIFT_BASE_SHA etc.). Shape and document LineVerifierOptions (gates: GateDefinitions; ids; clock; env; optional recordLog).
Tests in test/src/execution/line-verifier.test.ts run real trivial shell steps in a temporary git checkout.
  depends on: J1
  touches: packages/execution/src/line/verifier.ts, test/src/execution/line-verifier.test.ts
  - A gate set whose steps all exit 0 yields a LineVerification with phase 'line' and outcome 'passed' that LineVerificationSchema accepts
  - A failing landing step yields outcome 'failed', with that command's exit code, and its output's tail in logs
  - A step declared at: 'end' is never run and does not appear in commands
  - A worktree whose commit fails a check, but which holds an uncommitted, untracked or ignored file that would make the check pass, verifies as failed
  - The verifier needs no run-scoped store or RunSession
  - A test asserts core's isLandingEvidence('line') is false
  - npm run build, typecheck, lint and the new tests pass

J5: An end-to-end offline test of the line engine: test/src/execution/line-engine.test.ts. It drives drainLine (compose.ts) with resolve wired to the real resolveLineFailure (resolver.ts), over a real git repository from test/src/execution/line-repo.ts, the real createLineCheckout and the real createLineVerifier (J4) with small shell steps (for example, a step that fails when a file contains a marker). The queue, publisher, decision port and resolver/examiner agents are in-memory fakes. The clock is controllable. It proves the strand's acceptance together:
(1) A green batch gives one published composition that records the batch's members.
(2) A batch with one conflicting range and one clean range is composed one at a time. The resolver gets the conflicting range from the line head with the clean range merged, and fixes it on attempt 1. The fix is checked and examined by a different model, a 'line' decision is recorded, and the published head contains everything.
(3) A red range whose real failing step's output reaches the resolver's brief. The resolver cannot fix it: an agent that commits a still-broken merge and leaves an uncommitted or ignored file that would make the check pass is rejected by verification each time. The range parks after 3 attempts, and the queue moves on to the next batch.
(4) Two failing ranges in one batch share one hour: once the clock passes it, the composition parks what remains.
(5) A batch whose ranges all park publishes nothing, and its settlement passes the contract schemas.
Fix small defects in compose.ts or resolver.ts that this integration exposes, and report what you changed.
  depends on: J2, J3, J4
  touches: test/src/execution/line-engine.test.ts, packages/execution/src/line/compose.ts, packages/execution/src/line/resolver.ts
  - The five scenarios in the objective are tests that pass against real git and the real verifier
  - Every settlement recorded in the tests passes LineCompositionBodySchema/LineParkBodySchema (with batchId added) for its composition and parked entries
  - npm run build, typecheck, lint and test pass

J6: Extend S-02's line plane so a batch can be settled with what the composition engine produces. Today composeBatch and parkBatch (packages/core/src/rules/line.ts) each settle the batch, so a batch with both a composition and a parked range (D-02's one-at-a-time fallback) cannot be recorded. Add the following, and keep the existing compositions/parked routes and rules working as they are:
(1) In packages/contracts/src/v1/line.ts: LineSettleBodySchema = { batchId, composition?: LineCompositionBody without batchId (ranges stays min(1)), parked: array of LineParkBody without batchId } (strict). It may carry neither a composition nor parked entries: a batch whose ranges were all already on the line.
(2) In packages/core/src/rules/line.ts: settleBatch(record, body, ids: { compositionId?, parkedIds: string[] }, at), with the same stale-batch and resolver-attempt refusals, appending the composition (if any) and each parked entry (bounded by MAX_LINE_COMPOSITIONS and MAX_LINE_PARKED) and clearing the batch, all in one change.
(3) The batch cap the plan asks for: takeBatch moves at most MAX_LINE_BATCH_ENTRIES (export it; 25) of the oldest queue entries into a batch and leaves the rest queued.
(4) The route POST …/line/{branch}/settle in apps/api/src/operations/line.ts, registered like the compositions route with the same line-principal authorization, generation fencing and store compare-and-swap. Add the client method wherever the existing compositions/parked routes have one (for example persistence's http client), so S-04 can call it.
Tests: unit tests of the rule and the cap beside the existing line rule tests, and a route test beside the existing line route tests.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line.ts, packages/contracts/src/v1/line.test.ts, packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, apps/api/src/operations/line.ts, apps/api/src/handler.ts, packages/persistence/src/http/**, test/src/**/line*.test.ts (api route tests only)
  - LineSettleBodySchema exists and accepts composition-only, parked-only, both, and neither; a composition with no ranges is rejected
  - settleBatch records the composition and every parked entry in one record change and clears the batch; a stale batchId or more than 3 resolver attempts is refused
  - takeBatch takes at most MAX_LINE_BATCH_ENTRIES oldest entries and leaves the rest in the queue
  - POST …/line/{branch}/settle works for the line owner and is refused to other principals and stale generations, as the compositions route is
  - The existing compositions and parked routes and their tests still pass
  - npm run build, typecheck, lint and test pass. Revised for the four review findings:
(1) One deadline per composition (per batch), set by the composer and passed in LineFailure.deadline to every resolver call. The resolver has no deadline of its own. Tested with two failing units.
(2) A composition is recorded and published only when at least one range composed, so ranges stays min(1). A batch with nothing new settles with nothing, and an all-parked batch settles only its parked entries and leaves the head unmoved. Tested in J2 and J5.
(3) Diagnostics: LineVerifierPort.verify returns { verification, logs }, where logs are bounded output tails held in memory, never on the line record. LineFailure's red cause carries them to the resolver's brief. An optional log sink in J4 can supply logArtifactId.
(4) Verification evidences only the exact commit. The verifier port's contract is that it makes the worktree pristine at the commit (reset --hard plus clean -fdx), and the resolver also verifies in a fresh worktree opened at the candidate. J4 and J5 test that dirty, untracked or ignored repairs cannot pass.
The split is unchanged. J1 is the foundation (ports, git adapter, stubs, fixture with a commit-content fake verifier). After it, J2, J3 and J4 run in parallel, each on its own file. J5 is the integrated proof. J6 extends S-02's plane in parallel from the start (combined settle and batch cap), since it touches only contracts/core/api/persistence-http.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** STRAND PLAN REVIEW: round 2 of 2 — revise (`dec_01M5YC4HETX1GM0F6A1K04685V`)
  Chose: The foundation followed by parallel composer, resolver and verifier jobs is a useful split, and the combined settlement job addresses mixed outcomes against the existing plane. Two material gaps remain: the hour limit does not bound verification or the successful batch path, and the resolver assumes agents can perform git writes that Nightshift reserves for the engine.
- [MATERIAL] The shared deadline still does not enforce an hour per composition. J2 checks it only in fallback, so the initial batch can verify past the deadline and then settle/publish as green. J1's verifier accepts neither a deadline nor cancellation, and J4 runs setup and checks without a remaining composition budget; a long verification can keep the queue blocked beyond the hour. J3 can also start examination after verification has already exhausted the budget. Existing runCheckoutSteps runs sequential setup/check processes and does not acquire a composition deadline automatically. Carry and enforce the remaining budget through verification and agent execution, check expiry on the fast path and between stages, and test expiry during a green batch and during verification, including stopping the outstanding work and moving on. (J1, J2, J3, J4, J5)
- [MATERIAL] J3 explicitly tells the resolver agent to merge and leave a commit, rejects an unchanged HEAD, and tests this using an agent fake that commits. This conflicts with the existing harness contract (packages/harness/src/harness.ts and brief.ts): workers never receive git write access and Nightshift owns every commit; packages/execution/src/worker.ts snapshots their edits through engine-owned git operations. As written, a real resolver following that contract cannot produce the candidate these tests assume, so S-04 cannot merely wire this engine. Assign merge preparation and creation of the candidate commit to engine-owned checkout operations, preserving both required parents, and test an agent that only edits files. The ports currently have no operation for capturing such a repair. (J1, J3, J5). An independent examiner reviewed decision dec_01M5YC1QMQG2FJXPVKX3Q88R2Q against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** Final (round 2) review of S-03's job plan found that (a) the composition deadline did not bound verification or the green batch path, and (b) the resolver assumed the agent makes git commits, which the harness contract forbids: Nightshift owns every commit. (`dec_01M5YC5348J0279HZGTBMFPB12`)
  Chose: Delegate the round-2 plan with both findings folded into the jobs. (a) LineVerifierPort.verify takes the composition deadline: it kills or skips steps past it and reports timedOut. The composer checks the deadline after the batch verification (an expired green batch parks rather than publishes) and between units. The resolver checks it between every stage, including before examination. (b) LineCheckoutPort gains engine-owned startMerge (git merge --no-commit, leaving conflicts in the worktree), commitMerge (stage everything and commit the in-progress merge with both parents) and sameTree. The resolver agent only edits files, the engine makes the candidate commit, and tests use an agent that only edits files.. These fix the reviewer's material findings without changing the split or the dependencies, so it is built as reviewed.
  Weighed: Keep the round-2 plan as written, rejected because Both findings are correct. A real resolver agent cannot commit, so S-04 could not just wire it, and a slow verification could hold the queue past D-04's hour.
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** Landing fix round 1 has two findings. F-01: settling a green batch before its push is requested can lose it for good. F-02: the three resolver attempts are counted per failing range rather than per composition. (`dec_01M5YE85W1XNX7ZEFWSDTQZBPG`)
  Chose: F-01: the line owner first stages the publication (its bundle uploaded durably, giving a bundleKey). It then settles, and the settle body carries the push request, so settleBatch records the composition and a pending push to that commit in the same change. The plane's publisher completes a pending push without the owner, and a pending push already counts as line work. A push that resolves conflict, error, protected or forbidden requeues that composition's ranges, and a composition that was never pushed no longer stops its ranges being queued again. If staging fails, nothing is settled and the batch stays held for the next owner. F-02: the composer holds one budget of LINE_RESOLVER_ATTEMPTS per composition and passes what is left to the resolver. Once it is spent, every remaining failing unit parks without another agent call. Two parallel jobs: one for the plane (contracts, core, api) and one for the engine (packages/execution/src/line and its tests).. Both fixes follow the examiner's findings directly. Settling and requesting the push in one atomic change makes a green batch recoverable at every point a crash can land.
  Weighed: Keep the batch held until the push is confirmed (a new batch state), rejected because It adds a second batch lifecycle to S-02's record. Settling with the push request in the same change reuses the push state machine the plane's publisher already drives.
  Weighed: Publish first, then settle, rejected because If the owner dies in between, the line moves but the composition, and so the batch's members, is never recorded (acceptance 1).
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** Fix round 2, F-01: requeuing after a failed push appends the old range, stamped with the failure's time, after a newer queued head of the same program. groupRanges keeps the last entry by timestamp, so it composes the older head and the settlement drops the newer one. (`dec_01M5YFX2XV0VZKB3R565ZHM3Z4`)
  Chose: Fix both sides. Core's resolvePush requeues a failed composition's ranges ahead of the existing queue entries, keeping the composition's composedAt as their enqueuedAt, and skips a range whose program already has a queued entry for the same upTo. The composer picks each program's head by git ancestry: the entry that descends from all the program's other entries, falling back to the newest by enqueue time only when the history diverges. Regression tests cover both sides, plus the examiner's scenario end to end with the real core rules.. Ancestry is the truth about which head is newer, and history-ordered requeuing keeps the record honest. Together, newer work that arrives before a failed push is requeued can never be lost.
  Weighed: Fix only the requeue ordering in core, rejected because Enqueue time stays a proxy for history; any other path that reorders entries would bring the bug back.
  Weighed: Fix only the composer's choice by ancestry, rejected because The queue would still show a misleading order and timestamps to `line status` readers.
  Reversible.
  Produced: nothing that landed.
- **Strand S-04:** STRAND PLAN: round 1 — 5 jobs, 3 starting at once (`dec_01M5YH6K10HEMB6S815YYWH021`)
  Chose: J1: Plane additions the line owner needs (Pipkin M1b S-04). (a) In packages/core/src/rules/line.ts add `LINE_IDLE_SECONDS = 600`: how long the owner waits with an empty queue and nothing in flight before it stops, exported beside LINE_COMPOSITION_SECONDS. (b) Give the resolver's decisions (D-03: 'recorded as a decision for later review') a durable home: a contract schema `LineDecisionSchema` in packages/contracts/src/v1/line.ts that matches execution's `LineResolverDecision` port type in packages/execution/src/line/ports.ts field for field (authority 'line', unit, base, commit, context, alternatives, choice, rationale, reversibility 'reversible', resolverModel, examinerModel, attempts, verificationId, decidedAt) plus a `decisionId` and the recording `generation`; an optional `decisions` array on `LineRecordSchema` keeping the newest `MAX_LINE_DECISIONS` (50); a pure core rule `recordLineDecision(record, body, decisionId, generation, at)` that is idempotent for the same (commit, unit) and refuses a stale generation as a value; and a route `POST /v1/projects/{projectId}/line/{branch}/decisions` (body `LineDecisionBodySchema`, carrying `generation`) in apps/api/src/operations/line.ts, wired in the route table/handler and authorized for the line principal of the current generation only (core's authorize-line rules), returning the stored record. (c) `nightshift line status` shows the newest decisions (count and the last one's unit and choice).
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line.ts, packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, packages/core/src/rules/authorize-line*.ts, packages/core/src/auth/**, apps/api/src/operations/line.ts, apps/api/src/handler.ts, apps/api/src/handler-line.test.ts, apps/api/src/route-table.test.ts, apps/cli/src/commands/line.ts, test/src/conformance/line-ports.ts
  - `LINE_IDLE_SECONDS` is exported from @nightshift/core with value 600
  - A POST to the decisions route with the line token of the current generation stores the decision on the line record; a repeat of the same decision is stored once; a stale generation gets 409; a run's engine token or a human without the line principal is refused as other line-owner routes are
  - The record keeps at most 50 decisions, newest kept; records written before this change (no `decisions` field) still parse in memory, SQLite and DynamoDB stores
  - `nightshift line status` prints the decisions summary when there are decisions
  - Unit tests in packages/core (rule), apps/api (route, authorization, handler-line tests) and apps/cli cover the above; build, typecheck, lint and the touched tests pass

J2: The real resolver and examiner agents for the line (adapter of execution's `LineResolverAgentPort`, packages/execution/src/line/ports.ts), in a new file apps/mcp/src/runner/line-agents.ts exporting `createLineAgents(options)`. `resolve({brief, worktree, deadline})` starts one headless coding agent through @nightshift/harness, with its working directory the worktree, the brief as its task, the model chosen by packages/routing for an implement/fix role (the org's routing policy as the run's workers get it), killed at the deadline; it returns the model it ran and `finished`/`failed`. It must never run git that writes state: the brief already says so; the adapter additionally runs the agent without git write ability where the harness allows (as workers are restricted) and the engine owns commits. `examine({..., avoidModel})` starts a read-only examining agent on a model that is NOT `avoidModel` (the next model on the examiner role's preference list that differs), asks for a verdict on the resolved merge commit against base given the verification, and parses a structured verdict (`approved`/`rejected` with findings) from its final output; an unparseable answer or a failure is `rejected` with a finding saying so. The agent's environment is the project environment and provider credentials handed in by options (as the run root's workers get them); nothing reaches for process.env directly. Options inject the harness/launcher so tests use a fake.
  depends on: nothing (starts at once)
  touches: apps/mcp/src/runner/line-agents.ts, apps/mcp/src/runner/line-agents.test.ts
  - `createLineAgents` implements `LineResolverAgentPort` and is exported for the runner
  - Tests over a fake harness show: resolve launches in the worktree with the brief and returns the model and status; a deadline kills the agent and returns `failed`; examine never uses `avoidModel` (and refuses/returns rejected if no other model is available); an approving and a rejecting structured verdict are parsed; garbage output is `rejected`
  - No git-writing command is issued by the adapter itself
  - build, typecheck, lint and the new tests pass

J3: Docs for the project line and the line owner. Add a decision row to docs/architecture.md for the project line and its single line owner: one owner per (project, line branch), started by the control plane when work is queued, booted from the runner image in line mode, composing with natural batching by program-branch range (a failed batch one range at a time), a resolver whose fix lands after the landing checks and an examination by a different model and is recorded as a line decision, programs still reaching main through their own pull requests (D-05), only remote runs' published program branches feeding the line (D-06), bounded by a per-project monthly cap (default $25), an hour per composition and three resolver attempts, stopping after `LINE_IDLE_SECONDS` (600 s) with an empty queue, and a replacement after a lost machine (new generation, same dispatch lease rules) taking the held batch back where it stood; the rejected alternatives (composing on each run's machine; a serverless composer). Update skills/run-program (SKILL.md) where it talks about landings to say that a remote run's published program branch is queued onto the project line and composed there by the line owner, and that `nightshift line status` shows it. Mention the line owner in AGENTS.md only if AGENTS.md has a map of runner modes/bins that would otherwise be wrong. Do not touch docs/programs/.
  depends on: nothing (starts at once)
  touches: docs/architecture.md, skills/run-program/SKILL.md, AGENTS.md
  - docs/architecture.md has a decision row for the project line and the line owner covering the points in the objective and the two rejected alternatives
  - skills/run-program/SKILL.md mentions the line where it describes landings, and any skill test under test/src/skills still passes
  - No file under docs/programs/ is changed
  - lint and the skills/docs tests pass

J4: The runner's line mode (apps/mcp): a line dispatch boots the runner as the line owner. (1) Bootstrap: `readIdentity` recognises a line machine by the `nightshift-kind: line` tag (tags set by apps/api/src/runner/provision-line.ts `lineMachineTags`: nightshift-project, nightshift-line, nightshift-agent, nightshift-generation, nightshift-stage, nightshift-api) and returns a line identity; the first token is read from `firstTokenParameterName(stage, engineAgentId, generation)` and deleted as for a run. (2) A `LineRunnerPlane` port in apps/mcp/src/runner/ with its HTTP adapter in apps/mcp/src/compose.ts over the line routes (GET line, POST batch, settle, heartbeat, bundle-upload-url, decisions from J1), carrying the dispatch generation. (3) Refactor `runRunner` in apps/mcp/src/runner/main.ts so the run mode and a new line mode share boot, heartbeat (posting to the line heartbeat route in line mode), token renewal, volume mount / local disk + sidecar snapshot handling and setup-failure reporting; run mode behaviour and its existing tests stay unchanged. (4) `runLineOwner` (new apps/mcp/src/runner/line-owner.ts): report running, wait for the GitHub read token and provider credentials from the heartbeat, keep a mirror (bare) and checkout of the line's repository on the workspace, fetch the line branch, main and every queued program head (program branches from the line view's `programs`) with the read token, prepare the project environment as a run does, then build S-03's ports: `LineQueuePort` over the plane (takeBatch with the generation; lastComposed = the upTo of that program's newest composition on the record; settle → POST settle with the push), `LinePublisherPort` (stage: `git bundle` of expectedPredecessor..head uploaded through a bundle-upload-url presigned PUT, returning the key; outcome: re-read the line until the record's push for that head is resolved, mapping published vs any other status to rejected with its detail), `createLineCheckout`, `createLineVerifier` with the project's gates read from the checkout as runs read them, and `resolve` = `resolveLineFailure` with J2's `createLineAgents` and a decisions port posting to J1's route. Loop: before taking work, if the record holds a pending push (an earlier generation's), wait for its outcome; refetch heads; `drainLine`; when it returns after a rejected push, refetch and drain again (recompose); when the queue is empty, poll it, and once it has been empty with nothing pending for `LINE_IDLE_SECONDS` (overridable in options), end the work so the runner's last heartbeat is `stopped` with no failure and the process exits 0 (the plane's existing stop/cleanup then stops the machine). Stop at once when a heartbeat answers stop; exit non-zero on a lost lease as run mode does. A replacement generation simply runs the same loop: the plane hands the held batch back to it. (5) bin/nightshift-runner.ts dispatches to line mode for a line machine, wiring the real plane, machine, harness and agents.
  depends on: J1, J2
  touches: apps/mcp/src/runner/bootstrap.ts, apps/mcp/src/runner/main.ts, apps/mcp/src/runner/heartbeat.ts, apps/mcp/src/runner/plane.ts, apps/mcp/src/runner/line-owner.ts, apps/mcp/src/runner/line-owner.test.ts, apps/mcp/src/runner/runner.test.ts, apps/mcp/src/compose.ts, apps/mcp/src/bin/nightshift-runner.ts
  - Runner tests over a fake machine and fake line plane show: a line-tagged machine reads its line identity and its first token from the engineAgentId parameter; it heartbeats on the line route with its generation; it reports running and receives credentials
  - Over a real local git repo standing in for GitHub and a fake plane: queued program heads are fetched, a batch is composed through drainLine, the bundle is uploaded, settle carries the push, the owner reads the push outcome, and on a `conflict` outcome it refetches the line and recomposes
  - With an empty queue the owner keeps beating and, after the idle period (shortened in the test), ends with a `stopped` heartbeat with no failure and exit 0; new work arriving before the idle period resets it
  - A replacement generation with a held batch and a pending push from the old generation waits for the push outcome, then takes the held batch and composes it
  - A heartbeat answering stop ends the owner promptly; a lost lease exits non-zero
  - Every existing run-mode runner test passes unchanged
  - build, typecheck, lint and test pass

J5: An end-to-end test (test/src/line/ or test/src/execution/line-owner-e2e.test.ts) that drives the whole line through real pieces: a local control plane (apps/api's in-process local server or handler over in-memory stores) with a dispatcher that runs the publisher's `publishLine` in-process and records line provisioning, the git HTTP server the publisher tests already use (apps/api/src/github/git-http-server.ts) standing in for GitHub, and J4's `runLineOwner` over a fake machine against that plane (fake agents only for the resolver/examiner: a scripted resolver that edits the conflicted file into a merged form and an examiner on a different model that approves). Scenario: two programs each land and publish their program branch; the publisher queues each range and a line dispatch is requested; the owner boots for that dispatch, composes both ranges and main onto the line, hands the head to the publisher, which moves the line on the git server; then a third landing of one program conflicts with the other's work on the line, the resolver repairs it, the examiner approves, a line decision is recorded on the plane, and the repaired head is published; the owner then idles out (shortened idle period) and the dispatch ends stopped. A second case: the owner is killed mid-batch (lease lapses), a replacement generation is admitted and resumes the held batch to the same composed line. Add whatever small test seams the pieces need without changing their behaviour.
  depends on: J4
  touches: test/src/line/**, test/package.json, apps/api/src/local/**
  - The test passes under `npm run test` offline (no network beyond localhost, no AWS), within the suite's time limits
  - It asserts: the line branch on the git server contains both programs' work and main; the conflict commit was repaired and published; the line record shows the compositions pushed, a resolver decision recorded, an empty queue; the dispatch ended stopped after the idle period
  - The replacement case asserts the held batch was composed by the new generation and published once
  - sterility, lint and typecheck pass with the new test. The plane (S-02) and the engine (S-03) are already merged on this branch, so S-04 is wiring: what's missing is a durable home for resolver decisions and an idle constant in the plane (J1), a real agent adapter for the resolver/examiner port (J2), the runner's line mode (J4) and an end-to-end test (J5), plus docs (J3). J1, J2 and J3 touch disjoint files and run at once. J4 needs J1's route/constant and J2's adapter to wire the bin, so it waits for both; J5 drives J4's owner so it waits for J4. J4 is one job, not split, because the boot refactor of main.ts, the line identity, the plane client and the owner loop all meet in main.ts/compose.ts and would conflict if split. Resolver decisions live on the line record (newest 50) instead of a new store, to avoid a new table across three persistence backends.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-04:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M5YH9GVRGYCRWE55EQ7WJBKA`)
  Chose: The broad split is sensible: the parallel starter jobs are largely disjoint, the coupled runner work belongs together, and the end-to-end job covers publication, repair and recovery. However, the real agent path needs interfaces that do not exist on this branch and are not assigned by the plan; fake-agent tests would hide those gaps. The final verification coverage also omits synth.
- [MATERIAL] J2 requires the org's routing policy, but no job supplies it to the line owner. LineViewSchema and LineDispatchSchema carry no policy, lineHeartbeat returns credentials but no routing policy, and authorizeLine in packages/core/src/rules/authorize.ts refuses every non-line operation, including orgConfig.get and run reads. Unlike run workers (which use Run.policy), J4 cannot obtain the stated policy through its planned plane port. Assign an authorized policy delivery path and its wiring/test so the real resolver and different-model examiner can route under the org's policy. (J1, J2, J4)
- [MATERIAL] The proposed brief/worktree launcher does not match the existing @nightshift/harness API. HarnessStartInput in packages/harness/src/harness.ts requires an Agent already persisted as created, an ExecutionNode, JobContract and ProgramContract; the real adapters render promptFor(input), rather than accepting an arbitrary brief-only task. A line dispatch has none of those run-scoped records, and the plan assigns neither a supported line-agent launch contract nor execution-identity persistence/lifecycle for these agents. Specify and assign that bridge, preserving A-04 and the provider boundary, and test the real adapter input/prompt path with fake processes. A fake LineResolverAgentPort or invented run records would not establish that J4 can launch the promised agents. (J2, J4)
- [MATERIAL] Acceptance criterion 5 explicitly requires synth to be green, but none of J1–J5 runs or accepts synth. Assign the final combined-tree verification (for example the configured npm run verify, which includes build, typecheck, lint, test, synth and check:sterility) to a job so completing every job's stated acceptance proves the strand's required checks. (J5). An independent examiner reviewed decision dec_01M5YH6K10HEMB6S815YYWH021 against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-04:** STRAND PLAN: round 2 — 5 jobs, 3 starting at once (`dec_01M5YHBZQX5GFNRRN7FQVKR9DB`)
  Chose: J1: Plane additions the line owner needs (Pipkin M1b S-04). (a) In packages/core/src/rules/line.ts add `LINE_IDLE_SECONDS = 600`: how long the owner waits with an empty queue and nothing in flight before it stops, exported beside LINE_COMPOSITION_SECONDS. (b) Give the resolver's decisions (D-03: 'recorded as a decision for later review') a durable home: a contract schema `LineDecisionSchema` in packages/contracts/src/v1/line.ts that matches execution's `LineResolverDecision` port type in packages/execution/src/line/ports.ts field for field (authority 'line', unit, base, commit, context, alternatives, choice, rationale, reversibility 'reversible', resolverModel, examinerModel, attempts, verificationId, decidedAt) plus a `decisionId` and the recording `generation`; an optional `decisions` array on `LineRecordSchema` keeping the newest `MAX_LINE_DECISIONS` (50); a pure core rule `recordLineDecision(record, body, decisionId, generation, at)` that is idempotent for the same (commit, unit) and refuses a stale generation as a value; and a route `POST /v1/projects/{projectId}/line/{branch}/decisions` (body `LineDecisionBodySchema`, carrying `generation`) in apps/api/src/operations/line.ts, wired in the route table/handler and authorized for the line principal of the current generation only (core's `authorizeLine` in packages/core/src/rules/authorize.ts), returning the stored record. (c) The policy the line's agents route under: the line view (`GET …/line/{branch}`, `LineViewSchema`) gains an optional `policy: EffectivePolicy` (contracts' `EffectivePolicySchema`), filled from the org's config exactly as a run's snapshot is (`requireEffectivePolicy` in packages/execution/src/start-run.ts / core, at org level with no program narrowing, or narrowed by every program feeding the line if that function requires a program; say which in a comment), and omitted when the org has none configured (the owner then uses the contracts defaults). The line principal is already allowed `GET line`; no new read is opened to it. (d) `nightshift line status` shows the newest decisions (count and the last one's unit and choice).
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line.ts, packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, packages/core/src/rules/authorize.ts, packages/core/src/rules/authorize-line.test.ts, apps/api/src/operations/line.ts, apps/api/src/handler.ts, apps/api/src/handler-line.test.ts, apps/api/src/route-table.test.ts, apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts
  - `LINE_IDLE_SECONDS` is exported from @nightshift/core with value 600
  - A POST to the decisions route with the line token of the current generation stores the decision on the line record; a repeat of the same decision is stored once; a stale generation gets 409; a run's engine token or a principal other than the line's is refused as other line-owner routes are
  - The record keeps at most 50 decisions, newest kept; records written before this change (no `decisions` field) still parse in memory, SQLite and DynamoDB stores
  - `GET …/line/{branch}` with the line token returns `policy` equal to what a run of that org would snapshot (test against requireEffectivePolicy's output for a configured org; absent for an unconfigured one)
  - `nightshift line status` prints the decisions summary when there are decisions
  - Unit tests in packages/core (rule, authorization), apps/api (route, handler-line tests) and apps/cli cover the above; build, typecheck, lint and the touched tests pass

J2: Launching the line's resolver and examiner agents through the harness, without run-scoped records. Today `Harness.start` (packages/harness/src/harness.ts) needs an `Agent` persisted as created, an `ExecutionNode`, a `JobContract` and a `ProgramContract`, none of which a line dispatch has; do not invent any. Add to the harness contract a line-scoped launch: an optional `startLine(input: HarnessLineStartInput)` on `Harness` returning the same handle/exit shape, where `HarnessLineStartInput` carries the identity (`{ engineAgentId, generation, agentId }` — `agentId` minted by the owner as `${engineAgentId}-g${generation}-${role}-${n}` and announced on the line dispatch before launch by the caller, see J4; the adapter puts it on the handle and never mints one, preserving A-04's rule 1), `role: 'line_resolver' | 'line_examiner'`, the worktree and its tmpDir, the `RouteTarget` routing chose, the environment (project env + provider credentials handed in, nothing read from process.env), a deadline, and the task `{kind: 'line_resolve', brief}` or `{kind: 'line_examine', brief}`; no MCP server. Rendering the prompt from the task lives in packages/harness/src/brief.ts beside the other tasks; the examiner's prompt asks for a final fenced JSON verdict `{verdict: 'approved'|'rejected', findings: string[]}`. Implement `startLine` in harness-claude and harness-codex by reusing each adapter's existing command/permission building: git write denied exactly as for workers (D-P3-15), the examiner read-only (no file edits), exit settled once, usage carried. harness-agentcore may leave it unimplemented. Then, in a new apps/mcp/src/runner/line-agents.ts, `createLineAgents(options)` implementing execution's `LineResolverAgentPort` (packages/execution/src/line/ports.ts): options inject the harness registry, the `EffectivePolicy` (from J1's line view, or contracts' defaults), the identity, env and an `announce(agent)` callback awaited before every launch. `resolve` routes through packages/routing as a fix/implement worker under the policy, launches `startLine` with role line_resolver in the worktree, kills it at the deadline and returns `{model, status}`; `examine` routes the examiner role choosing a model whose identifier differs from `avoidModel` (next on the preference list), launches role line_examiner, and parses the verdict from the final output; no other model available, an unparseable answer or a failed agent is `rejected` with a finding saying why.
  depends on: nothing (starts at once)
  touches: packages/harness/src/harness.ts, packages/harness/src/brief.ts, packages/harness/src/index.ts, packages/harness/src/*.test.ts, packages/harness-claude/src/**, packages/harness-codex/src/**, apps/mcp/src/runner/line-agents.ts, apps/mcp/src/runner/line-agents.test.ts
  - `Harness.startLine` and `HarnessLineStartInput` exist in @nightshift/harness, provider-neutral (no provider names in types or events), and the run path's `start` is unchanged (all existing harness and adapter tests pass)
  - harness-claude and harness-codex tests with fake processes show for `startLine`: the prompt rendered from the line task reaches the CLI, the working directory is the worktree, no MCP config is passed, git-writing commands are denied as for workers, the examiner has no edit permission, the handle carries the given agentId, and a deadline/kill settles the exit once
  - line-agents tests over a fake harness show: `announce` is awaited before each launch; resolve returns the model and finished/failed; a deadline returns failed; examine never runs `avoidModel` and returns rejected when no other model is routable; approved and rejected JSON verdicts parse; garbage output is rejected
  - build, typecheck, lint and the touched packages' tests pass

J3: Docs for the project line and the line owner. Add a decision row to docs/architecture.md for the project line and its single line owner: one owner per (project, line branch), started by the control plane when work is queued, booted from the runner image in line mode, composing with natural batching by program-branch range (a failed batch one range at a time), a resolver whose fix lands after the landing checks and an examination by a different model and is recorded as a line decision on the line record, programs still reaching main through their own pull requests (D-05), only remote runs' published program branches feeding the line (D-06), bounded by a per-project monthly cap (default $25), an hour per composition and three resolver attempts, stopping after `LINE_IDLE_SECONDS` (600 s) with an empty queue, and a replacement after a lost machine (new generation, the dispatch lease rules) taking the held batch back where it stood; line agents launch through the harness's line-scoped `startLine`, each announced on the line dispatch before it starts, under the org's effective policy. Record the rejected alternatives (composing on each run's machine; a serverless composer). Update skills/run-program/SKILL.md where it talks about landings to say that a remote run's published program branch is queued onto the project line and composed there by the line owner, and that `nightshift line status` shows it. Touch AGENTS.md only if it has a map of runner modes/bins that would otherwise be wrong. Do not touch docs/programs/.
  depends on: nothing (starts at once)
  touches: docs/architecture.md, skills/run-program/SKILL.md, AGENTS.md
  - docs/architecture.md has a decision row for the project line and the line owner covering the points in the objective and the two rejected alternatives
  - skills/run-program/SKILL.md mentions the line where it describes landings, and the skill tests under test/src/skills still pass
  - No file under docs/programs/ is changed
  - lint and the skills/docs tests pass

J4: The runner's line mode (apps/mcp): a line dispatch boots the runner as the line owner. (1) Bootstrap: `readIdentity` recognises a line machine by the `nightshift-kind: line` tag (tags set by apps/api/src/runner/provision-line.ts `lineMachineTags`: nightshift-project, nightshift-line, nightshift-agent, nightshift-generation, nightshift-stage, nightshift-api) and returns a line identity; the first token is read from `firstTokenParameterName(stage, engineAgentId, generation)` and deleted as for a run. (2) A `LineRunnerPlane` port in apps/mcp/src/runner/ with its HTTP adapter in apps/mcp/src/compose.ts over the line routes (GET line incl. J1's `policy`, POST batch, settle, heartbeat, bundle-upload-url, decisions from J1), carrying the dispatch generation. (3) Refactor `runRunner` in apps/mcp/src/runner/main.ts so the run mode and a new line mode share boot, heartbeat (posting to the line heartbeat route in line mode), token renewal, volume mount / local disk + sidecar snapshot handling and setup-failure reporting; run mode behaviour and its existing tests stay unchanged. (4) `runLineOwner` (new apps/mcp/src/runner/line-owner.ts): report running, wait for the GitHub read token and provider credentials from the heartbeat, keep a mirror and checkout of the line's repository on the workspace, fetch the line branch, main and every queued program head (program branches from the line view's `programs`) with the read token, prepare the project environment as a run does, then build S-03's ports: `LineQueuePort` over the plane (takeBatch with the generation; lastComposed = the upTo of that program's newest composition on the record; settle → POST settle with the push), `LinePublisherPort` (stage: `git bundle` of expectedPredecessor..head uploaded through a bundle-upload-url presigned PUT, returning the key; outcome: re-read the line until the record's push for that head is resolved, mapping published vs any other status to rejected with its detail), `createLineCheckout`, `createLineVerifier` with the project's gates read from the checkout as runs read them, and `resolve` = `resolveLineFailure` with J2's `createLineAgents` (policy from the line view, else contracts' defaults; `announce` = a heartbeat progress beat on the line dispatch naming the agentId, role and model, awaited until the plane has acknowledged it) and a decisions port posting to J1's route. Loop: before taking work, if the record holds a pending push (an earlier generation's), wait for its outcome; refetch heads; `drainLine`; when it returns after a rejected push, refetch and drain again (recompose); when the queue is empty, poll it, and once it has been empty with nothing pending for `LINE_IDLE_SECONDS` (overridable in options), end the work so the runner's last heartbeat is `stopped` with no failure and the process exits 0 (the plane's existing stop/cleanup then stops the machine). Stop at once when a heartbeat answers stop; exit non-zero on a lost lease as run mode does. A replacement generation runs the same loop: the plane hands the held batch back to it. (5) bin/nightshift-runner.ts dispatches to line mode for a line machine, wiring the real plane, machine, harness registry and agents.
  depends on: J1, J2
  touches: apps/mcp/src/runner/bootstrap.ts, apps/mcp/src/runner/main.ts, apps/mcp/src/runner/heartbeat.ts, apps/mcp/src/runner/plane.ts, apps/mcp/src/runner/line-owner.ts, apps/mcp/src/runner/line-owner.test.ts, apps/mcp/src/runner/runner.test.ts, apps/mcp/src/compose.ts, apps/mcp/src/bin/nightshift-runner.ts
  - Runner tests over a fake machine and fake line plane show: a line-tagged machine reads its line identity and its first token from the engineAgentId parameter; it heartbeats on the line route with its generation; it reports running and receives credentials
  - Over a real local git repo standing in for GitHub and a fake plane: queued program heads are fetched, a batch is composed through drainLine, the bundle is uploaded, settle carries the push, the owner reads the push outcome, and on a `conflict` outcome it refetches the line and recomposes
  - A resolver launch is preceded by an acknowledged progress beat naming the agent; the decision the resolver records is posted to the decisions route
  - With an empty queue the owner keeps beating and, after the idle period (shortened in the test), ends with a `stopped` heartbeat with no failure and exit 0; new work arriving before the idle period resets it
  - A replacement generation with a held batch and a pending push from the old generation waits for the push outcome, then takes the held batch and composes it
  - A heartbeat answering stop ends the owner promptly; a lost lease exits non-zero
  - Every existing run-mode runner test passes unchanged
  - build, typecheck, lint and test pass

J5: An end-to-end test (new directory test/src/line/) that drives the whole line through real pieces: a local control plane (apps/api's in-process local server or handler over in-memory stores) with a dispatcher that runs the publisher's `publishLine` in-process and records line provisioning, the git HTTP server the publisher tests already use (apps/api/src/github/git-http-server.ts) standing in for GitHub, and J4's `runLineOwner` over a fake machine against that plane. Agents go through J2's `createLineAgents` over a fake harness whose `startLine` scripts the processes: the resolver edits the conflicted file into a merged form, the examiner (on a different model) prints an approving JSON verdict. Scenario: two programs each land and publish their program branch; the publisher queues each range and a line dispatch is requested; the owner boots for that dispatch, composes main and both ranges onto the line, hands the head to the publisher, which moves the line on the git server; then a third landing of one program conflicts with the other's work on the line, the resolver repairs it, the examiner approves, a line decision is recorded on the plane, and the repaired head is published; the owner then idles out (shortened idle period) and the dispatch ends stopped. A second case: the owner is stopped mid-batch (lease lapses), a replacement generation is admitted and resumes the held batch to the same composed line. Add only small test seams the pieces need, without changing their behaviour. Finally run the strand's whole gate set on the combined tree: npm run build, typecheck, lint, test, `npm --workspace @nightshift/cdk run synth` and `npm run check:sterility`, and fix anything this strand's work broke.
  depends on: J4
  touches: test/src/line/**, test/package.json, apps/api/src/local/**
  - The test passes under `npm run test` offline (no network beyond localhost, no AWS), within the suite's time limits
  - It asserts: the line branch on the git server contains both programs' work and main; the conflict was repaired and published; the line record shows the compositions pushed, a resolver decision recorded, an empty queue; the agents' announcements are on the dispatch; the dispatch ended stopped after the idle period
  - The replacement case asserts the held batch was composed by the new generation and published once
  - build, typecheck, lint, test, synth and check:sterility all pass on the combined tree, and the job's report quotes their results. Round 2. Changes from the review: (1) the org's effective policy reaches the line owner through the line view it is already allowed to read (J1c), and J2/J4 route under it; (2) line agents get a line-scoped harness entry point `startLine` (J2) implemented in the Claude and Codex adapters, carrying an agentId the owner mints and announces on the line dispatch through an acknowledged heartbeat progress beat before every launch (J4), so nothing runs unannounced and no run-scoped records are invented; (3) J5 runs the full gate set including synth and sterility on the combined tree. Parallelism unchanged: J1, J2, J3 at once on disjoint files (J1 plane/contracts/core/cli; J2 harness packages + apps/mcp/src/runner/line-agents.ts; J3 docs), J4 after J1 and J2 because it wires both, J5 after J4. J4 stays one job: the boot refactor, line identity, plane client and owner loop meet in main.ts/compose.ts. Resolver decisions live on the line record (newest 50) rather than a new store, avoiding a new table across three persistence backends.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-04:** STRAND PLAN REVIEW: round 2 of 2 — revise (`dec_01M5YHE413VA45Y7PA3GDB6D1G`)
  Chose: The jobs cover the strand's acceptance and the J1/J2/J3 → J4 → J5 ordering is sensible, with useful parallel work and a complete final gate set. However, the new line-agent launch and announcement contracts still conflict with the existing identity, dispatch-progress and machine-user contracts; these need resolving before implementation.
- [MATERIAL] J2 requires agentId = `${engineAgentId}-g${generation}-${role}-${n}` while returning the existing HarnessHandle, whose agentId is a branded AgentId. packages/contracts/src/ids.ts accepts only agent_<26 Crockford characters>, so the prescribed identity cannot satisfy the existing handle contract without an unsafe cast or a further contract change. Specify a compatible identity allocation (using the existing injected ID generator), or explicitly own and test the distinct line-identity type and affected handle APIs before J2 builds. (J2, J4)
- [MATERIAL] An acknowledged heartbeat progress beat does not durably register the line agents as the plan assumes. RunnerProgressSchema/DispatchProgressSchema in packages/contracts/src/v1/dispatch.ts have only stage/detail/gates/verdict, and core's foldProgress replaces the previous detail; foldStages retains only stage and time. Encoding an announcement in detail loses the resolver when the examiner announces, and subsequent progress loses that too. Thus J5 cannot assert that both agents' announcements remain on the dispatch, and J2's claimed persisted identity guarantee is not established. Assign the durable, generation-fenced announcement contract and persistence to a job, with tests that multiple announcements survive later beats and recovery; account for those contract/core/API edits in the dependency split. (J1, J4, J5)
- [MATERIAL] HarnessLineStartInput and createLineAgents options omit RunAs or an equivalent project-user launch facility. Both existing adapters use input.runAs with commandAs to switch from engine to project; without it they spawn as the runner's engine user. Passing only a sanitized environment does not enforce the repository's machine-user boundary or provide project-owned credentials/config and cancellation. Include the project-user execution context in the line launch contract and J4 wiring, and verify both adapters launch and cancel through it, so the line resolver and examiner do not execute project code as engine. (J2, J4). An independent examiner reviewed decision dec_01M5YHBZQX5GFNRRN7FQVKR9DB against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-04:** Round-2 plan review of strand S-04 asked for three changes before building: a line agent identity compatible with AgentId, a durable announcement of line agents, and project-user execution (RunAs) for line agents. (`dec_01M5YHED7YB3CXN9BW9P25RTPB`)
  Chose: All three taken into the jobs: (1) line agents get an ordinary AgentId minted by the injected IdGenerator (ids.next(\"agent\")); (2) J1 adds a generation-fenced POST …/line/{branch}/agents route and an `agents` list on the LineDispatch (newest 50 kept), and J4's announce awaits that route before every launch; (3) HarnessLineStartInput carries RunAs, and both adapters launch and cancel through commandAs as for workers, with J4 wiring the project user's RunAs.. The reviewer's findings are correct against the code (ids.ts, dispatch progress folding, adapters' use of input.runAs). The fixes stay inside the jobs already planned and do not change the dependency split: the new route and field are J1's (contracts/core/api), the RunAs field is J2's (harness), the wiring is J4's.
  Weighed: Announce agents through heartbeat progress detail, rejected because foldProgress replaces detail, so announcements do not survive later beats, as the reviewer showed
  Weighed: Custom line agent id string on the harness handle, rejected because AgentId is branded agent_<ULID>; it would need an unsafe cast
  Reversible.
  Produced: nothing that landed.
- **Strand S-04:** Landing fix round 1, F-03: the first line dispatch failed when the line branch did not exist on GitHub yet. (`dec_01M5YNMTRBYWVVW9TEK0RYXNX2`)
  Chose: The owner composes onto main's head when the line ref is absent. The publisher creates the ref with an absent-ref compare-and-swap only when the line record has never had a head; an absent ref on a line that had a head stays a conflict.. This keeps the publisher as the only writer, needs no contract change, and makes a deleted line branch a conflict rather than letting it be recreated silently.
  Weighed: Add an explicit `create` flag to the line push contract, rejected because a contract change across contracts/core/api for a case the record already distinguishes
  Weighed: Have the owner or plane create the branch before composing, rejected because breaks the rule that only the publisher writes to GitHub
  Reversible.
  Produced: nothing that landed.

## Usage

Token counts are what each harness reported and are not comparable across harnesses.
A cost marked * is estimated from the price table, not reported by the harness. A cost
that is unknown had neither: give the org's price table a price for that model to estimate it.
Each attempt counts one figure in the cost column (reported when it has one, else estimated). The
Reported and Estimated columns split that by kind; provider-reported dollars are never summed with
an API-equivalent estimate.

| Harness | Model | For | Routes | Input tokens | Output tokens | Cost per attempt (USD) | Reported (n: USD) | Estimated (n: USD) | Basis |
|---|---|---|---|---|---|---|---|---|---|
| claude | claude-opus-5-5 | work | 13 | 77360307 | 295061 | 27.92 | 13: $27.92 | none | provider-reported; 13 of 13 attempts valued |
| codex | gpt-6-astra | examine | 21 | 13867499 | 45830 | unknown | none | none | unknown; 0 of 21 attempts valued |
| claude | claude-fable-5-1 | arbitrate | 1 | 377765 | 2791 | 1.76 | 1: $1.76 | none | provider-reported; 1 of 1 attempts valued |
| claude | claude-sonnet-5-5 | work | 36 | 80877027 | 767154 | 33.65 | 36: $33.65 | none | provider-reported; 36 of 36 attempts valued |
| claude | claude-opus-5-5 | root | 1 | 134467955 | 47993 | 31.80 | 1: $31.80 | none | provider-reported; 1 of 1 attempts valued |

## Where the time went

Elapsed not observed (as of 2026-10-27T13:06:52.672Z); elapsed is the run's window and phase figures below are interval unions. Peak concurrency 4.

- **summed work (overlapping; not elapsed):** 12h 57m, each closed work interval counted in full

- **By phase (union, counted once):** work 6h 05m, wait 6h 28m, queue 0.3s, integration 1h 37m, examination 35m 32s, setup 18.0s, startup 58.0s, verification 1h 12m
- **Wait by blocker kind:** strand 5h 49m, job 1h 55m, parent_slot 48m 35s
- **Unattributed:** not observed. **Ambiguous (open or incomplete, in no union):** 7h 54m
- **Endings:** integrated 4, merged 36, integration conflict 0, verification failed 0, failed 0, deferred 0, examination stopped 9, examination skipped 0, other 0

Observed chain (not a claim about a faster schedule): covers 7h 43m of not observed, coverage not observed, complete; 0 ambiguous step(s).

1. node_01M5XX0SDM7N8NG23QFEMPNDRW integration 2026-10-27T12:59:37.848Z to 2026-10-27T13:06:49.720Z (7m 12s, via end)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW work 2026-10-27T12:52:35.578Z to 2026-10-27T12:59:37.369Z (7m 02s, via work)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW startup 2026-10-27T12:52:34.425Z to 2026-10-27T12:52:35.578Z (1.2s, via attempt)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW wait 2026-10-27T12:52:34.292Z to 2026-10-27T12:52:34.425Z (0.1s, via attempt)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW integration 2026-10-27T12:43:56.514Z to 2026-10-27T12:52:33.508Z (8m 37s, via retry)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW work 2026-10-27T12:33:11.811Z to 2026-10-27T12:43:56.020Z (10m 44s, via work)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW startup 2026-10-27T12:33:10.427Z to 2026-10-27T12:33:11.811Z (1.4s, via attempt)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW wait 2026-10-27T12:33:10.232Z to 2026-10-27T12:33:10.427Z (0.2s, via attempt)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW integration 2026-10-27T12:25:19.892Z to 2026-10-27T12:33:09.332Z (7m 49s, via retry)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW work 2026-10-27T11:13:23.048Z to 2026-10-27T12:25:19.442Z (1h 11m, via work)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW startup 2026-10-27T11:13:21.826Z to 2026-10-27T11:13:23.048Z (1.2s, via attempt)
1. node_01M5XX0SDM7N8NG23QFEMPNDRW wait 2026-10-27T05:23:37.713Z to 2026-10-27T11:13:21.825Z (5h 49m, via attempt)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV integration 2026-10-27T11:06:12.601Z to 2026-10-27T11:13:20.828Z (7m 08s, via dependency)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV work 2026-10-27T10:53:27.849Z to 2026-10-27T11:06:12.172Z (12m 44s, via work)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV startup 2026-10-27T10:53:26.962Z to 2026-10-27T10:53:27.848Z (0.9s, via attempt)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV wait 2026-10-27T10:53:26.780Z to 2026-10-27T10:53:26.962Z (0.2s, via attempt)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV integration 2026-10-27T10:45:49.805Z to 2026-10-27T10:53:25.941Z (7m 36s, via retry)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV work 2026-10-27T10:24:01.322Z to 2026-10-27T10:45:49.353Z (21m 48s, via work)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV startup 2026-10-27T10:24:00.464Z to 2026-10-27T10:24:01.321Z (0.9s, via attempt)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV wait 2026-10-27T10:24:00.339Z to 2026-10-27T10:24:00.464Z (0.1s, via attempt)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV integration 2026-10-27T10:16:21.701Z to 2026-10-27T10:23:59.503Z (7m 38s, via retry)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV work 2026-10-27T09:39:53.511Z to 2026-10-27T10:16:21.239Z (36m 28s, via work)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV startup 2026-10-27T09:39:52.127Z to 2026-10-27T09:39:53.510Z (1.4s, via attempt)
1. node_01M5XX0RWKCTS8MC6YQ1BH76NV wait 2026-10-27T05:23:37.340Z to 2026-10-27T09:39:52.127Z (4h 16m, via attempt)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 integration 2026-10-27T09:33:05.951Z to 2026-10-27T09:39:50.930Z (6m 45s, via dependency)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 work 2026-10-27T09:14:19.050Z to 2026-10-27T09:33:05.519Z (18m 46s, via work)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 startup 2026-10-27T09:14:18.124Z to 2026-10-27T09:14:19.050Z (0.9s, via attempt)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 wait 2026-10-27T09:14:17.992Z to 2026-10-27T09:14:18.124Z (0.1s, via attempt)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 integration 2026-10-27T09:06:22.218Z to 2026-10-27T09:14:17.207Z (7m 55s, via retry)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 work 2026-10-27T08:53:20.011Z to 2026-10-27T09:06:21.638Z (13m 02s, via work)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 startup 2026-10-27T08:53:19.191Z to 2026-10-27T08:53:20.011Z (0.8s, via attempt)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 wait 2026-10-27T08:53:19.026Z to 2026-10-27T08:53:19.191Z (0.2s, via attempt)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 integration 2026-10-27T08:44:50.696Z to 2026-10-27T08:53:18.225Z (8m 28s, via retry)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 work 2026-10-27T07:19:15.079Z to 2026-10-27T08:44:50.190Z (1h 25m, via work)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 startup 2026-10-27T07:19:13.985Z to 2026-10-27T07:19:15.078Z (1.1s, via attempt)
1. node_01M5XX0REWSZ2P5P86P9BD77F6 wait 2026-10-27T05:23:36.723Z to 2026-10-27T07:19:13.985Z (1h 55m, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS integration 2026-10-27T07:13:04.272Z to 2026-10-27T07:19:13.147Z (6m 09s, via dependency)
1. node_01M5XX0PNYNAGJ17MNQ45995MS work 2026-10-27T07:01:49.939Z to 2026-10-27T07:13:03.886Z (11m 14s, via work)
1. node_01M5XX0PNYNAGJ17MNQ45995MS startup 2026-10-27T07:01:49.095Z to 2026-10-27T07:01:49.939Z (0.8s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS wait 2026-10-27T07:01:48.980Z to 2026-10-27T07:01:49.095Z (0.1s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS integration 2026-10-27T06:53:42.650Z to 2026-10-27T07:01:48.137Z (8m 05s, via retry)
1. node_01M5XX0PNYNAGJ17MNQ45995MS work 2026-10-27T06:44:50.321Z to 2026-10-27T06:53:42.191Z (8m 52s, via work)
1. node_01M5XX0PNYNAGJ17MNQ45995MS startup 2026-10-27T06:44:49.366Z to 2026-10-27T06:44:50.321Z (1.0s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS wait 2026-10-27T06:44:49.243Z to 2026-10-27T06:44:49.366Z (0.1s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS integration 2026-10-27T06:37:55.048Z to 2026-10-27T06:44:48.505Z (6m 53s, via retry)
1. node_01M5XX0PNYNAGJ17MNQ45995MS work 2026-10-27T06:27:08.018Z to 2026-10-27T06:37:54.634Z (10m 47s, via work)
1. node_01M5XX0PNYNAGJ17MNQ45995MS startup 2026-10-27T06:27:07.198Z to 2026-10-27T06:27:08.018Z (0.8s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS wait 2026-10-27T06:27:07.080Z to 2026-10-27T06:27:07.198Z (0.1s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS integration 2026-10-27T06:19:49.867Z to 2026-10-27T06:27:06.325Z (7m 16s, via retry)
1. node_01M5XX0PNYNAGJ17MNQ45995MS work 2026-10-27T05:23:36.430Z to 2026-10-27T06:19:49.421Z (56m 13s, via work)
1. node_01M5XX0PNYNAGJ17MNQ45995MS startup 2026-10-27T05:23:35.102Z to 2026-10-27T05:23:36.430Z (1.3s, via attempt)
1. node_01M5XX0PNYNAGJ17MNQ45995MS wait 2026-10-27T05:23:34.939Z to 2026-10-27T05:23:35.102Z (0.2s, via attempt)

## Delivery

36 work item(s) and 0 repair job(s) in 4 strand(s); 36 attempt(s), 22 helper call(s).

- **First-attempt success:** all jobs: 36/36 (100%), 0 unfinished; coverage complete
- **Excluding repair jobs:** jobs: 36/36 (100%), 0 unfinished
- **Outcomes:** landed 36; failed by none
- **Rework:** 0 attempt(s), each counted once
  - unknown cause: 0 attempt(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
- **First attempts:** input 80877027, output 767154 tokens (complete coverage: complete 36); estimated not observed, reported $33.65 (provider-reported)
- **All rework:** input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed

## Human verdict

A person's one-click verdict on whether the run worked. It is not a verification and says nothing about why.

- Verdict: **not rated**
- This program: 0 of 0 ended run(s) rated; 0 worked, 0 did not; positive share among rated n/a; 0 unrated.

## Review

- **Coverage:** 4 node(s) examined, 36 examined by strand, 0 landed unexamined, 0 skipped; 13 examination(s) (passed 4, findings_raised 9)
- **Dispositions:** 15 unique finding(s); latest fixed 14, upheld 1; rulings upheld 1. fixed means the finding was not raised again; upheld means the arbiter agreed. Neither is independently established truth.
- **Overhead by role (apart from repairs):**
  - examiner: 13 call(s); input 10939806, output 33569 tokens (partial coverage: partial 13); estimated not observed, reported not observed; 13 unpriced
  - answerer: 0 call(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
  - arbiter: 1 call(s); input 377765, output 2791 tokens (complete coverage: complete 1); estimated not observed, reported $1.76 (provider-reported)
  - plan review: 8 call(s); input 2927693, output 12261 tokens (partial coverage: partial 8); estimated not observed, reported not observed; 8 unpriced
- **Repairs caused by review:** 9 attempt(s); input 30851334, output 60083 tokens (partial coverage: partial 9); estimated not observed, reported $8.66 (provider-reported)
- **Linkage:** findings linked 15; 0 helper call(s) unlinked; 0 repair(s) without findings

## Machine

- **Lifetime:** not observed (coverage unknown; 0 observed ending(s), 0 runner-only ending(s); last machine ending not observed, last runner ending not observed; 1 attempt(s) without an observed end; gaps between attempts 0.0s)
  - attempt 1 (dispatch): machine end unobserved, runner not ended
- **Instance:** $7.04 for 28583s (runner-metered 28583s), runner-metered seconds; machine end unobserved (lower bound) (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2; unknown)
- **Volume:** $0.17 for 28590.54s, open (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2)
- **Total:** $7.22 (Instance: 28583 s from runner-metered seconds; machine end unobserved (lower bound) at 0.88704 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2); volume: 28590.54 s from request to asOf (not yet deleted) at 0.021917808219178082 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2).)
- **Recorded spend:** {"estimatedUsd":21.814987397260275,"ceilingSeconds":86400,"meteredUsd":7.216872508980214,"meteredSeconds":28583}; computed $7.22 against metered $7.22 over 28583s (computedUsd prices instance and volume together over spend.meteredSeconds, as meteredUsd does; the components above use each one's own observed lifetime.)
- **Occupancy:** coverage partial; busy 0.0s at least, idle not claimed (No attempt has an observed machine end (terminatedAt), so idle time is not claimed; busy time is observed busy time, at least.), provisioning 2m 12s, setup 7.624s; peak 0 concurrent occupant(s)
- **Per-node shares:** none. No attempt has an observed machine end (terminatedAt), so cost cannot be apportioned to nodes. Each observed-closed attempt costs its observed machine lifetime (terminatedAt - startedAt) at the instance rate, split by occupied time within that same window (concurrent occupants share each moment equally). The cost of attempts without an observed machine end (open, or machine end unobserved) is never apportioned and is listed per attempt, together with unoccupied time within closed attempts and the whole volume, as unapportioned.

## Request evidence

Per-request ledgers are stored as artifacts. Fetch one through the authorized download route:
operation `artifact.createDownloadUrl`, `POST .../artifacts/{artifactId}/download-url`.

| Attempt | Artifacts | Ids |
|---|---|---|
| node_01M5XX0PNYNAGJ17MNQ45995MS work #1 | 44 | art_01M5XX39DT4SNX9WE9XXZGSWTW, art_01M5XX5AM1PPFEH41DBFA4MGVR, art_01M5XX7R1VND4A8FCRG26FMPDH, art_01M5XX9X3JS1FBNA83592TE0ZV, art_01M5XXC3RDC0Z4Q5MKMHJVQYDX, art_01M5XXED0XS0AZRWRM54MSZC99, art_01M5XXGA64P0Y8H26YCAAX76NG, art_01M5XXK22PW8M78BDPK39MZXVQ, art_01M5XXNBQGK90S242MYBS64YFF, art_01M5XXQMJ9CZNHQCT6FAWA0WS8, art_01M5XXTCERBQ2S20C8J07JYZGX, art_01M5XXWAEF83Z8E3XW0A64NMZH, art_01M5XXYYY9NPARQ4KQZS33ZG8P, art_01M5XY1GG5A1GQ0MASX6QHYHTG, art_01M5XY3HDR51JECCMSJRWN1QSG, art_01M5XY69AA2G6GK4GADK86YJH9, art_01M5XY8F6S18RC3AVRS2ANJ6YX, art_01M5XYAVSYKWHTZXJE6V5047YH, art_01M5XYDKPCADGFHS68NMT7HQYE, art_01M5XYGBJWRYP44ZA49K6HCKFE, art_01M5XYJX88JYWSMGK6FHHW93WG, art_01M5XYMY2D2FX02SPECXKPNJZ7, art_01M5XYQ0530XE3GFKYPW3EKZ5T, art_01M5XYRXPK4VJ42KGB56NWTEH4, art_01M5XYVB4XD7NQ6VVN33FAGTW3, art_01M5XYY31E8CB3YYFXWCECG009, art_01M5XZ0TXZEE7V1KN658Y6YJJV, art_01M5XZ2Z1PP2F17CK76NFHFYWE, art_01M5XZ5DDH0PC26EF5D5WDB5D0, art_01M5XZ843Q392F4T5AFJJ3DYD0, art_01M5XZ9ZWZP75B26MHRJCCDC1K, art_01M5XZCQSG7PTE8J9FGAM83C22, art_01M5XZF0VP220WQW3ER28W23NJ, art_01M5XZHA96ST7K61RW5Z5BS5YX, art_01M5XZM25GRBXPHD0P6T6HJ3CH, art_01M5XZNXM5QSWTH5AABTZ22ZKQ, art_01M5XZRMN12MWTNVXTA2FSFSPA, art_01M5XZV3P15924M89F36DGPQ10, art_01M5XZX74MPVMMXYFCEBMRM92K, art_01M5XZZZ15N6K6VKR90SSXVWVX, art_01M5Y020E15KR49DY41WYHC6DP, art_01M5Y04HGNM60WSW9Z3MEZVNCF, art_01M5Y074GXPPH05TM0D35VD3ZS, art_01M5Y07PG2XYK441S70P0FG76Z |
| node_01M5XX0PNYNAGJ17MNQ45995MS examine #1 | 2 | art_01M5XX6ZFP76C7X2D1BJQ35YCQ, art_01M5XX81CMDYNX2G9S51G8SJ16 |
| node_01M5XX0PNYNAGJ17MNQ45995MS examine #1 | 1 | art_01M5XXBPFHRJP0YWNPS69W6ZV3 |
| node_01M5XX0PNYNAGJ17MNQ45995MS examine #1 | 2 | art_01M5Y0MJP17J14XZYK8CMQSN0J, art_01M5Y0N07Q8E4HJPZHJ6SHDTRX |
| node_01M5XX0PNYNAGJ17MNQ45995MS work #2 | 9 | art_01M5Y0QTATTNSJ7K21TS30VH6X, art_01M5Y0SZWFXTXAA91DXZH58G8P, art_01M5Y0WCTB7RGNN3A6WVCG4Q27, art_01M5Y0Z4PVVFJFYR1Z6D9DP0GR, art_01M5Y11WKB96CKJMPQF6ZQ7DJA, art_01M5Y14BZY44GCQYKDW0KAXZ09, art_01M5Y16F2XMXBHAB4A73C6ADYQ, art_01M5Y18AZR9YH8D5QA8CHV73JW, art_01M5Y18T8SPF7HYCBMKNAGQTMG |
| node_01M5XX0PNYNAGJ17MNQ45995MS examine #1 | 2 | art_01M5Y1ND5KFFANM46WQWTD7X8C, art_01M5Y1NDFNES48E5P4P4TN9W1Q |
| node_01M5XX0PNYNAGJ17MNQ45995MS work #3 | 7 | art_01M5Y1QPB3F06ZXSYVCYSD81K7, art_01M5Y1T2515R6TWTV8Z3QQPG5M, art_01M5Y1WT1JZBXKTH8KK4P2E5E7, art_01M5Y1ZHY373JAG2GXMTPNH6X8, art_01M5Y220FJQQF679AZPFFBHP8S, art_01M5Y244DKP17JHT8ZJ0V137XF, art_01M5Y25QKH5CW4G4YP3AXE0FNE |
| node_01M5XX0PNYNAGJ17MNQ45995MS examine #1 | 2 | art_01M5Y2JH3TNADSB7K929FJV6YW, art_01M5Y2JHCFMJ6G161Z8XBT6MD7 |
| node_01M5XX0PNYNAGJ17MNQ45995MS arbitrate #1 | 2 | art_01M5Y2MEWHMMCSA6MZYBC5BC7W, art_01M5Y2MH6QVTZ2DFWEJCWETYC2 |
| node_01M5XX0PNYNAGJ17MNQ45995MS work #4 | 9 | art_01M5Y2QBEA6TGV817TH35MCS6C, art_01M5Y2T3AT18R5XX634H3RMH02, art_01M5Y2WMMWKGM32XQQRP5TWM9D, art_01M5Y2YNTC7EGRZZXGWWPZ21S2, art_01M5Y31DPWB5S7RN5S1VJPYFJH, art_01M5Y33HCSW5Z5EPSR5ANP4ECV, art_01M5Y3606DNAD7ZARMZ79RCGJE, art_01M5Y38R302E9VTVB9ZW4K9H5Q, art_01M5Y396235KAFZWFFSX1AB02H |
| node_01M5XX0PNYNAGJ17MNQ45995MS examine #1 | 1 | art_01M5Y3MCQBTD7W2SY9SY62BQAW |
| node_01M5XX0REWSZ2P5P86P9BD77F6 work #1 | 67 | art_01M5Y3PAZPP41YAHNM2876YK5S, art_01M5Y3R7HXQ2JY9V4APYT8T83W, art_01M5Y3T34JPYV0N1640D6BMV7Z, art_01M5Y3W1NFY25XBG7TSA88JB1A, art_01M5Y3YAY756DS00DK25PW4SND, art_01M5Y406H8Z7QW941YY2Y1PQ9T, art_01M5Y427N87GG4JXDSH4RZ3J02, art_01M5Y44ZHS82ABYEMNMJ8T41E3, art_01M5Y47QEA87333270QP126DHN, art_01M5Y49KE1V5V0VJH4C3MMW7ZW, art_01M5Y4C9XVH8WB8N2XD0BXQ899, art_01M5Y4F0BP6T70JSASRD7ANXWZ, art_01M5Y4GWDE4GKFFTGDQHYHPVG6, art_01M5Y4KM9ZAD2NF15SWBF4CF4R, art_01M5Y4P11WFYFB2QV939Y2B0JW, art_01M5Y4R6SHDD0ESCMHBCT3C4Q5, art_01M5Y4T3YWVWXBV2DXVJXB4K3Z, art_01M5Y4W2FP9MTYYB85VNMRGP0N, art_01M5Y4YKW55EX2PF3EG77ZKX6P, art_01M5Y51AH4V39K2W08BFFAWNJE, art_01M5Y536BRKH839M3Z6TZGG7YQ, art_01M5Y55Y88F8PZF2TQAZAPXXER, art_01M5Y5888QR2NJAD1TTKSFK7A5, art_01M5Y5AGQT9SNCCWVDFZQGNXZX, art_01M5Y5D8MAH1BEGJCPSZMJJ2W4, art_01M5Y5F5ZT6D4AY8Q5J1ZEXRM4, art_01M5Y5HV3VPKZCZ8597R2XX03D, art_01M5Y5MC1M7CC1T3ADDBF3DGHP, art_01M5Y5PDKBHN669K4DVEXPGY6E, art_01M5Y5S5FWZ9DFA2V2ET1DCHEH, art_01M5Y5VAS1VH4D5SX5001FY4R7, art_01M5Y5XQZFBET6SAS1TXEFSJDH, art_01M5Y60FVW5DSZFNWAAKS2FF9E, art_01M5Y637RJ0XSCQSNN8B5B971B, art_01M5Y65MYJ6RFHH5AYJXVYNEHG, art_01M5Y67T84276SBVF5HGEKJ8JP, art_01M5Y6AJ4K0N82RFHKR4SNM61T, art_01M5Y6DA14EKJ5DE2RBP5WK66D, art_01M5Y6FV72GMT3VDA5NP6EKF6Q, art_01M5Y6HWGQFN3SPMZG3TMV7PV7, art_01M5Y6MMD7HR6N2766PGTYYYN9, art_01M5Y6PTWYH1HN8CW5740KWQXG, art_01M5Y6S6WQSJ7BX442KAHA9MGH, art_01M5Y6VYS9YH18PMWWS1HSW3QB, art_01M5Y6XVHKKSZJMFXCDDF9H71F, art_01M5Y70H8RE7NC9HRXZ68KT19Z, art_01M5Y733HF75E0DF7VD2SMP066, art_01M5Y753R8R2ZFYM9MH4JB0E86, art_01M5Y77VMSV3Z8T6DTSC7SGDJ3, art_01M5Y7ADYEF10P9AS66XJ3XXTD, art_01M5Y7CE497SRBH2EKZXA8T4MW, art_01M5Y7F60SQG3N4F4S7DN1PSTH, art_01M5Y7H9PX0RAR3PTH609H7C3M, art_01M5Y7KRGBWK9PJMSBPXFB0Z9W, art_01M5Y7PGCT4MZV3N58APRJ5JX8, art_01M5Y7S89BEVXRGFXA4WFPCKPZ, art_01M5Y7VRQRFCDE9E9DJZGMM93B, art_01M5Y7XTRVB5PX36NQZMDG3TMH, art_01M5Y80JNDJYM58JRCM1NDJVTC, art_01M5Y82JH53XFCDSJKKBMQTM8Y, art_01M5Y8554XPM99VFTPDTVXAX4T, art_01M5Y87SJNYG70CV4W327DS577, art_01M5Y89QME7VKS968NA4AZRG4M, art_01M5Y8CFGZ95WYTPT4V8CC3KHH, art_01M5Y8F4Z0N261CT1KWCE4A3NG, art_01M5Y8H20HMQ45KFKK5VGHHSYT, art_01M5Y8H7D84MYD9B41XJNA99CS |
| node_01M5XX0REWSZ2P5P86P9BD77F6 examine #1 | 2 | art_01M5Y4F8DDYMAXVBEDED3NYRYJ, art_01M5Y4F8RCFDBA41D2JWMPR6JN |
| node_01M5XX0REWSZ2P5P86P9BD77F6 examine #1 | 2 | art_01M5Y4N4S833RNPG53JRT54E29, art_01M5Y4NZJ1K6E7RZ2MYRPN099V |
| node_01M5XX0REWSZ2P5P86P9BD77F6 examine #1 | 3 | art_01M5Y8Y8PWJV9DFNJ8Y2QA3441, art_01M5Y90P5QZXDQN3H12DCX0EA7, art_01M5Y90PJ71DFEX3QKEBZTVMB4 |
| node_01M5XX0REWSZ2P5P86P9BD77F6 work #2 | 11 | art_01M5Y93GP8Y92P6B9XFFVV024R, art_01M5Y95P9CKXZTNG2P908SKRK5, art_01M5Y9835SCNSS9S7QDJ5QT0BW, art_01M5Y9AV2B8YDWEZH38ECA8TMJ, art_01M5Y9DGAT6E8NAZQ2B1009C4E, art_01M5Y9FDHVX64NNB63HR9K8QG1, art_01M5Y9J5EBVA2PBJM48BTHE4FB, art_01M5Y9MF1FVZ8F2HQXQ4ETTB3W, art_01M5Y9PQXX09HX8MYT9PMDRF0Y, art_01M5Y9RKWHGXMX5MBFJVEWA6MH, art_01M5Y9RMFMVCB0RGF7BVERZCNS |
| node_01M5XX0REWSZ2P5P86P9BD77F6 examine #1 | 2 | art_01M5YA5N189XJH52N68WZ18MPT, art_01M5YA73TBXFTMJCXZJJ8SYFQP |
| node_01M5XX0REWSZ2P5P86P9BD77F6 work #3 | 15 | art_01M5YA9Y6CQDXF20B2QJBPZQRR, art_01M5YABS22RE5237Y2F0VF4HNX, art_01M5YAEGNXW12E4ES1VZHQ7RB7, art_01M5YAGZ31C7BWRKXFXP2KD1G6, art_01M5YAK35GXW4NQMJ4EXYCCCSC, art_01M5YANV2103R6S90WEEETCG6P, art_01M5YAQWT4Z8S8YWGX93RHSZ5K, art_01M5YATDHHK2NG9WT4XNPC2ZS9, art_01M5YAX2V4DCPN80FN0QVV820D, art_01M5YAZ011GCWRVSMEM580QR8Y, art_01M5YB1DHAR8S2NPQQ39N51MN5, art_01M5YB3JGJQRBRWHQD8QWXS2T9, art_01M5YB6AD2DK5APM09JJY4SMD3, art_01M5YB8B8JBJSJ5YBBFTK3ZMBW, art_01M5YB9JSRB2R1BA86NH4JH76N |
| node_01M5XX0REWSZ2P5P86P9BD77F6 examine #1 | 2 | art_01M5YBNW87G2CBVS6VH6X822M3, art_01M5YBNWMH8JEY45Z4PZ9ATH69 |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV work #1 | 28 | art_01M5YBRN1G95A04Q5BPAQ1SJ7E, art_01M5YBTK6TD4A7DRBK5CSA29KG, art_01M5YBWRY55XGGT6EG9GMH5HB8, art_01M5YBZ5PC6K9EVKBC7EAG9JGE, art_01M5YC1S4ZD1XSTPB2THP50BV9, art_01M5YC3R5X0ET42Y243NDQFFPW, art_01M5YC62WYQFRWKEH0XGRHDQ4X, art_01M5YC8ANDN4A2PYYKZ01KZAMA, art_01M5YCA8QEZATWN6ZHTR09CJAH, art_01M5YCCX4YK68V83P28NKDP36V, art_01M5YCFN1E8GH60T22PWATJQR8, art_01M5YCJCY1AY2M4E5NV78V9W4Y, art_01M5YCMGXZRKTG3DENW8B9MKEC, art_01M5YCPZDH5P2F2G41PKRNMWBR, art_01M5YCS99X64TX6ZMZT1KTXTDM, art_01M5YCVHX1411Y4CZD1T3SAR6P, art_01M5YCY9SKKXBY37NAAR2BKBQD, art_01M5YD11P4P2RER9K4RXGY4244, art_01M5YD3KEM5F010JZRS3KY9SWX, art_01M5YD5M5M2YQ8MFYWMVV13W5B, art_01M5YD8C24TJTQC1K0W67SRY1F, art_01M5YDAH6BM9YHMQDBH8WME3B6, art_01M5YDCYHP01S19TM3E71Y9B8P, art_01M5YDFPE84Y3FMSGP8DDZVJVM, art_01M5YDJEASRMDAZRK1PF7Z1ZHN, art_01M5YDMX9HMZZ2Z80C2BANSMZX, art_01M5YDPZQ0AHC9TGPERD4HXVA5, art_01M5YDRSQ8BZNM6CW2BCT5A07J |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV examine #1 | 2 | art_01M5YBZ8DH1N0MCJEVWHX7H2MN, art_01M5YBZ8MSZNREYV9E99WQHD2J |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV examine #1 | 2 | art_01M5YC4GV19PBSE01EFNKCE297, art_01M5YC4H79AQV94J17WDK5J3FQ |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV examine #1 | 2 | art_01M5YE5ZPR6X05EZZRHSA23V1E, art_01M5YE6RA89RCGHTH90MF5SAN0 |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV work #2 | 18 | art_01M5YE914RQMSDYTCYEG1F4ASE, art_01M5YEAWQ35BCMP9FH321WVXQX, art_01M5YED7KVSRRAWG9K3AGFG12F, art_01M5YEFZGCBXK416854E3H50VY, art_01M5YEJQCWHKBSXAHK7FBKRXT2, art_01M5YEN7V33KKJ106ZZ41EYQAW, art_01M5YEQ9WCQVFC01ZFRQ5M5N7J, art_01M5YET1RXMEE6HDTXKK9MM7WB, art_01M5YEW6HTJTQ7171WKA4E3X91, art_01M5YEYM8E4AYFQQ61DKVAQ386, art_01M5YF0T1D64TTM5K3A661G0YC, art_01M5YF2PK689T5B9XS03T113D5, art_01M5YF51B1YB1H1TXA2HX64YYK, art_01M5YF7754G843VTCQBTV2B0MG, art_01M5YF9KTHQWV9Q1AAYB8FSX6F, art_01M5YFCBQ2JF6W13T856AN061R, art_01M5YFEHJP484WKW4C96H4NHQ1, art_01M5YFERC8ZZR4XYGZ0ATVK6G4 |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV examine #1 | 2 | art_01M5YFW12J7A7X833ZM51Y828S, art_01M5YFWN7JN4KTEQY5KVN7TRAZ |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV work #3 | 10 | art_01M5YFZ806WSKF90GYBQ14P3VQ, art_01M5YG1A60W5BN6SEHANGXGHYS, art_01M5YG422FE0X4M6Q2CXTK5QBD, art_01M5YG63RQD12H031535TFPPD0, art_01M5YG8MJ23VY0N04J04GZREC0, art_01M5YGB9TJBTBJAGARCVY2B5KS, art_01M5YGD71HVEK004KQ4TQ4A2HJ, art_01M5YGFYY24Z09HK0YP91EK2W8, art_01M5YGJ7J3GMZ5TX3ZY61GH97D, art_01M5YGM2GH3RX730WH3AEJMZ6W |
| node_01M5XX0RWKCTS8MC6YQ1BH76NV examine #1 | 2 | art_01M5YH12SV1SE5ZAWF4E69HNCJ, art_01M5YH1336CD4HAA379SVRE1SH |
| node_01M5XX0SDM7N8NG23QFEMPNDRW work #1 | 57 | art_01M5YH33N15BYZS8E4MEX9Z43A, art_01M5YH516FSBWQ7VC0E5PRZSGZ, art_01M5YH7KZ7S2RHCRHYV8GV7JGR, art_01M5YH9NP60KC6Y8MDCHBYR5H2, art_01M5YHC0XAVCS9Y9G6K43TWFA3, art_01M5YHE11TDMB0YDVEYDS5QWW0, art_01M5YHG1VPY4YV48P046XVT68X, art_01M5YHHXEFJN3B742X6K92C85P, art_01M5YHME4E8C6PKAM8D1NEYSV4, art_01M5YHQ4FJV2D8ZQM46P2ZYAQP, art_01M5YHS0KZ8F7BMJ6A00DN149W, art_01M5YHVRGFWC1WMNP47ZTAQW8N, art_01M5YHY26PE6SXTJT4AJB081TN, art_01M5YHZYRPJ2G3QM0ANKXNDRBZ, art_01M5YJ25K1APVCQZZ9SYFRKKP6, art_01M5YJ4XFH9A3QC6WZM6AABVXT, art_01M5YJ6XG8T7093510X7TC2KP8, art_01M5YJ9FZ0H7296BMCKJP1MTW3, art_01M5YJC4HW4BWYR5RER53DJKC4, art_01M5YJE2EJ36YXTFBAZZHVEF2S, art_01M5YJGTB4KKVPF2AGYMGJY7G2, art_01M5YJK2A7CD90EMHHCYXZ5NNN, art_01M5YJNCTPS867KMV4FH32W6DZ, art_01M5YJR4Q6WPMP8CB0X5S2XHTR, art_01M5YJT01PK5APST4GGNHZX543, art_01M5YJWQ6P202BWXDC2GW29C9A, art_01M5YJZ63DNHYRB1HKGV4KBFJE, art_01M5YK19PD2CTM3X45FGVMJD3G, art_01M5YK41JWQZJDAH179ABRYPX0, art_01M5YK63TWA6DY0DTN37DXYB8T, art_01M5YK8M2DNNEY2XXHYWQCCV8H, art_01M5YKBAVPYXW77NK6VHPVYPZW, art_01M5YKD6HY2QZF12H7GQKC4K10, art_01M5YKFYEFQFKAA3VJR7TN8E5C, art_01M5YKJ8K54GVWKWB4V1J1YJPQ, art_01M5YKMGY0387BH8MF39S5YVSR, art_01M5YKQ8TH5FQPTA9FQBE29EAK, art_01M5YKSE4ZSTRNR3BBG230K3X3, art_01M5YKVVA2338B9DYFFJV619M0, art_01M5YKYK6NGEHDFQ8HY83GS0BM, art_01M5YKYKCKQN1S5YBD985VB9J2, art_01M5YM1B36S3ZNTSJ291VJVZFZ, art_01M5YM3T9EBD6Y8P2X5S4Q9F85, art_01M5YM5XJT4RVZ9VZ2W125AM5V, art_01M5YM8NF97WJFY82GZD6ZHBKC, art_01M5YMAR091CVH3AKZXJ72P5V8, art_01M5YMD7YVH2PKXP4RP52DXGF4, art_01M5YMFZVBY4P04ZH2A8H75SFM, art_01M5YMHYGY76EYMB5657KHTS0P, art_01M5YMMJAV3XD47602NHBMXE0G, art_01M5YMQ5H6SEW7RBRD8WJZN3TM, art_01M5YMS4TF1CH4XPRVGSX83F1C, art_01M5YMVWQ2BYAQWGAMGG9W1RGM, art_01M5YMY38GQHWZ76P2QK7P444R, art_01M5YN0F6JH9RBX0Q9DPN26B5M, art_01M5YN3732836ZJJ9RRSBQTBKK, art_01M5YN4YHXKGTEW6YEVQVCRY0G |
| node_01M5XX0SDM7N8NG23QFEMPNDRW examine #1 | 2 | art_01M5YH9C76G776VE2TG3NJ5YWQ, art_01M5YH9GKMNRBSGXBK52FJXS9V |
| node_01M5XX0SDM7N8NG23QFEMPNDRW examine #1 | 2 | art_01M5YHE3HFTATV95PFAC06ED7S, art_01M5YHE3SDJCEQHSVS7KBVJBDH |
| node_01M5XX0SDM7N8NG23QFEMPNDRW examine #1 | 2 | art_01M5YNJ9QY0YP2FCDKN6W0NBR6, art_01M5YNK8E4ZAJCHH68JRZ9TX0X |
| node_01M5XX0SDM7N8NG23QFEMPNDRW work #2 | 9 | art_01M5YNP37GGJCKK9PTE5A94YC0, art_01M5YNRDS3Y05VE90K49CVVEW8, art_01M5YNTNQ08BVFNDAR182EY3F8, art_01M5YNXDKGK3W088G6Q8756SKW, art_01M5YNZJAR5SCS9S7XJ4GCHAVP, art_01M5YP2032T9WHKFGWN73FQYME, art_01M5YP4QZKZK10KG5WYSRK6WAQ, art_01M5YP6MXVK4W6RJ40DH6K5E8E, art_01M5YP70ZXJXC1BEQE85R5BGY4 |
| node_01M5XX0SDM7N8NG23QFEMPNDRW examine #1 | 3 | art_01M5YPMC0B42ST1QSPGEQEE5A4, art_01M5YPPRDVZGZHFVEWJF2STQWZ, art_01M5YPPS6VKZKMM19KEEAP2KG5 |
| node_01M5XX0SDM7N8NG23QFEMPNDRW work #3 | 6 | art_01M5YPS9974NP5190Y0JVZ760E, art_01M5YPVEB21MASQR9MHBE2YSN7, art_01M5YPY67JSH59AAQMS5AYYY3R, art_01M5YQ0615T8210QA20R1PVASD, art_01M5YQ2RQ20ZAQEHAZ8RMSDPBC, art_01M5YQ3R7S4T9WN815Q0PQ8C1S |
| node_01M5XX0SDM7N8NG23QFEMPNDRW examine #1 | 2 | art_01M5YQGW2E1Q2DCRC5R3A076X1, art_01M5YQGWBZ6F46EJHMEVMW98YE |
| node_01M5XXC2V5H737X2RG4KNCAMXW work #1 | 10 | art_01M5XXDZG4WE15QHQV3RGY20Z1, art_01M5XXGQ6K45Y8XPB9HAKNAYS4, art_01M5XXREGH87XNM4TNRJT8JKJN, art_01M5XXTD15YB60EW6TXM3KSWSR, art_01M5XXWM25B9MKTXGKWHPD14C8, art_01M5XXZBYQRD3RPDG5EGVDT5AD, art_01M5XY7KMBME48VM5ZXQDT1FPT, art_01M5XY9NDGS2PB47YAJTNNVYF1, art_01M5XYC63XJXN43PYMQJQ7QW1H, art_01M5XYN1EZ2CF0DJ25GPSFMSQS |
| node_01M5XXCD2EET6Z3QPPHE5624E4 work #1 | 9 | art_01M5XYPZQ6YJN9YJWASQBM5279, art_01M5XYSPE2ZSN5335SJTH46T5J, art_01M5XZ1FQ25S5M3FCS15PS3RHX, art_01M5XZC0C8F5XFHR32YER7D8T8, art_01M5XZGJVWFBD0G90BMQQTX7FP, art_01M5XZKARAMQVAH46VS4N5NNDH, art_01M5XZVJDX675PWM2FVGQVCDJG, art_01M5XZYAAEQXQYYY0XQ273MWEE, art_01M5Y06ZKMSBV0C8KBNG4604A8 |
| node_01M5XXCH3Q22KHZHYPEZD1JQ17 work #1 | 3 | art_01M5XYQX2KSHB41FVJMS6KDMX2, art_01M5XZ0ZB8AZSVZZB82STFEGPS, art_01M5XZ13SWZ1FFT1TFKWHMF19P |
| node_01M5Y0PD91Q45FJF4J8Y0N1WBY work #1 | 6 | art_01M5Y0RBT5RQSVBESG0NHKA1S1, art_01M5Y0T9BG3TCSGVWK157AACDH, art_01M5Y0W4Y919R3PCVT0STXYT53, art_01M5Y0YPRSP4WF61T8JA73GHYY, art_01M5Y16TTCWZZ273AFCQ6D92B9, art_01M5Y185ZYN6XQNKQS69WHAJSP |
| node_01M5Y1NTS29A28RP66RBAD955K work #1 | 5 | art_01M5Y1QR7JH5F9JS0QZC75FFHB, art_01M5Y1SKTG249X72EQB3RYJ40Y, art_01M5Y1W9J9STRAK4R7VR7M095C, art_01M5Y24Y752T88E9EBGPPVSQV4, art_01M5Y254FM1JXPXHK10NSE0W7Q |
| node_01M5Y2NKBH0HQZXK9W5VEEETZ5 work #1 | 5 | art_01M5Y2QJRPD1X829W0HM08HNZG, art_01M5Y2SFAPJQQ8P05P1V9GJJHY, art_01M5Y2YT17SRP2SE31E7A2Z41Q, art_01M5Y37CQZXXGY1KCZF7G823FN, art_01M5Y38KMMNH5BG9TYDP73MMN6 |
| node_01M5Y4QRGZN9F64RE07QEPB4P3 work #1 | 15 | art_01M5Y4T30FVWNCFYATWC6DMH4M, art_01M5Y4VYKF812PW51WJ7JNE7MP, art_01M5Y4Y7KR8Q3KH0RMFXWCQTVP, art_01M5Y50A9NH69B6ZTVXY146D78, art_01M5Y529SAGJ7TFZB51J0FKY7T, art_01M5Y545CGDHA64MW34NP0Q1W8, art_01M5Y56F9A3ZE88GYWNCKN7Y6W, art_01M5Y5EPYXBG51V2VNYV58Q5RZ, art_01M5Y5PZ2CF2G4ZC553GQNH4AF, art_01M5Y5RXK1HANP9S4ZJXAFZ8HK, art_01M5Y5VH409J7M9VM08WTC0EVG, art_01M5Y5XD6GPZ8RMVS6FRJ6DYDS, art_01M5Y5ZBQ7S8ZQC8WXZW16V6DW, art_01M5Y617A6WTYB481WT4AV62CH, art_01M5Y6C172F10Z3KAB9Z3D1S1E |
| node_01M5Y4R4QHCR8GM5M32BC29ENE work #1 | 5 | art_01M5Y6EA3ZBH8HQKSZKWBSE26Z, art_01M5Y6GDGQJ5YA1EKAZYFYFARX, art_01M5Y6JGPCRCVQSW46ARMJ1WN3, art_01M5Y6WBEFJMTAQFHYGSK134WV, art_01M5Y76P4EDQVZVY74JTZ5AZRM |
| node_01M5Y4RNNHWSD78YFYMYK3Y4DT work #1 | 8 | art_01M5Y6EWWJC31VX8WQM0WA466F, art_01M5Y6GWJYT9Q2D55048GETKBT, art_01M5Y6K3X46XBSXBAYW4EFRC5G, art_01M5Y6N0EZDBDWZJ1N47KW23T0, art_01M5Y6PX0WSPQGYZ78V209WDYG, art_01M5Y6RZ56S7V3VTXFD78MVP6M, art_01M5Y71D1E5R8DZPHARBA45WX3, art_01M5Y7BWCN37ZS0F6HT85JGWDT |
| node_01M5Y4S7HQABZFBFB0PABS4X1A work #1 | 7 | art_01M5Y78Q6MBM57WQ63YHYPEDK2, art_01M5Y7AVJMMNWTJCBP7E24873T, art_01M5Y7D2WH6878Q70RQEWXAHAS, art_01M5Y7F04PNG71CG9F3YX6J8KP, art_01M5Y7TX07BPZXHVCZEJCAK0JA, art_01M5Y825T4KXCQ4WB6CZAJRF89, art_01M5Y82DBMS4K3S0MQ6KTT2JE6 |
| node_01M5Y4STS9C7C0G03FZMFNS8F9 work #1 | 8 | art_01M5Y7DY5J22V09GDQ883B6BJT, art_01M5Y7G1J4WFM27RMHV3QSXCCS, art_01M5Y7JBJD7CG00PNZJ07P43MA, art_01M5Y7MM2BGG41BP02VG7SW8VD, art_01M5Y7PY1XP5G7VEBPZ40QPQK3, art_01M5Y7RSWQ6K246NYZHSBC361Y, art_01M5Y84NGQMNZXBSHJX6H4KCCH, art_01M5Y8D98K0YPVEHYB5NHKJRSE |
| node_01M5Y4T2NCHX20B69TP5SKC1JQ work #1 | 4 | art_01M5Y84M1S6Z2DWQQMMDXB74NX, art_01M5Y871ZBGM37F9YKYY39SNBJ, art_01M5Y8FSGRP42J0YKDBDGW34F5, art_01M5Y8FZ49HKF2R2ZFRX7HSHJV |
| node_01M5Y91N97GTAABSRAT5N6A8BN work #1 | 2 | art_01M5Y94EFZW84VEQZBXHMM5V9Z, art_01M5Y9DCDFKE813TSBMREG9GMZ |
| node_01M5Y9229PJ6R503BEJ58GKS7E work #1 | 5 | art_01M5Y93YWWR0QX7W04WWSQ1ZTF, art_01M5Y96PJPYC7DRRCE8293QYXF, art_01M5Y9GRV86YZBMQ6FQG28H8ZF, art_01M5Y9QQVEJ33FSAQYE9W95W32, art_01M5Y9R0402WZ1CBV36DAFCB4J |
| node_01M5YA7XCMR9JNB28Q957VKW41 work #1 | 4 | art_01M5YA9VT5Q1WADM3TZWGH5A0R, art_01M5YACHH0B1T0Z9DKN6XSWFAZ, art_01M5YAPKSH8BHF2A3JDJ5ZA0T7, art_01M5YAZJF8ZSYYNSRR34WZZXPE |
| node_01M5YA86NWBE7QGSRMQQS1PE17 work #1 | 5 | art_01M5YAA3918Z9Q2GD7ZAAJQH81, art_01M5YACTZMWPP64VHK0FTQ5SG1, art_01M5YANZYQTH330XC7GBZ0NHAF, art_01M5YAZ4XRTVP1EAJ9NCJDE3K0, art_01M5YB8WW2Y617Y89GVFR8J4F8 |
| node_01M5YC5TTC9ZPPWKYTT63Q9KGG work #1 | 3 | art_01M5YC7YCX6THWD41J8YR0PJ70, art_01M5YC9VQK7QMNARNQZEXF5BJA, art_01M5YC9Y3W74CPCAPNXJ0G70JV |
| node_01M5YC61F9MQMVAFCZX5WGX7PA work #1 | 6 | art_01M5YC80W1DHJBPZ5S23Y86GRQ, art_01M5YCA39NYJWVMQ17VQEAZ8RS, art_01M5YCCG78XGH0642V4BC14S48, art_01M5YCM0R4QTHH6CX6HFKBN7T7, art_01M5YCPJFYS11VAP4T0K36W8AG, art_01M5YCY8F2AXFZD327YK2CTKYV |
| node_01M5YC6G5WR8SG65057V52AEKE work #1 | 3 | art_01M5YCBVB69GT3BR44G6AD3F08, art_01M5YCDZQ5ABQ3CSZM14R3AD4G, art_01M5YCE5MJTF0HPBSCT75TFMA7 |
| node_01M5YC6XDBYE7XC3QJND6R3V93 work #1 | 2 | art_01M5YCG47570DQHC5YAPE6SYT9, art_01M5YCGT14X6BWQ3MRYJZDGHB5 |
| node_01M5YC76GWWRF5863415WKECJA work #1 | 3 | art_01M5YCK3S7G71024JBGW39CZK0, art_01M5YCN4872KH3VX5X7V3NDGKE, art_01M5YCNC2B7N3JZNGCC07JQ22B |
| node_01M5YC7EM595G27SKSFVXS2HF5 work #1 | 5 | art_01M5YCR4FVF9R83KXAP9WSWGE6, art_01M5YCT0T731SA2PQYYRTDMDJZ, art_01M5YD50C7JMK89WBKNYA7J5F0, art_01M5YDE5B99N5XW26D2J1TG4GZ, art_01M5YDPVA9VTFJNEKTAE8EM2K8 |
| node_01M5YCNNT9BF1C5M82VBNT2CRB work #1 | 1 | art_01M5YDR2E88B2TXCCEE2VQ2S5G |
| node_01M5YE8HWNBREASGHV32W106S3 work #1 | 5 | art_01M5YEAERYXQPCJPKJP26M27ZG, art_01M5YED6ENYPPM4H92HZZGJ6FP, art_01M5YENGB102JFMC134BMTAZC2, art_01M5YER60QM1FC58T4ZS0MCEE7, art_01M5YF0P4PVW0P64TF2QJ2JMKW |
| node_01M5YE90217YR0S0PR139DPH1Y work #1 | 5 | art_01M5YEAWCAE4GFQ7EBJCMCGKXS, art_01M5YECQYT2SS4MXP1C15KDANQ, art_01M5YEFEM9WM6478WQR2DSVMJ7, art_01M5YERC3N9DCV1HQCK01D8XX7, art_01M5YF2FAXAJ3CFJZYA4A5D6S0 |
| node_01M5YF382MDJVCB76MZ7A8BT2J work #1 | 2 | art_01M5YF627CTRMAC3E63J785RYR, art_01M5YFDR87KCWY7BVM76FJY2FT |
| node_01M5YFXC9Q3X4SYSBAG6KNP30A work #1 | 3 | art_01M5YG069QGZCNTF6K0TJXXAEV, art_01M5YG91TNZS9ADDXCXRS9RRZX, art_01M5YGK54QE5103Z8S9P9D7Z52 |
| node_01M5YHESDJQPVHM97TZ68KD6WW work #1 | 5 | art_01M5YHGV3Y8ZMBXYEMGPGFWQ5B, art_01M5YHJQP5EW9MJF8G842NBQP2, art_01M5YHMW2JZAFZD744TK2ZWZV4, art_01M5YHQ33HTD2CMNM035BV8RKQ, art_01M5YHZTSEP4TVBSVDE67NPMNH |
| node_01M5YHF4SV2DVA55JZE6HM2YV5 work #1 | 5 | art_01M5YHH3PD8BBYFA6E3KGPA8G1, art_01M5YHK17VFHA8Z7ZGV9RSZ5Q4, art_01M5YHMWTPN149BY53ADQBG8XR, art_01M5YHQ90YBKZW3QKHSCWW4MVM, art_01M5YHS0W9200W1XJDWYT4V0SQ |
| node_01M5YHFAW131QW8DF7ETRE51KC work #1 | 1 | art_01M5YHTFPBG911B0N76EDSHM9Y |
| node_01M5YHFRXFPTMW57B1HVT2KXA0 work #1 | 14 | art_01M5YJ1TSYR69YVG0HGZ5E0B4Q, art_01M5YJ4AXKJAVD97MXXXQ16P1S, art_01M5YJ67G350ZEWME4S6A45R6M, art_01M5YJ84R3EYYMJG82TNZBFDNN, art_01M5YJAWMKJYVHA5ZQ59AGPYA8, art_01M5YJDMH6XM83YSJM9Y4T0769, art_01M5YJFR9WC8PK3NSM8WV96ZZY, art_01M5YJJ70RPE1JC4AXT83FT7GG, art_01M5YJMDRXRT3WQP0ZFMMY4JPS, art_01M5YJPC99GD092YBSR01KDN0H, art_01M5YJRM3ADXTPVEY73HNRZSJ5, art_01M5YK1S2ESVNCHRZK6J523VCZ, art_01M5YKCRMGAG6DA007JFF5J5NC, art_01M5YKNV57BHFPMBXE4N081691 |
| node_01M5YHG0YX68SVF78ZJ563S9B9 work #1 | 9 | art_01M5YKQT8Y81C7APC6CTYEQP18, art_01M5YKSPTVS7BSTHPFCAEDGX81, art_01M5YKVMC58F83G7SDN6Q51QNG, art_01M5YKXVP4TJFDHGCPBBFCYGCE, art_01M5YKZZSM6KXWCTVPGGQR2M8A, art_01M5YM1YKH4AZ5Y0MJZ02H575Q, art_01M5YM4J9749YFF9D84XCJ71PN, art_01M5YMDQ8BY95JENY6R2RC6QYD, art_01M5YMDXDXPCC9BC72MDVN7S7Q |
| node_01M5YMEBMC9AJSK8KNPV5CE90R work #1 | 4 | art_01M5YMG9QJY8XT74F94GEYHC3Y, art_01M5YMK0DHVMDW7M72H68JKGN3, art_01M5YMW5CNH22RM5XYQV9X9SQ4, art_01M5YN49ADBYP6Y4BRG2ZT25SD |
| node_01M5YNMENS4RZPEWWD2CPWDB4D work #1 | 5 | art_01M5YNPJ055CPWQF9GE1ZTYSZG, art_01M5YNRDK2WV0TYP4R207AYR4Y, art_01M5YNTKXBPCC0G2GM52CRQ6GZ, art_01M5YNWR1HDKEJY38535BJRXKX, art_01M5YP68B6ST0NJYWAK480K505 |
| node_01M5YNMPBNXYWDMJ544HHJ9PE1 work #1 | 3 | art_01M5YNPPQ5AVS8DJBVHQE16PKX, art_01M5YNSA81ZK5CMGHB73P9NPA0, art_01M5YP1X8ZE7Y9HC4F8NRQYTV5 |
| node_01M5YPQE1HQCH2ZYT1W1FQZXM3 work #1 | 3 | art_01M5YPT7RMR0FEP5P86Y139Z4B, art_01M5YQ28VWM1WTBDQ2JJQCK280, art_01M5YQ3A1VA1GPC4FJW8CJGGCR |
| node_01M5XW8F0TTNDRM5MH0DKRXDME root #1 | 354 | art_01M5XWFBWPGM361E9CK3ZKM1FQ, art_01M5XX0RHCZP6T832S5BH4A3EG, art_01M5XX2N7JSZ28KRJQHBZ1SWRP, art_01M5XX5B0ZNMJ087RY496C9X56, art_01M5XX7XC49M5D7NF3AJWPZQYW, art_01M5XX9XGKEEGGA037EQY48CRN, art_01M5XXCND59MR1AMX3W3KA6V1E, art_01M5XXEW8RD6BK5RA6VFJXQQ8Y, art_01M5XXH7WRE6D89N20XRCJ1BJM, art_01M5XXKZSB2ZZ7C1B0095V163A, art_01M5XXPQNTWG58W7X6RK54V0Z3, art_01M5XXS7KM7WE3KYQ7D4JMEVP7, art_01M5XXVA5BEAT8FGGY1QPY9WNV, art_01M5XXY21TN2JQ96VC1BK6V8B2, art_01M5XY04GDZ70QHM2M217M0EP7, art_01M5XY2MHE4W92V4578C7T7F4X, art_01M5XY59PDZ79DMQBGX8B340YX, art_01M5XY7712JYKADZAQ8TH1E4WS, art_01M5XY9YXPBCG39X263H21K6VT, art_01M5XYC6KE6SK2Y8KM53HJGHT4, art_01M5XYEHD9EF0TRVBW6XFJ80S2, art_01M5XYH99V19MNM8SZWJZXNK3P, art_01M5XYM16CHKYEHS8K1GZNBHRN, art_01M5XYPHZ12JVYB574S3WSCYN9, art_01M5XYRKNZ23BNV5Q76MDGVWA9, art_01M5XYVBJER3FQXJHSHAAVTFQB, art_01M5XYXEW3MBR5N7CB3RXSB1MA, art_01M5XYZY20SHH6KKG86XYE5F57, art_01M5XZ2M25HFX4HWPRXY5P5W36, art_01M5XZ4GHM8X9R0F1NX3NZ0GSC, art_01M5XZ78E563Z6SE9Z7T3HRFKS, art_01M5XZ9GYS97YMVVE5VA0731T7, art_01M5XZBTXV29Y4AJTZERBQXVAS, art_01M5XZEJTBJDQVMKY2JNN52N81, art_01M5XZGEV3DBG948T84KB99ZWR, art_01M5XZK59Y2EH01ZCH5M3FCSY3, art_01M5XZNN0HWKHTWYEAMYV2JF3C, art_01M5XZQQSDYNZ9C0SG4N3N01JG, art_01M5XZTFNZB7FNPCSEFQ09T9TG, art_01M5XZWGY9BPD6GSH2KB2T0VAF, art_01M5XZZ25GY5H0Y5D7W4RYCH1Q, art_01M5Y01Q3QANVFBTT8EGMZXT1G, art_01M5Y03MN3H4YVXXBJY7AG5D6W, art_01M5Y06CHP1QCAS2K3J0BSR5H4, art_01M5Y08M0JGG8N52J5HRJB4M5Y, art_01M5Y0AZ1BD25G7ZH4X9HYWVDR, art_01M5Y0DPXXQ367CT2Q1BBGWD9J, art_01M5Y0FHWBJW2TSBV37QA7KS1H, art_01M5Y0J9DH005CTTBWKXF7C5QW, art_01M5Y0MS1BVS30F1QAZY3DPGPR, art_01M5Y0PVX5JPPQD64PXP1E7FJJ, art_01M5Y0SKSR63WXWEQ5R5MYZR6K, art_01M5Y0VPYE02JZFMH72885P737, art_01M5Y0Y698B950D56848ZJJJG9, art_01M5Y10X41CM3PHJQRP3Q1VJJZ, art_01M5Y12RRR7TT5DMDKMS7K81M9, art_01M5Y15GNC524HF1G3M2VTAQ32, art_01M5Y17V0GY506BEK8RTTAHSMA, art_01M5Y1A3513ASVN4M9NYAJVBXX, art_01M5Y1CV1M55MB8NE2VX3R4AVJ, art_01M5Y1EQX6H91M03YE64FD7SRB, art_01M5Y1HDH8RNZM0Z8HW6SRXBBY, art_01M5Y1KY2B6HM94FKNGAJXCCTK, art_01M5Y1P00Y0710XV0MXPQ301D7, art_01M5Y1RQXH74NSSZARH931C9Y2, art_01M5Y1TV05CYGW5C4B9QYQ7ERQ, art_01M5Y1XAD3V4SCSTRRM5ZPR1WG, art_01M5Y2015N8309MKY2CCFXZWKH, art_01M5Y21WWJP540XENJKSB89X3N, art_01M5Y24MS562VS51KPF0CB5GEP, art_01M5Y26X3N11X2VXXTDGB8N8CW, art_01M5Y2978VE6DYJXB1MHX67EYK, art_01M5Y2BZ5C4F6DNNGVAS3E0338, art_01M5Y2DTZRJ8BBYB1QNZ3883CK, art_01M5Y2GHN39DARQA8SA8PD5G36, art_01M5Y2K15JP6PAQJKC18RDSXTW, art_01M5Y2N44QB4WC8RAAYP0V1N6M, art_01M5Y2QW18M64BXAK109SNJVZE, art_01M5Y2SY3837BP0CT3282QCAN6, art_01M5Y2WEGSRCZKSBDCPTB0X17Y, art_01M5Y2Z48ARYQGWF7J4EBY1B16, art_01M5Y3110AN3VWCVYMBBR5XQR1, art_01M5Y33RWVNJ79SFHAGDYNMD2M, art_01M5Y3624ZAJSNJN3F8PAPHMTK, art_01M5Y38BCG0PTM5DN7J3EWMZXH, art_01M5Y3B392Z70GWK2GRNN9TQ4V, art_01M5Y3CZ24JA4GVS1A8A6ZEFWB, art_01M5Y3FNRRFHP3KCZW8SKTQF1Y, art_01M5Y3J57A478PG9AGAGYBVNT8, art_01M5Y3M88AF9JA0S5ZJZ7YJ996, art_01M5Y3PE2JHK1JGJC5YMMNZ7FZ, art_01M5Y3RTR0Y15C8NP5EPYZ5BHG, art_01M5Y3VJMHN085W9CK796QZFHH, art_01M5Y3YAH28DHTVFEP1XD6EDZR, art_01M5Y40SFR1NX5KZXSA2GFQY18, art_01M5Y42X0MGYR5ZT0Q46C15A9D, art_01M5Y45MX7CSH89F8KZ8ANE0TQ, art_01M5Y47PDTS7ERJ6S7RPB1H7M3, art_01M5Y4A7CYZF255HQ0ZBXB1BQ0, art_01M5Y4CVN0R7AMAFMPP4W8FF0T, art_01M5Y4ESWJG3YYY88WN3BPX6Z6, art_01M5Y4HHS2G32EG9CN2MP9ZCV2, art_01M5Y4KSJ0R1VRXD1N7TY3ECMN, art_01M5Y4P48RS00MJ8HQQ9CB4TJC, art_01M5Y4RW58YW6QRV4DGS7TSDWT, art_01M5Y4TQF7816HE25QPWJWMQB6, art_01M5Y4XEMT0ECQNF51MCV9R37J, art_01M5Y4ZXN97KSSKVEPRW7DJNWP, art_01M5Y5214DJ3KXVWM6HP1FT4M7, art_01M5Y54S107GBSCF5J0F7YSS23, art_01M5Y56TK3ZYT9PDPK27J56GR6, art_01M5Y59BGPTJ1B81XE8D2Z8BKR, art_01M5Y5C0R03HFCGR1PQ25RXJQ0, art_01M5Y5DY0ARKTH5KPHHPQKPJMW, art_01M5Y5GNWSBD7VRD9YBV2CAYZC, art_01M5Y5JYM3DY8WG86GP7WTM5WM, art_01M5Y5N8CAKZT4EQM0EX49WFQ4, art_01M5Y5R08XQEWNVSR11AKPDRHX, art_01M5Y5SWG90Z7H8V5DNMY238ZZ, art_01M5Y5WJRGTXV3M6ETA6JQ8FGN, art_01M5Y5Z2P8SVVKCSEQBWCYYC7F, art_01M5Y61582BX1616ABBV9MZCAK, art_01M5Y63X4MRR9F0WM0XSBZXM6J, art_01M5Y660JSD6EFHPKAFE907C90, art_01M5Y68FM8YRXFNT5W315RHE8D, art_01M5Y6B6R1WC5731R1GAHKZ757, art_01M5Y6D23V5T6A4TG5GFZENX83, art_01M5Y6FT0G3T0CQ0VAQX3CH0X1, art_01M5Y6J3NN9DEWGDHCXVGGXBHW, art_01M5Y6MCG24TDW5PR5E4F1TMCK, art_01M5Y6Q4CPQE3CDZ6VDEWY5J5X, art_01M5Y6S0JG5RJPGQRBRAHBB1ZD, art_01M5Y6VPW6WYVJ990KZ0V89APP, art_01M5Y6Y5R7ZSNZWWHX4KHRY8JN, art_01M5Y709BQSCFKKPPT76HXVZSZ, art_01M5Y73186R15ET2PXKHBE99ZT, art_01M5Y753MDSGNY239YY507FFFJ, art_01M5Y77KQSNE68CTA47SK02F7A, art_01M5Y7A9S9J0QZ9Y4N52G62QXN, art_01M5Y7C67D80XCNJC76AMF077W, art_01M5Y7EY415GYJHB4HWBQB6WGZ, art_01M5Y7H7NYA55PDZ69HEVQY1RE, art_01M5Y7KGKK4MZXD6X5JM2S6PHC, art_01M5Y7P8G4B2MNH201406NJFSC, art_01M5Y7R5J0D8JZVBVJBD620C38, art_01M5Y7TTZNGC40E0P5HWBJENG9, art_01M5Y7XBQ9FPE607XSJKT34K79, art_01M5Y7ZDF7ASSY8CCR6ANCCZ2Q, art_01M5Y825BQ49VPA7CP9CFZR3MT, art_01M5Y849KHYJWHBJNMMEXQNW40, art_01M5Y86QV7VKB7CV3WQVSWZ0F7, art_01M5Y89FQVTDDDNVYE2M30SWZ2, art_01M5Y89FYC5Y6G6PCV9D6Q0K09, art_01M5Y8C7MD2ZGY37HVRCA6MPGG, art_01M5Y8ENXF35M41JEW7Z1R68MP, art_01M5Y8GT405801XHXCW8RJFYZ5, art_01M5Y8KJ0K9SHQ0QPSYJYAV3D6, art_01M5Y8NMSB464CRXZ3T2H2STHM, art_01M5Y8R4G6FKNXP0XV7QS7HNDB, art_01M5Y8TTYRDEESCQEJFJVF8YQ4, art_01M5Y8WPZQTZJDPTEF39CW8BZQ, art_01M5Y8ZEWA4A7AY6VSQWBYBAY6, art_01M5Y91TTB9N7SPNW6DCR760NQ, art_01M5Y941BYC0WFKYSFBM3H6R6V, art_01M5Y96S8C1MQ370H607RF0V41, art_01M5Y98RPTF27ZHDFE6W09FDMX, art_01M5Y9BBQXHVN5YATWVQ1H3A17, art_01M5Y9DYVYTEC6P9WKDEWGAD5C, art_01M5Y9FY7FRS3BTD7755FAV01Q, art_01M5Y9JP4210HPN0BP79YTG3PD, art_01M5Y9MWQY2E7S730SY9XKHMHP, art_01M5Y9Q8KRMNPYE6W7M6A3KAMF, art_01M5Y9T0G6S5FSKEE005N9RXG7, art_01M5Y9WRCRBKDQC51AM35T21CN, art_01M5Y9ZA1NZCTNFKAS07F9ZDH1, art_01M5YA1AW96HXNE3K2DBNH8EBG, art_01M5YA42RWPCH3YYR3Z4J2GT9B, art_01M5YA67YB4AVH4KB84W5WV1GV, art_01M5YA8N8DRH8ABMR6BX36CTZ1, art_01M5YABD4WJFWXBCKY2APVQ586, art_01M5YAE51G33BQ7CV2XSAMAE0Y, art_01M5YAGQ70CQ85SNBYVTZ3EZ21, art_01M5YAJQH3E2YTAWF817V0RA34, art_01M5YANFDP9X4SBMAZNTFPH9RT, art_01M5YAQN2HBH7BCAK2DD2DVA22, art_01M5YAT1X8HZCMEX05471NZ3TN, art_01M5YAWSSSS79RPP3Q0SCN8TRS, art_01M5YAZHPASTG9J491RW5TBJ7Z, art_01M5YB22BYPE0YD9YXG4Y8TQNJ, art_01M5YB445XX91Y1VF7X39VZZRS, art_01M5YB6W2DG32XXYP5GYAQHR3H, art_01M5YB9081M51EH9KRKDTJK3SG, art_01M5YBBEHXC80FZ7X82CD58FD7, art_01M5YBE6EDPVSQE29W3W9WVJHG, art_01M5YBGYB26WD16XF4NAX5X4E5, art_01M5YBKDHY57B3F20RWC02H7CK, art_01M5YBNGTQN135R7CDEW4FCYDJ, art_01M5YBQRBY6W888BBD3GKDJANK, art_01M5YBT3AEVB8J1C0B17VJCGX4, art_01M5YBWV72Q21KBPWBDKRC7QKT, art_01M5YBZK3K0QY112K44BA8Q00P, art_01M5YC24QPNZ422TC9JT7Y8DQT, art_01M5YC45K8TC530EX1T0GHEMWM, art_01M5YC6XFS6AZ9GYCS14MR5GG2, art_01M5YC92NAR3AQJ2CN2J8N3XR2, art_01M5YCBFZAD5GK15XX58FRJRDQ, art_01M5YCE7W3GS2Q432JEFRXR3MG, art_01M5YCGZRD6JBSH2BX38BVD6F6, art_01M5YCKEZR90CYF1WXXM8CYDMT, art_01M5YCNJ83ZZJP37S33F84NQMC, art_01M5YCRA4PWWB10EN1NT31ZQKD, art_01M5YCTCW3W81NQNGMNVH8JZFE, art_01M5YCWWMAG64MJRRJE4MCWQM2, art_01M5YCZK15EAAXRFF30J6QDTYM, art_01M5YD1F3T8YKD5SQGXS85163H, art_01M5YD470C061GNX7Y0ZRM2D51, art_01M5YD6FY4HXAW7KW1FH7BKFX1, art_01M5YD8SFWDN4X6HN8753YJFWZ, art_01M5YDBHCD8N877GXA08PNV266, art_01M5YDDDTXQCQ28RZ2HYET7ARY, art_01M5YDG3VX3TECZ0EN9TXB1JX3, art_01M5YDJKZNGGAWSRY9YXJHE70P, art_01M5YDMPBFY9QZC2QT0V9FKH14, art_01M5YDQE8648B8GGZHMD58FPPE, art_01M5YDSHX1WWS7BFEEFY2KPQ80, art_01M5YDW0QR3F4PVT1TAS1QJ51Q, art_01M5YDYR1Q9TZ42N1QPEF5HQ06, art_01M5YE0K7DF8MR2B31XE3SS97J, art_01M5YE3B3XPTA80ZCZPGSV2D4G, art_01M5YE5NYDK3AN1T62Q19P43PB, art_01M5YE7XKJBD39NZVEEF9F6H4F, art_01M5YEANG5XVQMBSNV257BNGY8, art_01M5YECJW35N4GKR9SFH6EETJC, art_01M5YEF7ZMKDCMEFBV3FQT6Q2A, art_01M5YEHT0M53A60Q0AJ68CXT87, art_01M5YEKTF6XC1B2NK6YK26D1SC, art_01M5YEPJBYD50SHSWMMJC8SW1N, art_01M5YERPX7ED0AVTPS8HP2HV9X, art_01M5YEV4VFN9ZNNVVCGRBVS42M, art_01M5YEXWR010Y3MPQYAZAC9Z0B, art_01M5YF0MMHEFY7NV1N554YTMSX, art_01M5YF337HZ69GXV6BWVYEBAKA, art_01M5YF5740JPYFRR1R6EEFZKFB, art_01M5YF7Z0JYPE5ACPQ9K75TQRM, art_01M5YFA22SXMC4WA16SE6K60YS, art_01M5YFCHG3PMBTMTQNFD7AX393, art_01M5YFF78PK8HZA6NQ94PDXDVF, art_01M5YFH3ZP1N4WEPRS6FE9DV02, art_01M5YFKVW6DXQ06JT4GTMPHTNP, art_01M5YFP54QVKE787M9MZFV0Z9E, art_01M5YFREBSAS43BQ5ZNFPFGA5K, art_01M5YFV68DWWA4WBE086YC5515, art_01M5YFX31FCVTG49Y98WHJH3KH, art_01M5YFZRRJVR6RM0J8RDG5VTBR, art_01M5YG296WRN6MX2H0ANP9WVSV, art_01M5YG4B7T5495PHVP56WHGB7E, art_01M5YG7349Z9XV4GDBEW8X6ZE4, art_01M5YG973AQ0WQKAWY6HB63ABQ, art_01M5YGBNKV8Z3JC8BVS5SAWGX9, art_01M5YGED8HQPFY6DVTJ4BRSWRH, art_01M5YGG83BRMVHBHMGGNXYH26B, art_01M5YGJZZXBFDNNDD9H3CKV9QF, art_01M5YGNB5201G5A3DTW8NRCVA5, art_01M5YGQJFGK4DH9Z6KBP3FCS62, art_01M5YGTAC3YV3JCE7GDMF3PY4J, art_01M5YGW911FGBG5BSQYMYQDT8Y, art_01M5YGYWVRDR3A8B0W20PPR2T2, art_01M5YH17CFT4H9WHN7H468D5HJ, art_01M5YH3FBCXZ54YY4N2KMK3C1A, art_01M5YH677YR49HTMG564XFAEZ9, art_01M5YH859ZRC9AYE9Z5Z5D5060, art_01M5YHASQK07ZQ2JPF1AFA8E86, art_01M5YHDBG97GNPRF544ZASG4DP, art_01M5YHFC71HMR0MFAZG5JQVB13, art_01M5YHJ43KSY5Z3K7M4YXTTHS4, art_01M5YHMBBJFJPXJK09E49MG7A1, art_01M5YHPPK8H13M3F01AAXWXGSK, art_01M5YHSEFWVWRZAT60Q2MHEFY9, art_01M5YHVA7ES453QJQ4V6SE9XCJ, art_01M5YHY0ZD0FMCDYG1BTNA0NK9, art_01M5YJ0GCSG9AZE8E4AJJHSK1F, art_01M5YJ2KEZK6557BGGR2S0G7P0, art_01M5YJ5BBGKXAMTDPQW59RFCFY, art_01M5YJ7E9QG3SQDFYR9TG7FNK7, art_01M5YJ9XV6VS8V9EFR6XS23FPF, art_01M5YJCMG4AJVH7GN82F7E8XCD, art_01M5YJEGAQWZM9QHYVA0PQ7TDG, art_01M5YJH878SY9C8FHEDDTS0NJW, art_01M5YJKHE0ACY513TZMG9QFJBN, art_01M5YJNTPTZX6N9ZT412CD08GX, art_01M5YJRJKCPFBGH53CX1AYG2BV, art_01M5YJTFA5YDV1QSTG0DF2MW7D, art_01M5YJX52ZTW0RTC8FHS0SCDZ0, art_01M5YJZNEYQ1MNY68ZQ2TK2YE8, art_01M5YK1QJPE0JH6Q7MEXCN4PD4, art_01M5YK4FF5E9JJEVRM39VN2E3N, art_01M5YK6KBH8BPQ95APBQ25HNTC, art_01M5YK91YPJQZ1SAKXC6AJSMVA, art_01M5YKBSGKZPGMSJMFMV04Y6H9, art_01M5YKDME9C1B5BWMBB9DE478R, art_01M5YKGCAR3XBCXKWK8S2Q6RWY, art_01M5YKJSB641XN6KMSHA5QAWCA, art_01M5YKMYTBTWAM5CNZ1NYEKKXD, art_01M5YKQPPXMRVWM0S06JWRDZBT, art_01M5YKSQ7SXB2FD78C98KXP3EG, art_01M5YKW96JS9WAX5M0E9X1RA0A, art_01M5YKYWECTQ3XXZYEGZHEA4FB, art_01M5YM0VP6X8G66PPD8Y69NE59, art_01M5YM3KK0E22JBDAG7FWSSRN3, art_01M5YM5V9QGFHCSGA1MVVJRTEK, art_01M5YM862B3S1Q6WF6JW279EM6, art_01M5YMAXYX019D1FQA36FY6VBB, art_01M5YMDNVD1B3NEBSB62B1M9XD, art_01M5YMG8MDFQN3JEDTGW6E544X, art_01M5YMJ8B5JCA4KDR2NMWGJARM, art_01M5YMN07KCNEXRYY4385EQ09Y, art_01M5YMQ7FF4FPAV1F8XVXN1BET, art_01M5YMSJQ84T7E8YQY150YG0SX, art_01M5YMWAKSFHXXZY54P7EWR6N5, art_01M5YMZ2GE8PE9H0FJ1WF8PDC0, art_01M5YN1KSJRFFHXTS6SJS6PSBA, art_01M5YN3N00M8XY8V67E7P9KVF1, art_01M5YN6CWJK744WFMAW5QWHSNG, art_01M5YN8JMJGJ3QN4336GGFK1CH, art_01M5YNAZC2WEFYE676YCA36F5C, art_01M5YNDQ8JDGAC8DFKFCJWZD5N, art_01M5YNGF55SDZJ1BW75RYP19SG, art_01M5YNK0YMJGKBY0XTX0KCF5ZD, art_01M5YNN1MPWY386MTCNCN8Y6QY, art_01M5YNQSHHJW6DAGJD17RH8NB8, art_01M5YNSZTP02STW3ZQE6Q4VF7R, art_01M5YNWC0WAW5632DB5WQ9KNSV, art_01M5YNZ3XEEAMS874Q1V7RHQDF, art_01M5YP0ZNAKQ2C4RYN3JDHMYR9, art_01M5YP3PCZ5S8G0DR05VDK5ZE0, art_01M5YP66T0ZA9ZSNCDCKC2EMXJ, art_01M5YP88WGBG3PMAX979EEY40X, art_01M5YPB0S0KXPM2623HGCYJFFY, art_01M5YPD3PSXVZ45WRRVMD6YG2X, art_01M5YPFK8MAJ720HFQXD8G3P21, art_01M5YPJAVE4N18WVT0ASB6VQ5G, art_01M5YPM5R5RT1N2WZ5FN1SEGCB, art_01M5YPPXMPKBMFS4TMBV7QF7PR, art_01M5YPS9R1SXJAHBXQH97HX7CP, art_01M5YPVG47NZ7M2WDE7BJ4CZHR, art_01M5YPY80RF26QPAATMWW1CDQC, art_01M5YQ06MNJK2DNVZE9JBY4XJW, art_01M5YQ2TGCHFM3D7PQWBHD160K, art_01M5YQ5CT76MFTNB4GQ30CZDKW, art_01M5YQ7CZYMA7TA20J8K411CZS, art_01M5YQA4WEAZMYVKFS8BP45XT8, art_01M5YQCDM1NN0ED1R46VWGTNZW, art_01M5YQEQC2KPW6C2CJ4CE8JG90, art_01M5YQH26BE36VSZYVFVNBKYB7 |

## Definitions

- **Active seconds** (`active_seconds`): Seconds during which something was executing for the run, as recorded by the control plane. Idle gaps are excluded. Denominator: Runs with recorded activity intervals.
- **Agent time** (`agent_time`): Harness execution time of an agent, from its start to its end. It excludes verification, queueing and integration. Denominator: Agents with both a recorded start and end.
- **API-equivalent estimate** (`api_equivalent_estimate`): An estimate of what the measured tokens would cost at a price table's list rates. It is an estimate from a price table, not a bill, and subscription or negotiated pricing may differ. Denominator: Attempts with a price-table entry for their model and measured tokens; others are unpriced.
- **Combined estimate** (`combined_estimate`): The model estimate plus the machine estimate. It is a lower bound when either part is incomplete. Denominator: Runs with both parts measured count fully; the rest are listed as incomplete.
- **Completion lead time** (`completion_lead_time`): Time from a story or goal being planned to its work being delivered, as recorded on a completion checkpoint. Denominator: Completion checkpoints whose members all have recorded times.
- **Coverage** (`coverage`): How completely an attempt's resources were observed: complete, partial, unknown, legacy (route figures only) or missing. Missing evidence is never shown as zero. Denominator: All attempts in the selected population, tallied by coverage class.
- **Delivered outcomes** (`delivered_outcomes`): Jobs whose work was verified and integrated, counted once each however many attempts it took. Denominator: All jobs in the selected population, delivered or not.
- **Elapsed completion time** (`elapsed_completion_time`): Wall-clock time from the start of the run or story to its completion, measured on the clock; overlapping work is counted once. Denominator: Completed runs or stories only; unfinished ones are excluded and counted in the sample size.
- **Examination time** (`examination_time`): Time examiners and the helper routes serving them (answering, arbitrating) spent on examinations of the work. Denominator: Examination routes with a recorded start and end.
- **Examiner dispositions** (`examiner_dispositions`): How examiners' findings were resolved: upheld, rejected, fixed or still open. Denominator: Findings raised in the selected population.
- **First-attempt success** (`first_attempt_success`): Delivered jobs whose first attempt (attempt 1) was verified and integrated without a later attempt. Association with rework is not causation. Denominator: Jobs that reached a terminal state in the selected population; jobs still running are not counted.
- **Human verdict** (`human_verdict`): The person's binary verdict on whether a run worked, captured with its attribution. It is separate from deterministic verification and does not change recorded outcomes. Denominator: Runs that received a verdict; unrated runs have none.
- **Infrastructure estimate** (`infrastructure_estimate`): An estimate of the machine expense of runs executed on Nightshift-provisioned machines, from their utilization and a rate table. Denominator: Runs with a machine report; local runs have none and are absent, not zero.
- **Integration time** (`integration_time`): Time spent integrating verified work onto its target branch, after verification passed. Denominator: Integrated jobs with recorded integration intervals.
- **Provider-reported cost** (`provider_reported_estimate`): The dollar figure the provider or harness itself reported, kept apart from the price-table estimate and never summed with it. It is an estimate of spend, not an invoice. Denominator: Attempts whose harness reported a cost; others are unpriced.
- **Queue time** (`queue_time`): Time verification requests waited for the verification queue before they started running. Denominator: Verifications in the selected population that recorded a queue phase.
- **Rating coverage** (`rating_coverage`): The share of completed runs that carry a human verdict. Denominator: Completed runs in the selected population.
- **Review overhead** (`review_overhead`): Resources and time spent by examination and arbitration routes, shown beside the work they reviewed. It is not a measure of review quality. Denominator: Helper routes in the selected population compared with all routes.
- **Rework attempts** (`rework_attempts`): Attempts made after a node's first attempt: escalations and retries of the same node's work. Association with other factors is not proof of causation. Denominator: Attempts of jobs in the selected population; the first attempt of each job is not rework.
- **Rework by cause** (`rework_by_cause`): Rework attempts grouped by the cause recorded when the attempt was made (for example verification failure or examiner finding). An attempt with several causes appears under each. Denominator: Rework attempts with a recorded cause; those without one are counted as unattributed.
- **Run completion time** (`run_completion_time`): Time from a run's start to its completion, measured on the clock. Denominator: Runs that completed.
- **Sample size** (`sample_size`): How many rows matched a filter and how many there were in all, so a figure is read against its population. Denominator: Matched rows out of all rows before filtering.
- **Settlement time** (`settlement_time`): Time from an attempt's start until its node settled, including verification, queue and integration. It is longer than agent time. Denominator: Routing decisions that recorded a wall-clock figure.
- **Summed work time** (`summed_work_time`): The sum of every attempt's working time. It is not elapsed time: work overlaps, so the sum can exceed the clock time of the run. Denominator: Attempts with a recorded start and end; attempts without both add nothing and are counted as missing.
- **Cache-read tokens** (`tokens_cache_read`): Tokens served from the provider's prompt cache, where reported. Denominator: Attempts whose provider reports cache reads; others are not counted as zero.
- **Cache-write tokens** (`tokens_cache_write`): Tokens written to the provider's prompt cache, where reported. Denominator: Attempts whose provider reports cache writes; others are not counted as zero.
- **Input tokens** (`tokens_input`): Input tokens the provider reported, normalized to include cache reads and writes where the convention is known; an unknown convention is flagged and the raw figure kept. Denominator: Attempts with a measured input counter; attempts without one are counted in coverage, never as zero.
- **Output tokens** (`tokens_output`): Output tokens the provider reported for the attempts. Denominator: Attempts with a measured output counter; absent counters are not zero.
- **Reasoning tokens** (`tokens_reasoning`): Reasoning or thinking tokens, where the provider reports them apart from output. Denominator: Attempts whose provider reports reasoning tokens; others are not counted as zero.
- **Wait time** (`wait_time`): Time the run spent waiting rather than working: for a human, for capacity, or for a prerequisite, as recorded on the control plane. Denominator: Runs with recorded waiting intervals; absent intervals are unknown, not zero.
