# T5 — The planned fixture's proofs; then live; as-built

**Program:** `p7-planning`
**Depends on:** T2, T4
**Decisions applied:** SC-P7-01 … SC-P7-14

## Deliverables

1. **The planned fixture**: the slice repository with a committed, ratified plan
   of three strands, one `dependsOn`, one prerequisite whose `verifyCommand` a
   test can flip, and one decision.
2. **`test/src/planning/`**: one test per success criterion SC-P7-03 … SC-P7-12,
   through the real CLI and the real server binary, reading the control plane and
   the repository. Readiness negative fixtures: one broken plan per `checkPlan`
   reason.
3. **Live**, on a repository the owner names: `nightshift init`; a real program
   planned with `plan-program`, **edited by the owner**, checked, ratified;
   `nightshift run {id}` unattended with real adapters against the deployed
   control plane, to a report.
4. `npm run smoke` twice, `npm run conformance -- --harness all`,
   `npm run slice`, to show P4 … P6 still hold.
5. **As-built** in the contract §13: task states; what the owner changed in the
   plan and what that says about the template; where the run departed from a
   strand's approach; what was parked; how long planning took against how long
   the run took; the SC table. `AGENTS.md` conventions and as-built;
   `docs/architecture.md` entries for D-P7-01, D-P7-05 and D-P7-09 on
   ratification; `docs/vision.md`, which does not yet say that a human plans.
6. PR into `v1`.

## Notes

- The measure of this program is the owner's own: did the plan tell you roughly
  what was coming, did you get to make the decisions you wanted to make, and did
  the run finish without you.
