# T2 — The control plane: the grown contract, plan status and hash, `awaiting_human`

**Program:** `p7-planning`
**Depends on:** T1
**Unblocks:** T4, T5
**Decisions applied:** D-P7-01, D-P7-03, D-P7-06, D-P7-10

## Deliverables

1. `PUT program` accepts the grown contract. A contract's `status` moves
   `planning → ratified` only with a `ratifiedPlanHash`; a ratified contract's
   plan fields are immutable, and re-ratifying is a new hash with the old one
   kept in a short history.
2. `PUT run` for a program whose contract has workstreams is refused unless the
   contract is `ratified` (SC-P7-05). A contract with no workstreams runs as it
   does today (SC-P7-14).
3. `ExecutionNodeStatus.awaiting_human`: reached from `queued`, left to `queued`.
   Off the path to `verified`; the P1 properties are untouched, and a test says
   so. `isSettled` does not include it: it is waiting, not finished.
4. Prerequisite status: a dedicated write, user principals only, that records
   the `verifyCommand`'s exit code and when it ran. Execution tokens may read
   prerequisites and may not write them, in both access tables.
5. Tests for each; the isolation suites gain the new routes; smoke covers
   ratify, the refused unratified run, and the prerequisite write.
6. Redeploy once.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

Then: `npm run deploy`, `npm run smoke`, twice.
