# Report: Make a remote run's machine the environment the plan's gate audit certified, and make the developer's walk-away moment t

Run `run_01M4GVMXHWHHK5ERBQ47PK0QN7` of plan `60d7976fb699`: **succeeded**. All four strands of P16 Environment Parity succeeded. The base was not red, no flake was reported, and no repair was opened. S-00 Gate health: D-01 (one Node pin, .node-version 24) was already on the branch; D-02 was completed by adding the missing "source" export condition to @nightshift/test (17895454); all seven gates passed. S-01 The machine runs the project's environment: already landed in P16's first run (resolvePins, the versions the dispatch carries, mise into the warm volume, projectEnvironment, rootless socket-activated Docker, boot-proof checks). The strand checked it against its acceptance and delegated no new jobs. S-02 The audit tells the machine from the code: parts A–F came from the first run; this run landed D-10, threading the project environment explicitly through ExecutionEnvironment to every step runner, with Nightshift's own processes no longer adopting it (48dc5eba); gate-standard rule 8 in the planning skill (5e249424); the environment-fault surfaces, where bounded reference-output tails travel with the dispatch because the machine cannot read the laptop's artifacts back, and large faults are split across event parts (a recorded departure, 5f672816, attempt 2 after an upheld examiner finding); and as-built docs (14b6dea9). S-03 Wait, then go: the heartbeat progress contract (27fa736d); the runner reporting its stages and per-gate audit progress (3a995106, attempt 4 after examiner/arbiter findings on heartbeat timing); the CLI's WAIT/OK GO display with Ctrl-C detach and `remote status --watch` (33836a22, attempt 4); a fix so OK GO never trusts a replaced machine's verdict (d638da9e); and docs (54830412, c6a41b3b). Stage-list departure recorded: setup is its own stage. Not done, by design: the boot proof and keki's lightning-ux remote trial need an image build and deploy, which this program forbids. The owner runs them; they are the first real test of rootless Docker under socket activation and of mise on the image.

4 of 4 strands succeeded; 0 deferred; 0 parked. Wall clock 278 min 12 s.

## Arbiter rulings — read these first

An arbiter ruled on these disputed findings. Each ruling is yours to reverse with
`nightshift ruling reverse <program> <decisionId> --reason …`. Reversing one records
your decision and replays nothing: an overturn's work stays landed and an uphold's ruling
stays carried out until the decision graph (P9); roll back by hand from the checkpoint named.

- **Upheld** by gpt-6-astra F-01 A sampling failure discards the progress taken for that beat, so the first `up` stage or a later audit verdict may never reach the plane after a transient machine read error. on node_01M4H2J70B9CZS04QGYF5QF77Q: Confirmed in the checkout: beat() takes unsent progress and clears it before awaiting options.sample(), but the catch that restores it with unsent ??= progress surrounds only posting and response parsing. A sample rejection therefore loses that progress permanently when no newer progress arrives; run() counts the miss and retries without it. The production sampler awaits Promise.all of machine reads and commands without catching rejections, so this is a reachable failure path. This violates acceptance criterion 1's failed-beat retry guarantee and can lose the initial up stage or the final audit fault verdict, including before a subsequent stopped/environment_fault beat. The finding is material and the work should not land as it is. The restoration boundary must cover sampling as well while preserving newest-wins behavior, with regression coverage for a rejected sample.
  Decision `dec_01M4H71H4T48YG6P7CCM1D33QN`, made against checkpoint `ckpt_01M4H714E0A3HETENPRE33G414`.
- **Upheld** by gpt-6-astra F-01 Non-terminal WAIT output omits the current stage's elapsed time. The plain display prefixes stage changes with only the total time since requestedAt and never reads progress.stageStartedAt, so a pipe or CI log cannot show the required stage time alongside the total. The terminal path does show both. Add both m:ss durations to each plain stage-change line while keeping one line per change. on node_01M4H2KC8GR9EAD49KN6829KJZ: Confirmed in the checkout: plainDisplay in apps/cli/src/commands/watch.ts computes its time prefix only from dispatch.requestedAt and emits stage changes as `${at} ${stageLine(dispatch)}`. Neither this path nor stageLine reads progress.stageStartedAt. Only the terminal path through waitLines computes and shows both durations. The task explicitly requires stage elapsed time and total elapsed time; the non-TTY requirement changes rendering frequency and format, not the required timing information. This leaves pipe and CI output missing required information. Each plain stage-change line with current progress must include both m:ss durations from environment.clock while retaining one line per change. The finding is valid and the work should not land as it is.
  Decision `dec_01M4H6KGJCEH7YNER1SMZJJ5XY`, made against checkpoint `ckpt_01M4H6K5WSE28A4293FW4GVZWJ`.

## Stories

### US-01 The machine runs the runtime versions the project pins, for any language, and gives agents and gates a working Docker, s: done

- **Who:** A developer who plans a program on their laptop and dispatches it with `nightshift run --remote`
- **Today:** The machine is not the environment the planning audit certified. It runs whatever runtimes the image ships (Node 24) whatever the project pins, and its worker users have no Docker, so gates that were green on the laptop fail or defer on the machine. keki-backend's lightning-ux started red on 2026-10-08 and no strand ran.
- **Afterwards:** The machine runs the runtime versions the project pins, for any language, and gives agents and gates a working Docker, so a gate that is green where the plan was audited is green where the run runs.
> "It did the gate audit that we just literally shipped. then it fails on the gates not setup right? what the hell?"
> "i mean it simply cannot happen, it is a product destoyer."
> "wouldn't that be best practice for devs to pin the same version they actually have installed so tests are accurate?"

Criteria: SC-01 met, SC-02 met, SC-08 met. Strands: S-01, S-02.

### US-02 The machine checks every prerequisite itself. A gate that is green in the recorded audit and red on the machine is repor: done

