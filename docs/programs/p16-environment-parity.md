# Program P16 — Environment Parity

| Field | Value |
|-------|-------|
| Program ID | `p16-environment-parity` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p16-environment-parity` |
| Source stage | none: the owner's direction of 2026-10-08, after keki-backend's `lightning-ux` remote run (`run_01M4ETF3JX06TFX821DX4E8TD1`) |
| Status | **Planned**, 2026-10-09: `plan check` READY; awaiting ratification |
| Depends on | P10 (the runner, D-P10-29), P15 (gate health, the run-start audit, red-base repair) |

This document is the stable authority for P16. Its plan, contract and kept
conversation are in `docs/programs/p16-environment-parity/`. The success
criteria, strands, decisions and their answers live in `contract.json`; the
why and the how live in `plan.md`. Amend either only through a human
decision.

## Objective

Make a remote run's machine the environment the plan's gate audit certified,
and make the developer's walk-away moment the moment the machine has proved
it.

## Why

On 2026-10-08 keki-backend's `lightning-ux` was audited green on the owner's
laptop (Node 22, Docker). It was then dispatched to a machine with Node 24 and
no Docker for its worker users. The machine did three things wrong:

- It counted its Docker gates' deferrals as failures, because HP-01 had been
  checked on the laptop.
- It failed a unit test that only fails on Node 24.
- It called the base red and opened a repair job against keki's code.

The owner's ruling: a run that is green where it was planned and fails on the
machine cannot happen. The machine adapts to the project, never the reverse.

## Exit trial

These are the owner's, after the program lands, because deploying and image
builds are forbidden to the run:

1. Deploy, and build the runner image.
2. Run `npm run runner:boot` and see the Node and Docker checks pass as a
   worker user.
3. Dispatch keki-backend's `lightning-ux` remotely and see it reach OK GO and
   start its strands.

## S-01 as built

S-01 gives a dispatched machine the project's own language runtimes and
working Docker, and keeps Nightshift's own processes off them. This is what
landed, in plain terms, for whoever reads this next.

### What exists now

- **The pins rule** (`packages/core/src/rules/pins.ts`): `resolvePins` reads a
  project's `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`,
  `.go-version`, `.java-version`, `rust-toolchain.toml`/`rust-toolchain`,
  `.tool-versions` and `package.json#volta.node` (`engines.node` only as a
  fallback when nothing else pins Node), and refuses when two files disagree.
  `satisfiesPin` is an npm-range matcher (exact, partial, `^`, `~`, `x`,
  hyphen ranges, `||`, and Rust's channel names). `dispatchToolchain` turns
  the pins plus the laptop's measured versions into the exact versions a
  dispatch carries, refusing a measured version that is itself partial (a
  measured Node `22` is not enough — the dispatch needs `22.22.0` or whatever
  patch the laptop actually ran).
- **`nightshift run --remote` measures its own laptop** before anything is
  written to the control plane or a machine is paid for: `assertRemoteReady`
  in `apps/cli/src/commands/remote.ts` calls the exported `measureToolchain`,
  which reads the pin files at the dispatched commit (never the working
  tree), runs each pinned runtime's `--version` on the laptop, and refuses
  with both versions named — the pin and what the laptop measured — when a
  runtime is missing or its version does not satisfy the pin. On success the
  exact versions go on the dispatch as `input.toolchain`
  (`DispatchInputSchema.toolchain` in `packages/contracts/src/v1/dispatch.ts`,
  `DispatchToolchainSchema`, one entry per runtime, each an exact version by
  `isExactRuntimeVersion`, never a pin or a range).
- **The machine installs them before setup.** `installRuntimes` in
  `apps/mcp/src/runner/workspace.ts` runs `mise install <runtime>@<version>`
  for every pinned runtime but Rust, into `/workspace/stores/runtimes`
  (`RUNTIMES_DIR`, on the volume), and checks each with its own `--version`.
  A failed install, or an install that reports a different version, stops the
  workspace with the tool's own words. This runs before the program's `setup`
  step, so setup itself sees the pinned runtimes.
- **Runtime versions join the warm key.** `NIGHTSHIFT_RUNTIMES` becomes
  `runtime:<name>` entries beside the lockfile hashes in the install marker
  (`runtimeHashes` / `installHashes` in `@nightshift/verification`), so a tree
  installed for one Node is reinstalled when the dispatched Node changes.
- **One project environment**, computed once and pure
  (`projectEnvironment` in `workspace.ts`): each pinned runtime's own `bin`
  first on `PATH`, then the image's `PATH`, then whatever the runner
  inherited; the store variables (`npm_config_cache`, `PNPM_HOME`,
  `CARGO_HOME`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, …) pointed at the volume;
  `JAVA_HOME` and `RUSTUP_HOME`/`RUSTUP_TOOLCHAIN` when those runtimes are
  pinned; `DOCKER_HOST` on a worker's own socket when a uid is given. It is
  written once to `<run>/project.env`
  (`apps/mcp/src/project-env.ts`), which the orchestrator-role server reads
  at startup (`createRuntime` in `apps/mcp/src/compose.ts`) and threads
  explicitly (S-02, D-10): `ExecutionEnvironment.projectEnv` is given to
  every step that runs the project's code (setup, verification and its
  reruns, examination checkouts, the setup reference), the runner gives
  `context.projectEnv` to the machine's audit and prerequisite checks, and
  each worker user gets it through `RunAs.env`
  (`createWorkerUsers({ projectEnv })` in `apps/mcp/src/run-as.ts`). No
  Nightshift process adopts it into its own `process.env`. The boot proof
  reads the same file.
