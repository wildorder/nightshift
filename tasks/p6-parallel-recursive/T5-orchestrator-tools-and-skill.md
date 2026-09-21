# T5 — Orchestrator tools and the skill

**Program:** `p6-parallel-recursive`
**Depends on:** T2, T3
**Unblocks:** T6
**Decisions applied:** D-P6-09

## Deliverables

1. `delegate` returns as soon as the delegation is recorded, with
   `status: "queued" | "running"`; it no longer waits for a worker to start.
2. `job.wait { jobIds: string[] }` (a single `jobId` still accepted): returns
   when the first settles, naming which; capped as today.
3. `job.retry { jobId }` (T3).
4. `program.status`: the tree with each node's status, the queue in start order,
   what the merge queue is doing, and the wall clock remaining.
5. `job.get` on a queued node says why it is waiting: a full parent, or a spent
   wall clock.
6. **The skill**: delegate independent work together; give sub-programs a
   narrower scope and a whole objective; do not delegate overlapping scopes
   unless a conflict is acceptable; read `integration_conflict` and
   `verification_failed` and decide between retry and redelegation. The "one job
   at a time" warning goes.
7. Tests for each tool over the real server binary, scripted harness.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```
