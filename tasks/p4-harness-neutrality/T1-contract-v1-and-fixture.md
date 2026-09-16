# T1 — Adapter contract v1, `WorkerTools`, and the conformance fixture

**Program:** `p4-harness-neutrality` (see `docs/programs/p4-harness-neutrality.md`)
**Depends on:** nothing
**Unblocks:** T3, T5, T6
**Decisions applied:** D-P4-01, D-P4-04; A-04, A-05, A-29, A-30

## Objective

Finalize the adapter contract against what three adapters need, and write the
conformance suite that proves the nine Stage 4 items, so every adapter is built
against a specification and judged by one suite. The scripted harness passes it
in `npm test` before any model is involved.

## Deliverables

1. **`packages/harness`, version 1.**
   - `WorkerTools`: `progress(message, percent?)`, `complete(summary) →
     CompleteJobResult`, `fail(reason)`, `recordDecision(input) → Decision`.
     Defined here as an interface; implemented in `packages/execution` over
     `worker.ts` (deliverable 3) and injected into `HarnessStartInput.tools`.
   - `Harness.capabilities`: `{ workspace: "local" | "remote"; usage: boolean }`.
   - `HarnessExit` gains optional `usage: RouteUsage` on `completed` and
     `failed`.
   - The five implementer rules become seven: the worker's tool calls reach
     `WorkerTools` by exactly one transport, and an adapter with a remote
     workspace is responsible for the worktree's contents being identical on
     both sides at `complete`.
   - The brief gains two provider-neutral paragraphs: how to report progress and
     finish when the tools are functions rather than an MCP server, and that the
     working directory is the whole repository, wherever it is.
2. **Version 0 stays implementable.** The Claude adapter and the scripted
   harness compile against v1 with only additive changes (T6 does the Claude
   work; this task keeps the build green).
3. **`WorkerTools` implementation** in `packages/execution/src/worker.ts`,
   `createWorkerTools(environment, identity)`, used by the worker MCP role
   (T6) and by the AgentCore adapter (T5). One implementation, two callers.
4. **The conformance fixture** in `test/fixtures/slice-repo/`: one Job Contract
   whose acceptance requires reading an existing module, changing it, changing
   its test, running the tests, and completing; the same file set the P3 slice
   used, with a job objective written so a real model must explore before it
   edits. Plus the deterministic-failure job (acceptance asks for behaviour the
   fixture's tests contradict) and the cancellation job (the brief asks the
   worker to report progress and wait for an instruction that never comes).
5. **The suite**, `test/src/conformance/harness.ts` grown from the version 0
   seed: the nine §4.3 assertions per adapter, parameterised by a `Harness`
   and a `ConformanceEnvironment` (the local control plane or the deployed
   one). Every assertion reads the control plane, never process memory. The
   version 0 assertions stay.
6. **Scripted harness scripts** for the three fixtures, including one that
   exercises `WorkerTools` directly (as a remote adapter would) rather than
   through the stdio MCP server, so the function transport is tested offline.
7. `npm test` runs the suite against the scripted harness over both transports.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- Resist making `WorkerTools` richer than the four operations. Anything else a
  harness wants belongs behind `start`.
- The brief is shared. A sentence that only one provider needs goes in that
  adapter.
- The suite is the specification. When an adapter cannot pass an assertion, the
  question is whether the assertion states a Nightshift property or a local
  accident; only the second may change, and in §12.
