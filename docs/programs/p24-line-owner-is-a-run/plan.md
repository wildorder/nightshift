# P24 The Line Owner Is a Run

## Overview

The project line (P23, A-66) keeps its job, composing every program's landed
work onto `nightshift/develop`, and loses its private machinery. A line owner
session becomes a **run** of a per-line program, dispatched, leased, tokened,
heartbeated and stopped by the code that already does that for program runs.
The composer sits where a run's root orchestrator sits, but it is deterministic
code: it takes the queue, merges, verifies and pushes, and the one time it needs
intelligence, a conflict or a red check, it asks the engine for a **repair job**
(P15, D-P15-04) on the same warm machine. That job gets everything a run's job
has: an Agent record, events, a routing decision, usage, a transcript, a
high-risk examination and a recorded decision. The line's own resolver loop,
its agent launcher and the harnesses' `startLine` are deleted, along with the
second machine record (`LineDispatch`) and its duplicated heartbeat, token,
credential and cancel handlers.

While a repair runs, the line does not stop. It reserves the paths the failing
range touches and keeps composing every range that touches none of them; the
few that do wait, and a repaired range is composed next. A range whose repair
budget is spent is parked with the cause and the agent's own words. Every
machine, program run or line run, keeps its runner log as an artifact, so a
failure can be read after the machine is gone.

