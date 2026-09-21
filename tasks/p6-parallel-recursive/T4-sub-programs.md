# T4 — Sub-programs

**Program:** `p6-parallel-recursive`
**Depends on:** T1, T2
**Unblocks:** T6
**Decisions applied:** D-P6-01, D-P6-03, D-P6-04; A-11, A-39

## Objective

A sub-program is a node with its own orchestrator: launched like any worker,
holding a delegating token, able to delegate within its subtree and nothing else.

## Deliverables

1. **`delegate { kind: "sub-program", objective, scope, acceptance }`**: a
   `sub-program` node (no Job Contract commit of its own), an `orchestrator`-role
   agent, routed and started by the engine through the same adapters.
2. **The sub-orchestrator MCP role** in `apps/mcp` (`NIGHTSHIFT_ROLE=
   sub-orchestrator`), holding only its execution token, with exactly the tools
   of D-P6-03. Its `delegate` validates the contract, narrows scope from its own
   node's, and writes the contract and a `validated` child through the API. It
   starts nothing. `job.wait` and `job.get` read the control plane, as the
   root's already do.
3. **Discovery** (D-P6-01): while any sub-orchestrator is running the engine
   reads the run's nodes once a second, enqueues `validated` nodes it did not
   create, and stops the worker of any running node it finds `cancelled`.
4. **Its working directory**: a detached checkout of the program head under the
   state directory, refreshable with a tool, never snapshotted, removed when the
   node ends.
5. **The sub-orchestrator brief** in `packages/harness`, provider-neutral: what a
   sub-program is, that it delegates and does not edit, how to read a conflict
   and a verification failure, how to finish. Adapter addenda stay per adapter.
6. **Endings**: `subprogram.complete` is refused while a child is unsettled
   (`mayEndSubProgram`); `subprogram.fail` cancels what is left. A
   sub-orchestrator that exits without either fails its node and cancels its
   subtree. Cancelling a sub-program cancels its subtree (D-P6-08).
7. **Tests**: a fake sub-orchestrator delegates two children that the engine
   finds and runs; delegation outside its scope, past the depth limit, and under
   a sibling are each refused by the API; edits in its directory reach no commit.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- The sub-orchestrator's server imports no execution engine. If it needs
  `runJob`, the design has been left.
- One transport per worker still holds: a sub-orchestrator is reached through
  its MCP launch.
