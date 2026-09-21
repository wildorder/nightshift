# T8 — Live: plan, ratify and run a real program unattended; as-built

**Program:** `p7-planning`
**Depends on:** T3, T7
**Decisions applied:** SC-P7-16

## Deliverables

1. On a repository the owner names: `nightshift init`, then a real program
   planned with `plan-program`, specs written by `author-specs`, **edited by the
   owner**, checked, ratified.
2. `nightshift run {id}` unattended, real adapters, the deployed control plane,
   to a report.
3. `npm run smoke` twice, `npm run conformance -- --harness all`,
   `npm run slice`, to show P4 … P6 still hold.
4. **As-built** in the contract §13: task states; what the owner changed in the
   plan and what that says about the templates; every departure the run made
   from the plan; what was parked; how long planning took against how long the
   run took; the SC table. `AGENTS.md` conventions and as-built;
   `docs/architecture.md` entries for D-P7-01, D-P7-06 and D-P7-10 on
   ratification; `docs/vision.md`, which does not yet say that a human plans.
5. PR into `v1`.

## Notes

- The measure of this program is the owner's own: did the plan tell you roughly
  what was coming, did you get to make the decisions you wanted to make, and did
  the run finish without you.
