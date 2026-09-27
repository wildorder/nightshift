# T4 — `resume` retries a failed check, and discards nothing

**Program:** `p9-decision-graph-replay`
**Depends on:** T1
**Unblocks:** T5
**Decisions applied:** D-P9-07

## Objective

A deferred check that fails at `resume` is handled as a run would handle a failed
check: the node is retried, and the rest of the provisional line still lands if
it verifies. Nothing is thrown away for having been built on it.

## Deliverables

1. In `nightshift-resume` (apps/mcp, which can start agents): a deferred node
   whose checks fail at resume ends `verification_failed` and is retried as the
   engine retries (D-P8-07: one rung up, the failed check's command and output in
   the worker's brief as what to fix), at most twice, through the same engine,
   merge queue, verification and examination as a run.
2. The rest of the provisional line, in order, goes through the merge queue on
   whatever head results, each replayed and verified there; a node that conflicts
   or fails is left failed with its reason, and nothing is discarded unverified.
3. `resumeDeferred`'s discard path is removed; `ResumeResult` reports landed,
   retried and failed nodes. The CLI's in-process path (no `resumePath`) keeps
   refusing what it cannot do and says so.
4. The report says, for what still failed, that it is the owner's to plan a
   correction for.
5. Engine and CLI end-to-end tests: a deferred check that fails, is retried and
   lands, and the later provisional work lands on top; one whose retries fail,
   with the rest landing where it still verifies.

## Acceptance

- SC-P9-09 proven offline; P7's resume tests changed only where they asserted a
  discard, listed in the as-built.