- **Who:** The same developer, when the machine still differs from where the plan was audited
- **Today:** The run blames the project. A prerequisite checked on the laptop is trusted on a machine where it is not true, a deferral counts as a failure, the run calls the base red and opens a repair job that would change the product's code to suit Nightshift's machine, and the report never says the machine was the cause.
- **Afterwards:** The machine checks every prerequisite itself. A gate that is green in the recorded audit and red on the machine is reported as an environment fault with both outputs side by side, the run stops there, and the project's code is never changed to work around the machine.

Criteria: SC-03 met, SC-04 met, SC-05 met, SC-07 met. Strands: S-02.

### US-03 `run --remote` stays with them through boot, setup, the machine's prerequisite checks and its gate audit, showing WAIT, : done

- **Who:** The same developer, at the moment they dispatch
- **Today:** `run --remote` returns as soon as the machine is requested, which is when the developer leaves, before anything has shown the machine can run the program. A doomed run is found the next morning.
- **Afterwards:** `run --remote` stays with them through boot, setup, the machine's prerequisite checks and its gate audit, showing WAIT, and says OK GO only when the machine agrees with the planning audit. If it does not, they see why within minutes, still at the keyboard.
> "i don't think it's unreasonable to ask the user to WAIT until nightshift says OK YOU CAN GO NOW. it could even be funny in some terminal art showing wait vs ok go."

Criteria: SC-06 met, SC-07 met. Strands: S-02, S-03.

## Departures from the plan

**S-02 The audit tells the machine from the code**

- **the plan says the fault event holds the reference audit's and the machine's outputs as artifacts. On a machine the artifact body store is write-only (no download route by design), so the reference output could not be read back to show its tail. Instead the laptop's reference audit carries a bounded outputTail per gate inside the dispatch input, and a fault with many gates is split across numbered environment.fault parts so every gate keeps a readable tail (per the F-01 tails ruling).**
  Chose: Bounded reference tails travel with the dispatch; artifacts are still recorded; large faults split into event parts.
  Why: Keeps both outputs visible side by side without a new download route, and satisfies the ruling that tails never collapse to zero.

**S-03 Wait, then go**

- **the plan lists the machine's stages as up, workspace, toolchain, prerequisites, audit, with setup grouped under "workspace". In the code, the runner installs the pinned runtimes (installRuntimes) after the checkout and before setup, because setup runs on those runtimes. So setup cannot be part of the workspace stage without the stages going out of order. I am adding a sixth stage, `setup`, between toolchain and prerequisites: up → workspace → toolchain → setup → prerequisites → audit. Docker on the machine is rootless and socket-activated per worker user, so the runner has no Docker of its own to prove at the toolchain stage. Its readiness is shown through the prerequisite checks (a project that needs Docker declares it) and through the audit. The toolchain stage names the runtimes it installed.**
  Chose: Six stages in the order they really happen: up, workspace, toolchain, setup, prerequisites, audit
  Why: The display shows what is really happening, in order. The plan's five headings are all kept.

## Gate health

Audit: **healthy** at `ec4bd064`, 2026-10-09T17:29:07.301Z.

## Strands

### S-00 Gate health: succeeded

Acceptance, as planned:
- The repository pins one Node version, and it agrees with package.json engines (D-01)
- Tests resolve the workspace packages from their sources, so a test sees a change without a build first (D-02)
- `nightshift gates p16-environment-parity` is green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Finish D-02 (tests resolve workspace packages from source) for the one workspace package that was missed: test/package.j | integrated | 17895454 | 1 |

- Finish D-02 (tests resolve workspace packages from source) for the one workspace package that was missed: test/package.j
  - Route: claude-haiku-4-5-20251001 (claude, cheap) by R-bounded: verified

### S-01 The machine runs the project's environment: succeeded

Acceptance, as planned:
- A pure rule reads a checkout's standard pin files for every runtime (.tool-versions, .nvmrc, .node-version, .python-version, .ruby-version, .go-version, .java-version, rust-toolchain.toml, package.json volta and engines as a last resort for Node) and refuses pin files that disagree for one runtime, naming both; tested table-driven (D-03)
- The reference audit records the version of each pinned runtime it ran with; dispatch refuses one that violates its pin, naming both versions, and the dispatch carries the exact versions the machine must run (D-03)
- The image carries one polyglot version manager (mise) for the engine's use; at boot the machine installs the dispatch's runtimes through it into the warm volume, verified as the manager verifies them, and every setup step, verification step, gate-audit step, prerequisite check and agent shell finds them first on PATH; Nightshift's runner, MCP servers, claude and codex keep the image's Node (D-04)
- The image gives every worker user rootless Docker that starts on the first connection to its socket, and DOCKER_HOST reaches gates and agents through the run-as wrapper (D-05)
- The runner boot proof checks, as a worker user, the runtime versions a fixture with Node and Python pins asks for, `docker info`, a Postgres container a host-side client connects to, and that an idle worker has no Docker daemon running
- Every existing suite stays green

Ran as a single job.

### S-02 The audit tells the machine from the code: succeeded

**Departed from the plan's approach:**

- **the plan says the fault event holds the reference audit's and the machine's outputs as artifacts. On a machine the artifact body store is write-only (no download route by design), so the reference output could not be read back to show its tail. Instead the laptop's reference audit carries a bounded outputTail per gate inside the dispatch input, and a fault with many gates is split across numbered environment.fault parts so every gate keeps a readable tail (per the F-01 tails ruling).**
  Chose: Bounded reference tails travel with the dispatch; artifacts are still recorded; large faults split into event parts.
  Why: Keeps both outputs visible side by side without a new download route, and satisfies the ruling that tails never collapse to zero.