- **Docker per worker, on its first connection**, not at boot
  (`infra/cdk/src/lib/runner-image.ts`): each worker's rootless daemon is
  installed by Docker's own `dockerd-rootless-setuptool.sh` while it still
  listens on the conventional `/run/user/<uid>/docker.sock`; the daemon is
  then moved to a private socket, and the conventional path becomes a
  `docker.socket` that a `systemd-socket-proxyd` service answers, pulling the
  real daemon up on demand and forwarding to it. An idle worker has the
  socket listening and no `dockerd`. `packages/harness/src/run-as.ts`'s shell
  line sets the target user's own `XDG_RUNTIME_DIR=/run/user/$(id -u)` and
  defaults `DOCKER_HOST` to that socket unless something already set it; the
  engine's own `XDG_RUNTIME_DIR` and `DOCKER_HOST` are never passed to a
  worker.
- **`claude`, `codex`, the MCP servers and the runner itself stay on the
  image's Node 24**, never the project's pinned one. The runner's unit starts
  it by absolute path (`/usr/local/bin/node`), and `agentLauncher` in
  `apps/mcp/src/compose.ts` resolves `claude`/`codex` on the image's own
  `PATH` with `resolveNodeCli`/`nodeCliDeps` (`packages/harness/src/node-cli.ts`),
  launching a Node-shebang script as `<image node> <script>` rather than
  letting the project's Node (first on the project environment's `PATH`) run
  it by the bin's shebang. On a laptop, where there is no project
  environment, nothing changes.

### Departures from `plan.md`

1. **The laptop's runtime versions are measured by `run --remote` itself, at
   dispatch** (the exported `measureToolchain`), because S-02's reference
   audit did not exist yet to do it. S-02 should record the same measurement
   in its reference audit rather than duplicate or replace this one.
2. **The Docker socket uses the `docker.socket` + `systemd-socket-proxyd`
   pattern directly**, rather than relying on rootless Docker's native
   systemd-socket-activation support, since that native path could not be
   checked without an image build.
3. **On the machine, the engine process itself runs in the project
   environment** (adopted into its own `process.env` at startup, and passed
   to each worker user through `RunAs.env`), instead of an explicit
   `projectEnv` threaded to every call site that runs project code. Some call
   sites — `packages/execution/src/examine.ts`'s candidate checks,
   `gate-repair.ts`'s setup reference, and `flaky.ts`'s reruns — were outside
   S-01's scope; they get the project environment anyway because they run
   inside the engine process and inherit it, but S-02, which owns those
   files, may thread it through explicitly instead. **Undone by S-02
   (D-10):** the project environment is now threaded explicitly to each of
   those call sites, and neither the runner nor the MCP server adopts it.
