# P15 Gate Health

## Overview

Nightshift can only be as good as a repository's gates. This program makes gate
health something Nightshift judges, records and repairs. Before a plan is
ratified, planning audits the repository's gates against a gate standard
Nightshift ships, the human decides each fix, and a gate-health strand builds
them. During a run, a broken or flaky gate is repaired by the run itself and
recorded as a decision for the owner to review. Nothing is re-planned.

The authority is `docs/programs/p15-gate-health.md`, the program's contract
document in this repository's own format. Its §3.2 decisions are the contract's
D-01 … D-11 here, and its §4 is the design. This plan is how that contract is
built by Nightshift itself, the first Nightshift program it runs.

Not delivered: repairing gates outside a program, test coverage, changes to how
a strand cuts or routes its own jobs, backfilled records for projects already
planned, and deployment (the owner deploys after the run).

## Who it is for

US-01 comes first: the owner's direction was that the human initialises
Nightshift on a repository by deciding its gate fixes before the first run,
because the run can only be as good as the testing. US-02 is the run's half: when
a gate still breaks, the run fixes it and the owner reviews, rather than the run
stopping or asking for a re-plan.

## Architecture

New, by layer:

- **contracts**: a `GateHealth` record, one per project (fingerprint, commit
  audited, verdict `healthy | repairing`, findings each with the decision that
  answered it, gate-machinery paths with their hashes, auditor, time). A
  verification command gains `flaky?: true`. A Job Contract gains
  `kind: "repair"`.
- **core**: the fingerprint function (setup and gate commands, lockfiles, the
  named gate-machinery files at a commit); `plan check`'s new rule (D-08);
  `failureClimbs` never climbs for a flaky result; the report's *Gate health*
  section.
- **persistence and api**: a `gateHealth` store port in memory, AWS, the local
  SQLite store and HTTP, and its routes. Written only by Nightshift commands and
  the engine.
- **cli**: `nightshift gates {id} --record`, which runs the mechanical audit
  (A-52, already built) and writes the record with the findings the planning
  agent supplies; `plan check` reads the record.
- **skills**: `plan-program/gate-standard.md` (§4.1 of the contract), and the
  planning audit step in `plan-program`.
- **execution and mcp**: flaky detection in verification; the repair job kind
  and the root's authority to add it on a planned run (amending D-P7-04 for
  repairs only); repair-first at the start of a run, replacing A-52's stop and
  the runner's `failBeforeStart`; gate definitions that change when a repair
  lands; the program checkout as the setup reference.
- **studio**: the run's Status tab shows the audit, each repair and each flake.

What stays: how strands are cut, routed and examined; the merge queue; the
mechanical audit itself; verification's pristine clean.

## Strands

### S-01 The gate-health record and the planning audit

Afterwards, planning a program on a repository with no healthy record runs the
gates, reviews the gate machinery against the gate standard, and turns each
finding into a decision the human answers. `nightshift gates {id} --record`
writes the project's record, and `plan check` answers READY only per D-08. A
later plan on unchanged gates skips the audit, and changing any gate-machinery
file brings it back.

#### Approach

- The record in `contracts`, its port in `core`, its stores in `persistence`
  (memory, AWS, local SQLite, HTTP) and its routes in `apps/api`, following how
  the warm-cache record is built end to end. Reads by any project member;
  writes by the CLI's signed-in operator and by an engine token for the run's
  project.
- The fingerprint in `core`, pure: given the setup and verification commands,
  the lockfiles' bytes and each named machinery file's bytes, a `sha256`. The
  CLI computes it from `git show <commit>:<path>` so it describes a commit, not
  the working tree.
- `nightshift gates {id} --record [--findings <file>]`: the findings file is the
  planning agent's (id, standard rule, what was found, the decision id that
  answers it, the machinery paths it touched). With no findings and a green
  mechanical audit the verdict is `healthy`; otherwise `repairing`.
- `plan check` gains the rule of D-08, with every reason at once as today. It
  reads the record over the control plane when signed in, and says so when it
  cannot.