Not delivered here: batch-and-bisect proving and conflict analysis between
ranges (PK-7), release candidates (M2), and removing per-project hotspots such
as a shared `docs/as-built.md` that every program appends to (a project
convention; this plan's guidance names it, nothing here edits a project).

## Who it is for

US-01 is the owner running several programs at once, for whom one conflict
today holds every range queued behind it for up to an hour. US-02 is the same
owner the morning after a line failure, who today has one line of parked reason
and a machine that no longer exists; the first line failure on foodfly
(2026-10-28, "the resolver failed (exit 127)") was never explained for that
reason. US-03 is whoever maintains Nightshift: the line's agent path and
machine path were written beside the run's, and the three bugs found on the
first trial (the `%2F` route, the missing boot lease, the worktree the project
user could not enter) all lived in the copy.

The conversation reached this design by rejecting three others: a run per
repair started by the plane (minutes of overhead per repair where seconds are
available on the warm machine), a second line-keyed shape for every agent
record (the parallel path again, spread thinner), and a model in the composer's
seat (the line's choices are determined by data; the practitioners who tried a
robot making content decisions about others' work all backed it out).

## Architecture

What the code map (2026-10-28) found, and what the design does with it:

- **The engine's job path is plain functions.** `delegateJob` and `startJob`
  (`packages/execution/src/runner.ts`) take an `ExecutionEnvironment` and a
  `RunSession` (scope, program, run, root node, orchestrator agent id,
  checkout). The MCP `delegate` tool is a thin wrapper. The runner image already
  ships the engine, so the line machine has the code and lacks only the run to
  key its records by.
- **Repair jobs exist** (P15, D-P15-04): a job outside every strand, requiring
  a recorded decision, examined at high risk, allowed to change anything. A
  line repair is one with a new cause.
- **Every agent record is run-keyed and most are node-keyed** (Agent, Event,
  RoutingDecision, Measurement, Artifact, Verification, Examination), down to
  the table's partition keys. Nothing here changes those shapes; the line gains
  a run instead.
- **The two dispatch records already share their status machine**
  (`DispatchMachine` in `core/rules/dispatch.ts`); what is duplicated is the
  handlers around it (`operations/dispatch.ts` vs `operations/line.ts`:
  heartbeat, token, credentials, cancel, ~250 lines twice). Retiring
  `LineDispatch` removes the copy rather than merging it.
- **The runner never keeps its own log.** `say` writes to stderr, systemd keeps
  it in the journal, and the journal dies with the machine. Program runs keep
  agent transcripts but not the runner's log either.

Afterwards:

```
 project with "line" ──► line program (kind: line, programBranch = the line branch), made by the plane
 a range is published ──► queue entry ──► no live run of the line program? dispatch one (self-started cap)
                                                           │
                       ┌───────────────────────────────────┘
                       ▼
          LINE RUN on a machine (runner image; a run machine in every respect)
          root seat: the composer (code), engine token, standard stores
            take queue → merge main, ranges → landing checks → publish (CAS) → settle
            conflict / red ──► decision + repair job (engine, same machine, warm worktree)
                                 reserve the range's paths; other ranges keep landing
                                 job lands on the line candidate → compose next
                                 budget spent → park with cause + agent's words
            idle period over ──► the run ends; the machine stops
          every N minutes and at stop: runner log → artifact of the run
```

What stays exactly as it is: how a program run lands, verifies and publishes;
the publisher's CAS push; the line record's queue, batch and composition rules;
the self-started cap; the one-live-run guard (A-66's "one owner" now simply is
it).

## Strands

### S-01 The line program and its run, in the plane

**What will exist afterwards.** A project that names a line has a program of
kind `line` for it, made by the plane, whose `programBranch` is the line
branch. A line owner session is a run of that program, dispatched through
`dispatch.create` like any remote run, under the self-started cap and the
org's ceilings, with an engine token. "One owner per line" is the one-live-run
guard. `LineDispatch` is gone, with its handlers; the `line.*` routes that
remain are the line's own job (queue, batch, settle, push, bundle upload), and
the engine access table grants them to a line run's token for its own project
and branch. The line record keeps the queue, compositions, parked ranges, push
and cap, and loses `agents` and resolver decisions (a repair's decision is the
run's).

#### Approach

- Contracts: `ProgramContractSchema` gains an optional `kind: "line"`; a line
  program's contract is honest content (objective, one criterion "every
  published range is composed onto the line or parked with its reason", the
  line's scope) written by one core function from the project's `line` setting.
  `RepairCauseSchema` gains `line_conflict` and `line_red`. `LineRecord` drops
  `agents`/`decisions`; compositions and parked entries name the repair's
  `runId`/`jobContractId` where one ran. The line principal and `LineDispatch`
  schemas are removed.
- Core: `ensureLineProgram` (idempotent, keyed by project and branch);
  admission of a line run (`lineAdmission`) applied at `dispatch.create` for a
  `line` program; the engine access table gains the surviving `line.*`
  operations scoped `own_project_line`; `isPlanned`/`mayRunContract` treat a
  line program as runnable without ratification.
- API: the publisher's queue-and-start path asks for a run of the line program
  instead of a line dispatch; `reconcile` loses its line-dispatch pass and
  `reconcileLinesWithWork` starts a run; `line.ts` keeps only queue, batch,
  settle, push, bundle-upload handlers; the heartbeat/credentials/cancel/token
  copies are deleted. `provision-line.ts` goes; `provision.ts` tags a line run's
  machine from its program kind.
- Persistence: store methods for `LineDispatch` removed from all three adapters
  and the conformance suite; existing `LINEDISPATCH#` rows on dev are ignored
  (a one-line note in the run's report).
- `docs/architecture.md`: a row amending A-66 (A-67).

This is the riskiest strand: dispatch admission, authorisation and the
one-live-run guard. Its orchestrator should mark those jobs high.

#### Considered and rejected

- A line-keyed parent on every agent record: every store, route and reader
  twice.
- Keeping `LineDispatch` pointing at the run: the duplicated handlers stay, and
  they are where the trial's bugs lived.
- A placeholder contract: the contract's required fields can all be said
  truthfully of a line.

### S-02 The composer in the root seat, repairs as engine jobs, the kept log

**What will exist afterwards.** The runner boots a line run as it boots any
run, and when the program's kind is `line` it starts the composer instead of a
root agent. The composer builds the engine's `ExecutionEnvironment` from what
the machine already has and, on a conflict or a red check, records a decision
and delegates a repair job (cause `line_conflict`/`line_red`, the brief
assembled from the line head, the ranges it holds, the conflicting paths or the
failing check's output, what landed since, and the line's recent repairs). The
job's landing target is the line candidate; the composer takes its commit and
composes on. Path reservation and the repair budget live in
`packages/execution/src/line/compose.ts`. `line-agents.ts`, the resolver loop,
`LineResolverAgentPort`, `startLine` in both adapters and `HarnessLineStartInput`
are deleted. The runner keeps its own log in a file on the volume and records
it as an artifact of its run (kind `runner-log`) every ten minutes and at stop,
for program runs and line runs alike.

#### Approach

- Runner (`apps/mcp/src/runner`): `lineMode` folds into `runMode`; the identity
  comes from the run's tags as today; `line-owner.ts` becomes the composer's
  host: standard HTTP stores and outbox under the engine token, the project
  environment, `createRuntime`, and a `RunSession` whose orchestrator agent is
  the composer itself (an Agent record of role `orchestrator`, so events have an
  author). The bundle upload and line push stay as they are.
- Execution (`packages/execution/src/line`): `LineComposerPorts.resolve`
  becomes `repair(failure): Promise<RepairOutcome>`, implemented in the runner
  by decision + `delegateJob` + `startJob` + wait; `compose.ts` gains the
  reservation set (paths of a range: `git diff --name-only from..upTo`), the
  held queue, the next-up rule for a repaired range, and the per-lineage budget;
  integration of a repair job targets the line candidate worktree (the job's
  `integrate` input names the branch).
- Harnesses: remove `startLine`, `renderLineBrief`'s line-only task kinds, and
  the line tool policies; a repair worker is an ordinary worker with a repair
  brief (`renderBrief` already renders `repair`).
- Log: `nightshift-runner.ts` tees `say` to `${layout.run}/runner.log`; a small
  module uploads it through `recordArtifact` under the run's root node, timed
  and at every ending path, never failing the run when it cannot.
- Tests: `line-owner.test.ts` and `test/src/line/line-e2e.test.ts` drive the
  composer through a fake engine where the real one is too heavy, and the e2e
  proves a conflict → repair job → composed → pushed path, a reservation holding
  one range while another lands, and a budget-spent park with the agent's words.

#### Considered and rejected

- Repairs as plane-started runs on their own machines: minutes of start-up per
  repair, for no gain in recording.
- Halting the whole line during a repair: the global lock every scaled system
  removed.
- Reading the systemd journal: needs group membership in the image (infra);
  the runner's own file needs nothing.

### S-03 Seeing it: Studio, CLI, report

**What will exist afterwards.** The Studio lists a line program apart from
plan programs on the project page (one row: the line, its head, its last
composition, its parked ranges, its live run), and a line run's page reads as
compositions and repairs rather than strands and jobs; a repair job shows as
any job does, with its transcript and examination. `nightshift line status`
reads the line record and the line program's runs. The report of a line run
has no strands section and leads with what was composed, what was parked and
why, and the repairs.

#### Approach

- Studio: a `kind === "line"` branch in the project page's program list and the
  run page's header; no new routes. CLI: `line status` lists runs of the line
  program with their machines and spend. Report: `gatherReport`/`renderReport`
  recognise the kind for the overview and omit the plan sections.
- Docs: the run-program skill's and `docs/architecture.md`'s wording; a note in
  the plan-program skill's hotspot guidance that a file every program appends to
  (as foodfly's `docs/as-built.md`) is where line repairs will concentrate.

#### Considered and rejected

- A separate Studio page for lines: the line is a program with runs now; one
  branch in two views is the whole difference.

## Decisions

D-01 to D-07 are in the contract, all answered. The three below are the ones the owner weighed at the end of planning.

### D-04 When is a range's paths reserved?

On its first conflict (closest to today's certainty, still scales), or only
after a repaired range bounces a second time (closest to Scion, highest
throughput). Answered: first conflict; to be relaxed later only if
reservations themselves show up as the bottleneck.

### D-05 The repair budget per range lineage

Three, as today's resolver attempts, counted across a range and the repairs of
its repairs; then parked for the program's pull request. Answered: three.

### D-07 Does a line run take one of the org's machine slots?

It is a machine; today's line owner takes one, and the Studio now sets the
ceiling. Answered: yes, it counts.

## Risks

- **Dispatch admission and authorisation change** for a new program kind; a
  mistake either refuses every line run or lets a line token past its project.
  S-01's jobs are high risk; the handler tests already pin every principal.
- **The trial will find what fakes cannot.** P23's three bugs were all between
  the machine and the plane. The exit gate is a real trial: two programs on a
  sandbox or foodfly with a deliberate conflict, watched through the kept log.
- **The repair brief** is product, not plumbing: it may need a round of tuning
  against real conflicts before repairs land reliably.
- **This program touches the engine and dispatch code**; run it alone.