4. **The pinned Rust toolchain's home moved onto the volume.** The image's
   own `rustup` home (`/opt/rust/rustup`) is root's and read-only past
   install, so it can hold only the image's stable toolchain. A project
   pinning another Rust version gets a rustup home of its own under
   `/workspace/stores/runtimes/rustup`, which the engine (as itself) installs
   into with the image's `rustup` binary, and which the project environment
   then selects with `RUSTUP_HOME`/`RUSTUP_TOOLCHAIN` — Rust stays on
   `rustup`, as the plan asked, rather than moving to `mise`.

### Known limits

- **Boot setup runs as the engine, which has no Docker daemon.** A setup step
  that needs Docker gets none at boot. (The gate audit runs setup again as a
  worker, where Docker is available.)

### What the owner must do after this lands (the run cannot)

1. **Build the image and deploy.** Nothing here was deployed or built; mise's
   binary and checksum, the generated systemd units, and the Rust/mise
   installer scripts were checked locally (`bash -n`, a real mise 2026.10.5
   reading the config back) but never run on a built image.
2. **Commit Node and Python pins to `wildorder/nightshift-remote-fixture` if
   it has none.** The boot proof's `fixtureToolchain` (in
   `apps/api/src/smoke/runner-boot-env.ts`) requires the fixture to pin both:
   a `.nvmrc` naming an exact Node 22 version (e.g. `22.22.0`) or any Node
   spec, and a `.python-version` naming an exact 3.12.x version (e.g.
   `3.12.8`) or any Python spec — a non-exact pin is accepted only if the
   documented default (`node 22.22.0`, `python 3.12.8`) satisfies it, or an
   override does (`NIGHTSHIFT_SMOKE_NODE_VERSION` /
   `NIGHTSHIFT_SMOKE_PYTHON_VERSION`). Missing either pin, or one that no
   default or override satisfies, refuses the proof before it dispatches.
3. **Run `npm run runner:boot`.** It now also checks, as a worker user and
   through the run sandbox's own wrapper (never a login shell): the pinned
   `node` and `python` versions answer `--version`, `docker info` succeeds,
   a `postgres:16` container's published port answers a host-side client,
   and an idle worker (one the single-strand fixture never delegates to) has
   no `dockerd` process while its `docker.socket` is listening.

## S-02 as built

S-02 makes the audit tell the machine from the code: a gate green on the
laptop and red on the machine stops the run as an environment fault instead
of opening a repair, and the project environment that S-01 built is now
threaded explicitly instead of adopted. This is what landed, read from the
commits (`0b25b71`, `d661e0b`, `0d5156c`, `e72b175`, `4d91ba7`, `7f23ab5`,
`48dc5eb`, `5e24942`, `5f67281`) and the code they left.

### What exists now

- **Deferral-aware audits.** `auditGates` (`packages/execution/src/gate-audit.ts`)
  uses the same `deferSignalOf` that `verifyNode` already used: a step that
  exits 75 with a `NIGHTSHIFT_DEFER` line gets the verdict `deferred`, not
  `failed`. `GateVerdict` gains `deferred`, `AuditedGate` carries the
  `DeferSignal`, and `GateAudit` lists deferred ids separately from
  `failing`. A deferred setup step leaves its checks `unrun`, as a failed one
  does, but neither makes the base red; `red-base.ts` still records only
  `failed` gates. `nightshift gates` (`apps/cli/src/commands/gates.ts`)
  prints `DEFERRED <id>: <HP-nn> <description>` with its remediation, and the
  machine's own audit log (`apps/mcp/src/runner/gates.ts`) labels a deferred
  step the same way.
