# T6 — The fixture, the eleven proofs, the benchmark

**Program:** `p6-parallel-recursive`
**Depends on:** T3, T4, T5
**Unblocks:** T7
**Decisions applied:** all; SC-P6-01 … SC-P6-17

## Deliverables

1. **The fixture program** (contract §4.3): `maxDepth 2`, `maxConcurrency 2`; the
   slice repository grows enough modules for A, B, C1 and C2 to be independent,
   plus the conflicting pair and the incompatible pair.
2. **Scripted harness**: scripts for each job, each taking a configurable delay so
   overlap is observable, and a **scripted sub-orchestrator**: a real child
   process speaking to a real sub-orchestrator-role MCP server.
3. **`test/src/parallel/`**, over the real server binary and the local control
   plane, one test per Stage 5 proof (SC-P6-01 … 11), each reading the control
   plane and the repository, never process memory. Concurrency is asserted from
   event sequences, not from timing.
4. **SC-P6-15** as a sweep over the finished run: every commit between the base
   and the program head has a passed `Verification` naming it.
5. **SC-P6-16**: kill the server with two workers and the sub-orchestrator
   running; read back durable statuses.
6. **The benchmark** (SC-P6-12): `npm run benchmark:parallel`, the fixture at
   `maxConcurrency 1` and at `2`, scripted delays fixed, wall clock printed. Not
   part of `npm test`; its correctness half (both runs reach the same tree of
   statuses) is.
7. **SC-P6-17**: the P1, P4 and P5 suites untouched and green.

## Acceptance

```sh
npm run verify
npm run check:architecture
```

## Notes

- A proof that passes because of a `sleep` will fail on the Windows leg. Use the
  scripts' own progress events as barriers.
