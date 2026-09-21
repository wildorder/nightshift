# T7 — Live, and the as-built

**Program:** `p6-parallel-recursive`
**Depends on:** T6
**Decisions applied:** SC-P6-18

## Deliverables

1. `npm run deploy` (if anything changed since T1), `npm run smoke` twice.
2. `npm run slice` gains a **tree phase**: the fixture tree against the deployed
   plane with real adapters, the program's policy allowing both providers, at
   least one job pinned to each harness, the sub-orchestrator on a real model.
   Ends with the run `succeeded` and the branch verifying.
3. The benchmark, once with the scripted harness and once with real adapters, for
   the as-built.
4. `npm run conformance -- --harness all`, to show P5's gate still holds.
5. **As-built** in the contract §13: task states; what the first real
   sub-orchestrator did that the brief had to change for; the benchmark table;
   measured discovery latency; departures; the SC table. `AGENTS.md`
   conventions and as-built; `docs/architecture.md` entries for D-P6-01 and
   D-P6-05 on ratification; `staging.md`.
6. PR into `v1`.

## Acceptance

```sh
npm run verify
AWS_PROFILE=nightshift npm run smoke
npm run conformance -- --harness all
npm run slice
```

## Notes

- Expect the first real sub-orchestrator to surprise. Each surprise is a brief or
  enforcement change and a §12 entry, never a suite edit.
