# Program P18 — Strand Builds

| Field | Value |
|-------|-------|
| Program ID | `p18-strand-builds` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p18-strand-builds` |
| Source stage | none: the owner's direction of 2026-10-16 (§3.1), after measuring keki-backend's `room-bookings` run |
| Status | **Built 2026-10-16** in a coding-agent session (D-P18-01 … D-P18-08 agreed in conversation). D-P18-04's examination runs after the strand's gates, not alongside them yet (§12) |
| Depends on | P6 (the merge queue), P8 (examination, routing), P10 (the runner), P15 (gate repair, flakes), A-57 (end gates), A-58 (plan, run, done) |
| Blocking decisions | none |

This contract is the stable authority for P18. Amend it only through a human
decision recorded in §12.

## 1. Objective

Nightshift exists to deliver unattended results that pass the plan's acceptance
criteria, fast and without stopping, leaving a trail of decisions to audit later.
P18 keeps the **job** as the unit of planning, visibility and review, and stops
making it the unit of execution and proof. A strand's orchestrator **authors** its
jobs as a plan — as parallel as the work allows — which an independent examiner
**reviews before anything is built**; the jobs then build onto the strand's own
branch with no ceremony of their own; and the **strand** is verified, examined and
landed once.

### Who it is for

| Story | Who | Today | Afterwards |
|-------|-----|-------|------------|
| US-01 | The owner, the morning after | A night spent mostly checking and waiting: every job verified on its own, often twice, examined, queued one at a time; a failure restarts from a cold agent. | The night spent building. Each strand verified once, its failures fixed by the agent that wrote the code, its jobs still visible one by one. |
| US-02 | The owner, auditing later | Each job's diff was reviewed after the fact; how the strand was split was never reviewed at all. | The strand's job plan, its review and every revision are on the record before the code; each job is a commit; the strand's examination judges the whole against its acceptance. |

> "the only thing I care about is for nightshift to deliver unattended results that pass predefined acceptance criteria - fast and without stopping, leaving a trail of decisions behind to audit later."
>
> "i like the structured jobs...they provide visibility, also if an orchestrator "authors" the strand plan with a series of jobs and their dependencies, you can run an examiner on the authoring instead of the output, which i've found quite reliable.. that's the plan->author->critical-review->build i use elsewhere in skills."
>
> "but i don't like all the ceremony around building jobs - separate worktree, formal gates, multiple review rounds after it's built and tested..that's all nasty stuff. is there any way to save the job concept, but lighten the ceremony?"
>
> "the one thing i don't like is not leaning into parallel jobs where they can be parallel.. seems like the strand orchestrator authoring the plan should do that where possible."

### What exists today (measured)

keki-backend's `room-bookings` (`run_01M4WCRZ…`, 2026-10-14, 21 jobs, 18 landed,
23.7 h): 840 min of worker time against 539 min of gate runs (≈ 47 full runs of an
11½-minute gate for 18 landings: a candidate check and a queue check per examined
job, more after fixes and flakes), 247 min of finished jobs waiting for the serial
queue, 47 min of examination, and 32 worker attempts for 21 jobs, each retry a new
agent in a new worktree. A median job: ≈ 24 min building, ≈ 38 min of checking and
waiting.

Mechanically: a strand is a `sub-program` node whose orchestrator writes no code
and delegates jobs; every job lands directly on the **program** branch through the
run's one serial merge queue, with a full gate run per landing; the strand node
never lands, it declares `succeeded`; `JobContract.dependencies` is stored and
never enforced; a retry always starts a new session.

## 3. Decisions

### 3.1 The owner's direction, 2026-10-16

| # | Question | Answer |
|---|----------|--------|
| Q1 | What is Nightshift for? | Unattended results that pass predefined acceptance criteria, fast, without stopping, with a decision trail. |
| Q2 | Keep jobs? | **Yes**, for visibility and for reviewing the authoring; lose the per-job ceremony. |
| Q3 | Who splits a strand into jobs, and when? | The strand orchestrator, at run time, not the human in planning; reviewed by an examiner before building. |
| Q4 | Parallel? | **As parallel as the work allows**; the authoring decides, the review checks it. |
| Q5 | Examination at the strand's end? | **Yes**, alongside the gates, on the same commit. |

### 3.2 Decisions

| ID | Decision | Status |
|----|----------|--------|
| D-P18-01 | **A strand authors its jobs as a plan, and the plan is reviewed before anything is built.** The strand orchestrator's first act is `strand.plan`: each job's id, objective, acceptance, the paths it expects to touch, and the jobs it depends on. An independent examiner reviews the plan against the strand's brief and acceptance — coverage, real dependencies, parallel jobs that would touch the same paths, jobs too small to be worth their cost — and its findings come back to the orchestrator, which revises (at most two rounds) and records the outcome as a decision. `delegate` is refused until the strand has a reviewed plan. | agreed 2026-10-16 |
| D-P18-02 | **Independent jobs run at once.** A strand job starts when every job it depends on has merged onto the strand branch, and as many run together as the strand's concurrency allows. `JobContract.dependencies` is enforced. | agreed 2026-10-16 |
| D-P18-03 | **A strand job lands on its strand's branch, not the program branch, and with no ceremony.** Each strand has a branch, `nightshift/<run>/<strandNode>`, cut from the program head when the strand starts, checked out in the strand's worktree (the orchestrator reads it there). A job is cut from the strand branch's head; its worker runs the tests its change touches; on `job.complete` its commit is merged onto the strand branch, and the job ends **`merged`**, a new status: landed on its strand, verified only as part of the strand. No per-job gate run, candidate check, examination or queue turn. A merge conflict fails the job with `integration_conflict`, for the orchestrator to retry from the new strand head. | agreed 2026-10-16 |
| D-P18-04 | **The strand lands once, as one job does today.** `subprogram.complete` marks the strand node `implemented` at the strand branch's head; it enters the run's merge queue, which brings the program head into the strand branch when it moved (a merge, so every job's commit stays in history), verifies the landing gates on that commit, examines the strand per the examination policy **at the same time** as the verification, seals, fast-forwards the program branch, checkpoints and publishes. The strand node ends `integrated`, and its outcome is `succeeded`. | agreed 2026-10-16 |
| D-P18-05 | **A strand's failure goes back to the agent that knows it.** A strand whose landing fails — red gates, a blocking finding, a conflict with the program head — is continued by the engine without anyone asking: its orchestrator's own session is resumed in the strand's worktree with the failures (each failing step's log tail, each finding), it delegates the fix as jobs, and completes again. At most `MAX_STRAND_FIX_ROUNDS` (3) rounds; then the strand fails as today, for the root to decide. | agreed 2026-10-16 |
| D-P18-06 | **The strand examination judges the whole.** The examiner reads the strand's diff against the program head, its brief and acceptance, the reviewed job plan, and the decisions recorded under it, and judges whether the acceptance is met and the work is sound. Only material findings block (D-P8 policy); the rest are recorded. | agreed 2026-10-16 |
| D-P18-07 | **Root-level jobs and unplanned runs are unchanged.** A job the root delegates directly (a repair, an unplanned run's job) keeps today's path. P18 changes how a planned strand builds. | agreed 2026-10-16 |
| D-P18-08 | **The trail.** Each job is a commit on the strand branch carrying its Nightshift trailers; the job plan, its review and each revision are decisions under the strand; the strand's verification and examination are records on the strand node; the report lists each strand's jobs with their status (`merged`), and the strand's landing with its gates and examination. | agreed 2026-10-16 |

### Non-guarantees

- **A job's "done" is its agent's claim** until its strand is verified. A bad job is
  found at the strand's end, not after itself; its commit says which it was.
- **Parallel jobs can conflict** on the strand branch when the plan's paths were
  wrong; the review exists to catch that, and a conflict costs one retry.

## 4. Design

```text
strand.delegate ─► strand node running, strand branch cut from program head
  orchestrator:  strand.plan {jobs} ─► plan review (examiner) ─► revise ≤2 ─► decision
                 delegate J1..Jn (dependencies) ─► engine starts each when its deps merged
  each job:      worktree from strand head ─► worker builds, runs its tests ─► job.complete
                 ─► engine merges its commit onto the strand branch ─► job `merged`
  orchestrator:  subprogram.complete ─► strand node `implemented` at strand head
  merge queue:   merge program head in (if moved) ─► verify ║ examine ─► seal ─► ff ─► integrated
  failure:       engine resumes the orchestrator's session with the failures (≤3 rounds)
