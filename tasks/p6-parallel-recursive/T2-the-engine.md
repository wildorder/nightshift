# T2 — The engine

**Program:** `p6-parallel-recursive`
**Depends on:** T1
**Unblocks:** T3, T4, T5
**Decisions applied:** D-P6-01, D-P6-02, D-P6-07, D-P6-08; D-P3-04, SC-P3-11

## Objective

Replace "one job, started inline by `delegate`" with an engine that owns a run's
scheduling: delegation writes records, the engine starts workers as slots free
up, and many lifecycles run at once in the orchestrator's process.

## Deliverables

1. **`packages/execution/src/engine.ts`**: `createEngine(environment, session)`
   with `submit(delegation)`, `get(jobId)`, `waitAny(jobIds, deadline)`,
   `cancel(jobId)`, `snapshot()` and `stop(mode)`. `runJob` splits into
   `delegateJob` (persist contract and node, `validated → queued`) and
   `startJob` (agent, token, routing decision, worktree, harness), so a queued
   node has no agent, no token and no worktree until it starts.
2. **Scheduling.** After every submit and every settle: for each `queued` node in
   delegation order, start it if `maySlotStart`. A 429 from the API on the start
   edge is "not yet", not a failure. `P3_MAX_CONCURRENT_CHILDREN` and
   `ConcurrencyRefusedError` go.
3. **The registry** replaces `attached.job`: every started job's handle,
   completion and stop function, keyed by node.
4. **Wall clock** (D-P6-07): past `maxWallClockSeconds` the engine starts nothing,
   and a queued node's `job.get` says so. Not a failure of the node.
5. **Tree-wide shutdown** (D-P6-08): interrupt every running handle in parallel
   within one grace period, cancel queued nodes, end the run `interrupted`, flush
   and spill once. `run.finish` refuses while the registry or the queue is
   non-empty.
6. **Tests** over the fake harness: two jobs overlap; a third queues and then
   starts; the API's 429 is honoured; shutdown with three running and one queued
   leaves five durable statuses.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- The engine never integrates in this task: `finishJob` stops at `implemented`
  and hands the node to T3's queue, which until T3 lands is P3's inline
  verify-and-integrate behind a one-at-a-time lock.
- Every path still ends in a durable status. N lifecycles means N chances to
  leave a node `running`; the registry is what shutdown walks.
