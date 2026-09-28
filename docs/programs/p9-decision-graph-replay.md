# Program P9 — Decision Graph and Correction

| Field | Value |
|-------|-------|
| Program ID | `p9-decision-graph-replay` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p9-decision-graph-replay` |
| Source stage | Stage 8 (Decision Graph and Replay), reframed by the owner (§3.1) |
| Status | **Closed 2026-09-27** on the owner's word. Built T1 … T5 (§13), deployed, the live suite passed. SC-P9-13, the owner's trial, runs after the close; what it finds is fixed as follow-ups. |
| Depends on | P6 (the engine, the merge queue, sub-programs), P7 (planning, strands, `resume`), P8 (rulings as decisions with checkpoints, `ruling reverse`) |
| Blocking decisions | none |

This contract is the stable authority for P9. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Make a decision **reversible by correction**. When the owner reverses a decision
(one they answered in a plan, an orchestrator's choice, an arbiter's ruling),
Nightshift records the reversal and hands a planner everything it needs to
correct the program under the new decision: the fork in the road, the branch that
was taken, what was built on it and where. The correction is planned with the
owner, ratified and run like any program, and may change anything the new
decision calls for.

Every decision is tied to the commits it produced, so the report shows which
choices shaped which code, and a reversal starts from an exact place.

**How this departs from the source plan.** Stage 8 asks Nightshift to compute the
minimum execution cone of a reversed decision, invalidate exactly that, preserve
everything else, and replay it, with tests proving no unrelated work is replayed
(SC-13). The owner's direction (§3.1): a reversal is a new plan with a different
decision, not a replay. Tracing a cone assumes a reversal only undoes things; a
new decision may need changes anywhere, and only a planner reading the code can
see that. So Nightshift does not tag work downstream of a decision, revert it
automatically, or guarantee a minimum; the planner decides what changes, and the
owner ratifies it. SC-12 (decisions tied to checkpoints and what they produced)
is met; SC-13 is replaced by SC-P9-05 … SC-P9-08.

**What P9 is not.** Nothing remote (P10). No new harness. No change to routing or
examination.

### What exists today

- **Decisions** carry context, alternatives (with why each was rejected), choice,
  rationale, a reversibility class, `checkpointBefore`, an optional
  `checkpointAfter`, `affectedNodes`, authority and `supersedesDecisionId`. `core`
  enforces that a human outranks an agent and that an override never softens
  reversibility.
- **A decision is not tied to what it produced.** `checkpointAfter` is set only on
  an arbiter's ruling; `affectedNodes` is `[]` on nearly every decision. Which
  commits a decision led to can only be guessed from timing.
- **Two reversals exist and do nothing further.** `nightshift ruling reverse`
  (P8) records a superseding human decision and prints a checkpoint to reset to
  by hand. `nightshift resume` (P7, D-P7-10) discards what was built on a deferred
  check that fails; the owner accepted that as temporary, "until P9".
- **Planning** (P7) is a session with the owner: `plan-program` writes
  `plan.md` and `contract.json`, `plan check` and `plan ratify` gate it,
  `nightshift run` runs it.

## 2. Environment and human prerequisites

Everything from P3 … P8 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P9-01 | Ratify D-P9-01 … D-P9-08 | **satisfied 2026-09-27** |
| H-P9-02 | P8 merged | **satisfied 2026-09-26** (PR #21) |

**Explicitly not required.** No new AWS resource. The API gains fields (§4.4) and
is redeployed.

## 3. Decisions

### 3.1 The owner's direction, 2026-09-27

| # | Question | Answer |
|---|----------|--------|
| Q1 | How is reversed work found and undone? | **It is not traced.** A reversal is a new plan with a different decision: the planner reads the commit history, the original plan and the decision's record, and plans the correction, which may reach outside what the old decision produced |
| Q2 | Does a correction need the owner's approval before it runs? | **Yes**: it is a plan, planned with the owner and ratified like any other |
| Q3 | A reversed decision that was irreversible (an effect outside the repository)? | **Flag it, and confirm before the correction runs** |
| Q4 | The exit gate | **A live suite, and the owner's own trial**: a real decision reversed on a real repository |
| Q5 | Tie each decision to its commits? | **Yes**: the "cheap fix", so the report shows which choices shaped which code and a correction starts from an exact place |
| Q6 | What is the difference between a retry and a correction? | **What triggers it.** A broken result (a failing check, an examiner's finding) is retried automatically, as today. A changed decision is a correction: a new plan, with the owner. A check that fails at `resume` is a broken result (D-P9-07) |

### 3.2 Ratified decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P9-01 | **A decision is stamped with what it produced.** When the node a decision was made on lands (a job integrates, a strand or sub-program completes), Nightshift sets the decision's `checkpointAfter` and records the commits that node's work landed, from `checkpointBefore` to the landing, as `produced`. A plan decision (the owner's answer, recorded at run start) is stamped with what the strands it `touches` produced. Deterministic, from the records and git; no agent declares anything. | The cheap fix of §3.1 Q5. It ties a choice to its own work and nothing downstream, which is all a correction needs to start from and all the report needs to show. |
| D-P9-02 | **Any decision can be reversed, by one verb.** `nightshift decision reverse <program> <decisionId> --choice <new> --reason <why>` records a superseding `human` decision (as `ruling reverse` does today, which becomes an alias of it). It changes nothing else, and prints how to plan the correction. | One path for plan decisions, orchestrators' choices and rulings. A reversal on its own is a record; the correction is a plan. |
| D-P9-03 | **A correction brief gathers what the planner needs.** `nightshift decision brief <program> <decisionId>` writes, for the reversal: the original decision (context, the alternatives and why each was rejected, choice, rationale, class); the owner's new decision and reason; the checkpoint it was made at and the commits it produced (D-P9-01), with the files they touched; every later commit on the program branch; the plan section or strand the decision belongs to; the run's report; and the decisions made after it that name it or share its strand. | The planner starts from the fork in the road, not from scratch. The alternatives are often the most useful part: the new decision is frequently one already weighed and rejected, and why it was rejected is what to watch for. |
| D-P9-04 | **A correction is a program, planned in correction mode.** `plan-program` gains a correction mode that starts from the brief: it plans the change the new decision calls for, wherever that reaches, with the owner, into an ordinary `plan.md` and `contract.json`. The contract names what it `corrects` (program, run, the decision reversed and the reversing decision). `plan check`, `plan ratify` and `nightshift run` apply unchanged. | The owner's direction (§3.1 Q1, Q2). Planning already ends where a wrong choice becomes cheap (A-42), and a correction is exactly that kind of plan. |
| D-P9-05 | **An irreversible reversal is flagged, and confirmed before the correction runs.** A correction whose `corrects` includes a decision of class `irreversible` (or `compensatable`) is flagged in its plan and by `plan check`, and `nightshift run` refuses it until the owner confirms (`--confirm-irreversible <decisionId>`), recorded as a human decision. A compensatable one may instead carry a human prerequisite naming the compensation (D-P7-05). | §3.1 Q3. The repository can be corrected; an effect outside it cannot be, and saying so before anything runs is the point of the classes. |
| D-P9-06 | **The two programs point at each other.** The correction's report opens with what it corrects and why. The original run's record holds the reversing decision, so the original report, regenerated with `nightshift report <program>`, shows each reversed decision with the correction that followed it. | Whoever reads either report sees the whole story. |
| D-P9-07 | **A check that fails at `resume` is handled like any failed check; nothing is discarded** (closing D-P7-10's temporary branch). The node ends `verification_failed`, and `nightshift-resume`, standing in for the orchestrator a run would have, retries it as a run would (D-P8-07: one rung up, the failed check's output in its brief), at most twice. The rest of the provisional line goes through the merge queue on the head that results, each piece verified there. What still fails is left failed and reported, and it is the owner's to plan a correction for. | The owner's ruling of 2026-09-21. A broken result gets the ordinary retry, a changed decision gets a correction: the one distinction (§3.1). |
| D-P9-08 | **The report shows the decision graph.** Every decision in a run with its alternatives, its class, the commits it produced, and whether it was reversed and by what, so close calls are visible. | §3.1 Q5: visibility of close calls is half of why decisions are recorded. |

### Non-guarantees

- **No minimum is computed or guaranteed.** What a correction changes is the
  planner's judgement, ratified by the owner. Work unrelated to the decision is
  kept because the plan leaves it alone, not because Nightshift proves it.
- **Decisions agents do not record.** A choice nobody wrote down has no record to
  reverse. Recording decisions stays the orchestrators' and workers' job
  (`decision.record`).

## 4. Design

### 4.1 A reversal's path

```text
report / decision graph ──► owner picks a decision to reverse
        │
        ▼
