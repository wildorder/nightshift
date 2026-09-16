# T1 — Harness adapter contract, version 0

**Program:** `p3-vertical-slice` (see `docs/programs/p3-vertical-slice.md`)
**Depends on:** nothing
**Unblocks:** T5, T8
**Decisions applied:** D-P3-03, D-P3-09, D-P3-15; architecture §1, §5, vision "Harness adapter"

## Objective

Define, in `packages/harness`, the interface the execution layer drives a worker
through, around only what Nightshift needs. No provider code. P4 finalizes this
contract against three adapters; version 0 exists so that T5 is written against
an interface and T8 against a specification.

## Deliverables

1. `packages/harness/src/`:
   - `Harness` with `id`, `start`, `cancel`, `status`, as sketched in the
     contract §4.6. `cancel` takes a grace period: a cooperative stop first, a
     hard kill after.
   - `HarnessStartInput`: the `Agent`, `ExecutionNode`, `JobContract` and
     `ProgramContract` records, the worktree path, the `RouteTarget`, the
     `McpLaunch` (command, args, env) for the worker MCP server, and a
     `HookSink`.
   - `HarnessHandle`: `agentId`, optional `pid`, `exit: Promise<HarnessExit>`,
     optional transcript path. `HarnessExit` is a discriminated union:
     `completed`, `failed { exitCode }`, `interrupted { signal }`, `cancelled`.
   - `HookSink`: `emit(event: HookEvent): void`, where `HookEvent` carries an
     `EventType` from `@nightshift/contracts` restricted to the hook-sourced set
     in the contract §4.7, an `occurredAt`, and a small payload. Never a harness
     event name. Emission is ordered and non-blocking; delivery is the
     execution layer's outbox (T5).
   - The `Scope.permissions` vocabulary (D-P3-15) as exported constants in
     `@nightshift/core` (`PERMISSION_FS_READ` …), re-exported here, with a
     helper that reports which of them a scope grants. An unknown permission
     string is not an error in `core` (the contract allows any string) but the
     adapter must treat it as "not granted".
2. A **prompt assembly helper** the adapters share, `renderWorkerBrief(input)`:
   the objective, effective scope, acceptance criteria, program constraints, the
   instruction to report through the Nightshift tools and never to commit, in
   plain text. Provider-neutral; adapters may append.
3. A contract test, `describeHarnessConformance(harness, fixture)`, in
   `test/src/conformance/harness.ts`, exported from `@nightshift/test`. It is
   the seed of P4's shared suite and asserts only what version 0 promises: a
   handle is returned with the agent's identity; `exit` settles exactly once;
   `cancel` on a running agent settles `exit` as `cancelled`; `status` agrees
   with `exit`; every `HookSink` event carries a hook-sourced `EventType`.
   T9's scripted harness is its first subject.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`packages/harness` depends on `@nightshift/contracts` and `@nightshift/core`
only. No Node builtin import in the interface module; the adapters spawn
processes, the contract does not.

## Notes

- Resist adding to the interface what a specific harness makes easy. The source
  plan's rule cuts both ways: do not force every harness down to the least
  capable feature set, and do not put one harness's features into the contract.
  Provider-specific capability goes behind `start`.
- `status` exists because P8 needs to ask a remote runner about an agent it did
  not spawn in this process. In P3 it is answered from the handle.
- Write the interface documentation as if T8's author has never seen this
  repository: what each field is for, and which events the adapter must emit
  without the worker's cooperation (D-P3-09).