```

## 5. Scope

In: the job plan tool and its review; the strand branch and worktree; dependency
gating; strand jobs merging onto the strand branch and the `merged` status; the
strand node's landing through the queue with verification and examination
together; the engine's automatic strand fix rounds by resumed session; briefs for
the strand orchestrator and its workers; the report, the Studio and the run skill.

Out: root-level jobs and unplanned runs (D-P18-07); a worker continuing a
predecessor's session for a dependent job (a later refinement).

## 6. Success criteria

| ID | Outcome | Serves |
|----|---------|--------|
| SC-P18-01 | A strand's orchestrator cannot delegate before its job plan is reviewed; the plan, review and revision are decisions under the strand | US-02 |
| SC-P18-02 | Two independent jobs of a strand run at the same time; a dependent one starts only after its dependency merged | US-01 |
| SC-P18-03 | A strand job runs no gate, candidate check or examination of its own and ends `merged` on the strand branch | US-01 |
| SC-P18-04 | A strand lands with one verification of the landing gates and its examination running together, and ends `integrated` | US-01 |
| SC-P18-05 | A strand whose landing fails is continued by its own orchestrator's resumed session with the failures, and lands once fixed | US-01 |
| SC-P18-06 | The report and the Studio show each strand's jobs and its landing | US-02 |
| SC-P18-07 | On keki-backend's `admin-redesign`, the run's gate runs number one per strand landing plus the end, and the run takes markedly less than `room-bookings`' measured shape | US-01 |

## 7. Deterministic verification

`npm run verify`; SC-P18-07 is the owner's trial.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-10-16 | Drafted from the owner's direction and agreed in conversation (D-P18-01 … D-P18-08) | Human (the direction); agent (the write-up) |
| 2026-10-16 | **Built** (A-59). Three findings while building: (1) the plan review waits in session (`strand.review.wait`, capped like `job.wait`) rather than ending the orchestrator's turn, so no harness has to resume a session for it, and the engine runs the review from its discovery loop; (2) the API minted an examiner's or arbiter's token only on a job node, so no strand could have been reviewed or examined: they may now hold one on a strand's node, never a worker; (3) `nightshift resume` read the provisional line as one commit per deferred node: a deferred strand carries its whole branch, merged with the head when it moved. **Not yet built:** D-P18-04's examination *alongside* the gates. An examination's record names a finished verification and hands the examiner the gate results as evidence; running the two together changes that contract, so the strand's examination runs once its gates pass. | Agent; the owner's trial follows |
