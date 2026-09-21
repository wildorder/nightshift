# T3 — The merge queue

**Program:** `p6-parallel-recursive`
**Depends on:** T2
**Unblocks:** T5, T6
**Decisions applied:** D-P6-05, D-P6-06; A-05, A-10, A-29

## Objective

One serial pipeline per run, the only route to the program branch: reconcile,
verify on the head, seal, fast-forward, checkpoint.

## Deliverables

1. **`packages/execution/src/merge-queue.ts`**: a loop the engine wakes when a
   node becomes `implemented` or the pipeline goes idle. It asks `core`'s
   `nextToIntegrate` and processes exactly one node at a time.
2. **Reconcile.** If the program head is the node's base, nothing to do.
   Otherwise replay the snapshot onto the head in the node's worktree, producing
   a new Nightshift-authored commit with the original message and trailers plus
   `Nightshift-Rebased-From`, update the node's `commitSha` (legal: the node is
   `implemented`, not yet verified), re-run the scope check, and emit
   `node.rebased { from, onto, commitSha }`.
3. **Conflict** (D-P6-06): abort the replay, leave the worktree as the worker
   left it, fail the node with `integration_conflict` and the conflicting paths
   as `outcomeReason`, emit `integration.conflict`. The pipeline moves on.
4. **Verify on the head**, then seal, fast-forward and checkpoint as P3 does.
   The fast-forward is a compare-and-swap on the branch ref as well as
   `--ff-only`; losing it re-enters reconcile rather than failing.
   `verifyNode` moves out of `finishJob` and into the queue.
5. **`retryJob`** (D-P6-06): `failed | verification_failed | interrupted` →
   `retry → queued`; on start, a fresh worktree from the current head, a new
   agent, a new `RoutingDecision` with `attempt + 1` and `previousRouteId`. The
   old worktree is removed at that point and not before.
6. **Tests** with real git: two clean jobs integrate in delegation order even
   when the later one finishes first; a stale base is rebased, recorded,
   verified and integrated; a conflicting pair leaves one integrated, one
   `integration_conflict`, and a retry of it integrates; an incompatible pair
   leaves the second `verification_failed` and a branch that still verifies;
   every commit on the branch has a passed `Verification` for that commit.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- Never resolve a conflict. Not with `-X theirs`, not with a retry loop.
- "Delegation order even when the later finishes first" means the queue does not
  wait for unfinished nodes: order is decided among what is ready *now*.
