# Program P9 — Decision Graph and Replay

| Field | Value |
|-------|-------|
| Program ID | `p9-decision-graph-replay` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p9-decision-graph-replay` |
| Source stage | Stage 8 (Decision Graph and Replay) |
| Status | **Draft 2026-09-27**, for the owner's answers to Q1 … Q7 (§3.1) and ratification |
| Depends on | P6 (the engine, the merge queue, sub-programs), P7 (plans, strands, their decisions, the provisional line, `resume`), P8 (rulings as decisions with checkpoints, `ruling reverse`) |
| Blocking decisions | Q1 … Q7 |

This contract is the stable authority for P9. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Make a decision **operationally reversible**. When the owner reverses a decision
(a plan decision they answered, an orchestrator's choice, an arbiter's ruling),
Nightshift works out exactly which work was built on it, takes that work back
out of the program branch without touching anything else, rebuilds it under the
new decision, and brings the program back to a verified state. Nothing is
deleted: the original decision, the original work and its commits stay on the
record, and the reversal is a higher-authority decision beside them.

Source criteria: **SC-12** (decisions are tied to executable checkpoints and
causal descendants) and **SC-13** (reversing a decision invalidates the minimum
necessary execution cone). The source plan's exit gate: *decision reversibility
works across dynamic recursive execution, not merely static workstreams.*

**What P9 is not.** Nothing remote (P10). No new harness. No change to how a run
plans, routes or examines.

### What exists today

- **Decisions** have the right shape (P1): context, alternatives, choice,
  rationale, a reversibility class (`reversible`, `compensatable`,
  `irreversible`), `checkpointBefore`, an optional `checkpointAfter`,
  `affectedNodes`, authority, and `supersedesDecisionId`. `core` enforces that a
  human outranks an agent, that an override never softens reversibility, and
  follows supersession chains (`overrideDecision`, `effectiveDecision`).
- **The causal edges are almost never recorded.** `affectedNodes` is `[]` on
  every worker decision and every plan decision a run records at start; an
  orchestrator may fill it and in practice does not; only an arbiter's ruling
  names its node. So today nothing can say what a decision's descendants are.
- **Commits land on one line.** The merge queue replays each job onto the head,
  verifies it there, and fast-forwards (A-41). Every later job is built on every
  earlier one, so git ancestry alone would put the whole rest of the run in any
  cone. Checkpoints are refs (`refs/nightshift/checkpoints/<id>`).
- **Two reversals exist and replay nothing.** `nightshift ruling reverse`
  (P8, D-P8-13) records a superseding human decision and prints the checkpoint
  to reset to by hand. `nightshift resume` (P7, D-P7-10) discards what was built
  on a deferred check that fails, instead of fixing it and replaying the cone;
  the owner accepted that as temporary, "until P9".
- **A strand cone exists.** `downstreamCone` in `core` gives every strand that
  depends on a strand, transitively: what is parked when one fails. Its comment
  says it is the cone P9 replays; it covers strands only, not jobs or decisions.
- **Runs end.** Most reversals will come after a run has finished and the owner
  has read the report, when no engine is running. The run table has no status to
  go back to.

## 2. Environment and human prerequisites

Everything from P3 … P8 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P9-01 | Ratify D-P9-01 … D-P9-10 | open |
| H-P9-02 | P8 merged | **satisfied 2026-09-26** (PR #21) |

**Explicitly not required.** No new AWS resource. The API gains routes and fields
(§4.5) and is redeployed.

## 3. Decisions

### 3.1 Questions for the owner

| # | Question | Leaning |
|---|----------|---------|
| Q1 | What puts work in a decision's cone? | Computed by Nightshift from what it already records, not declared by agents (D-P9-01) |
| Q2 | How does reversed work leave the program branch? | New commits that revert it, on top; history is never rewritten (D-P9-03) |
| Q3 | What is rebuilt: the same jobs, or does an orchestrator re-plan? | The cone's orchestrator re-plans it, given the reversal as a binding decision (D-P9-05) |
| Q4 | Where does a replay run when the original run has ended? | A new run of the same program, a **replay run**, holding only the cone (D-P9-06) |
| Q5 | What about compensatable and irreversible decisions? | Compensatable: a human prerequisite to compensate, then replay. Irreversible: the reversal is recorded, and replay refuses unless the owner says to go ahead anyway (D-P9-07) |
| Q6 | Does reverting work need a new node status? | Yes: `reverted`, reachable only from `integrated`, and nothing leaves it. It is a change to P1's table (D-P9-04) |
| Q7 | The exit gate | The source plan's fixture and a recursive one, deterministic; the live suite; and the owner reverses a real decision on a real repository (SC-P9-14, SC-P9-15) |

### 3.2 Proposed decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P9-01 | **Nightshift computes the cone; agents do not declare it.** A node is in the cone of decision *X* when any of: (a) it was delegated, directly or through sub-programs, by the node *X* was made on, **after** *X* was recorded; (b) *X* names it in `affectedNodes`; (c) *X* is a plan decision and the node belongs to a strand the decision `touches`; (d) it depends on a node already in the cone, through a Job Contract's `dependencies` or a strand's `dependsOn`; (e) its landed commit cannot be kept once the cone's commits are reverted, because the revert conflicts with it (D-P9-03). Nothing else is. The cone is computed in `core` from the records, deterministically, and recorded before anything moves. | Agents do not fill `affectedNodes` today and will not reliably tomorrow; a cone that depends on a model remembering to declare its consumers is not a cone. Everything (a) … (d) needs is already recorded. (e) is the one fact only git knows, and git states it deterministically. Git ancestry alone is not used: on a single line it makes everything later a descendant, the opposite of *minimum*. |
| D-P9-02 | **The cone is explained.** Every node in it carries why it is there: which rule, through which node. The report and `nightshift decision cone` show it before anything is replayed. | A human deciding whether to reverse needs to see what it costs, and a cone nobody can explain is a cone nobody can trust. |
| D-P9-03 | **Reversed work leaves by revert commits; history is never rewritten.** At the program head, Nightshift reverts the cone's landed commits, newest first, as Nightshift-authored commits (A-29). A non-cone commit whose revert would conflict joins the cone (D-P9-01 e) and the computation repeats. The head after the reverts must pass the program's verification; a checkpoint marks it, `checkpointAfter` of the reversal. Nothing is force-moved, and every original commit stays reachable from its checkpoint. | Rewriting the branch would move commits the human may already have built on, and A-29 has Nightshift never move a branch except forward. Reverts keep D untouched by construction: its commit is never replayed or rebuilt. |
| D-P9-04 | **A reverted node is `reverted`.** P1's table gains one status and one edge, `integrated → reverted` (`revert`); `reverted` is terminal and leads nowhere, so nothing reaches `sealed` or `integrated` from it. The node keeps its commit, verification, examination and decisions. Its replacement is a new node naming it (`replaces`). | Leaving the node `integrated` would make the record claim work is on the branch that is not. A new status is the only honest record; ratifying this decision is the owner's authorisation to change P1's table in exactly this way, as D-P7-10 was for `deferred`. |
| D-P9-05 | **The cone is re-planned, not re-run.** Replay hands the cone to the orchestrator that owned it (the strand's for work inside a strand, the root's otherwise) with the reversal as a **binding human decision** in its brief, the cone's original Job Contracts as a starting point it may reuse or replace, and the rest of the run's state. It delegates; the engine verifies, examines and lands as always. | The cone's Job Contracts were written under the decision being reversed: re-running them verbatim would rebuild the same thing. The orchestrator is where the plan-to-job cut is made (A-42), so it is where the cut is remade. |
| D-P9-06 | **A replay runs in a replay run.** A reversal after the original run ended starts a new run of the same program whose `replayOf` names the original and whose scope is exactly the cone; its report is the cone's, beside the original. A reversal during a run (an arbiter's ruling the owner reverses while the engine is attached, a failing check at `resume`) replays inside that run. | The run table's statuses are final once ended, and reopening a finished run would make its report a moving target. A replay run is ordinary: the same engine, queue, routing and examination, attended or dark. |
| D-P9-07 | **Reversibility classes decide what replay may do.** `reversible`: replay. `compensatable`: the reversal records a **compensation** human prerequisite (P7's mechanism, D-P7-05) naming what must be undone outside the repository, and the replay run defers what needs it until preflight says it is done. `irreversible`: the reversal is recorded, and replay is refused unless the owner passes `--accept-irreversible`, which is itself a recorded human decision. Nothing re-labels a class. | Architecture §6: an irreversible external effect is never described as reversible. The repository can always be reverted; the world outside it cannot, and saying so is the point of the classes. |
| D-P9-08 | **Every decision can be reversed from one verb.** `nightshift decision reverse <program> <decisionId> --choice <new> --reason <why>` records the superseding human decision, computes and prints the cone, and asks before replaying (`--yes` to skip). `ruling reverse` becomes the same verb for a ruling. `nightshift decision cone` shows a cone without reversing anything. | One path means one set of rules; P8's `ruling reverse` was always the first case of this. |
| D-P9-09 | **`resume` fixes instead of discarding** (closing D-P7-10's temporary branch). A deferred check that fails at resume becomes a fix job for its node, and what was built on it is its cone, replayed after the fix lands (D-P9-05), not discarded. | The owner's ruling of 2026-09-21: no fix job or replay at resume was accepted as temporary, until P9. |
| D-P9-10 | **Minimality is proven, not asserted.** A property test over random trees, dependency graphs and decision placements checks that the computed cone is exactly what D-P9-01's rules reach, that no node outside it runs a worker in the replay, and that every preserved node's commit is on the branch afterwards with its patch id unchanged. | SC-13 says *minimum*; a property is the only way to say it about more than the fixtures. |

### Non-guarantees

- **Semantic dependencies git cannot see.** A node outside the cone whose code
  still merges cleanly but relied on the reverted behaviour is caught by the
  program's verification after the reverts (D-P9-03), not by the cone. If
  verification catches it, the replay stops there and says so; if the checks do
  not cover it, nothing catches it. That is the same guarantee every landing has.
- **Other people's branches.** Nightshift never pushes (A-29), so nothing it
  reverts has left the machine through Nightshift. What the owner pushed or built
  on by hand is theirs.

## 4. Design

### 4.1 A reversal's path

```text
nightshift decision reverse … ──► superseding human decision (authority human)
         │
         ▼
  cone = core.coneOf(decision, records)        ← D-P9-01, explained (D-P9-02)
         │   reversibility?  irreversible ──► refused unless --accept-irreversible
         │                   compensatable ──► compensation prerequisite recorded
         ▼
  revert the cone's commits at the head, newest first
         │   a revert conflicts with a non-cone commit ──► it joins the cone, again
         ▼
  verify the reverted head ── fails ──► stop; recorded; the report says why
         │ passes: checkpoint (the reversal's checkpointAfter); nodes → reverted
         ▼
  replay run (or the live run): the cone's orchestrator re-plans it under the
  reversal; engine → verify → examine → merge queue, as always
         │
         ▼
  verified head; report: what was reverted, why each node was in the cone,
  what replaced it, and that nothing else ran
```

### 4.2 The cone

`coneOf(decision, records)` in `core` is pure and takes the run's nodes, Job
Contracts (with their `dependencies` and `strandId`), the program's strands, the
decisions, and a list of nodes git says cannot be kept. It returns each node in
the cone with the rule and the path that put it there. The execution layer runs
it, attempts the reverts in a scratch worktree, feeds any conflict back in, and
repeats until the set is stable (it only grows, and is bounded by the run).

### 4.3 The record

- `Decision` gains nothing: a reversal is an ordinary superseding decision.
- **`Reversal`** (new, run-scoped): the decision reversed, the reversing
  decision, the cone with reasons, the reverted commits, the checkpoint after the
  reverts, the replay run (or `in-run`), and its outcome.
- `ExecutionNode` gains `replaces?: ExecutionNodeId` and the status `reverted`.
- `Run` gains `replayOf?: { runId, reversalId }`.
- Events: `decision.reversed`, `cone.computed`, `node.reverted`,
  `replay.started`, `replay.completed`.

### 4.4 Where the code goes

`core`: `coneOf`, the `revert` edge, reversal rules. `execution`: reverting,
the replay run's start, `resume`'s fix-and-replay. `apps/mcp`: the replaying
orchestrator's brief (the reversal as a binding decision, the cone's original
contracts). `apps/cli`: `decision reverse`, `decision cone`, `ruling reverse` as
an alias. `api`: the `Reversal` record and the node and run fields.

### 4.5 Control-plane changes

`PUT|GET …/runs/{runId}/reversals/{reversalId}`; the `revert` transition,
allowed only to the operator's session and the engine; `replaces` and `replayOf`
held to the chain like every other reference. Redeployed.

## 5. Scope

### In scope

The cone, its explanation, reverting, the `reverted` status, replay runs and
in-run replay, the three reversibility classes, `decision reverse` and `decision
cone`, `resume`'s fix and replay, the report's reversal section, the properties
and fixtures of §6, the live suite, and the owner's trial.

### Out of scope

- Undoing anything outside the repository. Compensation is a human's, recorded
  as a prerequisite.
- Rewriting history or force-moving any ref (D-P9-03).
- Anything remote (P10) or realtime (P11).
- A Studio view of the decision graph (P11 ships the data surface).

## 6. Success criteria

- **SC-P9-01** `coneOf` is deterministic and pure; each node in a cone carries
  the rule and path that put it there.
- **SC-P9-02** The source plan's fixture (Job A records D-01; Jobs B and C are
  delegated after it and consume it; Job D is independent): reversing D-01
  reverts B and C, keeps D's commit with its patch id unchanged, runs no worker
  for D, preserves D-01, records the human override, replays B and C's work, and
  ends verified.
- **SC-P9-03** Recursive: a decision recorded inside a sub-program's orchestrator,
  with a strand depending on that sub-program, reverses into a cone spanning both,
  and nothing outside it runs.
- **SC-P9-04** A property over random trees, dependency graphs and decision
  placements: the cone is exactly what D-P9-01 reaches; nothing outside it runs a
  worker; every preserved commit remains on the branch.
- **SC-P9-05** A revert that conflicts with a non-cone commit pulls that commit's
  node into the cone, with the reason recorded; a revert that cannot be made at
  all stops the reversal before anything moves.
- **SC-P9-06** A reverted head that fails verification stops the replay, records
  why, and leaves the branch at the last verified checkpoint.
- **SC-P9-07** Reverted work leaves by revert commits only; no ref other than the
  program branch moves, and it moves forward only; every original commit stays
  reachable from its checkpoint.
- **SC-P9-08** A reverted node is `reverted` through the table's one new edge;
  P1's properties still hold with it, and nothing leaves `reverted`.
- **SC-P9-09** The replaying orchestrator's brief carries the reversal as a
  binding human decision and the cone's original contracts; the replayed work is
  verified, examined and landed by the ordinary path.
- **SC-P9-10** A replay run names its original and reversal, holds only the cone,
  and has its own report; a reversal during a live run replays inside it.
- **SC-P9-11** `compensatable` records a compensation prerequisite and defers what
  needs it; `irreversible` refuses replay without `--accept-irreversible`, which
  is itself recorded.
- **SC-P9-12** `decision reverse`, `decision cone` and `ruling reverse` work
  through the real CLI; a reversal needs a human session, and an execution token
  is refused.
- **SC-P9-13** `resume` with a deferred check that fails: a fix job for its node,
  its cone replayed after the fix lands, nothing discarded.
- **SC-P9-14** The P1 property tests, the P4 isolation suites, the P5 conformance
  suite, the P6 tree, the P7 planned fixture and the P8 examination suites pass,
  changed only where a ratified decision adds a status or a field, listed in the
  as-built.

**Exit gate**

- **SC-P9-15** Live, `npm run replay`, with real adapters against the deployed
  control plane: the SC-P9-02 fixture and the recursive one, reversed and
  replayed, ending verified, with the cone and the untouched work checked.
- **SC-P9-16** The owner's own: a real program on a repository of the owner's
  choosing, one decision in it reversed with `nightshift decision reverse`, and
  the replay run's report read. The build agent does not run it.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy`, `npm run smoke` (twice),
`npm run conformance -- --harness all`, `npm run slice`, `npm run routing`,
`npm run replay`.

## 8. Constraints

- No model decides a cone, whether a commit can be kept, or whether a decision's
  class may be ignored. Orchestrators re-plan the cone's work; everything around
  them is deterministic.
- A-05 holds: replayed work lands only through verification (and examination
  where the policy says).
- A-29 holds: Nightshift owns every commit, never rewrites history, never pushes.
- Human authority is highest: only a human reverses, and an agent never supersedes
  a human decision.
- P1's transition table changes only as D-P9-04 says, if ratified.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.5; running the
smoke, slice, conformance, routing and replay suites. SC-P9-16's trial is the
owner's.

Forbidden:

- Rewriting, force-moving or deleting any ref, or pushing.
- Replaying anything outside a cone, or anything an irreversible decision governs
  without the owner's recorded go-ahead.
- Weakening the P1 … P8 suites.
- Inspecting the legacy Nightshift's branches or tags.

## 10. Tasks

Drafted after the questions are answered.

## 11. Risks

| Risk | Handling |
|------|----------|
| The cone is too big to be worth it, because a decision early in a run touches everything | The cone is shown before anything moves (D-P9-02, D-P9-08); a reversal the owner judges too costly is recorded without `--yes` and replayed later, or never |
| A semantic dependency outside the cone breaks after the reverts | Verification after the reverts stops the replay there (SC-P9-06); the non-guarantee is stated |
| The replaying orchestrator rebuilds the reversed choice anyway | The reversal is a binding human decision in its brief, and examination sees the Job Contracts; the report shows what replaced what |
| Reverts pile up and make the history hard to read | Every revert commit names the reversal and the node; the report maps them |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-27 | Contract drafted after P8 closed. D-P9-01 … D-P9-10 proposed; Q1 … Q7 put to the owner. | Agent, for human ratification |

## 13. As built

Not started.