Acceptance, as planned:
- The project environment reaches every project process on the machine explicitly: ExecutionEnvironment carries it, and setup, verification, flaky reruns, examination checkouts, gate repairs, the gate audit and prerequisite checks each pass it to the step runner; the runner and the engine's MCP server no longer adopt it into their own process environment, and Nightshift's own processes run in the image's environment (D-10)
- The gate standard gains rule 8, declares its runtimes, and the mechanical audit reports a used runtime with no pin, pins that disagree, and an auditing machine whose runtime does not satisfy its pin, each naming the files and versions; the planning skill turns each into a decision
- auditGates treats exit 75 with a NIGHTSHIFT_DEFER line as deferred, on the laptop and the machine, sharing job verification's deferSignalOf
- A prerequisite check records where it ran, and a run trusts only checks made where it runs; the machine runs every verifyCommand as a worker user in the project's environment before its audit (D-08)
- `run --remote` runs the reference audit on the laptop at the exact base, with prerequisites checked there, and records its per-gate verdicts with the dispatch (D-06)
- The machine compares its audit with the reference gate by gate: agreement on red is a red base and is repaired as today; passed in the reference and red on the machine is an environment fault that records its own event with both outputs, opens no repair, and ends the run and the dispatch with that cause (D-07)
- A workspace or setup failure on the machine ends the dispatch as failed with its cause
- The report and `remote status` show an environment fault side by side; the Studio narrates the new events
- Every existing suite stays green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| P16 S-02, D-10: thread the project environment explicitly instead of adopting it into Nightshift's own process environme | integrated | 48dc5eba | 1 |
| P16 S-02 surfaces for the environment fault (D-07). Read docs/programs/p16-environment-parity/plan.md S-02 ("Surfaces")  | integrated | 5f672816 | 2 |
| Write rule 8 of Nightshift's gate standard into skills/plan-program/gate-standard.md. The file has seven numbered sectio | integrated | 5e249424 | 1 |
| Write a "## S-02 as built" section into docs/programs/p16-environment-parity.md (after "S-01 as built", before "## Decis | integrated | 14b6dea9 | 1 |

- P16 S-02, D-10: thread the project environment explicitly instead of adopting it into Nightshift's own process environme
  - Route: claude-opus-5-5 (claude, frontier) by R-high: verified
  - Examined by gpt-6-astra: passed, blocking
- P16 S-02 surfaces for the environment fault (D-07). Read docs/programs/p16-environment-parity/plan.md S-02 ("Surfaces") 
  - Routes, in order (a fallback is `unavailable`; a climb follows a failure):
    1. claude-sonnet-5 (claude, standard) by R-default: failed
    2. claude-opus-5-5 (claude, frontier) by R-default: verified
  - Examined by gpt-6-sol: findings_raised, blocking
    - F-01 material: A remote environment fault cannot be recorded because the production artifact body store cannot read the reference output. recordEnvironmentFault calls bodies.get for every fault with a reference artifact, but createRuntime supplies createHttpArtifactBodyStore without a read implementation; its get throws artifact_read_unavailable. Thus the event, side-by-side tails, and intended fault handling fail on the real machine. The test's readable in-memory body store masks this path. (unresolved)
  - Examined by gpt-6-sol (fix 1): passed, blocking
- Write rule 8 of Nightshift's gate standard into skills/plan-program/gate-standard.md. The file has seven numbered sectio
  - Route: claude-sonnet-5 (claude, standard) by R-default: verified
- Write a "## S-02 as built" section into docs/programs/p16-environment-parity.md (after "S-01 as built", before "## Decis
  - Route: claude-sonnet-5 (claude, standard) by R-default: verified

### S-03 Wait, then go: succeeded

**Departed from the plan's approach:**

- **the plan lists the machine's stages as up, workspace, toolchain, prerequisites, audit, with setup grouped under "workspace". In the code, the runner installs the pinned runtimes (installRuntimes) after the checkout and before setup, because setup runs on those runtimes. So setup cannot be part of the workspace stage without the stages going out of order. I am adding a sixth stage, `setup`, between toolchain and prerequisites: up → workspace → toolchain → setup → prerequisites → audit. Docker on the machine is rootless and socket-activated per worker user, so the runner has no Docker of its own to prove at the toolchain stage. Its readiness is shown through the prerequisite checks (a project that needs Docker declares it) and through the audit. The toolchain stage names the runtimes it installed.**
  Chose: Six stages in the order they really happen: up, workspace, toolchain, setup, prerequisites, audit
  Why: The display shows what is really happening, in order. The plan's five headings are all kept.

Acceptance, as planned:
- The runner reports its progress (machine up, workspace, Node and Docker ready, prerequisites, audit with its verdict) through the heartbeat, and the dispatch record holds the latest
- `run --remote` stays attached and renders WAIT with the current stage, then OK GO only when the machine's audit agrees with the reference; plain lines when stdout is not a terminal
- On an environment fault or a failed dispatch it renders the cause and the side by side, and exits non-zero
- Ctrl-C detaches without cancelling and says how to reattach; `nightshift remote status --watch` reattaches to the same display (D-09)
- Every existing suite stays green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| P16 S-03, part 1: the progress contract. A remote runner will report how far it has got through the heartbeat, and the d | integrated | 27fa736d | 1 |
| P16 S-03, part 2: the remote runner reports its progress through the heartbeat. The contract already exists: `RunnerProg | integrated | 3a995106 | 4 |
| P16 S-03, part 3: `nightshift run --remote` stays attached and shows WAIT, then OK GO. `nightshift remote status --watch | integrated | 33836a22 | 4 |
| Fix in apps/cli/src/commands/watch.ts (P16 S-03): the attached WAIT display must trust `Dispatch.progress` only when it  | integrated | d638da9e | 1 |
| Document P16 S-03 ("Wait, then go") as built. This is documentation only: do not change code. Read the code and the comm | integrated | 54830412 | 1 |
| Documentation correction in docs/programs/p16-environment-parity.md, section "## S-03 as built", "What exists now". The  | integrated | c6a41b3b | 1 |

- P16 S-03, part 1: the progress contract. A remote runner will report how far it has got through the heartbeat, and the d
  - Route: claude-sonnet-5 (claude, standard) by R-default: verified
  - Examined by gpt-6-sol: passed, blocking
- P16 S-03, part 2: the remote runner reports its progress through the heartbeat. The contract already exists: `RunnerProg
  - Routes, in order (a fallback is `unavailable`; a climb follows a failure):
    1. claude-sonnet-5 (claude, standard) by R-default: failed
    2. claude-opus-5-5 (claude, frontier) by R-default: failed
    3. claude-opus-5-5 (claude, frontier) by R-default: failed
    4. claude-opus-5-5 (claude, frontier) by R-default: verified
  - Examined by gpt-6-sol: findings_raised, blocking
    - F-01 material: The first beat can omit `up` when the sampler is still running and workspace progress arrives. (unresolved)
    - F-02 material: The end-of-loop flush drops unsent progress when there is no pending milestone. (unresolved)
    - F-03 material: A detail-only progress update inside the 2-second gap can remain unsent until the 20-second heartbeat instead of waking after the gap. (unresolved)
  - Examined by gpt-6-sol (fix 1): findings_raised, blocking
    - F-01 material: A failed beat retries stale progress ahead of newer progress and can hold a new stage for the full 20-second interval. (unresolved)
    - F-02 material: A pending detail timer can send a detail-only change less than the required two-second gap after a newer stage beat. (unresolved)
  - Examined by gpt-6-sol (fix 2): findings_raised, blocking
    - F-01 material: A sampling failure discards the progress taken for that beat, so the first `up` stage or a later audit verdict may never reach the plane after a transient machine read error. (upheld)
  - Examined by gpt-6-sol (fix 2): passed, blocking
- P16 S-03, part 3: `nightshift run --remote` stays attached and shows WAIT, then OK GO. `nightshift remote status --watch
  - Routes, in order (a fallback is `unavailable`; a climb follows a failure):
    1. claude-sonnet-5 (claude, standard) by R-default: failed
    2. claude-opus-5-5 (claude, frontier) by R-default: failed
    3. claude-opus-5-5 (claude, frontier) by R-default: failed
    4. claude-opus-5-5 (claude, frontier) by R-default: verified
  - Examined by gpt-6-sol: findings_raised, blocking
    - F-01 material: Ctrl-C can be ignored while a dispatch fetch or environment-fault event retry is in flight, so the command may exit 0 or 1 instead of detaching with exit 130. (unresolved)
    - F-02 material: The non-TTY WAIT display never prints stage or total elapsed time, though the attached display must show both. (unresolved)
  - Examined by gpt-6-sol (fix 1): findings_raised, blocking
    - F-01 material: The watch can print OK GO for a replacement machine that is still provisioning because it accepts an audit verdict from the prior dispatch generation. beginReplacement preserves progress while incrementing generation; readDispatch checks only status and verdict, so a generation-2 provisioning dispatch with generation-1 `agrees` progress exits 0 before the replacement reports `skipped` or reaches its audit. The watch should only trust progress for the dispatch's current generation. (unresolved)
  - Examined by gpt-6-sol (fix 2): findings_raised, blocking
    - F-01 material: Non-terminal WAIT output omits the current stage's elapsed time. The plain display prefixes stage changes with only the total time since requestedAt and never reads progress.stageStartedAt, so a pipe or CI log cannot show the required stage time alongside the total. The terminal path does show both. Add both m:ss durations to each plain stage-change line while keeping one line per change. (upheld)
  - Examined by gpt-6-sol (fix 2): passed, blocking
- Fix in apps/cli/src/commands/watch.ts (P16 S-03): the attached WAIT display must trust `Dispatch.progress` only when it 
  - Route: claude-haiku-4-5-20251001 (claude, cheap) by R-bounded: verified
- Document P16 S-03 ("Wait, then go") as built. This is documentation only: do not change code. Read the code and the comm
  - Route: claude-sonnet-5 (claude, standard) by R-default: verified
- Documentation correction in docs/programs/p16-environment-parity.md, section "## S-03 as built", "What exists now". The 
  - Route: claude-sonnet-5 (claude, standard) by R-default: verified

## Success criteria

| Criterion | State | By |
|---|---|---|
| SC-01 On a remote machine, every setup step, verification step, prerequisite check, gate-audit step and agent shell runs the version of each language runtime the project pins (Node, Python, Ruby, Go, Java, Rust and any other the version manager supports, from their standard pin files), as named on the dispatch, while Nightshift's own runner, servers and agent CLIs stay on the image's Node; a runtime the project does not pin is the image's, as today | met | S-01 |
| SC-02 On a remote machine, `docker info` succeeds for every worker user and a gate can start a Postgres container and connect to it from the host, and a project that never touches Docker starts no Docker daemon; the runner's boot proof (`npm run runner:boot`) checks all of this as a worker user, instead of by hand | met | S-01 |
| SC-03 Before its gate audit, the machine runs every prerequisite's verifyCommand on itself, as a worker user in the project's environment, and records each result as the machine's; the laptop's check never stands in for it | met | S-02 |
| SC-04 A gate audit, on the laptop or the machine, treats a step that exits 75 with a NIGHTSHIFT_DEFER line as deferred, never failed, exactly as job verification does | met | S-02 |
| SC-05 A gate that passed in the run's reference audit and fails on the machine is an environment fault: the run stops at the audit before any strand starts, no gate.red is recorded and no repair job is opened, and the report and `remote status` show both outputs side by side; a gate red in both is a red base and is repaired as today | met | S-02 |
| SC-06 `nightshift run --remote` stays attached through the reference audit, boot, setup, the machine's prerequisite checks and its gate audit, shows WAIT and what the machine is doing while they run, and shows OK GO only when the machine's audit agrees with the reference; on an environment fault it shows the side by side and exits non-zero; Ctrl-C detaches and `nightshift remote status --watch` reattaches | met | S-03 |
| SC-07 A setup or workspace failure on the machine ends the dispatch as failed with its cause, instead of leaving it provisioning until the reconciler gives up | met | S-02 |
| SC-08 The planning gate audit reports, under a new eighth rule of the gate standard (declares its runtimes), a language runtime the repository uses but does not pin, pin files that disagree, and a runtime on the auditing machine that does not satisfy its pin; each is a finding the human answers like any other | met | S-02 |

## Parked

Nothing was parked.

## Deferred

Nothing was deferred.

## Human prerequisites still pending

None.

## Decision graph

Every decision the run recorded: what was weighed, what it produced, and whether you
reversed it. To reverse one: `nightshift decision reverse <program> <decisionId> --choice … --reason …`.

- **Plan:** D-01: Nightshift pins Node twice and the pins disagree (.nvmrc 22; .node-version and engines 24). Which pin stays? (`dec_01M4GVMXT0BA3HD9ZWZK7FHZH2`)
  Chose: One pin: .node-version at 24, .nvmrc removed. Low risk, taken at the leaning under the owner's standing review style unless the owner objects. Revised during planning: CI's setup-node reads .node-version, and the program may not touch .github/**, so .node-version is the pin that stays; CI, the image and engines already say 24.
  Weighed: One pin: .nvmrc at 24, .node-version removed, and CI pointed at it
  Weighed: Both, at 24
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-02: The test gate reads the build gate's output, because the workspace packages resolve to their compiled dist. Fix it or leave it? (`dec_01M4GVMXYGFAHV5HDVMKR0Y7HQ`)
  Chose: Resolve the workspace packages from source in tests, through a source export condition. Low risk, taken at the leaning under the owner's standing review style unless the owner objects: an agent that edits a package and runs only the tests gets stale results, as happened building D-P10-29; the build gate still compiles everything.
  Weighed: Leave it: verification runs build before test
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-03: Which version of each pinned runtime does the machine run? (`dec_01M4GVMY0KXS0T38TXV82WR5SW`)
  Chose: The pins decide; the reference audit's exact versions are used when they satisfy the pins, and a reference audit on a runtime that violates its pin is refused at dispatch with both versions named. The owner chose it, adding: "this is going to be a major issue moving forward. nightshift should work on any environment, and we are super narrow on what we support." That widened the program from Node to every language runtime (D-04). The owner's own laptop runs Node 22.22.0 on this repository's pin of 24: the refusal names such a mismatch before a machine is paid for.
  Weighed: The project's pin files alone
  Weighed: Exactly the versions the laptop's reference audit ran on
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-04: How does the machine get the project's runtimes, and which runtimes? (`dec_01M4GVMY2YY1MYEF4TJ7EH2VGK`)
  Chose: Every language runtime, through one polyglot version manager (mise) on the image honouring the standard pin files, installed into the warm volume. The owner's answer, replacing the earlier Node-only leaning after noting that Nightshift should work on any environment: one manager covers Node, Python, Ruby, Go, Java and the rest from the files projects already commit; rustup on the image already honours rust-toolchain.toml. The dev container was weighed as the widest reach and left for later: every job in a container under rootless Docker is a program of its own.
  Weighed: Node only, from a verified download of the official build cached on the warm volume
  Weighed: The project's dev container: gates and agents run inside it
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-05: When does a worker user's Docker run? (`dec_01M4GVMY5EYHDTM44DQ391XYMN`)
  Chose: Started by the first connection to its socket, so a project that never uses Docker pays nothing. The owner's choice, after asking whether a project with no Docker in its tests would get Docker anyway: a project that never touches Docker pays nothing; the socket-proxy pattern is the fallback inside this answer if rootless Docker's own activation does not work on the image.
  Weighed: Every worker's daemon started at boot
  Weighed: Started only for projects that declare a Docker prerequisite
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-06: What is the machine's audit compared against, to tell an environment fault from a red base? (`dec_01M4GVMY8BE2P3VXAKPH3E27RM`)
  Chose: A reference audit on the laptop at dispatch, at the exact base, with prerequisites checked there, recorded with the dispatch. The owner's choice: the laptop's audit at the exact base is the only reference with the prerequisites checked and the gates that matter actually run; it also catches a red base before a machine is paid for. The owner accepts the longer wait.
  Weighed: Per-gate results kept in the planning gate-health record
  Weighed: No comparison: a gate red on the machine is a red base unless the machine's own prerequisite checks explain it
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-07: What does a run do on an environment fault? (`dec_01M4GVMYASYVS1JX7RZEDBRG66`)
  Chose: Stop at the audit before any strand starts, end the dispatch, report both outputs side by side. The owner's choice: a few minutes of machine time and the cause shown at the keyboard, rather than a night of work verified against gates that cannot be trusted on that machine.
  Weighed: Carry on, treating the disagreeing gates as deferred until the owner is back
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-08: Where does a prerequisite check count? (`dec_01M4GVMYCT2NXH6YA4AZ603Z38`)
  Chose: Each check records where it ran, and a run trusts only checks made where it runs. The owner's choice: keki's HP-01 was checked on the laptop and trusted on a machine that lacked Docker; a check means something only where it ran, and neither location overwrites the other.
  Weighed: The latest check anywhere sets the program's status, as today
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-09: What does Ctrl-C do while `run --remote` shows WAIT? (`dec_01M4GVMYESZ5RG9Z274PSJ27H2`)
  Chose: Detach: the machine carries on, and `nightshift remote status --watch` reattaches. Low risk, taken at the leaning under the owner's standing review style unless the owner objects: closing a terminal must never kill a run; `remote cancel` stays the one way to stop it.
  Weighed: Cancel the dispatch
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-10: How does the project environment reach every step on the machine? (`dec_01M4GVMYH3F578H067ME7EG0NM`)
  Chose: Threaded explicitly: ExecutionEnvironment carries it and every step runner is passed it; Nightshift's own processes never adopt it. The first run built the second option because three callers were outside S-01's path scope; that was a workaround, and the owner ruled path scopes out of Nightshift entirely on 2026-10-09 ("give them the scope to do the job"). With no scope in the way, the root fix is to pass the environment to the processes that are the project's, and keep Nightshift's own processes in the image's environment.
  Weighed: Adopted into the engine process's environment at boot, so every step inherits it
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** S-01 in this run: the first run of P16 already integrated S-01 on the program branch (commits 11f9283, c4520d6, ec3f3df, 5b30ea4, 5b27bd4, 0f4fe9b), carrying out the upheld rulings on partial measured Node versions (isExactRuntimeVersion in contracts, enforced by dispatchToolchain) and on pinned Rust (its own rustup home on the volume). The remaining issue, the engine and runner adopting the project environment into process.env rather than threading it, has been reassigned to S-02 by the human's D-10. (`dec_01M4GXMA11JFTK48PEHWHQAWWW`)
  Chose: Delegate no new jobs. Confirm the landed S-01 against the acceptance criteria and the targeted suites, then complete. The threading is left to S-02 under D-10.. Each acceptance criterion maps to code that has already landed: pins.ts with table-driven tests; measureToolchain plus DispatchToolchainSchema's exact versions; mise in runner-image.ts with installRuntimes into RUNTIMES_DIR; projectEnvironment; the runner keeping the image's Node; run-as XDG_RUNTIME_DIR and DOCKER_HOST; docker.socket plus systemd-socket-proxyd; and the boot-proof checks. The targeted tests pass (pins, dispatch, runner, workspace, runner-image, harness: 253 tests).
  Weighed: Delegate a job to thread projectEnv through examine.ts, gate-repair.ts, flaky.ts and remove adoption, rejected because D-10 assigns exactly this work to S-02, which runs at the same time; doing it here too would conflict on the same lines
  Weighed: Re-delegate S-01 from scratch, rejected because The landed code already meets every acceptance criterion and its tests pass at the current head
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** S-02 in this run: parts A–F landed in the first run (deferral-aware audits, rule 8 mechanical audit, check sites D-08, setup failure SC-07, reference audit D-06, comparison and environment.fault D-07). Remaining: D-10 threading, the fault's surfaces, rule 8's text in gate-standard.md, and the as-built docs. (`dec_01M4GXQHPSJZMWKKT68RBAY86P`)
  Chose: Three parallel jobs (D-10 threading, high risk; fault surfaces incl. inline bounded tails per the F-01 tails ruling, medium; gate-standard rule 8 text, low), then one docs job recording S-02 as built after they land.. The surfaces job avoids the files D-10 edits, so both can run at once; the docs job must describe what actually landed.
  Weighed: One job for all remaining work, rejected because D-10 is high-risk and wide; mixing it with UI/report work slows examination and raises conflict risk
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4GXPTDWGP57JZMNMQPFERCZ:** D-10 removes adoption of the project environment by Nightshift's own processes. runner/root.ts rootEnvironment was copying every project variable (PATH with the pinned runtimes, stores) into the environment of the root agent CLI and of the orchestrator MCP server it launches. That is adoption by inheritance, not by Object.assign. (`dec_01M4GY6T29Y37TSBY5891B1Z4F`)
  Chose: rootEnvironment now passes only NIGHTSHIFT_PROJECT_ENV_FILE when there is a project environment. The engine reads that file in createRuntime and threads it through ExecutionEnvironment.projectEnv and RunAs.env. The runner test now checks that the root env names the file and carries none of the project variables.. Every project step now receives the project environment explicitly, so the root's processes no longer need it. Keeping them in the image environment is what D-10 asks for.
  Weighed: Keep spreading projectEnv into the root environment and only remove the Object.assign calls, rejected because The orchestrator MCP server and the root CLI would still run with the project's PATH. D-10 and the job say Nightshift's own processes (runner, MCP servers, agent CLIs) stay in the image's environment.
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4GXQ5VG3NMXRG88ESVQ0VGG:** P16 S-02 D-07 requires every environment-fault event to carry a bounded tail of each faulted gate's reference and machine output, inline, within the event store's 8192-byte inline payload limit. An arbiter's prior ruling (dec_01M4GSF9ZKT59V6DPXRXYZV7HP) found that a formula which halves one shared tail-length budget can cliff straight to zero on a many-gate fault, dropping every tail even though the payload still has room. (`dec_01M4GZF9EKZM55PTRXFS6ER0Y8`)
  Chose: Search for the widest shared character budget (binary search over candidate char counts, each verified against the real payload's measured byte size via inlinePayloadBytes), applied uniformly to every gate's reference and machine tail, with a final linear correction for the ellipsis-boundary's non-monotonic byte cost.. A search asks the real question ('does this exact candidate payload fit the real 8192-byte bound?') rather than estimating it, so it cannot both overflow the bound and cannot gratuitously collapse to zero while room remains: it finds the largest budget that fits, and that budget is shared evenly so no gate is singled out to lose its tail. This directly satisfies the regression requirement (≥25 faulted gates with long outputs, every gate keeps a non-empty tail, payload stays within MAX_INLINE_PAYLOAD_BYTES), which is covered by packages/execution/src/environment-fault.test.ts.
  Weighed: Keep a closed-form formula (e.g. available bytes / number of tail slots, clamped to a floor) computed from estimated per-field overhead., rejected because Any estimate of per-gate JSON overhead (artifact ids, verdict enums, punctuation) is approximate; a formula tuned to one estimate either overshoots the real byte bound (and EventSchema.parse throws) or undershoots it (wasting room), and is exactly the kind of 'formula that halves a shared length' the ruling flagged as prone to a cliff at zero.
  Weighed: Apply a fixed per-gate character floor (e.g. 200 chars) regardless of gate count, truncating further only if needed., rejected because With many gates, honoring a fixed floor for every gate can itself overflow the inline bound before any truncation logic reduces it, re-creating the same failure mode by a different route.
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4GXQ5VG3NMXRG88ESVQ0VGG:** The environment.fault event must carry each faulted gate's reference and machine output tails inline, within the 8192-byte inline payload limit, and the arbiter ruled a 25-gate fault must still show a meaningful tail per gate. Measured: 25 gates leave about 33 characters per tail in one event, and 40 gates do not fit in one event even with no tails (so such a fault could not be recorded at all). (`dec_01M4H01Q67HRGPVTFAWDZZV267`)
  Chose: Split a large fault into parts: gates are packed in audit order into as many environment.fault events as needed so that every tail keeps at least 300 characters (or its whole output if shorter), each event within the limit; within a part, tails share the largest length that fits. Parts carry part/parts fields; the first keeps the existing idempotency key. Readers (report, remote status, Studio via the report) merge every part's gates.. Guarantees a per-gate floor of a few hundred characters for any gate count, keeps each event inside the inline limit (A-08), and makes faults of 40+ gates recordable. A small fault is still exactly one event, as before.
  Weighed: One event, one shared tail length found by binary search, rejected because At 25 gates each tail is only ~33 characters, and at 40 gates the event cannot be written at all
  Weighed: Put the tails in an artifact behind payloadArtifactId, rejected because The report (core, over ProjectStores) and the Studio do not read bodies, and a machine's body store cannot read back either
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** DEPARTURE: the plan says the fault event holds the reference audit's and the machine's outputs as artifacts. On a machine the artifact body store is write-only (no download route by design), so the reference output could not be read back to show its tail. Instead the laptop's reference audit carries a bounded outputTail per gate inside the dispatch input, and a fault with many gates is split across numbered environment.fault parts so every gate keeps a readable tail (per the F-01 tails ruling). (`dec_01M4H0Z7C09MQ853PYX4VJ7SA5`)
  Chose: Bounded reference tails travel with the dispatch; artifacts are still recorded; large faults split into event parts.. Keeps both outputs visible side by side without a new download route, and satisfies the ruling that tails never collapse to zero.
  Weighed: Give the machine's body store a read path, rejected because The control plane deliberately serves no artifact download route
  Weighed: Omit the reference tail when unreadable, rejected because The report would lose the required side-by-side tails
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** DEPARTURE: the plan lists the machine's stages as up, workspace, toolchain, prerequisites, audit, with setup grouped under "workspace". In the code, the runner installs the pinned runtimes (installRuntimes) after the checkout and before setup, because setup runs on those runtimes. So setup cannot be part of the workspace stage without the stages going out of order. I am adding a sixth stage, `setup`, between toolchain and prerequisites: up → workspace → toolchain → setup → prerequisites → audit. Docker on the machine is rootless and socket-activated per worker user, so the runner has no Docker of its own to prove at the toolchain stage. Its readiness is shown through the prerequisite checks (a project that needs Docker declares it) and through the audit. The toolchain stage names the runtimes it installed. (`dec_01M4H1DV7ZHTG18YZYK4N0JXM1`)
  Chose: Six stages in the order they really happen: up, workspace, toolchain, setup, prerequisites, audit. The display shows what is really happening, in order. The plan's five headings are all kept.
  Weighed: Keep five stages and report setup inside the toolchain stage's detail, rejected because The developer reads the stage name. Setup is often the longest step and deserves its own line.
  Weighed: Move installRuntimes before the clone so the stage order matches the plan, rejected because The project's pins are read from the checkout, so it has to come first.
  Reversible.
  Produced: nothing that landed.
- **Strand S-03:** How S-03 divides into jobs (`dec_01M4H1DZ5SW4AQAF24EDTZ6V1F`)
  Chose: J1: progress contract + core rule + API heartbeat stores latest progress. Then in parallel, J2: runner reports stages and per-gate results through the heartbeat, sending a stage change at once; J3: the CLI's attached WAIT / OK GO display, run --remote staying attached, Ctrl-C detach, remote status --watch. J4 afterwards: the "S-03 as built" docs and README.. The contract is the seam that J2 and J3 share. Landing it first lets the two larger halves run at the same time without touching the same lines.
  Weighed: One job for all of S-03, rejected because It is too big for one worker, and the runner and CLI halves are independent once the contract exists
  Weighed: Run the runner and CLI jobs in parallel from the start, each defining the schema itself, rejected because They would both write the same schema lines and conflict
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4H2KC8GR9EAD49KN6829KJZ:** P16 S-03 part 3: `run --remote` must stay attached showing WAIT then OK GO, and `remote status --watch` must reattach to the same display. The display polls `Dispatch.progress`, renders differently on a TTY vs a pipe, and must end cleanly on every dispatch outcome (agrees/red/skipped/fault/other-failure/stopped/Ctrl-C/poll-failure) without ever being able to cancel the dispatch itself. (`dec_01M4H4DQQNM16CASSV5S4Z2ZQ7`)
  Chose: watchDispatch(environment, session: Pick&lt;Session, "stores"&gt;, scope, programId) — no transport reference anywhere in the display, so a Ctrl-C detach that cancelled anything would be a type error, not just an untested path. All dispatch outcomes are classified once by a pure `classify()` function shared by both the fresh attach (`run --remote`) and the reattach (`remote status --watch`), so "a dispatch already past its audit shows its ending at once" falls out of the same logic rather than needing a special case.. Restricting the display's dependency to `stores` only (not the full `Session`) turns "Ctrl-C never cancels anything" into a structural guarantee that is enforced at compile time rather than a behavior that has to be re-verified by hand on every future change. Centralizing the ending logic in one `classify()` function also means `run --remote`'s attach and `remote status --watch`'s reattach cannot drift apart on what counts as an ending.
  Weighed: Give watchDispatch the full Session (including transport) so the display could also expose a cancel action., rejected because That shape makes a future edit one line away from accidentally cancelling on Ctrl-C; the acceptance criterion requires Ctrl-C to never cancel anything.
  Weighed: Hand-type the WAIT/OK GO ASCII banners character by character in the source., rejected because Error-prone alignment; instead generated the banners once with a throwaway Node script and pasted the exact output in as string-array constants, so no new dependency ships and the rows are guaranteed to line up.
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4H2J70B9CZS04QGYF5QF77Q:** Acceptance criterion 5 requires new tests in apps/mcp/src/runner covering the audit's per-gate progress reporting (agrees/red/fault/skipped verdicts). gates.ts's auditOnMachine needs a real MachineAuditRuntime (git, stores, bodies, ids, clock, paths) to exercise auditGates, compareWithReference, recordEnvironmentFault and recordRedBase for real, not just mocked. (`dec_01M4H4M4AFW6571BDS4TEMC8TT`)
  Chose: Added apps/mcp/src/runner/gates.test.ts using @nightshift/persistence/memory's createInMemoryStores (already a dependency, network-free, test-only by its own docs) plus a real temporary git repository via nodeGitRunner, and core's fixture factories (makeRun/makeDispatch/makeProgramContract) instead of the full startRun orchestration.. This keeps the audit's fault/red-base recording paths exercised for real (real stores.runs/events/artifacts, real git worktrees) while staying inside apps/mcp's existing dependency graph and running fully offline, matching the job's layering constraints. It also let the agrees/red/fault/skipped progress-reporting tests run in under a second total rather than spinning up an HTTP server per case.
  Weighed: Reuse test/src/execution/machine-gates.test.ts's createBaseWorld harness (a real local HTTP control plane via @nightshift/api/testing), rejected because apps/mcp cannot depend on @nightshift/api (the test package depends on mcp, not the reverse); standing up a local HTTP server per test is also far heavier than this job's scope needs.
  Weighed: Hand-roll fake implementations of ProjectStores/ArtifactBodyStore from scratch, rejected because would duplicate @nightshift/persistence/memory's in-memory adapter, which apps/mcp already depends on and which re-parses every record through its contract schema; reimplementing it adds risk for no benefit.
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4H2J70B9CZS04QGYF5QF77Q:** P16 S-03 heartbeat progress: the job says to store "the latest progress as unsent", but the examiner's F-01 found that a single slot lets a later stage overwrite `up` before the first beat. The same race could also skip any stage. (`dec_01M4H5FD0XKB2P5FM7RM4PK3CM`)
  Chose: Unsent progress is a short queue with one entry per stage. Within a stage the newest replaces the older; a new stage queues behind and goes in the next beat, sent as soon as the current beat returns. A failed beat puts its progress back unless a newer one of the same stage has arrived. `stopped` is held back until it can go with the last unsent progress, so the fault verdict is never sent after it.. Every stage reaches the plane in order, the plane always ends on the newest progress, and stale progress is never sent over newer. The queue holds at most six entries, because stages only move forward.
  Weighed: A single latest-progress slot, with the snapshot taken before sample(), rejected because It fixes only the first-beat race. Any two stage changes inside one beat's flight still drop the earlier stage, and a fault's verdict could land in the same slot as an earlier stage.
  Reversible.
  Produced: nothing that landed.
- **Ruling node_01M4H2KC8GR9EAD49KN6829KJZ:** The arbiter's ruling on finding F-01 of examination exam_01M4H6HQ1TJJME5ZEPM1RDXBXM. (`dec_01M4H6KGJCEH7YNER1SMZJJ5XY`)
  Chose: uphold. Confirmed in the checkout: plainDisplay in apps/cli/src/commands/watch.ts computes its time prefix only from dispatch.requestedAt and emits stage changes as `${at} ${stageLine(dispatch)}`. Neither this path nor stageLine reads progress.stageStartedAt. Only the terminal path through waitLines computes and shows both durations. The task explicitly requires stage elapsed time and total elapsed time; the non-TTY requirement changes rendering frequency and format, not the required timing information. This leaves pipe and CI output missing required information. Each plain stage-change line with current progress must include both m:ss durations from environment.clock while retaining one line per change. The finding is valid and the work should not land as it is.
  Weighed: overturn, rejected because the arbiter chose to uphold
  Reversible.
  Produced: nothing that landed.
- **Job node_01M4H2J70B9CZS04QGYF5QF77Q:** P16 S-03 heartbeat progress: what happens to progress after a failed beat. Waking early on every progress could burn the three LEASE_MISSES within seconds during a short plane outage. (`dec_01M4H6SMKJ5VNR4MVR11FZYFSK`)
  Chose: A failed beat's progress goes back only if nothing newer has arrived, and it waits for the normal 20s interval. A new stage or verdict given meanwhile still beats as soon as the failed beat returns. Detail-only wakes are suppressed while misses > 0. The 2s detail gap is measured from the last beat's start, recomputed in each wait, so a newer stage beat resets it (F-02).. This meets AC1 (newest unsent progress re-sent, stage changes immediate) and keeps LEASE_MISSES meaning roughly a lost lease.
  Weighed: Retry a failed beat's progress at once, or 2s later, rejected because Three quick failures would declare the plane lost within seconds rather than about a minute, and exit the runner over a short blip.
  Weighed: Hold every progress until the interval after a failure, rejected because A new stage given while a failing beat is in flight would wait 20s (examiner F-01).
  Reversible.
  Produced: nothing that landed.
- **Ruling node_01M4H2J70B9CZS04QGYF5QF77Q:** The arbiter's ruling on finding F-01 of examination exam_01M4H6ZRR1FB17W3QSGHNYW0DC. (`dec_01M4H71H4T48YG6P7CCM1D33QN`)
  Chose: uphold. Confirmed in the checkout: beat() takes unsent progress and clears it before awaiting options.sample(), but the catch that restores it with unsent ??= progress surrounds only posting and response parsing. A sample rejection therefore loses that progress permanently when no newer progress arrives; run() counts the miss and retries without it. The production sampler awaits Promise.all of machine reads and commands without catching rejections, so this is a reachable failure path. This violates acceptance criterion 1's failed-beat retry guarantee and can lose the initial up stage or the final audit fault verdict, including before a subsequent stopped/environment_fault beat. The finding is material and the work should not land as it is. The restoration boundary must cover sampling as well while preserving newest-wins behavior, with regression coverage for a rejected sample.
  Weighed: overturn, rejected because the arbiter chose to uphold
  Reversible.
  Produced: nothing that landed.

## Usage

Token counts are what each harness reported and are not comparable across harnesses.
A cost marked * is estimated from the price table, not reported by the harness. A cost
that is unknown had neither: give the org's price table a price for that model to estimate it.

| Harness | Model | For | Routes | Input tokens | Output tokens | Cost (USD) |
|---|---|---|---|---|---|---|
| claude | claude-opus-5-5 | work | 12 | 1548 | 470148 | 39.53 |
| claude | claude-haiku-4-5-20251001 | work | 2 | 714 | 28801 | 0.86 |
| codex | gpt-6-astra | examine | 1 | 600054 | 1098 | unknown |
| claude | claude-sonnet-5 | work | 8 | 1448 | 452258 | 33.87 |
| codex | gpt-6-sol | examine | 11 | 6093569 | 26083 | unknown |
| codex | gpt-6-astra | arbitrate | 2 | 262031 | 601 | unknown |
