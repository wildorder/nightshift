# T5 — The execution layer

**Program:** `p3-vertical-slice`
**Depends on:** T1, T2, T4
**Unblocks:** T6
**Decisions applied:** D-P3-04, D-P3-05, D-P3-06, D-P3-09, D-P3-10; A-04, A-05, A-06, A-10, A-11

## Objective

Build the machinery that turns a validated Job Contract into an integrated,
checkpointed commit, in `packages/execution`, against the `NightshiftStores`
ports and the `Harness` interface only. This is the Stage 3 pipeline: worktree,
worker, progress, result, verification, sealed commit, integration, checkpoint.
It must not know which adapter or which store it has.

## Deliverables

1. **Paths and state directory** (D-P3-10), reusing T3's session paths:
   worktree, run and agent directories under `NIGHTSHIFT_STATE_DIR`.
2. **Git operations** in `src/git/`, each a thin function over `git` via
   `child_process` with an injectable runner: worktree add and remove, head of a
   branch, dirty check, snapshot commit (stage everything under the worktree,
   soft-reset any worker commits onto the base, commit with the Nightshift
   author and the run/node/job trailers), changed paths between two commits,
   ref create, fast-forward merge, clean checkout (`reset --hard` and
   `clean -fd`). Every command runs with `-c` identity overrides so the
   operator's git config is never the author.
3. **Scope check at commit** (D-P3-05): the changed paths of the snapshot must
   all be matched by the effective scope's `includes` and none by `excludes`,
   using `globContains`-compatible matching from `core` (add a path matcher
   there if the containment helper cannot serve; keep the semantics in one
   place). Violations list every offending path.
4. **The job runner**: given stores, a harness, a clock and an id generator,
   `runJob(context, jobContract, scopeRequest, routeTarget)` drives the
   lifecycle in the contract §4.3, writing every transition through the stores
   *in the order the table lists* so the central record always leads the
   process: contract, node `validated → queued`, agent `created`, routing
   decision, worktree, harness `start`, node `running`, agent `started`, wait,
   then the result path. Node and agent transitions go through `core`'s
   `transition`, `markImplemented`, `markVerified`, `markVerificationFailed`
   and the T2 tables; the runner never assigns a status string directly.
5. **Verification** (D-P3-06): after the worker exits `completed` and the node
   is `implemented`, clean-checkout the candidate commit, run T4 against the
   program contract's steps, upload each step's output as a `verification-log`
   artifact through `ArtifactBodyStore`, write the `Artifact` records, then
   the `Verification`, then transition. A worker exit that is not `completed`
   never reaches this step.
6. **Seal, integrate, checkpoint** (D-P3-05): sealed ref; program checkout
   must be clean and its branch head must still equal the worktree base, else
   `failed` with `stale_base` or `program_checkout_dirty`; `merge --ff-only`;
   node `integrated`; checkpoint ref and record; worktree removed. On any
   failure the worktree stays and the node's `outcomeReason` names it.
7. **The worker-side half**, used by the worker MCP role (T6):
   `completeJob(context)` performs the scope check and the snapshot commit and
   moves the node to `implemented` with the sha; `failJob(context, reason)`;
   `reportProgress(context, message)`. These live here so the two server roles
   share one implementation of "what a completed job is".
8. **Outbox and spool** (D-P3-10): `EventOutbox` with `emit(type, source,
   payload, ids)`, deterministic idempotency keys (`<source>:<writerId>:<n>`),
   ordered delivery through `events.append` with bounded retry, `flush(deadline)`,
   `spill(path)` and `replay(path)`. `HookSink` from T1 is implemented over it.
   Transcript upload: the harness handle's transcript file, if any, becomes a
   `transcript` artifact after exit.
9. **Shutdown**: `shutdown(reason)` cancels a running harness, records agent and
   node `interrupted`, flushes the outbox, spills what is left. Idempotent.
10. Tests, offline, using: the in-memory stores behind the local control plane
    from T2 (so every API rule is in the loop, never the memory stores
    directly), a fake harness implementing T1's interface in-process, and real
    git in a temporary repository. Cover every row of the lifecycle table and
    every failure path in the contract §4.3, plus: the central record exists
    before `start` is called (assert store state inside the fake `start`);
    the program checkout is untouched until integration; a dirty program
    checkout refuses integration; a moved program branch is `stale_base`; the
    outbox replays a spool without duplicating an event; shutdown with a
    running worker leaves `interrupted`.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`packages/execution` depends on `@nightshift/contracts`, `@nightshift/core`,
`@nightshift/harness` and `@nightshift/verification` (add the reference to the
layer table and the scaffold map). No adapter, no provider SDK, no
`@nightshift/persistence/*` import: stores arrive injected.

## Notes

- Order of writes is the whole of SC-P3-02. Write the test that fails if
  `start` is called before the node is `queued` and the agent `created` before
  writing the runner, and keep it.
- `job.complete` is worker-initiated and the verification that follows is not.
  The seam between deliverables 7 and 5 is A-05 in code: nothing in 7 may
  write a `Verification` or move a node past `implemented`.
- Run-wide concurrency is scheduler policy (P1 decision log). P3 enforces "one
  running child under the root" in the runner with a typed refusal, and says in
  the refusal that P5 lifts it.
- Windows: paths under the state directory can get long; keep the worktree
  path short (`<state>/wt/<runId-tail>/<nodeId-tail>` is acceptable if the full
  ids are recorded on the node result). Killed processes report no signal;
  record `failed` with the exit code (contract §4.3).
