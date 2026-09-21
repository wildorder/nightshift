# Program P7 — Planning

| Field | Value |
|-------|-------|
| Program ID | `p7-planning` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p7-planning` |
| Source stage | — (inserted 2026-09-21; not in the source plan, which assumes the orchestrator plans for itself) |
| Status | **Drafted 2026-09-21**, for human ratification. D-P7-01 … D-P7-11 proposed; tasks T1 … T8 drafted. |
| Depends on | P6 Parallel and Recursive Execution (the engine, the merge queue, sub-programs) |
| Blocking decisions | none |

This contract is the stable authority for P7. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Put a **planning stage** in front of execution, owned by the human.

Today a program is eleven success criteria and a scope, and everything between
that and the code is invented by an orchestrator at run time. The first trial on
a real repository (keyart, 2026-09-21) made the cost plain before the run had
finished: the developer cannot see roughly what will be built or how, cannot
anticipate a decision and make it up front, and cannot shape where the work is
cut. Every one of those choices is then made mid-run by an agent with partial
context, recorded as a decision that may have to be reversed, with code already
built on it.

After P7, a program is **planned with the human, in documents, until the human is
happy with it**, and only then run. Planning produces the same three artifacts
for every program, in the same places, for the life of a product:

1. a **program document**: what this program is for, how the architecture
   changes, the decisions that can already be seen coming, the risks;
2. a **manifest**: the machine contract — success criteria, the workstream
   roster with scopes and dependencies, and the human prerequisites;
3. a **spec per workstream**: what will exist and how, at the fidelity a
   developer wants to read before saying yes.

Two things the plan has to get right, because they are what let a run finish
**end to end with nobody watching**:

- **Seams.** Where the program is cut into workstreams, and where this program
  ends and the next begins, so that every workstream is an independently green
  checkpoint and no run waits on a human in the middle.
- **Human prerequisites.** Everything only a human can do (a credential, a
  console action, a DNS record), found at planning time, written as a runbook
  with a command that proves it was done, and checked deterministically before
  the run starts.

Then `nightshift run <program>` executes the ratified plan autonomously: no
human session as orchestrator, dependencies enforced by the engine, a workstream
that cannot finish parked with its downstream cone while everything else
continues, and a report at the end.

## 2. Environment and human prerequisites

Everything from P3 … P6 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P7-01 | Ratify D-P7-01 … D-P7-11 | open |
| H-P7-02 | P6 merged | **satisfied 2026-09-21** (PR #18) |
| H-P7-03 | The keyart trial run has finished, so its observations can inform T3's templates | open; not blocking T1 or T2 |

**Explicitly not required.** No new AWS resource. The API gains a little (§4.5).

## 3. Proposed decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P7-01 | **Planning is a stage with a gate.** A program is `planning` until a human ratifies its plan, and nothing executes before that. Ratifying records a hash of the plan's artifacts in the control plane; a run refuses to start if the artifacts on disk no longer match a ratified hash, so an edited plan is re-ratified, never silently run. | The owner's requirement, verbatim in spirit: "only after we're happy with the plan after back and forth editing the planning docs should we let the orchestrator go off and build autonomously". A gate that can be bypassed by editing a file after approval is not a gate. |
| D-P7-02 | **Three artifacts, one layout, for every program.** In the target repository: `docs/programs/{program-id}-program.md` (narrative), `docs/programs/{program-id}-manifest.json` (canonical structured plan), `tasks/{program-id}/{WS-id}-{slug}.md` (one spec per workstream), and after a run `docs/programs/{program-id}-report.md`. **One canonical home per fact**: success criteria, the roster, dependencies, scope and prerequisites live in the manifest and only there; the program document refers to them by id and never restates them. Project-wide defaults (project id, verification commands, model policy, context documents) move to `nightshift.config.json`. The single root `nightshift.program.json` is retired: a product runs many programs, and one file at the root holds one. | The layout the owner's earlier Nightshift used and already knows. Two copies of a fact drift; a plan whose documents disagree is a plan nobody can ratify. |
| D-P7-03 | **The manifest is the Program Contract, grown.** `ProgramContract` gains `status`, `executionMode` with its reason, `workstreams`, `prerequisites`, `anticipatedDecisions` and `outOfScope`. A workstream has an id (`WS-01`), a name, a spec file, a size, a `scope` (`summary`, `includes`, `excludes`), `dependencies`, `prerequisites`, and a risk. Everything a program contract has today stays as it is, and a manifest with no workstreams is still a valid contract that runs as programs run today. | One record is still the authority (A-06), so there is no second document to keep in step with it. Backwards compatibility keeps P3 … P6's suites and the conformance run untouched. |
| D-P7-04 | **Scope is load-bearing.** Every workstream states what it owns, what it includes, and what it **excludes**. The roster of ids, names and scopes is what every spec author and every orchestrator is handed about the workstreams that are not theirs, so an exclusion is how a workstream tells its neighbours "not here" and how a requirement is stopped from belonging to nobody. | A workstream's neighbours will otherwise reimplement its work or assume it covers something it does not. It is also what makes overlap checkable (D-P7-07). |
| D-P7-05 | **Seams: every workstream is an independently green checkpoint.** Starting from a green repository containing only its declared dependencies, a workstream must be able to finish with the program's verification green. A later workstream never repairs an earlier one. Shared-contract changes are sequenced expand → migrate → contract/delete. `executionMode` is `atomic` (one workstream, one spec) unless there is causal evidence for `orchestrated`: context that cannot fit one session, real parallelism, or a migration that must be ordered. | P6's merge queue verifies every job on the head it lands on, so a roster that leans on later repair work fails at the first workstream instead of at the end. And a parked workstream (D-P7-10) must leave everything outside its cone building. Defaulting to atomic stops a plan being cut up because the work is important rather than because cutting helps. |
| D-P7-06 | **The actor audit, and human prerequisites.** Planning asks of every unit of work: *what credential or access does this consume, and does the crew hold it?* Each hit becomes a prerequisite `HP-nn` with a description, a **remediation** written as the exact commands or console steps, and a **`verifyCommand`** that exits zero iff it is done, runnable headless with credentials the runner holds. A prerequisite is something the crew *cannot* do, never something merely tedious. Human actions are hoisted to workstream boundaries and batched into the fewest handoffs; agent-doable work is sequenced ahead of the first unmet one. **Only the deterministic preflight ever marks a prerequisite satisfied**, never a planner and never a model. | The thing that actually stops a run finishing unattended is rarely the code. The distinction between permission to *perform* (the crew lacks it, which is why it is a prerequisite) and permission to *observe* (the runner must have it) is where a `verifyCommand` usually goes wrong. |
| D-P7-07 | **A deterministic readiness check decides whether a plan can be ratified.** `nightshift plan check`, no model involved: the manifest is valid; dependencies are acyclic and name real workstreams; every success criterion is claimed by a workstream; every workstream's scope is inside the program's; every workstream has a non-empty spec; every prerequisite has a remediation and a `verifyCommand` and is referenced by a workstream; **two workstreams with no dependency path between them whose scopes overlap are flagged**, because P6 will run them at once and they will conflict. It answers `READY` or a list of reasons. | Ratifying is a human's judgement; whether the plan is *executable* is not a matter of judgement. The overlap rule turns P6's most likely failure (an `integration_conflict`) into a planning-time finding. |
| D-P7-08 | **Anticipated decisions are made by the human, before the run.** The plan lists the choices that can be seen coming, each with the options, the leaning and the reason. At ratification they are recorded as `Decision`s with authority `human` on the program node, and every spec author, orchestrator and worker that reaches that choice is handed the answer. | A decision made up front is a constraint, not a fork: nothing is built on the alternative, so there is nothing to replay. It shrinks the decision graph P9 has to manage rather than feeding it. |
| D-P7-09 | **Two skills, shipped with Nightshift, are the planning flow.** `plan-program` works with the human: reads the vision, the as-built, `AGENTS.md`, the context documents, the backlog and any prior run report; chooses the execution mode; runs the actor audit; writes the program document and the manifest straight to disk as the review surface; and iterates on the files. `author-specs` writes one spec per workstream, **each by a clean agent** given the program document, the roster and that workstream's manifest entry, then runs the readiness check. The human edits any of it. `nightshift plan ratify` closes the stage. | Documents on disk are the review surface, not a chat window. A spec written inside the planning conversation is written in a context carrying the whole negotiation and then graded by its own author; a clean agent per workstream sees what a worker will see. |
| D-P7-10 | **Execution follows the ratified plan, with no human in the loop.** `nightshift run {program-id}` runs preflight, then starts a **headless root orchestrator** through the routed adapters whose brief is the plan. The engine enforces `dependencies`: a workstream starts only when the ones it depends on have integrated. A workstream is a job, or a sub-program when its spec needs more than one. Inside its scope an agent decides freely. Changing the roster (adding, dropping or re-cutting a workstream) is a recorded decision that cites the plan item it departs from. A workstream that cannot finish is **parked** with everything downstream of it while the rest of the program continues, and a workstream whose prerequisite is unmet waits as `awaiting_human` without blocking anything outside its cone. | This is "go off and build autonomously e2e". A failure that stops the whole run wastes the night; one that parks a cone wastes only the cone. `JobContract.dependencies` has existed since P1 and nothing has ever read it. |
| D-P7-11 | **The run reports against the plan, and the next plan reads the report.** `docs/programs/{program-id}-report.md`: every workstream's outcome against its spec, success criteria met and unmet, decisions taken (and which departed from the plan), what was parked and why, prerequisites still pending. Re-planning starts from the repository as it now is, keeps the record of what ran, and gives replacement work new ids. | A program that half-finished is planning input, not a failure to start over from. |

### Non-guarantees

- **A ratified plan is not a correct plan.** The readiness check proves a plan is
  executable, not that it is wise.
- **Specs are medium fidelity on purpose.** They say what will exist and how it
  is shaped; they are not a line-by-line design, and a worker still makes the
  local choices.
- **A prerequisite's `verifyCommand` is run verbatim**, in the same trust class
  as the program's verification commands. It is reviewed at planning time
  precisely because it will be run.
- **Workers are still not contained** on the operator's machine (A-39, P10).

## 4. Design

### 4.1 The flow

```text
brief ──► plan-program ──► program.md + manifest.json ──► author-specs ──► tasks/{id}/WS-nn-*.md
             ▲   (with the human, files on disk, as many rounds as it takes)        │
             └────────────────────── human edits anything ◄──────────────────────┘
                                          │
                              nightshift plan check   ──►  READY | reasons
                                          │
                              nightshift plan ratify  ──►  plan hash recorded; status: ratified
                                          │
                              nightshift run {id}
                                 preflight: every HP's verifyCommand, deterministically
                                 headless root orchestrator, brief = the plan
                                 engine: dependencies, slots, merge queue (P6)
                                 parked cones, awaiting_human
                                          │
                              docs/programs/{id}-report.md  ──►  input to the next plan
