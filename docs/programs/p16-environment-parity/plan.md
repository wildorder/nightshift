# P16 Environment Parity

## Overview

A remote run happens on a machine, but its plan was audited on a laptop. Today
nothing makes the two alike, and nothing notices when they differ. On
2026-10-08 keki-backend's `lightning-ux` was audited green on a laptop with
Node 22 and Docker, then dispatched to a machine with Node 24 and no Docker
for its worker users. The machine called the base red, and the run's first job
was a "repair" that would have changed keki's code to suit Nightshift's
machine. Only a separate bug, D-P10-29, stopped that commit.

P16 closes the gap from both sides:

- **The machine becomes the environment the audit certified.** It runs the
  runtime versions the project pins, for any language, and gives agents and
  gates a working Docker.
- **When it still differs, the run says so and stops.** It no longer blames
  the project. A gate green in the reference audit and red on the machine is
  an *environment fault*.
- **The developer's walk-away moment becomes a proved moment.**
  `run --remote` waits with them, showing WAIT, until the machine's audit
  agrees, then says OK GO.

Out of scope, in prose:

- Deploying, building images, and the live trial. The owner does these once
  the program lands: the boot proof, then keki's `lightning-ux` remotely, is
  the exit trial.
- OS packages and system libraries. The environment-fault guard names a gate
  that differs because of them.
- Rootful or shared Docker.
- The repository-scanning tier probe.
- Studio screens beyond narrating the new events.

## Who it is for

All three stories are the same developer at three moments.

- **US-01** is the root fix. The machine must not differ from where the plan
  was audited.
- **US-02** is the guard alongside it. When the machine does differ anyway,
  the run must say so and must never touch the project to cover for the
  machine.
- **US-03** is what the developer feels. The owner asked for the wait
  explicitly ("ask the user to WAIT until nightshift says OK YOU CAN GO NOW")
  and wants it to be fun.

The owner's reaction to the keki run sets the bar: a run that is green where
it was planned and fails on the machine "simply cannot happen".

## Architecture

**What changes:**

- **Runtime pins, for every language.** A pure rule in `core` reads a
  checkout's standard pin files. The dispatch carries the exact version of each
  pinned runtime, checked against the reference audit's. One polyglot version
  manager on the image (mise) installs them on the machine.
- **The machine's project environment.** One place on the machine builds the
  environment every *project* process gets: setup, verification, gate-audit
  steps, prerequisite checks, and agents' shells. It puts the project's
  runtimes first on PATH and points `DOCKER_HOST` at the worker user's own
  socket.
  Nightshift's own processes keep the image's Node by absolute path: the
  runner, the MCP servers, and `claude` and `codex`.
- **Rootless Docker per worker user**, wired in the image and started by the
  first connection to the user's socket.
- **A reference audit.** `run --remote` audits on the laptop at the exact base,
  as a local run already does, and records per-gate verdicts with the
  dispatch. The machine compares its own audit with it, gate by gate.
- **Two new outcomes:**
  - *Environment fault.* It gets its own event, distinct from `gate.red`, so
    the engine's red-base hold and the brief's repair instruction never see
    it.
  - *Dispatch failed at setup.* This closes today's gap, where a setup
    failure leaves the dispatch `provisioning` until the reconciler gives up.
- **Heartbeat progress**, so the CLI can say what the machine is doing.

**What stays exactly as it is:**

- A red base, red on both sides, is repaired as P15 built it.
- Verification, the merge queue, examination and correction.
- Local runs, apart from the deferral-aware audit and the prerequisite
  location.

## Strands

### S-00 Gate health

Nightshift's own gates, before anything is built on them. The audit on
2026-10-08 was green on a fresh checkout of `main`: setup 4 s, build 4 s,
typecheck 1 s, lint 2 s, test 227 s, synth 3 s, sterility under 1 s. It found
two things.

- **Two Node pins that disagree** (D-01). `.nvmrc` says 22, while
  `.node-version` and `package.json` engines say 24. CI and the image run 24.
  The laptop that ran this audit was on 22.22.0. Once the machine honours a
  pin, Nightshift's own runs depend on which file it reads.
