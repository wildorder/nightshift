# T6 — Recovery and cancellation

**Program:** `p10-remote-runner`
**Depends on:** T4
**Unblocks:** T8
**Decisions applied:** D-P10-05, D-P10-06, D-P10-18, D-P10-19, D-P10-20

## Objective

A run survives its machine. The reconciler notices a lost lease, fences the
old runner by generation, launches a replacement with the same volume, and the
replacement resumes the orchestrator's session and the engine's state from the
volume and the records. Cancellation stops work within two heartbeats. Resume
by hand is the same path. Every fault leaves a durable explanation.

## Deliverables

1. **Reconciler** (`apps/api/src/lambda/reconciler.ts`, every minute): for
   every dispatch in `provisioning | ready | running | stopping`:
   - **lease lost** (`leaseLost`): `TerminateInstances` on the recorded
     instance (idempotent if already gone); `generation + 1`; a new
     `attempts[]` entry with the reason (`lease_lost`); if `attemptsExhausted`
     → `stopping` with `failure.code = recovery_exhausted`, else `provisioning`
     again through the dispatch Lambda's launch path with the **same volume**
     (re-attached after the old instance is terminated; the volume's zone fixes
     the replacement's zone; a zone capacity error is retried on the next tick
     up to the attempt limit).
   - **wall clock**: `meteredSeconds` past the run's `maxWallClockSeconds` or
     the org's `maxRunHours` → `stopping` with `failure.code = wall_clock`;
     metered USD past `maxUsdPerRun` → `stopping`, `failure.code = run_cap`.
   - **stopping**: if the runner has not reported `stopped` within two
     heartbeat intervals of `stopping`, terminate; then T3's snapshot path.
   - **orphans**: instances tagged `nightshift:managed=true` whose dispatch is
     terminal or missing are terminated and recorded in `cleanup.failures` of
     the dispatch they name (or a `remote-orphans` event when none).
   Everything through `ComputeControl`; the fake drives every branch offline.
2. **Fencing**: the heartbeat, mint, publication and every engine write
   compare `claims.generation` to the dispatch's and refuse `stale_generation`
   (T1's rule); the refused call's body is logged as an event
   (`dispatch.stale_write_refused`) so the report can show a stale runner
   returned. The old runner, on its first refusal, exits.
3. **The replacement resumes** (`apps/mcp/src/runner/recover.ts`): on boot
   with `attempts.length > 1`: mount the volume, `fsck` the mirror and the
   checkout (`git fsck --connectivity-only`), rebuild the engine's view from
   the control plane (`EngineSnapshot` from nodes, verifications, sealed refs
   present under `refs/nightshift/sealed/*` on the checkout, the merge queue's
   order from delegation order), prune worktrees whose node is terminal, keep
   those whose node is `started | implemented`; for each `started` job node
   whose agent is dead: resume the worker's harness session by its recorded
   session id where the adapter supports it (`capabilities.resume`), else the
   existing retry path with the dead attempt's work kept (`33f8970`); resume
   the **root's** session by `rootSessionId` with a brief that says what
   happened and what landed meanwhile; if the root's resume fails, start a
   fresh root from the ratified plan with the run's record as its brief. Then
   `running`. Publication intents `pending` at the crash are re-checked against
   the branch head before anything new is landed (the publisher's lost-reply
   rule).
4. **Cancellation**: `POST /runs/{runId}/dispatch/cancel` → `stopping`, the
   run's `cancel` as today; the heartbeat response carries `stop: true`; the
   runner cancels every agent (`DEFAULT_CANCEL_GRACE_MS`), writes `stopped`
   through one last heartbeat, and exits; the reconciler enforces. A cancel
   during `provisioning` terminates on arrival. A cancel during recovery wins:
   the replacement sees `stopping` on bootstrap and stops.
5. **Resume by hand**: `POST /runs/{runId}/dispatch/resume` on a `stopped`
   dispatch whose `cleanup.snapshotId` exists and is within seven days: a new
   volume from that snapshot, `generation + 1`, `attempts[]` reason `resume`,
   the launch path, the recovery path on boot; the run's status follows
   P7/P9's `resume` semantics (deferred steps run, provisional work lands when
   it passes). After seven days, refused with the date the snapshot was
   deleted. `nightshift remote resume <program> [--run]` calls it.
6. **Budgets across recovery**: `spend.meteredUsd` and `meteredSeconds`
   accumulate across attempts; the inference budget is the run's as before;
   a test shows a recovered run refused at the same caps as an uninterrupted
   one.
7. **The deterministic fault battery** (`test/src/remote/faults.test.ts`, in
   `npm test`), over the fake compute, a fake GitHub and the memory plane:
   lost push acknowledgement; external branch movement; a stale runner
   writing after replacement (refused, event recorded); cancellation during
   recovery; budgets preserved; attempts exhausted → `recovery_exhausted` with
   the snapshot taken; snapshot failure → `stopped` with `cleanup.failures`;
   zone capacity error on relaunch → retried then exhausted; a replacement
   finding a `pending` publication already on the branch; the root's resume
   failing → fresh root started with the record as brief. Each case asserts
   the dispatch's final record explains itself (SC-P10-10).
8. **Report and Studio**: `gatherReport` gains a `dispatch` section (tier,
   class, attempts with reasons, metered cost, publication outcome, cleanup
   outcome, retention date); `renderReport` prints it; the Studio's run status
   tab shows the dispatch status, generation and attempts, and the program
   page's run list shows the tier and cost.

## Acceptance

- SC-P10-09, SC-P10-10, SC-P10-11's cancellation bound and SC-P10-13 proven:
  offline through the battery; live by killing the runner process (`kill -9`
  over SSM) and, separately, terminating the instance during a fixture run,
  both recovering to the published branch under the same run id.
- `npm run verify` green.