nightshift decision reverse … ──► superseding human decision (nothing else moves)
        │
        ▼
nightshift decision brief … ──► the correction brief (D-P9-03)
        │
        ▼
plan-program, correction mode, with the owner ──► plan.md + contract.json (corrects: …)
        │   irreversible / compensatable reversed? ──► flagged (D-P9-05)
        ▼
plan check ──► plan ratify ──► nightshift run (confirm irreversible first)
        │
        ▼
the correction's report opens with what it corrects; the original's shows the reversal
```

### 4.2 Stamping (D-P9-01)

The engine already knows when a node lands (a job integrates through the merge
queue; a sub-program completes). At that moment it lists the decisions made on
that node, and for each sets `checkpointAfter` to the landing's checkpoint and
`produced` to the commits between the decision's `checkpointBefore` and there
that the node's work landed (for a sub-program, its subtree's). Plan decisions are
stamped when the run ends, from the strands they touch. A decision whose node
never landed keeps no `produced`, which is itself worth seeing.

### 4.3 The record

- `Decision` gains `produced?: { commits: CommitSha[] }`, set once, by the engine
  or the operator's session; `checkpointAfter` becomes settable once for any
  decision, as it is for rulings today.
- `ProgramContract` gains `corrects?: { programId, runId, decisionId,
  reversedBy }[]`.
- Events: `decision.stamped`, `decision.reversed`.

### 4.4 Control-plane changes

The `produced` field and its set-once rule; `checkpointAfter` set once on any
decision; `corrects` held to the chain (the program, run and decisions must be the
caller's). Redeployed.

## 5. Scope

### In scope

Stamping decisions, `decision reverse` (with `ruling reverse` as its alias),
`decision brief`, `plan-program`'s correction mode, the irreversible flag and
confirmation, `corrects` and the two-way report links, the report's decision
graph, `nightshift report`, `resume`'s retry of a failed check, the live suite, and the owner's trial.

### Out of scope

- Computing a cone, tagging downstream work, or reverting automatically (§1).
- Undoing anything outside the repository.
- Rewriting history or force-moving any ref.
- Anything remote (P10) or realtime (P11).

## 6. Success criteria

- **SC-P9-01** A decision made on a job is stamped, when the job integrates, with
  the landing's checkpoint and exactly the commit it landed; one made on a
  strand's orchestrator, with the commits the strand's work landed after it; a
  plan decision, with what the strands it touches landed. Deterministic, over real
  git.
- **SC-P9-02** A decision whose node never landed has no `produced`, and the
  report says so.
- **SC-P9-03** `nightshift decision reverse` records a superseding human decision
  for a plan decision, an orchestrator's decision and a ruling alike; an execution
  token is refused; `ruling reverse` is the same verb.
- **SC-P9-04** `nightshift decision brief` contains everything D-P9-03 lists,
  from the control plane and the repository alone.
- **SC-P9-05** A correction contract names what it corrects; `plan check` and
  `plan ratify` accept it, and refuse a `corrects` naming a program, run or
  decision that is not the caller's, or a decision that has not been reversed.
- **SC-P9-06** A correction reversing an `irreversible` or `compensatable`
  decision is flagged by `plan check`, and `nightshift run` refuses it until the
  owner confirms, which is recorded.
- **SC-P9-07** The correction's report opens with what it corrects; the original
  report, regenerated, shows the reversal and the correction.
- **SC-P9-08** The fixture: a planned program whose strand records a decision,
  run to the end; the decision reversed; a correction planned from the brief
  (scripted), ratified and run, changing code both inside and outside what the
  decision produced; the result verified; both reports linked.
- **SC-P9-09** `resume` with a deferred check that fails: the node retried as a
  run would retry it (one rung up, the failure in its brief, at most twice), then
  the rest of the provisional line through the queue on the resulting head;
  nothing discarded that still verifies, and what still fails reported.
- **SC-P9-10** The report shows every decision with its alternatives, class,
  produced commits and reversal.
- **SC-P9-11** The P1 … P8 suites pass, changed only where a ratified decision
  adds a field, listed in the as-built.

**Exit gate**

- **SC-P9-12** Live, `npm run correction`, with real adapters against the
  deployed control plane: decisions stamped by real runs; `decision reverse` and
  `decision brief` against the deployed plane; `resume`'s retry with a real worker.
- **SC-P9-13** The owner's own: on a repository of the owner's choosing, a
  decision from a real run reversed, the correction planned from the brief with
  `plan-program`, ratified and run, and both reports read. The build agent does
  not run it.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy`, `npm run smoke` (twice),