```

### 4.2 What a spec contains

```text
# WS-03 — {name}
Objective            the outcome, in a sentence or two
What will exist      the capabilities and surfaces afterwards
Approach             modules touched, interfaces and data shapes, in prose and signatures
Touches / Excludes   from the manifest's scope, made concrete as paths
Decisions            taken here, with reasons; open ones, surfaced for the human
Acceptance           checkable statements, traced to SC ids
Verification         what proves it, beyond the program's gate
Jobs                 only when the workstream is a sub-program: its own bounded pieces
```

### 4.3 Node mapping

| Plan | Execution (P6) |
|------|----------------|
| program | program node, headless root orchestrator |
| workstream, one job | job node; its Job Contract is derived from the manifest entry and the spec |
| workstream, several jobs | sub-program node; its orchestrator's brief is the spec |
| `dependencies` | the engine holds a node `queued` until they have integrated |
| `prerequisites` | preflight; an unmet one leaves the node `awaiting_human` |
| anticipated decision | a `Decision`, authority `human`, recorded at ratification |

### 4.4 Parking

A workstream that ends `failed`, `verification_failed` after its retries, or
`cancelled` is parked. Its downstream cone (everything that depends on it,
transitively) is never started and is reported as blocked, naming the workstream
that blocked it. Everything else runs to the end. `core` computes the cone; it is
the same cone P9 will replay.

### 4.5 Control-plane changes

| Change | Why |
|--------|-----|
| `ProgramContract` grows (D-P7-03); program `status` and the ratified plan hash | D-P7-01, D-P7-03 |
| `ExecutionNodeStatus.awaiting_human`, for a node whose prerequisite is unmet | D-P7-10. A status, not a rule change: no edge in the job table leads through it to `verified` |
| Prerequisite status writes are the preflight's alone | D-P7-06 |

## 5. Scope

### In scope

- `packages/contracts`, `packages/core`: the plan schema; readiness rules;
  dependency gating; the downstream cone; `awaiting_human`.
- `apps/api`: the contract's growth, plan status and hash.
- `apps/cli`: `init`, `plan check`, `plan ratify`, `preflight`, and `run` as the
  end-to-end entry point; `nightshift.config.json`.
- `packages/execution`: dependency gating, parking, preflight, the headless
  root orchestrator's launch.
- `apps/mcp`: the plan-following orchestrator surface; the report.
- `skills/`: `plan-program`, `author-specs`, and the templates; the existing
  `nightshift` skill learns that a ratified plan is what it executes.
- `test/`: a planned fixture program; readiness negative fixtures; the e2e run.
- A restaging sweep: Routing & Examination becomes P8, Decision Graph P9, Remote
  Runner P10, Realtime P11, in every document and every message that names one.

### Out of scope

- Cost- and risk-based routing, examination, budgets (P8).
- Reversing a decision and replaying its cone (P9). P7 computes the cone and
  parks it; it does not replay it.
- Self-serve signup and publishing the package. `nightshift init` sets up a
  repository for a user who already has an account.
- A UI for plans. The documents are the UI.
- Linear, GitHub Issues or any tracker integration.

## 6. Success criteria

- **SC-P7-01** `plan-program` takes a brief to a program document and a manifest
  on disk, in the D-P7-02 layout, with an execution mode and its reason, and
  revises them in place over several rounds.
- **SC-P7-02** `author-specs` produces one spec per workstream in the §4.2 shape,
  each written without the planning conversation in context.
- **SC-P7-03** The actor audit turns a human-only step into an `HP` with a
  remediation and a `verifyCommand`; a program with none produces none.
- **SC-P7-04** `nightshift plan check` refuses, with reasons, each of: a cycle; an
  unknown dependency; an unclaimed success criterion; a scope outside the
  program's; a missing or empty spec; a prerequisite with no `verifyCommand`; two
  independent workstreams with overlapping scopes. It answers `READY` otherwise.
- **SC-P7-05** Nothing executes for a program that is not ratified, and a plan
  edited after ratification is refused until it is ratified again.
- **SC-P7-06** Preflight runs every `verifyCommand` deterministically, marks only
  what passed, and prints the remediation for what did not. No model and no
  planner can mark a prerequisite satisfied.
- **SC-P7-07** `nightshift run {id}` executes a ratified plan to the end with no
  human session: a headless root orchestrator, workstreams started in dependency
  order, as many at once as the limits allow.
- **SC-P7-08** A workstream with an unfinished dependency is never started.
- **SC-P7-09** A workstream that fails is parked with its downstream cone, named
  as the blocker, and every workstream outside the cone still finishes.
- **SC-P7-10** A workstream with an unmet prerequisite waits `awaiting_human`
  without blocking anything outside its cone.
- **SC-P7-11** Anticipated decisions are recorded with authority `human` before
  any work starts, and reach every agent that faces them.
- **SC-P7-12** A departure from the roster is a recorded decision citing the plan
  item; a run with none says so in its report.
- **SC-P7-13** The report states every workstream's outcome, every success
  criterion's state, what was parked and why, and what is still pending, and
  `plan-program` reads it when re-planning.
- **SC-P7-14** A manifest with no workstreams runs exactly as a program runs
  today; the P1 property tests, the P4 isolation suite, the P5 conformance suite
  and the P6 tree pass unchanged.
- **SC-P7-15** `nightshift init` takes a repository from nothing to plannable:
  config, project, skills, MCP registration.

**Exit gate**

- **SC-P7-16** A real program is planned with the skills on a real repository,
  edited by the human, ratified, and run unattended to a report, with real
  adapters against the deployed control plane.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy`, `npm run smoke` (twice),
