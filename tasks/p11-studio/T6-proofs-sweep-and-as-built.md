# T6 — Proofs, the document sweep, as-built

**Program:** `p11-studio`
**Depends on:** T3, T5
**Decisions applied:** all

## Objective

The Studio is deployed with every page, proven live, the documents say the
Studio is built, and the owner can run their trial. The build agent does not
run the trial.

## Deliverables

1. **Live**: `npm run deploy`; `npm run smoke` twice; `npm run studio:smoke`;
   the hosted Studio signed into by the operator user and a run of the P9
   correction suite's program watched while `npm run correction` runs it
   (SC-P11-04, live half): the timeline advances before the run finishes. Record
   the observed lag from event `recordedAt` to its appearance.
2. **The document sweep** (§4.5): `architecture.md` A-15 → superseded, A-15a
   "the Studio is built in P11 as a client"; O-02 resolved by D-P11-05; the
   layering diagram; `vision.md`'s "Do not build" and "After v1" lists;
   `AGENTS.md`'s layout note and an "As built for P11" section; `staging.md`'s
   P11 row and state; `apps/studio/README.md`.
3. **As-built** in `docs/programs/p11-studio.md` §13: task states, the SC table
   with where each is proven, what changed in earlier programs' suites and why
   (the persistence split, the report's move), build decisions for the owner's
   ratification, the `us-east-1` bootstrap, and what the owner should look for
   in their trial (SC-P11-12): sign in at the hosted URL, start a program run
   from a terminal on a repository of their choosing, watch it, read the run
   page, reverse a decision from it, then `decision brief` from the terminal.
4. PR into `v1`.

## Acceptance

- Every SC but SC-P11-12 marked met with its proof; SC-P11-12 marked the
  owner's.
- `npm run verify`, `check:architecture`, `smoke` twice, `studio:smoke` green.
