# T1 — Rules and the control plane

**Program:** `p6-parallel-recursive` (see `docs/programs/p6-parallel-recursive.md`)
**Depends on:** nothing
**Unblocks:** T2, T4
**Decisions applied:** D-P6-02, D-P6-04, D-P6-05; A-04, A-05, A-11, A-35

## Objective

Everything P6 needs from `core`, `contracts` and the API, before any engine
exists, each rule pure and each route proven in smoke. No P1 rule or property
test changes.

## Deliverables

1. **Start-edge concurrency** (D-P6-02). `maySlotStart(tree, nodeId, limits)` in
   `core`, defined over P1's `runningChildCount` of the node's parent. The API's
   node creation stops checking concurrency (authority, depth and scope stay);
   the `queued → running` edge checks it and answers 429 with the counts.
   `checkDelegation` itself is untouched: callers that are asking "may this
   exist" pass an open concurrency, and the P1 property still reads it as it
   always did.
2. **Terminal parents.** `checkDelegation` refuses a parent in any terminal
   status, `succeeded` included (P5 added the status after the rule was written).
   Driven from `TERMINAL_STATUSES`, not a literal list.
3. **Integration order** (D-P6-05). `nextToIntegrate(nodes)`: among `implemented`
   job nodes, the lowest delegation ordinal (node id, which is a ULID), or
   `undefined`. Property test: the answer depends only on the set of ready nodes,
   never on their order in the input or on any unready node.
4. **The sub-program ending rule** (D-P6-03). `mayEndSubProgram(tree, nodeId)`:
   a `running` sub-program node none of whose descendants is unsettled.
5. **Delegating tokens** (D-P6-04). `role: "worker" | "orchestrator"` on the
   execution token claims and on the execution `Principal`; minted from the
   agent's role, and only for an orchestrator agent on a `sub-program` node.
   `authorize` gains `ORCHESTRATOR_ACCESS`, a `Record<Operation, …>` like
   `EXECUTION_ACCESS`, with a new reach `own_subtree`; `AuthorizationTarget`
   gains what deciding it needs (the target node's ancestry, resolved by
   `enforce` from the stored tree, never from the request). Writable statuses for
   an orchestrator token: `validated` on a node whose parent is its own node;
   `cancelled` on a descendant; `succeeded` or `failed` on its own node.
   `authorize.test.ts` grows a cell per operation per role, and the route-table
   test holds both tables total.
6. **Contracts.** `delegate`'s `kind`; event types `node.rebased` and
   `integration.conflict`; `RoutingDecision.attempt > 1` already exists.
7. **Isolation suite.** `apps/api/src/isolation.test.ts` gains the orchestrator
   principal: every operation, inside its subtree, on a sibling subtree, in
   another run.
8. **Smoke**: a delegating token creating a child under its own node (201), under
   a sibling (403), minting a token (403); a start past the limit (429).
9. Redeploy once.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Then: `npm run deploy`, `npm run smoke`, twice.

## Notes

- If a P1 property test needs editing, stop. D-P6-02 was designed so that it
  does not.
- Ancestry comes from the stored tree. A token that could name its own ancestry
  could name anyone's.
