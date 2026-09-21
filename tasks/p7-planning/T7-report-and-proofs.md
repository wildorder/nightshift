# T7 — The report, re-planning input, and the planned fixture's proofs

**Program:** `p7-planning`
**Depends on:** T5, T6
**Unblocks:** T8
**Decisions applied:** D-P7-11; SC-P7-01 … SC-P7-15

## Deliverables

1. **`docs/programs/{id}-report.md`**, written from the control plane alone:
   per workstream, its outcome against its spec's acceptance, its commits, its
   attempts; per success criterion, met or not and by what; decisions taken, the
   ones that departed from the plan first; what was parked, what it blocked and
   why; prerequisites still pending with their remediation; wall clock and usage.
2. `plan-program` reads a prior report when re-planning (T3 wires it; this task
   proves it on the fixture).
3. **The planned fixture**: the slice repository with a committed, ratified
   plan of four workstreams, one dependency edge, one prerequisite whose
   `verifyCommand` a test can flip, and one anticipated decision.
4. `test/src/planning/`: one test per success criterion SC-P7-04 … SC-P7-14,
   through the real CLI and the real server binary, reading the control plane
   and the repository.
5. Readiness negative fixtures: one broken plan per `checkPlan` reason.

## Acceptance

```sh
npm run verify
npm run check:architecture
```
