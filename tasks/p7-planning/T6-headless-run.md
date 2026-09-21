# T6 — The headless root orchestrator and `nightshift run {id}`

**Program:** `p7-planning`
**Depends on:** T4, T5
**Unblocks:** T7
**Decisions applied:** D-P7-08, D-P7-10

## Objective

`nightshift run {id}` takes a ratified plan to a report with nobody watching.

## Deliverables

1. `nightshift run {id}`: refuses an unratified or edited plan; runs preflight;
   starts the run; records the anticipated decisions as `Decision`s with
   authority `human` on the program node; launches the root orchestrator; waits;
   writes the report (T7); exits non-zero when anything was parked.
2. **The root orchestrator is an agent like any other**, started through the
   routed adapters in the orchestrator role with a **plan-following brief**
   (`packages/harness`): the program document, the roster, the dependency order,
   the decisions already made, and its rules — delegate each workstream as its
   spec says, in dependency order, as many at once as the limits allow; retry
   what is worth retrying; change the roster only by recording a decision that
   cites the plan item; never write code.
3. The deterministic alternative, behind a flag, for a plan that needs no
   judgement: the engine submits every workstream straight from the manifest
   with no root model at all. The report says which ran.
4. Every spec author, orchestrator and worker is handed the anticipated
   decisions that touch its scope.
5. Tests with the scripted harness: a three-workstream plan with a dependency
   runs to a report; an unratified plan is refused; an edited plan is refused.

## Notes

- The human's Claude Code session can still orchestrate, as it does today. This
  adds the unattended path; it does not remove the attended one.
