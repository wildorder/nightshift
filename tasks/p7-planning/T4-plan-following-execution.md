# T4 — Plan-following execution

**Program:** `p7-planning`
**Depends on:** T1, T3
**Unblocks:** T5
**Decisions applied:** D-P7-04, D-P7-06, D-P7-09

## Objective

`nightshift run {id}` takes a ratified plan to a report with nobody watching.

## Deliverables

1. **The engine takes the ratified contract.** A strand is submitted as a
   sub-program (or a single job when its orchestrator would have one thing to
   do); it stays `queued` with `waitingFor: strands` naming them until the strands
   it depends on have succeeded.
2. **Parking** (§4.4): when a strand settles without succeeding, the engine
   computes `blockedBy`, cancels the cone's queued strands with a reason naming
   the blocker, emits `strand.parked` and `strand.blocked`, and keeps scheduling
   everything else.
3. **Deferral and the provisional line** (D-P7-10). A verification step whose
   prerequisite is unmet, or that reports it *cannot run* for a hurdle the engine
   then records as a new prerequisite, is `deferred`; the others run. A node with
   a deferred step lands on `refs/nightshift/provisional/{run}` through the same
   merge queue, never on the program branch, and later work is cut from the
   provisional head. `nightshift resume {id}`, after preflight passes: run the
   deferred steps over the provisional commits in order; fast-forward the program
   branch through what passes; on a failure, delegate a fix at that commit and
   replay its downstream cone onto it, discarding what no longer applies and
   saying so. A step that ran and failed is a failure, never a deferral.
4. **`nightshift run {id}`**: refuses an unratified or edited plan; runs
   preflight and stops with the remediations if anything the *first* strands need
   is unmet; starts the run; records the plan's decisions as `Decision`s with
   authority `human` on the program node; launches the root orchestrator; waits;
   writes the report; exits non-zero when anything was parked.
5. **The root orchestrator is an agent like any other**, started through the
   routed adapters with a **plan-following brief** in `packages/harness`: the
   plan document, the strands and their order, the decisions already made, and
   its rules — delegate each strand as a sub-program with its plan section as the
   objective's body, in dependency order, as many at once as the limits allow;
   retry what is worth retrying; never write code; never add or drop a strand.
6. **A strand's orchestrator** is handed its plan section verbatim, the decisions
   that touch it, and the roster of the *other* strands' ids, names and scopes. It
   decides its own jobs.
7. **`docs/programs/{id}/report.md`**, written from the control plane alone: per
   strand, its outcome against its acceptance, its jobs, commits and attempts, and
   any departure from its section's approach, first; per success criterion, met
   or not and by what; what was parked, what it blocked and why; prerequisites
   still pending with their remediation; the run's own decisions; wall clock and
   usage.
8. Tests over the fake harness and real git: `dependsOn` is never violated under
   any finishing order (a property test over random DAGs); a failed strand parks
   exactly its cone; an unratified plan and an edited plan are both refused; a
   three-strand plan runs to a report with the scripted harness.

## Notes

- The human's own Claude Code session can still orchestrate, as today. This adds
  the unattended path; it removes nothing.