- **Rule 8, "declares its runtimes" (SC-08).** `GATE_STANDARD_RULES = 8`
  (`packages/contracts`), and `skills/plan-program/gate-standard.md` gained a
  "## 8. Declares its runtimes" section in the Means/Check/Typical-fix style
  of rules 1–7 (mirrored byte-for-byte in the embedded copy,
  `packages/harness/src/gate-standard.ts`, which a test checks against the
  shipped file). The audit itself is mechanical: `runtimeFindings` in
  `packages/core/src/rules/pins.ts` reuses `resolvePins` and reports, for the
  measurable runtimes only, a marker file with no pin (`package.json` with no
  Node pin, and so on — `go.mod` is a marker but never a pin), pins that
  disagree (naming both files and specs), and a pin the auditing machine's
  measured version doesn't satisfy (or that is missing). `nightshift gates`
  prints these under a "rule 8, declares its runtimes" heading
  (`auditProgramRuntimes`/`describeRuntimeFindings`); they do not change the
  gate audit's exit code. `skills/plan-program/SKILL.md` step 3a turns each
  finding into a decision — pin the runtime, reconcile the pins, or fix the
  laptop — and says a remote run audits again at dispatch.
- **Prerequisite checks now count only where they ran (D-08).**
  `PrerequisiteCheck` keeps `lastCheck` for the laptop (the `where` field
  defaults to `"laptop"` for old records) and gains `machineChecks`, up to 20,
  keyed to a run's `runId`/`generation`. `rules/prerequisite-checks.ts`'s
  `unmetPrerequisitesAt` builds a run's `unmet` set only from checks made at
  that run's own location: the laptop trusts `status`; a dispatched run
  trusts only its own dispatch's machine checks. Before its gate audit, the
  machine itself runs every `verifyCommand` (`checkPrerequisitesOnMachine` in
  `apps/mcp/src/runner/gates.ts`) through `runPreflight`, as the
  `${engineAgentId}-gates` worker, in the project environment, and records
  each result through the existing `prerequisite.put` (now carrying `where:
  "machine"` and the dispatch). A machine check never touches `status`, and
  only an engine token whose run and generation match the dispatch may write
  one; an execution token cannot write a laptop check. Overlapping
  laptop/machine writes to the same prerequisite both land, through an
  atomic read-change-write (`ProgramContractStore.update`, conditional on a
  `REV` attribute for DynamoDB, retried up to 8 times).
- **Setup failure ends a dispatch through the heartbeat (SC-07).**
  `HeartbeatBodySchema` gains an optional `failure`, accepted only alongside
  `report: "stopped"`; `DispatchFailureCodeSchema` gains `setup_failed` and
  `environment_fault`. `runnerStopped` in `packages/core/src/rules/dispatch.ts`
  takes the dispatch straight from `provisioning`, `ready` or `running` to
  `failed` with the failure recorded, instead of the old plane-only
  `stopped` transition. In the runner, the heartbeat now starts before the
  volume is mounted, and any failure from the mount through setup sends
  `stopped` with `{code: "setup_failed", message: "the workspace could not
  be prepared: <cause>"}` (cause capped at 2000 characters) rather than
  waiting for the reconciler to give up on a stalled lease. `remote status`
  prints `failure <code>: <message>`.
- **The reference audit, on the laptop, at dispatch (D-06).** `run --remote`
  no longer skips the run-start audit: `runProgram` runs preflight, then
  `assertRemoteReady` (so a toolchain refusal comes first), then the gate
  audit at exactly the dispatched base SHA, with prerequisites checked fresh
  on the laptop. A red base still dispatches — no `gate.red` is written and
  no `red` reason is passed to `startRun` — but the machine must then agree.
  If the branch moved, locally or at origin, during the audit, the run
  refuses before anything is written; `startRun` is held to the audited SHA.
  The per-gate verdicts (`passed`/`failed`/`deferred`/`waiting`), the Node
  measured through `env.exec` in the repo, and each failed gate's output (as
  a verification-log artifact) go on the dispatch as `input.reference`
  (`DispatchInputSchema.reference`, `ReferenceAuditSchema` in
  `packages/contracts/src/v1/dispatch.ts`) — only a gate that ran may carry
  an artifact or (after the surfaces work below) a tail, and `reference.base`
  must equal the dispatch's `baseSha`.