- **The test gate reads the build gate's output** (D-02). Every workspace
  package's `exports` point at `dist`, so a test sees a source change only
  after a build. Verification orders the gates, so it passes there. An agent
  that edits a package and runs only the tests gets stale results.

#### Approach

- **One pin.** `.node-version` at 24, which CI's `setup-node` already reads;
  `.nvmrc` removed.
- **Source in tests.** Each workspace package's `exports` gains a `source`
  condition pointing at `src/index.ts`. The test runs resolve it, through
  `resolve.conditions` in the root config and each app's config. Builds and
  the published `dist` are untouched.

#### Considered and rejected

- **Path aliases per package in the vitest config.** That is a second map to
  keep in step with the packages.
- **Making the test gate build first.** That is work repeated across gates
  (rule 7).

### S-01 The machine runs the project's environment

**Afterwards:** a project that pins Node 22 and Python 3.12 runs exactly those
on the machine, in every process that is the project's, and its worker users
can use Docker. The boot proof checks both as a worker user, so the next gap
is found by a script, not by a customer.

#### Approach

**The pins.**

- A pure rule, `resolvePins(files)` in `core`, returns each pinned runtime
  with its version or range and the file it came from, or a refusal.
- It reads the standard files projects already commit:
  - `.tool-versions`, `.nvmrc`, `.node-version`, `.python-version`,
    `.ruby-version`, `.go-version`, `.java-version` and
    `rust-toolchain.toml`;
  - `package.json` `volta.node`, and `engines.node` only when nothing else
    pins Node.
- It refuses two files that disagree for one runtime, naming both. A partial
  pin such as `22`, or a range, is satisfied by an exact version (D-03).
- It is tested table-driven, including Nightshift's own repository and
  keki's.
- The rule is what the laptop checks against. The version manager does the
  installing.

**The versions a dispatch carries.**

- The reference audit (S-02) records each pinned runtime's version as it ran:
  the runtime's own `--version`, on the laptop.
- If every version satisfies its pin, they are the dispatch's versions.
- If one doesn't, dispatch refuses before any machine is paid for, with
  something like: "your audit ran on Node 22.22.0; this project pins 24".
- A runtime the project doesn't pin is the image's, and the dispatch says so.
- The dispatch's input gains the versions and where each came from.

**Getting the runtimes onto the machine (D-04).**

- The image carries one polyglot version manager, mise, for the engine's use
  only.
- At boot, before setup, the machine asks it to install exactly the
  dispatch's versions under `/workspace/stores/runtimes` on the warm volume,
  verified as mise verifies them. A warm machine finds them there.
- Rust needs nothing extra: rustup is already on the image and honours
  `rust-toolchain.toml` itself. Go 1.21 and later honours `go.mod`'s
  `toolchain` line the same way.
- The runtime versions join the warm-snapshot key beside the lockfile hashes,
  so a pin change is a cache change.
- Projects never see mise. They see `node`, `python` and the rest on PATH, at
  the pinned versions, so nothing reads a shim or a shell hook.

**One project environment.**

- One function builds it: `projectEnvironment(layout, toolchain, runAs)`
  beside `storesEnvironment`.
  - Each pinned runtime's `bin` goes first on PATH.
  - The store variables are folded in.
  - `DOCKER_HOST` is set to `unix:///run/user/<uid>/docker.sock` for the
    worker user.
- The callers that build an environment today all take it from there:
  - boot setup (`prepareWorkspace`);
  - the gate audit (`auditOnMachine`);
  - worktree and checkout setup (`prepareCheckout`);
  - verification (`verifyNode`), which today gets neither the stores nor
    anything project-specific;
  - prerequisite checks (S-02);
  - agents' shells, through `RunAs.env` and the harness adapters' allowlists.
- `XDG_RUNTIME_DIR` is set for the worker user by the run-as wrapper rather
  than stripped, so the user's socket path resolves.

**Nightshift's own processes stay on the image Node.**

