# T10 — Deployed slice, skill run-through and as-built

**Program:** `p3-vertical-slice`
**Depends on:** T7, T8, T9
**Unblocks:** the exit gate
**Decisions applied:** D-P3-03, D-P3-11; A-17; SC-P3-16, SC-P3-17

## Objective

Run the slice for real: the deployed control plane, the operator's Cognito
identity, Claude Code as the worker and as the orchestrator, the fixture job,
and read the lifecycle back from the API alone. Then record what happened.

## Environment

One account, `755348349819` / `us-west-2`, profile `nightshift` for the scripts
and the operator's `nightshift login` for the servers. The API stack must have
been redeployed at the end of T2. Claude Code signed in on this machine.

## Deliverables

1. **Scripted, deployed.** `npm run slice` phase one: the T9 suite with
   `NIGHTSHIFT_SLICE_TARGET=deployed` and the scripted harness. Exit 0, cleanup
   confirmed by a second run.
2. **Claude, deployed.** Phase two: the same suite with
   `NIGHTSHIFT_SLICE_HARNESS=claude` for the outcomes a real model can be asked
   to produce (`implement`, and `hang` via a brief that asks the worker to
   report progress and then wait for an instruction that never comes). The
   remaining scripts stay scripted; a model cannot be reliably asked to fail a
   test on purpose. Record the wall clock and the `RoutingDecision` usage
   fields the adapter could fill.
3. **The exit-gate run-through** (SC-P3-16), by hand:
   - `nightshift login`, `nightshift project create`, the program contract in a
     fresh copy of the fixture repository with that project id.
   - `claude` in the fixture repository with the Nightshift MCP server
     configured (the MCP configuration snippet is documented in the skill),
     invoking the skill: start the run, delegate the fixture job, wait, read
     the result, record one decision, finish.
   - From a different shell, with a fresh token and only the API: `GET
     …/state`, `GET …/events`, the verification, the checkpoint, and the
     artifacts, and confirm the lifecycle table in the contract §4.3 is
     reconstructable from those reads alone. Fetch one verification log from
     S3 by its recorded URI and confirm it is the step's output.
   - Confirm the program branch in the fixture clone was fast-forwarded and the
     operator's working tree was otherwise untouched.
4. **Smoke** (SC-P3-17): `npm run smoke` against the redeployed stack, twice.
5. **As-built** in the contract §13: every task's state and location; the
   command lines the adapter actually used; the observed durations (delegate
   to worker start, worker runtime, verification, integration); the run and
   node identifiers of the exit-gate run; anything the model did that the brief
   had to be changed to prevent; and the P2-style table discharging SC-P3-01
   … SC-P3-17. Update `AGENTS.md`'s pin table and conventions, and, on the
   human's ratification, `docs/architecture.md` with A-27 … A-31 and O-04
   marked resolved.

## Acceptance

```sh
npm run verify                              # still credential-free, still green
AWS_PROFILE=nightshift npm run smoke
AWS_PROFILE=nightshift npm run slice
```

All exit 0, and the by-hand run-through is recorded with identifiers a reader
can look up.

## Notes

- Expect the first real worker to surface prompt problems the scripted harness
  cannot: a model that commits anyway, that edits outside scope because the
  brief was vague, that calls `job.complete` before running tests. Each is a
  change to the brief (T1's helper or T8's addition) or to enforcement (T5),
  never to the contract's invariants, and each goes in the as-built.
- Do not run two slice suites at once against the deployed stack; the smoke
  suite's rule applies.
- The exit-gate run is the demo the whole program exists for. Keep its
  transcript (the orchestrator's, via Claude Code's own session log) somewhere
  the human can read; the worker's transcript is already an artifact.