`npm run conformance -- --harness all`, `npm run slice`, `npm run routing`,
`npm run correction`.

## 8. Constraints

- No model decides what a decision produced, whether a correction may run, or
  whether a class may be ignored.
- Human authority is highest: only a human reverses, only a human ratifies a
  correction, and an agent never supersedes a human decision.
- A-05 and A-29 hold: corrections land only through verification, as
  Nightshift-owned commits, never rewriting history, never pushing.
- P1's transition table is not changed.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.4; running the
smoke, slice, conformance, routing and correction suites. SC-P9-13's trial is the
owner's.

Forbidden:

- Rewriting, force-moving or deleting any ref, or pushing.
- Running a correction that reverses an irreversible decision without the
  owner's recorded confirmation.
- Weakening the P1 … P8 suites.
- Inspecting the legacy Nightshift's branches or tags.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Contracts, rules and the API: `produced`, `checkpointAfter` once for any decision, `corrects`, the reversal and confirmation records; deploy | — | AWS |
| T2 | Stamping decisions when their node lands and plan decisions at run end; the report's decision graph and `nightshift report` | T1 | — |
| T3 | `decision reverse`, `decision brief`, `plan-program`'s correction mode, the irreversible flag and confirmation, the two-way report links | T1, T2 | — |
| T4 | `resume` retries a failed check and lands the rest, discarding nothing | T1 | — |
| T5 | Fixture proofs; the live suite; as-built; ready for the owner's trial | T3, T4 | AWS, Claude Code, Codex |

