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
  at startup and adopts into its own `process.env`
  (`adoptProjectEnv`), so every step the engine runs inherits it by whichever
  path launched it, and which each worker user gets through `RunAs.env`
  (`createWorkerUsers({ projectEnv })` in `apps/mcp/src/run-as.ts`). The boot
  proof reads the same file.
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
   files, may thread it through explicitly instead.
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

## Decision log

| Date | Decision | Authority |
|------|----------|-----------|
| 2026-10-09 | Plan drafted: D-01 … D-09 proposed | Agent |
| 2026-10-09 | D-03, D-05, D-06, D-07 and D-08 answered by the owner at the leanings. D-04 widened by the owner from Node to every language runtime through one polyglot version manager: "nightshift should work on any environment". D-01, D-02 and D-09 taken at the leanings under the owner's standing review style | Human |
| 2026-10-09 | The first run cancelled after S-01 landed an ambient-environment workaround forced by path scopes. Path scopes removed from Nightshift (PR #12, the owner's ruling). D-10 added to S-02: the project environment is threaded explicitly | Human |