- **The comparison and the `environment.fault` event (D-07).**
  `auditOnMachine` (`apps/mcp/src/runner/gates.ts`) now returns its audit
  instead of discarding it, and `compareWithReference`
  (`packages/execution/src/gate-comparison.ts`) compares it with the
  reference gate by gate: passed/passed agrees and the run starts;
  failed/failed is a red base, `gate.red` and repair as today; passed/failed
  is an **environment fault**; a gate the reference left `deferred` or
  `waiting` gives no evidence, so the machine's own result stands. On a
  fault, the machine's output of each disagreeing gate is recorded as a
  verification-log artifact on the program node (`recordEnvironmentFault` in
  `packages/execution/src/environment-fault.ts`), `node --version` is
  measured on the machine as a worker in the project environment, and an
  `environment.fault` event is appended naming the gates, both outputs and
  both Node versions — never `gate.red`. The run moves `pending` →
  `cancelled` with the fault as its `outcomeReason` (there is no
  `pending` → `failed` transition), and the dispatch moves to `failed` with
  the new `environment_fault` failure code through the heartbeat.
  `auditThenRoot` wraps this so a fault never calls `runHeadless`;
  `nightshift-runner.ts` reports the ended dispatch directly.
- **D-10: the project environment, threaded explicitly, not adopted.**
  `ExecutionEnvironment` (and `LandingEnvironment`, for resume) carry an
  optional `projectEnv`. `createRuntime` (`apps/mcp/src/compose.ts`) reads it
  once from `project.env` via `readProjectEnv`, and `buildEnvironment`
  (`session.ts`) puts it on the `ExecutionEnvironment`; worker users still
  get it through `RunAs.env`. A new `projectStepEnv(projectEnv, scratch)`
  (`packages/execution/src/scratch.ts`) layers the scratch directory's
  `TMPDIR`/`TEMP`/`TMP` on top of the full project environment, so scratch
  still wins; it is passed as the step's `env` extra, which
  `sanitizeEnvironment`'s allowlist lets through unfiltered (`PATH`,
  `DOCKER_HOST`, the store variables). Every step that runs the project's
  code now takes it explicitly: `setup.ts`'s `prepareCheckout`, `verify.ts`'s
  first run and reruns, `flaky.ts` (`RerunInput` gains `projectEnv`, so a
  rerun has the first run's environment whether or not it has a `runAs`),
  `examine.ts`'s candidate setup/checks/rerun, `gate-repair.ts`'s
  `prepareSetupReference`, and `gate-audit.ts`. The runner's
  `auditOnMachine` and its prerequisite checks already passed
  `context.projectEnv` explicitly. Adoption into `process.env` is removed —
  the `Object.assign` in `nightshift-runner.ts` and `adoptProjectEnv` in
  `nightshift-mcp.ts` are gone, along with their test — and the root agent
  now gets only `NIGHTSHIFT_PROJECT_ENV_FILE` (the path, via
  `PROJECT_ENV_FILE_ENV`), never the variables themselves, so the root agent
  and its MCP server stay in the image's own environment.
- **Surfaces.** The report's gate-health section renders an environment
  fault as a table (gate, command, reference and machine verdicts, both
  Node versions in the headers) followed by each gate's two output tails in
  code fences (`renderEnvironmentFault` in `packages/core/src/report`,
  merging every part of a split fault via `environmentFaultOf`). `remote
  status` gives a `failure environment_fault` dispatch a cause line and,
  reading the run's events best-effort through `environmentFaultOfRun`,
  prints the same side-by-side table. The Studio's `narrate.ts` narrates
  `environment.fault` (naming the part when there are several), and
  `gate-health.tsx` shows the side-by-side table with verdict badges and
  tails. `skills/plan-program/SKILL.md` step 3a tells the planner that a
  remote run audits again at dispatch.

### Departures from `plan.md`

1. **The reference's output tail travels in the dispatch, not only as an
   artifact.** The plan's reference audit kept only each failed gate's
   output as an artifact for the fault to read back. In production the
   machine's artifact store is write-only (it signs uploads; there is no
   read callback wired into `createRuntime`), so a fault recorded on the
   machine could not read the reference's body and showed no reference
   output at all (examiner F-01, `dec_01M4GSF9ZKT59V6DPXRXYZV7HP`).
   `ReferenceGateSchema` gained a bounded `outputTail` (at most 2000 chars
   per gate, 64k total; only a ran gate may carry one) that `referenceAuditOf`
   fills on the laptop and the dispatch carries; `recordEnvironmentFault`
   reads that tail first and only falls back to `bodies.get` (catching any
   read failure) for older dispatches that have none.
