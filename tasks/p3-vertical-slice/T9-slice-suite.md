# T9 — Fixture repository, scripted harness and the offline slice suite

**Program:** `p3-vertical-slice`
**Depends on:** T6
**Unblocks:** T10
**Decisions applied:** D-P3-11; contract §6, §8

## Objective

Prove SC-P3-01 … SC-P3-15 in `npm test`, on both CI legs, with no LLM and no
AWS: a fixture repository, a scripted harness that is a real process, the local
control plane, the real MCP server in both roles, real git. Make the same suite
runnable against the deployed control plane and the real adapter for T10.

## Deliverables

1. **Fixture repository** at `test/fixtures/slice-repo/`: a small Node project
   with two or three modules and tests on the built-in runner (`node --test`),
   no dependencies, an authored `nightshift.program.json` with stable ids, a
   `verification` of `node --test` and a second cheap step, `delegationLimits`
   `{ maxDepth: 1, maxConcurrency: 1 }`, and an examination policy with
   `required: false` for every level. A materializer in the suite copies it to
   a temporary directory, runs `git init`, commits, creates the program branch
   and returns the paths. Nothing under `test/fixtures` is a git repository in
   the monorepo.
2. **Scripted harness** at `test/src/harness/scripted.ts`, implementing T1's
   `Harness`. `start` spawns a real `node` child running
   `test/src/harness/worker.ts` (built), which launches the worker MCP server
   from `input.mcp` over stdio with the SDK client and follows a named script:
   - `implement`: read a source file, edit it, add a test, call
     `job.progress` twice, call `job.complete`, exit 0.
   - `implement-broken`: as above, but the added test fails.
   - `out-of-scope`: edits a file outside the job's includes, then
     `job.complete`.
   - `hang`: `job.progress` once, then wait until killed.
   - `fail`: `job.fail` with a reason, exit 0.
   - `silent-exit`: edit, exit 1 without reporting.
   The harness emits `agent.started` and `agent.completed` / `agent.failed` /
   `agent.interrupted` from the child's lifecycle, and `tool.called` for each
   MCP call the script makes, through the `HookSink`, so SC-P3-12 has a subject.
   It passes T1's conformance test.
3. **The suite** at `test/src/slice/`, one file per outcome group, each test
   starting the orchestrator-role MCP server as a child over stdio and driving
   it with the SDK client exactly as Claude Code would (`run.start`, `delegate`,
   `job.wait`, `job.get`, `program.status`), against the control plane chosen
   by `NIGHTSHIFT_SLICE_TARGET` (`local`, default; `deployed`) and the harness
   chosen by `NIGHTSHIFT_SLICE_HARNESS` (`scripted`, default; `claude`). The
   MCP server's harness choice is injected through its composition root by
   environment, so the server under test is the real binary.
   - SC-P3-01: `delegate` with an invalid contract is refused with
     `validation_failed`; with a widening scope, `scope_widening`; nothing is
     persisted in either case.
   - SC-P3-02: the fake-side assertion from T5 repeated through the real
     server: when the scripted worker starts, the job, node (`running`) and
     agent (`started`) are already readable from the control plane.
   - SC-P3-03, SC-P3-04: the worktree exists under the state directory on the
     job's branch; the program checkout is clean and lacks the edited file
     until integration; after integration the program branch head is the
     sealed commit.
   - SC-P3-05: `GET …/events` shows `node.progress` events with source `mcp`
     during the run, before `job.complete`.
   - SC-P3-06: immediately after `job.complete` the node is `implemented`, not
     `verified`; no `Verification` exists yet.
   - SC-P3-07: `implement-broken` ends `verification_failed` with a
     `Verification` whose failing step names the test, a log artifact whose
     body (read back from the local control plane's `bodies`, or from S3 when
     deployed) contains the failure, and the program branch unmoved.
   - SC-P3-08, SC-P3-09, SC-P3-10: `implement` ends `integrated`; the sealed
     ref, the fast-forwarded branch, the checkpoint ref and record all point at
     the same commit; the commit's author is Nightshift and its trailers name
     the run, node and job.
   - SC-P3-11: `hang`, then kill the worker's pid from `job.get` externally;
     the node and agent end `interrupted` (or `failed` with the exit code on
     Windows), `outcomeReason` set, and the state is readable from the control
     plane after the orchestrator server is closed and reopened with
     `run.attach`.
   - SC-P3-12: every hook-sourced event in the events list has
     `source: "hook"`, and the `silent-exit` script (which calls no tool)
     still yields `agent.started` and `agent.failed`.
   - SC-P3-13: `out-of-scope` ends `failed` with the offending path in
     `outcomeReason`, nothing sealed, branch unmoved.
   - SC-P3-14: covered by the architecture suite; reference it.
   - SC-P3-15: the whole file set runs under `npm test` with no credentials
     and no endpoint other than the loopback control plane; assert that every
     URL the servers were configured with names `127.0.0.1`.
4. **Deployed mode**: `NIGHTSHIFT_SLICE_TARGET=deployed` reuses the smoke
   suite's context to obtain a machine token and the endpoint, writes into a
   throwaway `slice-<ulid>` project with a membership for the machine
   principal, and cleans up as the smoke suite does. Artifact bodies are read
   back from S3 with the AWS SDK, so this mode lives in a file that only runs
   when selected. A root `npm run slice` script guards the account, runs the
   deployed and scripted pair, then the deployed and Claude pair, and prints the
   run identifiers.
5. Timeouts and isolation: `test/vitest.config.ts` sets the slice files'
   `testTimeout` and `hookTimeout` explicitly (project configs do not inherit
   the root's), `fileParallelism` off for the slice files, and every test uses
   its own temporary state directory and fixture copy.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Both CI legs green. The layer table gains `apps/api`, `apps/mcp`,
`packages/execution`, `packages/verification` and `packages/harness` for `test`
(D-P3-12), and `@modelcontextprotocol/sdk` appears in `test` for the client.

## Notes

- The suite drives the real server over stdio with a real client so that the
  tool surface, the role split and the stdio lifecycle are under test, not a
  function call that resembles them.
- `job.wait` is the orchestrator's clock, but the assertions read the control
  plane. A test that reads process memory proves nothing about SC-P3-11.
- Watch total runtime: worktrees, four child processes per job and git. If a
  test group exceeds a minute on the Windows runner, split the fixture jobs
  rather than raising the timeout further.
- Cleanup in deployed mode must run when an assertion fails and must report,
  never swallow, its own failure (P2 T7).