```text
T1 ── T2 ── T3 ──┐
  └──────── T4 ──┴── T5
```

Specs live in `tasks/p9-decision-graph-replay/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| Orchestrators record few decisions, so there is little to reverse | The report's decision graph makes the gap visible; the skills already ask for decisions; a later program can require them at named points |
| A correction plan quietly redoes far more than needed | It is planned with the owner and ratified; the brief shows exactly what the decision produced, so a plan that strays is visible |
| A stamped `produced` is wrong because a node's work was rebased in the queue | Stamping reads the commits the queue actually landed, after replay, not the worker's snapshot |
| An irreversible effect is forgotten | Flagged by `plan check` and refused by `run` until confirmed (D-P9-05) |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-27 | **P9 closed.** The owner closes it before their trial: SC-P9-13 moves after the close, and anything it finds is fixed as a follow-up, as P7's foodfly findings were. The seven build decisions below stand as built, accepted with the close, and are revisited if the trial says so. | **Human** |
| 2026-09-27 | **Build decisions, provisional until the owner ratifies or reverses them.** (1) **`plan check` reaches the control plane for a correction**, and only then: whether a decision was reversed is the control plane's to say, so checking a correction needs `nightshift login`; every other plan still checks offline. (2) **A reversal is recorded on the reversed decision's own node**, with its `checkpointBefore` and class copied, so it sits beside what it reverses in the record and the report. (3) **A stamp that cannot be written is left off silently**, not recorded as an event (T2's spec said "recorded"): the report shows such a decision as having produced nothing that landed, and no event type was added for it. (4) **A later node whose replay conflicts at `resume` ends `cancelled`**, with an `integration_conflict:` reason: the only edge out of `deferred` that is not a verification, and P1's table is not changed. It is reported for a correction, as a failed retry is. (5) **A retry at `resume` runs one node at a time through the P3 route** (`startJob` with no merge queue: verify where it stands, seal, fast-forward), because `resume` lands the line in order and nothing else is in flight. (6) **A decision recorded by an earlier attempt of a node is stamped with the retry's landed commit**: it was made on that node, and that node's work is what landed. (7) **The owner confirms an irreversible reversal on every run of the correction**, recorded on that run: a confirmation for one run is not taken as consent for another. | Agent, for human ratification |
| 2026-09-27 | **Contract ratified**, D-P9-01 … D-P9-08, with D-P9-07 reworded on the owner's question (Q6): a check that fails at `resume` is retried like any failed check, not given a separate "fix". Task specs T1 … T5 written. | **Human** |
| 2026-09-27 | **Reversal is correction by re-planning, not cone replay.** The first draft computed a minimum cone, reverted it and replayed it, as Stage 8 asks. The owner's direction: a reversal is a new plan with a different decision; the planner reads the history, the original plan and the decision's record, and the correction may reach outside the old decision's work. No downstream tagging, no automatic reverts, no new node status. Corrections are planned with the owner and ratified; irreversible reversals are flagged and confirmed before the correction runs; each decision is tied to the commits it produced ("the cheap fix"); the exit gate is a live suite and the owner's own trial. SC-13's minimum cone is replaced (§1). | **Human** |
| 2026-09-27 | Contract drafted after P8 closed. | Agent, for human ratification |

## 13. As built

Built 2026-09-27 on `program/p9-decision-graph-replay`, T1 … T5 in one sitting,
after the owner reframed the program the same morning (§3.1, §12).

### Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | **done**, deployed | `npm run smoke` 90 of 90 (a second run hit one S3 `ECONNRESET` on an upload, then 90 of 90) |
| T2 | **done** | Stamping at three points: `integrateNode` (a job), `finishSubProgram` (a strand), `endProgramNode` (the plan's and the root's) |
| T3 | **done** | `decision reverse`, `decision brief`, `report`, `run --confirm-irreversible`, `plan check` on a correction, `plan-program`'s correction mode |
| T4 | **done** | `resumeDeferred` takes a `ResumeRetry`; `nightshift-resume` supplies it |
| T5 | **done** | The fixture, the live suite, the battery below. SC-P9-13 is the owner's |

### What was proven, and where

| SC | State | By |
|----|-------|----|
| SC-P9-01 | met, **live** | `test/src/execution/stamping.test.ts` (a job's decision, exactly its landed commit and the landing's checkpoint); `test/src/planning/unattended.test.ts` (a strand's departure with its strand's commits; the plan's D-01 with what the strands it touches landed); live, a real worker's decision stamped with the commit its retry landed |
| SC-P9-02 | met | `stamping.test.ts`: a job that failed leaves its decision unstamped; the report says "produced nothing that landed" |
| SC-P9-03 | met | `test/src/cli/decision.test.ts` (an orchestrator's decision), `test/src/cli/ruling.test.ts` (a ruling, the same verb), `correction-e2e.test.ts` (a strand's); the API refuses an execution token's stamp (`records.ts`) |
| SC-P9-04 | met | `decision.test.ts`: the choice and why, what was weighed and why it lost, what it produced with its files, everything after it, the reversal |
| SC-P9-05 | met | `packages/core/src/rules/corrections.test.ts`, `apps/api/src/operations/decisions.test.ts` (ratification refuses an unreversed decision), `decision.test.ts` (`plan check`) |
| SC-P9-06 | met | `correction-e2e.test.ts`: flagged by `plan check`, refused by `run`, run with `--confirm-irreversible`, the confirmation recorded |
| SC-P9-07 | met | `correction-e2e.test.ts`: the correction's report opens with what it corrects; the original, regenerated by `nightshift report`, shows the reversal and the correction |
| SC-P9-08 | met | `test/src/planning/correction-e2e.test.ts`: a planned run whose strand departs (a decision marked irreversible), reversed, briefed, corrected by a scripted plan that rewrites a module the decision produced and adds modules it never touched, confirmed, run, verified, both reports linked |
| SC-P9-09 | met, **live** | `test/src/execution/engine.test.ts`: a failed check at resume retried with what failed in the brief and landed, the later work replayed on top; with no retry available, reported and the later work still landed. Live below |
| SC-P9-10 | met | `packages/execution/src/report.test.ts`, `decision.test.ts`, `unattended.test.ts` |
| SC-P9-11 | met | Below; nothing weakened |
| SC-P9-12 | met, **live**, 2026-09-27 | `npm run correction`, below |
| SC-P9-13 | **after the close** | The owner's, run after P9 closed (§12); follow-ups fix what it finds. Below: what to look for |

### The live suite, 2026-09-27

`npm run correction` against the deployed stack, a real Claude Code worker:

- The job recorded a decision ("a single-line arrow function"), planted a file
  the gate refuses, and deferred on the gate's human prerequisite: 42 s.
- The prerequisite met, `nightshift-resume` ran the gate, which failed; it
  retried the node one rung up with the failure in the brief; the real worker
  removed the file and the retry landed: `retried` and `landed` both the node,
  96 s in all.
- The decision was stamped with exactly the commit the retry landed; the owner's
  reversal was accepted by the deployed API and a rewrite of the decision was
  refused; the report showed the decision graph with the reversal.

The first live run found only that an unplanned run cannot `run.finish` as
deferred (a P7 rule for strands); the suite ends its session instead.

The battery after T5: `npm run smoke` 90 of 90 twice; `npm run conformance --
--harness all` 3 of 3 for claude and 3 of 3 for codex; `npm run slice` every leg;
`npm run routing` all 8 phases; `npm run verify` green (3,108 tests).

### What changed in earlier programs' suites, and why

Nothing was weakened.

- **P7** `engine.test.ts`: "resume stops at a deferred check that fails, and
  discards what was built on it" is replaced by D-P9-07's behaviour (reported,
  nothing discarded; and a retry that lands). `unattended.test.ts` reads the
  plan's decision from the report's decision graph, where it read
  `humanDecisions`. The scripted harness gains `value=` for `add-module` and
  `class=` for a strand's departure.
- **P8** `ruling.test.ts`: `ruling reverse` now says "Nothing else changed" and
  points at the brief, where it said "Nothing is replayed". `examination.test.ts`
  reads resume's new result shape. The API's ruling-only `checkpointAfter` path
  is the general stamp (`isDecisionStamp`).
- The report's "Decisions the run took" is the "Decision graph".

### For the owner's trial (SC-P9-13)

Deploy is current. On foodfly (or any planned repository), after a run:

1. Read the report's **Decision graph**: every decision with what was weighed,
   its class and the commits it produced. Pick a close call.
2. `nightshift decision reverse <program> <decisionId> --choice "…" --reason "…"`.
3. `nightshift decision brief <program> <decisionId> --out docs/programs/<fix>/brief.md`,
   then ask `plan-program` to plan the correction from it; commit, `plan check`,
   `plan ratify`, `nightshift run <fix>` (with `--confirm-irreversible` if it
   asks).
4. Look for: whether the brief told the planner enough; whether the correction
   changed what it should and left the rest alone; `nightshift report <program>`
   on the original, showing the reversal and the correction.

Re-run `nightshift init` in the repository first: the skills changed.