`npm run conformance -- --harness all`, `npm run slice`.

## 8. Constraints

- The readiness check and the preflight are deterministic. No model decides
  whether a plan is ready or a prerequisite is met.
- One canonical home per fact.
- No P1 rule, property test or job-table edge changes. `awaiting_human` is a
  status reached and left by the engine, off the path to `verified`.
- A-39: no adapter gains an allow-list, a sandbox or an approval policy.
- Pins exact; scripts run on Windows and Linux.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.5; running the
smoke, slice and conformance suites; running Claude Code and Codex headless on
the operator's subscriptions; planning and running a trial program on a
repository the owner names.

Forbidden:

- Letting anything but the preflight mark a prerequisite satisfied.
- Running an unratified plan, by any path, including a test hook in production
  code.
- Weakening the P1, P4, P5 or P6 suites.
- Anything remote (P10). Settling O-02, O-03, O-05 or O-06.
- Inspecting the legacy Nightshift's branches or tags. Its planning flow is
  carried over from the owner's description and their installed skill, not from
  its code.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | The plan schema, readiness rules, the cone, and the restaging sweep | — | — |
| T2 | The control plane: the grown contract, plan status and hash, `awaiting_human` | T1 | AWS for the redeploy and smoke |
| T3 | The skills and templates: `plan-program`, `author-specs` | T1 | the keyart trial's observations (H-P7-03) |
| T4 | The CLI: `init`, `plan check`, `plan ratify`, `preflight`, config | T1, T2 | — |
| T5 | The engine: dependency gating, parking, `awaiting_human` | T1, T2 | — |
| T6 | The headless root orchestrator, `nightshift run {id}`, human decisions seeded | T4, T5 | — |
| T7 | The report, re-planning input, and the planned fixture's proofs | T5, T6 | — |
| T8 | Live: plan, ratify and run a real program unattended; as-built | T3, T7 | AWS, Claude Code, Codex, a repository the owner names |

