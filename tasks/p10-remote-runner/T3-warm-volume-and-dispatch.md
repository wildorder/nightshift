# T3 — Warm volume and dispatch

**Program:** `p10-remote-runner`
**Depends on:** T2
**Unblocks:** T4, T7
**Decisions applied:** D-P10-02, D-P10-09, D-P10-15, D-P10-18, D-P10-19

## Objective

`nightshift run <program> --remote` refuses what it must, records a dispatch,
and a machine comes up with the project's warm volume mounted, the repository
checked out at the authorized SHA, the plan hash verified and the program's
setup run against the stores. The second run of a project is measurably warm.

## Deliverables

1. **CLI** (`apps/cli/src/commands/run.ts`, `run-program.ts`): `--remote` is
   accepted for a planned program only (D-P10-09); `--compute <tier>`. Before
   anything: the working tree is clean (`git status --porcelain` empty), the
   program branch's head equals `origin/<branch>` (`git rev-parse` both; a
   missing remote branch is its own message), the plan is ratified and its
   hash matches the ratification, and the chosen tier is within the org's
   ceilings (read through the API). Then `startRun` as today, then `POST
   /runs/{runId}/dispatch` with an idempotency key derived from `(runId,
   baseSha, planHash)`. Prints run id, tier, class, `$/hour`, the estimated cost
   at the run's wall-clock ceiling, and the dispatch status. Exits 0 on
   `requested`; the laptop may close. `nightshift remote status <program>
   [--run]` prints the dispatch record; `cancel` and `resume` call their routes
   (T6 makes them do everything they should).
2. **The API refuses independently** (`apps/api/src/operations/dispatch.ts`):
   using the GitHub App's installation token for the org, it reads
   `GET /repos/{owner}/{repo}/branches/{branch}` and refuses when the head is
   not the requested `baseSha`, when the repository is not in the org's
   recorded installation, when the plan hash is not the ratified one, and when
   `mayDispatch` says no. Nothing the CLI claimed is trusted (SC-P10-02).
3. **Dispatch Lambda** (`apps/api/src/lambda/dispatch.ts`, invoked
   asynchronously from the route): `requested → provisioning`; picks a zone
   (round-robin over the four, the snapshot being region-wide); `WarmCache` for
   the project and architecture → `CreateVolume` from its snapshot, else an
   empty gp3 of the tier's size, tagged `nightshift:managed=true`,
   `nightshift:runId`; writes the bootstrap secret to SSM; `RunInstances` with
   the launch template, the tier's type, the zone, the tags, and the volume
   attached as `/dev/xvdf`; records `instanceId`, `volumeId`,
   `availabilityZone`, `amiVersion`, `generation: 1`, `attempts[0]`. Failure at
   any step is `failed` with the AWS error, after terminating or deleting what
   was created. Everything through the `ComputeControl` port; the fake in
   `test/src/remote/fake-compute.ts` drives the offline tests.
4. **Runner workspace** (`apps/mcp/src/runner/workspace.ts`): formats the
   volume if it has no filesystem (first run), mounts it at `/workspace`;
   `mirror.git` fetched or cloned from GitHub with the installation token the
   heartbeat response carries (`credentials.github`, read scope, short-lived);
   `checkout/` created or fast-forwarded to `baseSha` from the mirror, refusing
   a divergent checkout (a fresh one is made beside it and the old one removed);
   `stores/` with `npm_config_cache`, `PNPM_HOME`/`pnpm store path`,
   `CARGO_HOME`, `PIP_CACHE_DIR`, `UV_CACHE_DIR` exported into **every** process
   the runner starts (the root, the workers, verification) through
   `ExecutionEnvironment`; the plan document's hash recomputed from the checkout
   and compared to the dispatch's `planHash` before any agent starts; the
   program's `setup` run once in `checkout/` with its duration recorded as
   `ComputeUtilization.setupSeconds`. `ready` is written after that.
5. **Snapshot at end** (`apps/api/src/lambda/reconciler.ts`, the part that is
   not recovery): when a dispatch reaches `stopping` with the run ended,
   `CreateSnapshot` of the volume (tagged), wait for `completed`, write the
   project's `WarmCache` (`lockfileHashes` from the checkout's lockfiles,
   reported by the runner on its last heartbeat) with the previous head pushed
   into `history`, delete the volume, delete snapshots older than seven days or
   beyond the three newest, record `cleanup`, `stopped`. A snapshot is taken only
   if the run's setup passed at least once; otherwise the volume is deleted and
   the cache pointer is left alone. Any failure lands in `cleanup.failures`
   and the dispatch is still `stopped`.
6. **`nightshift init`**: writes `npm ci --prefer-offline` for npm and `pnpm
   install --frozen-lockfile` for pnpm as the detected setup, and runs the
   probe (T7 owns the probe's rule; here `init` only calls it if present).
7. **Cold-to-warm measurement** (`scripts/remote-warm.mjs`, part of T8's
   fixture later): two consecutive dispatches of the fixture repository, the
   `setupSeconds` of each read from the utilization records, the ratio printed
   and asserted under 0.1 (SC-P10-08).
8. **Tests, offline**: the CLI's refusals, each with its message; the API's
   four refusals with a fake GitHub; the dispatch Lambda over the fake compute
   (happy path, volume-from-snapshot, empty volume, failure mid-way cleans up);
   idempotency (same key twice is one dispatch, different key for the same run
   is refused); the snapshot lineage (history of three, deletion of the fourth,
   no snapshot after a failed setup); the plan-hash mismatch stops before any
   agent (fake runner).

## Acceptance

- SC-P10-02 and SC-P10-03 proven offline, SC-P10-05's record half proven.
- Live, by hand from a developer machine: a dispatch of the fixture reaches
  `ready` with the checkout at the SHA and setup green; the second reaches
  `ready` from a snapshot and its setup is under a tenth of the first's.
- `npm run verify` green.