- The runner's unit already uses `/usr/local/bin/node`.
- The MCP servers launch with `process.execPath`.
- `claude` and `codex` are npm-global bins started by name, whose shebang
  would pick up whatever Node is first on PATH. They are launched through the
  image's Node by absolute path, so a project on Node 18 cannot break the
  agent CLI.

**Docker (D-05).**

- The image runs `dockerd-rootless-setuptool.sh install` for each worker user
  at build time, so each has a `docker.service` user unit.
- In front of it sits a `docker.socket` user unit on the user's socket path.
  A connection starts `systemd-socket-proxyd`, which pulls the real rootless
  daemon up and forwards to it.
- Linger is already on. An idle worker has the socket listening and no
  daemon.
- Rootless Docker's own socket-activation support is the first thing to check
  on the image. Use it if it works; the proxy is the fallback that works
  regardless of rootlesskit.

**The boot proof.**

- `runner-boot.smoke.ts` gains checks run as a worker user, through the run
  sandbox's own wrapper, not a login shell:
  - `node --version` equals a pinned fixture's version;
  - `docker info` succeeds;
  - a `postgres:16` container is started, and a host-side `pg_isready` or
    client connects to its published port;
  - an idle worker shows no `dockerd`.
- The P10 T2 checks were by hand and were deleted in T3. These are not
  deleted.
- **The run cannot run the proof.** Deploying and image builds are forbidden.
  The owner runs it after the program lands. The image component's synthesis
  and every pure piece are tested offline.

#### Considered and rejected

- **The pin files alone, ignoring the laptop's version.** A partial pin (`22`)
  leaves the patch to chance, and the laptop that certified the gates may sit
  on a different patch.
- **The laptop's version alone.** Today the owner's laptop runs Node 22 on a
  repository pinned to 24. That is a mismatch to name, not to copy.
- **Node only, from the official download.** That was the first leaning. The
  owner ruled it too narrow: "nightshift should work on any environment".
- **The project's dev container.** It reaches furthest, but every job in a
  container under rootless Docker is a program of its own. Pins cover the
  projects that have none.
- **mise's shims and shell activation.** Steps run `sh -c`, not a login
  shell, and agents' shells are sanitised, so explicit PATH entries are the
  only thing every caller honours.
- **Starting every worker's Docker at boot.** Sixteen idle daemons for
  projects that never use one.
- **Starting Docker only for projects with a Docker prerequisite.**
  Testcontainers often has no prerequisite, so it would silently get none.
- **Fixing `XDG_RUNTIME_DIR` by passing the engine's.** That would point
  every worker at the engine's runtime directory.

### S-02 The audit tells the machine from the code

**Afterwards:** a run that meets a machine unlike its reference audit stops
before any strand starts, says which gates disagree, and shows both outputs.
It never opens a repair against the project. A red base, red in both, is
repaired exactly as today.

#### Approach

**The audit checks runtimes (SC-08).**

- The gate standard gains rule 8, *declares its runtimes*. The numbers never
  change, so it is added at the end.
- The rule means: a repository pins every language runtime it uses, in one
  file per runtime, and the gates are audited on those versions.
- The mechanical audit uses S-01's `resolvePins` and reports, naming the
  files and the versions:
  - a runtime the repository plainly uses with no pin (`package.json` with no
    Node pin, `pyproject.toml` with no Python pin, and so on);
  - pins that disagree;
  - a runtime on the auditing machine that does not satisfy its pin.
- `GATE_STANDARD_RULES` becomes 8, and the planning skill's step 3a turns
  each into a decision.
- This is the root fix for drift on the developer's side. Your laptop on
  Node 22 against Nightshift's pin of 24 would have been a finding at
  planning, fixed with you there. The refusal at dispatch (D-03) stays as the
  guard for drift that arrives after planning.

**Deferral-aware audits.** `auditGates` uses `deferSignalOf`, as `verifyNode`
does. A step that exits 75 with a `NIGHTSHIFT_DEFER` line is `deferred`, never
`failed`, on the laptop and on the machine. This alone would have turned
keki's three Docker "failures" into deferrals.

**Checks where the run runs (D-08).**

- A prerequisite check records where it ran: `laptop` or `machine`, plus the
  dispatch.