```text
T1 ──┬── T2 ──┬── T4 ──┐
     │        └── T5 ──┴── T6 ── T7 ──┐
     └── T3 ──────────────────────────┴── T8
```

Specs live in `tasks/p7-planning/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| Planning becomes a ceremony people skip | `atomic` is the default and is one workstream and one spec; a small program's plan is small |
| Specs drift from what was built | The report is written against the spec, workstream by workstream; drift is visible, not silent |
| A `verifyCommand` needs the very credential the human holds | D-P7-06's perform/observe distinction is in the skill and the template, with examples |
| The overlap check cries wolf on broad scopes | It flags, with the two scopes side by side; a dependency edge or a narrower scope clears it, and either is a better plan |
| A headless root orchestrator wanders off the plan | Its brief is the plan, the engine enforces the dependencies, and a roster change is a recorded decision the report lists first |
| The keyart trial teaches something that changes this design | H-P7-03 holds T3 for it; T1 and T2 do not depend on it |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-21 | Program inserted after the first real-repository trial showed that a program of success criteria alone gives the developer nothing to review and leaves every structural choice to be made mid-run. Restaged: Routing & Examination → P8, Decision Graph → P9, Remote Runner → P10, Realtime → P11. Contract drafted; D-P7-01 … D-P7-11 proposed; tasks T1 … T8 drafted. | Human (direction) and agent (draft), for human ratification |

## 13. As built

Not yet.
