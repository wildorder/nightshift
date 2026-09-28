# T5 — Fixture proofs; the live suite; as-built; ready for the owner's trial

**Program:** `p9-decision-graph-replay`
**Depends on:** T3, T4
**Decisions applied:** all

## Objective

The correction is proven end to end on a fixture and live, the as-built is
written, and everything is deployed for the owner's trial. The build agent does
not run the trial.

## Deliverables

1. **The fixture (SC-P9-08)**: a planned program whose strand records a decision,
   run to the end with the scripted harness; the decision reversed through the
   CLI; the brief written; a scripted correction plan that changes code both
   inside and outside what the decision produced; checked, ratified and run;
   verified; both reports linked.
2. **`npm run correction`** (`apps/api/src/smoke/correction.smoke.ts`): real
   adapters against the deployed plane; a job and a strand that each record a
   decision, stamped when they land; `decision reverse` and `decision brief`
   against the deployed plane; a deferred check that fails at resume, retried by
   a real worker, and the provisional line landed.
3. Deploy if needed; `npm run smoke` twice, `conformance --harness all`, `slice`,
   `routing`, `correction`.
4. **As-built**: task states, the SC table, what changed in earlier suites, build
   decisions for ratification, and what the owner should look for in their trial
   (SC-P9-13). AGENTS.md "As built for P9"; architecture entries; staging.md.
5. PR into `v1`.