- A run's `unmet` set is built only from checks made where that run runs.
- Before its audit, the machine runs every `verifyCommand` in the project
  environment (S-01), as a worker user, through the engine's existing
  `prerequisite.put`.
- The laptop's `preflight` keeps its own checks, and neither overwrites the
  other's meaning.

**The reference audit (D-06).**

- `run --remote` stops skipping the run-start audit. It runs it on the laptop
  at the exact base the dispatch names, with prerequisites checked on the
  laptop.
- It records per-gate verdicts (`passed`, `failed`, `deferred`, `waiting`),
  the Node it ran on, and each failed gate's output as an artifact. They go
  with the dispatch input.
- A laptop that finds the base red still dispatches. The machine must then
  agree, and the red base is repaired as today.

**The comparison.** `auditOnMachine` returns its audit instead of discarding
it, and compares it with the reference, gate by gate:

| Reference | Machine | Means | What happens |
|---|---|---|---|
| passed | passed | agree | the run starts |
| failed | failed | red base | `gate.red`, and the repair as today |
| passed | failed | **environment fault** | the run stops (D-07) |
| deferred or waiting | anything | no evidence from the laptop | the machine's own result stands |

**The environment fault itself (D-07).**

- It records a new event, `environment.fault`, on the program node. It holds:
  - the gates that disagree;
  - the reference audit's and the machine's outputs, as artifacts;
  - the reference's Node beside the machine's.
- It does not write `gate.red`, so the engine's red-base hold and the brief's
  repair instruction never see it.
- The runner ends before `runHeadless`. The run moves from `pending` to
  `cancelled`, with the environment fault as its `outcomeReason`. The
  transition table has no `pending → failed`, and adding one is not worth it.
- The dispatch moves to `failed` with a new failure code, `environment_fault`.
  The engine reports this through a new heartbeat field, since today only the
  plane writes `failure`.

**Setup failure (SC-07).** The heartbeat accepts `stopped` with a failure
while the dispatch is still `provisioning`. A workspace or setup failure then
ends the dispatch `failed` with its cause, instead of waiting for the
reconciler to give up.

**Surfaces.**

- The report's gate-health section shows an environment fault as a side by
  side: gate, reference verdict and machine verdict, each output's tail, and
  both Node versions.
- `remote status` shows the cause.
- The Studio narrates `environment.fault`, and the gate-health panel shows it.
- The planning skill's step 3a tells the planner that a remote run audits
  again at dispatch.

#### Considered and rejected

- **Per-gate results in the planning gate-health record.** The planning audit
  runs at a draft commit, usually with prerequisites pending, so the gates
  that matter were `waiting` and prove nothing. The record is also
  per-project, and other programs and repairs rewrite it.
- **No comparison, classifying by prerequisite checks only.** A Node mismatch
  breaks a unit test, with no prerequisite involved. That is exactly keki's
  unit gate.
- **Carrying on with the disagreeing gates deferred.** Every landing would
  then be verified against gates that cannot be trusted on that machine, a
  night of work that cannot land.
- **Re-running the disagreeing gate on the machine to rule out a flake.** The
  reference passed and the machine failed; one more failure on the same
  machine proves nothing new.

### S-03 Wait, then go

**Afterwards:** `nightshift run --remote` is the moment the developer is told
the truth. They watch:

1. the reference audit on their own laptop;
2. the machine come up;
3. the workspace and setup;
4. the project's Node and Docker;
5. the prerequisite checks;
6. the machine's audit, gate by gate, against the reference.

The screen says WAIT, with what is happening and how long it has taken. When
the machine agrees, it says OK GO, the moment to close the laptop. The owner
wants this to be fun: two pieces of terminal art, WAIT and OK GO, in the CLI's
plain-text style, with no dependency for it.

#### Approach

**Progress through the heartbeat.**

- A new heartbeat field, `progress`, carries the machine's stages: up,
  workspace, toolchain, prerequisites, audit. The audit stage carries its
  per-gate results as they finish.
- The dispatch record keeps the latest.
- Heartbeats run every 20 seconds, and a stage change is sent at once rather
  than waiting for the next beat.

