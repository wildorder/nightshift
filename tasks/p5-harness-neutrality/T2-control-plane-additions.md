# T2 — Control-plane additions: routing-decision table, `succeeded`, `finishRun`

**Program:** `p5-harness-neutrality`
**Depends on:** nothing
**Unblocks:** T4
**Decisions applied:** D-P5-06; A-05, A-13

## Objective

Two small, bounded changes to `core` and the API that the exit gate needs, each
with its rule in `core` and its route covered by the smoke suite. Nothing here
touches the job-node lifecycle.

## Deliverables

1. **Routing-decision update semantics** (D-P5-06): a table in
   `packages/core/src/rules/routing-transitions.ts`: `usage` may be set once
   when the stored value is `{}`; `outcome` may move from `pending` to any
   terminal value and never again; every other field is immutable. `PUT
   …/routing-decisions/{id}` applies it; a second identical `PUT` is a 200; a
   change the table forbids is a 409.
2. **`succeeded`** added to `ExecutionNodeStatus` in `contracts`, and to the
   `core` transition table as `running → succeeded` **guarded by node kind**:
   legal for `program` and `sub-program`, illegal for `job`. The exhaustive
   table test enumerates the new status; the P1 property tests for A-05 pass
   unchanged, and a new test asserts a job node is refused the edge.
3. **`finishRun`** in `core`: the program node's terminal status from the run's
   (`succeeded`, `failed`, `cancelled` for `cancelled` or `interrupted`). The
   execution layer's `run.finish` and shutdown apply it; `PUT node` accepts it
   through the guarded table.
4. **Smoke**: a routing decision updated with usage then refused a second
   change; a run finished with its root node ending `succeeded` and a job node
   refused `succeeded`.
5. Redeploy once.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Then: `npm run deploy`, `npm run smoke`, twice.

## Notes

- The whole point of `succeeded` is that the job-node table is untouched. If
  the implementation finds itself editing a job-node edge or a P1 property
  test, stop.