2. **A fault's shared tail length is found by binary search, bounded below,
   and split across several events when it still doesn't fit.** The plan
   described one `environment.fault` event with each output's tail inline.
   A first cut halved one shared length down to zero as gate count grew,
   so a 25-gate fault kept no tails at all even with room to spare
   (`dec_01M4GSF9ZKT59V6DPXRXYZV7HP` again). `boundEnvironmentFault` now
   binary-searches the largest shared tail length that fits within the
   inline payload limit, so a short output leaves its room to longer ones
   and tails drop to zero only when the gates alone fill the event.
   `splitEnvironmentFault` packs gates into as few parts as keep every tail
   at least `MIN_ENVIRONMENT_FAULT_TAIL_CHARS` (300) characters (or whole, if
   shorter) within the limit — a small fault is still one event
   (`dec_01M4H01Q67HRGPVTFAWDZZV267`); `EnvironmentFaultGate` gained optional
   `part`/`parts` fields and deterministic idempotency keys per part, and
   both the report and the Studio merge every part before rendering.
3. **D-10's threading was done in a later job than the one that first landed
   S-01's engine-adoption workaround**, once path scopes were removed
   (owner's ruling, PR #12); S-01's own text and its Departure 3 were updated
   in the same commit (`48dc5eb`) to say the departure is undone, rather than
   leaving S-01 to describe behavior S-02 had already replaced.

### Known limits

- **In-run verification still reads the laptop's prerequisite `status`.**
  `execution/verify.ts` and `examine.ts` are out of this strand's scope; a
  check gated on a prerequisite the laptop satisfied but the machine hasn't
  (re)checked can still run on the machine. D-08 covers only the gate
  audit's own `unmet` set.
- **A deferred gate, deferred on both the reference and the machine, is
  never compared.** The comparison table gives the machine's own result
  "no evidence from the laptop," by design (plan.md), so a Docker deferral
  that would behave differently on the two environments is not caught here.

### What the owner must do after this lands (the run cannot)

1. **Build the image and deploy**, as S-01 required: nothing in S-02 changes
   that; the machine-side behavior (prerequisite checks, the audit, the
   fault) was checked by unit and end-to-end tests against fakes, never a
   built image or a real dispatch.
2. **Watch the first real remote run's environment fault, if one happens**,
   for a disagreement the comparison table doesn't expect — the table was
   built from keki's three failure modes plus the obvious pairings, not an
   exhaustive audit of every verdict combination a live machine can return.

## Decision log

| Date | Decision | Authority |
|------|----------|-----------|
| 2026-10-09 | Plan drafted: D-01 … D-09 proposed | Agent |
| 2026-10-09 | D-03, D-05, D-06, D-07 and D-08 answered by the owner at the leanings. D-04 widened by the owner from Node to every language runtime through one polyglot version manager: "nightshift should work on any environment". D-01, D-02 and D-09 taken at the leanings under the owner's standing review style | Human |
| 2026-10-09 | The first run cancelled after S-01 landed an ambient-environment workaround forced by path scopes. Path scopes removed from Nightshift (PR #12, the owner's ruling). D-10 added to S-02: the project environment is threaded explicitly | Human |