- `skills/plan-program/gate-standard.md`, and a new step in `plan-program`
  between reading the code and proposing seams: fingerprint check, audit,
  findings to decisions, the gate-health strand `S-00` when there is anything to
  fix, `--record`. The step says the human waits for it, on purpose.
- Tests: the fingerprint's properties, the store against the real HTTP control
  plane (the existing suites' pattern), `plan check`'s rule in both directions,
  and the CLI end to end on the planning fixture repository.

#### Considered and rejected

- A committed file in the repository as the record: a hand edit would fake an
  audit, and the Studio and a runner could not read it without a checkout.
- A one-time onboarding program per project: it goes stale silently as the
  repository changes.
- An intelligent audit at the start of every run: an agent and a full review
  each night, repeating work on gates that did not change.

### S-02 Repairs in the run

Afterwards, a run never stops for a gate. A red base at the start becomes the
run's first job, a repair, and the strands wait on it alone. A check that fails
and then passes on the same commit lands the work as flaky, does not climb the
route, and opens a repair job nothing waits on. A repair job may change anything,
setup and gate commands included; it always records a decision, is examined at
high risk against the gate standard, and its new gate definitions apply to the
verifications after it lands. The report and the Studio show the audit, every
repair and every flake. After a repair lands, setup runs once in the program
checkout, so later worktrees are seeded from it.

#### Approach

- **Flaky**: in `verify.ts`, after the checks, rerun each failed check once on
  the same pristine checkout. A pass marks the command `flaky`, the verification
  passes, and the engine is told (an event) so the root can open the repair.
  `failureClimbs` is untouched for real failures.
- **Repair jobs**: `kind: "repair"` on the Job Contract; the root's `delegate`
  refusal on a planned run (`plan_fixes_strands`) admits a repair, with the
  program's whole scope (D-10), risk `high`, and an objective that names the
  failing gate and the gate standard. Every repair delegation records a decision
  in the same call; the tool refuses one without it. The examiner's brief gains
  the gate standard and "a weakened gate is a blocking finding unless the
  decision says why".
- **Gate definitions that change**: a repair that edits `nightshift.config.json`
  (or the contract's setup or verification) lands like any work; on landing the
  engine reads the merged setup and verification from the program branch, records
  the change on the decision, and later verifications use it. The plan hash does
  not change: this is a run decision, reviewed, not a re-ratification.
- **Repair first**: `nightshift run`'s red result and the runner's no longer stop
  or fail the run. They start it, and the root's first act is a repair job;
  `strand.delegate` holds every strand until that repair lands.
- **Setup reference**: after a repair lands (and at run start), setup runs once
  in the program checkout with the install marker written, so D-P10-24's seeding
  works on a laptop too.
- **Surfaces**: the report's *Gate health* section (verdict, repairs with their
  decisions, flakes) in `core`'s report; the Studio's Status tab the same.
- The verification and repair parts are the riskiest code in this program: the
  strand's orchestrator marks those jobs `high`.
- Tests: the execution world (`test/src/execution`) for flaky detection, a repair
  that changes a gate definition, and repair-first; the MCP tool's refusal of a
  repair without a decision; the report's section; the Studio's tab.

#### Considered and rejected

- Holding a job whose gate flaked until the repair lands: reliable, but every
  flake would serialise the night (owner's Q6).
- Letting a repair change only tests and scripts: keki-backend's missing setup
  could then never be fixed by a run (owner's Q5).
- Re-ratifying when a gate definition changes: the owner's Q2.

## Decisions

All eleven are answered in the contract (D-01 … D-11), mirroring D-P15-01 …
D-P15-11 of the contract document, where each one's question, options and
rationale are written out. None is open.

## Risks

- **The planning audit is noisy.** Too many findings make planning a chore. The
  standard is short on purpose.
- **A repair loops.** It is bounded by D-P8-13's fix limits like any job.
- **Self-hosting.** Nightshift is building Nightshift. The run executes the
  deployed Nightshift, not this branch, so nothing the run changes affects the
  run itself; the owner deploys after.
- **The test suite is long.** One verification is the whole `npm run verify`
  chain, minutes on the runner; `maxConcurrency` 2 means two at once.
