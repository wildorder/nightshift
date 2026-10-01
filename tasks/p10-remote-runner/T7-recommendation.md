# T7 — Recommendation

**Program:** `p10-remote-runner`
**Depends on:** T3
**Unblocks:** T8
**Decisions applied:** D-P10-13, D-P10-14

## Objective

Before the first run, `nightshift init` and `plan check` tell the customer
which tier the project needs and why. After three runs, the report, the CLI
and the Studio tell them whether they are paying for more than they use, or
running closer to the edge than they should.

## Deliverables

1. **The probe** (`apps/cli/src/commands/compute-probe.ts`, pure over the file
   system, no execution): `probeRepository(repoPath): ProbeSignals`: the
   lockfile's byte size (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
   `Cargo.lock`, the largest); `workspaces` from `package.json` globs or
   `pnpm-workspace.yaml`; `docker` when a `Dockerfile*` or `docker-compose*`
   exists, or `testcontainers` / `@testcontainers/*` is a dependency, or a
   workflow under `.github/workflows/` uses `services:` or `docker`; `browser`
   when `playwright`, `@playwright/test`, `puppeteer` or `chromium` is a
   dependency; `nativeBuild` when `Cargo.toml` exists or a dependency has a
   `binding.gyp` or is `node-gyp`/`napi-rs` family; `cdkBundling` when
   `cdk.json` exists and `aws-cdk-lib` is a dependency; `maxConcurrency` from
   the config or contract. `recommendFromProbe` (T1) turns it into `{ tier,
   reasons }`.
2. **Where it shows**: `nightshift init` writes `compute.recommended` into
   `nightshift.config.json` and prints the tier and reasons; `plan check`
   recomputes it, prints `compute: better (Docker service tests; six
   workspaces)`, and when the contract or config pins a `compute.tier` below
   the recommendation, adds a non-blocking note (READY is unaffected: the
   customer chooses). `plan-program`'s skill text gains one paragraph on the
   tier and how to override it.
3. **Utilization sampling** (`apps/mcp/src/runner/sampler.ts`): every 30
   seconds, memory used over total (`/proc/meminfo`), CPU busy fraction since
   the last sample (`/proc/stat`), swap used, `/workspace` used fraction
   (`statfs`), OOM kills (`dmesg` lines matching `Out of memory` or
   `oom-kill` since boot, and cgroup `memory.events` for the worker users);
   folded into the heartbeat's `utilizationSample`; the API folds samples into
   the run's `ComputeUtilization` (peaks, the fraction of samples with CPU over
   90%, counts); `wallClockSeconds` and `setupSeconds` from T3.
4. **Right-sizing** (`recommendFromUse`, T1) applied: `GET
   /programs/{programId}/compute/recommendation` reads the last three
   completed runs of the program's project on the project's current tier and
   returns `{ tier, direction: down | up | keep, evidence }` or `insufficient`
   with the count. `nightshift compute recommend <program>` prints it; the
   report's `dispatch` section (T6) adds the recommendation line; the Studio's
   program card shows `recommend: good (peak memory 31%)` or nothing when
   `keep` or `insufficient`.
5. **Nothing moves by itself**: no code path writes `compute.tier` from a
   recommendation. A test asserts that after a `down` recommendation the next
   dispatch without `--compute` still uses the configured tier (or the probe's
   recommendation when none is configured, as D-P10-14's order says).
6. **Tests**: the probe over the five fixture repositories under
   `test/fixtures/compute/` (plain Node, Docker service tests, Rust, CDK
   bundling, six-workspace monorepo) yields the expected signals and tiers
   with their reasons (SC-P10-06); the sampler's fold from hand-built samples;
   the recommendation route for down, up, keep, insufficient; `plan check`'s
   printed line and its non-blocking note; the Studio card for each state in
   jsdom.

## Acceptance

- SC-P10-06 and SC-P10-07 proven offline; live, after T8's three fixture runs,
  `nightshift compute recommend` answers with evidence.
- `npm run verify` and the Studio's typecheck green.