**The attached CLI.**

- After dispatch, `runProgram` polls the dispatch (and the run's events for
  `environment.fault`) every few seconds.
- It renders WAIT with the current stage, and redraws in place only on a
  terminal.
- `CliEnvironment` gains a sleep and TTY detection on stdout.
- When the output is not a terminal, it prints one plain line per stage
  change, so a CI log or a pipe reads cleanly.

**Endings:**

| Outcome | What it shows | Exit |
|---|---|---|
| Machine agrees | OK GO | 0 |
| Environment fault | the side by side | non-zero |
| Failed dispatch | the cause | non-zero |
| Ctrl-C (D-09) | detached, nothing cancelled, and the reattach command | — |

**Reattaching.** `nightshift remote status --watch` is the same display.

#### Considered and rejected

- **Streaming the machine's log to the laptop.** That would add a channel
  beside the control plane, which AGENTS.md forbids. The heartbeat is the one
  channel.
- **A curses-style full-screen UI.** It is a dependency, and it does nothing
  sensible in a pipe.
- **Returning at dispatch and sending a notification at OK GO.** The point is
  that the developer is still there if the machine disagrees.

## Decisions

The answers and the owner's reasons live in the contract. Leanings:

- **D-01** One Node pin: `.node-version` at 24, which CI reads; `.nvmrc`
  removed.
- **D-02** Tests read the workspace packages' sources through a `source`
  export condition.
- **D-03** The pins decide. The reference audit's exact versions are used
  when they satisfy the pins. A laptop that violates a pin is refused at
  dispatch with both versions named.
- **D-04** Every language runtime, through mise on the image, from the
  standard pin files, installed into the warm volume.
- **D-05** Docker starts on the first connection to the worker's socket.
- **D-06** The reference is a laptop audit at dispatch, at the exact base.
- **D-07** On an environment fault, stop at the audit and report side by
  side.
- **D-08** A prerequisite check records where it ran, and a run trusts only
  its own location's.
- **D-09** Ctrl-C detaches, and `remote status --watch` reattaches.

## Verification cost

**Per verification.** One full verification is about four minutes on the
owner's laptop, and the test gate is nearly all of it (227 s of about 240 s).
With `maxConcurrency` 2, two verifications can run at once, about eight
minutes of CPU per pair.

**How the strands run.** They are serial (S-00, S-01, S-02, S-03), so one
strand runs at a time and its jobs share the two slots. They are serial
because each builds on the last:

- S-02's checks run in the environment S-01 builds.
- S-03 displays S-02's outcomes.

## Risks

- **mise's reading of idiomatic files.** Recent mise reads `.nvmrc` and
  `.python-version` only when configured to. The image sets that once, and the
  boot proof's Node and Python fixture checks it. The machine installs exact
  versions resolved by Nightshift's own rule and handed to mise, so the two
  never disagree about what a file means.
- **Rootless Docker under socket activation is unproven on the image.** The
  run cannot boot a machine, so the strand builds it from documentation, and
  the owner's boot proof is its first real test. The proxy pattern is the
  fallback inside the same decision. If neither works, the boot proof fails
  loudly rather than a customer's run.
- **The agent CLIs' shebangs.** If `claude` or `codex` resolve their Node from
  PATH, a project on an old Node breaks the agent. S-01 launches them through
  the image's Node by absolute path. The boot proof should start one under a
  project pinned to an old major.
- **The reference audit lengthens the wait.** It adds the laptop's audit time,
  about four minutes for Nightshift and longer for keki with e2e, to the
  machine's boot and audit. The owner said waiting is fine. It also catches a
  red base before a machine is paid for.
- **keki's unit test on Node 24.** With D-03, keki's machine runs Node 22 and
  the test passes. The `console.error` of a ZodError that throws on Node 24 is
  keki's latent bug and stays keki's. It is not this program's to fix.
- **Event numbering lag on AWS.** Events are numbered by a Streams consumer.
  The CLI reads the dispatch record for progress and the environment fault's
  cause, and reads events only for detail.
