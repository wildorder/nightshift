# Program P7 — Planning

| Field | Value |
|-------|-------|
| Program ID | `p7-planning` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p7-planning` |
| Source stage | — (inserted 2026-09-21; not in the source plan, which assumes the orchestrator plans for itself) |
| Status | **Drafted 2026-09-21**, revised the same day after review; for human ratification. D-P7-01 … D-P7-09 proposed; tasks T1 … T5 drafted. |
| Depends on | P6 Parallel and Recursive Execution (the engine, the merge queue, sub-programs) |
| Blocking decisions | none |

This contract is the stable authority for P7. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Put a **planning stage** in front of execution, owned by the human, that ends
exactly where a wrong choice becomes cheap.

Today a program is a list of success criteria and a scope, and everything between
that and the code is invented by an orchestrator at run time. The first trial on
a real repository (keyart, 2026-09-21) made the cost plain before the run had
finished: a developer cannot see roughly what will be built or how, cannot
anticipate a decision and make it up front, and cannot shape where the work is
cut.

P7 does **not** bring back a static plan of every task. Nightshift v1 has an
orchestrator that decomposes work with the code in front of it, sub-orchestrators
that plan their own region, and a merge queue that makes a bad split recoverable.
Planning job by job on paper would duplicate the engine and be wrong by the first
stale base. So the line is drawn by one test:

> **Would undoing this choice throw away more than one job's work, or need a
> human? Then it is the plan's. Otherwise it is the run's.**

| The human decides, in the plan | Nightshift decides, in the run |
|---|---|
| Outcomes, and what is out of scope | How many jobs, and how they are cut |
| The **seams**: a handful of strands, each a scope, an objective and acceptance, and any ordering between them | Order and parallelism inside a strand |
| The **approach** per strand, at the fidelity a developer wants before saying yes | Local design inside a job |
| The decisions that are expensive to reverse, or that the human simply cares about | Everything else, recorded |
| **Human prerequisites**, each with a runbook and a command that proves it was done | Retries, models, conflict recovery |

After P7 a program is planned **with the human, in a document, over as many
rounds as it takes**, ratified, and only then run: `nightshift run {program}`
executes it end to end with nobody watching, and reports against the plan.

Two things the plan has to get right, because they are what let a run finish
unattended:

- **Seams.** Strands that are independently green and do not overlap, so the run
  never needs a later strand to repair an earlier one.
- **Human prerequisites.** Everything only a human can do, found at planning
  time and done *before the run starts*. **The default is to hoist a human step
  to a prerequisite and keep the program whole.** A program is split in two only
  when the human's action genuinely depends on something the run itself
  produces, so it cannot be done first.

## 2. Environment and human prerequisites

Everything from P3 … P6 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P7-01 | Ratify D-P7-01 … D-P7-09 | open |
| H-P7-02 | P6 merged | **satisfied 2026-09-21** (PR #18) |
| H-P7-03 | The keyart trial run has finished, so its observations can shape T2's skill and template | open; not blocking T1 |

**Explicitly not required.** No new AWS resource. The API gains a little (§4.5).

## 3. Proposed decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P7-01 | **Planning ends where a wrong choice becomes cheap.** The plan fixes outcomes, seams, approach, the expensive decisions and the human prerequisites. It does not fix jobs: how a strand is cut into jobs, in what order, on which model and with what retries is the run's, decided by an orchestrator with the code in front of it and recorded as it goes. | v1's engine already makes job-level mistakes recoverable: a conflict is a retry, every landing is verified on the real head. A plan of jobs would duplicate it and be wrong by the first stale base. What is *not* recoverable cheaply is a wrong boundary, a wrong architectural call, or a run that stops at 3 a.m. for a credential. |
| D-P7-02 | **Planning is a stage with a gate.** A program is `planning` until a human ratifies it, and nothing executes before that. Ratifying records a hash of the plan document and the contract in the control plane; a run refuses to start when what is on disk no longer matches a ratified hash, so an edited plan is re-ratified, never silently run. | "Only after we're happy with the plan after back and forth editing the planning docs should we let the orchestrator go off and build autonomously." A gate that an edit after approval can walk around is not a gate. |
| D-P7-03 | **Two artifacts per program, in one place, for the life of a product.** `docs/programs/{program-id}/plan.md`, written for a developer to read, and `docs/programs/{program-id}/contract.json`, the Program Contract. After a run, `docs/programs/{program-id}/report.md` beside them. **One home per fact**: structured facts (success criteria, strands and their scopes, prerequisites, decisions' answers) live in the contract; the plan carries what the contract cannot (why, how, what was considered) and refers to the rest by id. Project-wide defaults move to `nightshift.config.json`. The single root `nightshift.program.json` is retired: a product runs many programs. There is no third layer: Job Contracts stay what they are, records written at run time. | The owner wants structure and location consistent across many programs. Two files is the fewest that keeps a machine contract and a human document each honest; a task file per job is the layer D-P7-01 says the run owns. |
| D-P7-04 | **Strands are the seams, and a strand's section of the plan is its spec.** The contract gains `strands`: an id (`S-01`), a name, a `scope` (`summary`, `includes`, `excludes`), acceptance, the success criteria it claims, `dependsOn`, and `prerequisites`. The plan has one section per strand saying what will exist and how: the modules touched, the shapes of the interfaces, what was considered and rejected. At run time a strand is a **sub-program** (or a single job when it is that small), and its orchestrator is handed exactly that section. What the human read is what the agent is told. Strands are fixed by ratification; the jobs inside one are free. Every strand must be independently green given only the strands it depends on, and shared-contract changes are sequenced expand → migrate → contract. | P6 already gives a bounded region to an orchestrator of its own; a strand is that, chosen by a human. `excludes` is how a strand tells its neighbours "not here". Independently green is what P6's merge queue will hold it to anyway. |
| D-P7-05 | **The actor audit: hoist human steps, keep programs whole.** Planning asks of every piece of work: *what credential or access does this consume, and does the crew hold it?* Each hit becomes a prerequisite `HP-nn` with a description, a **remediation** written as the exact commands or console steps, and a **`verifyCommand`** that exits zero iff it is done, runnable headless with credentials the runner holds. A prerequisite is something the crew *cannot* do, never something merely tedious. **The first resort is always to hoist the step to before the run**; the program is split only when the human's action depends on an output of the run itself and so cannot come first, and the plan says which output. Only the deterministic preflight ever marks a prerequisite satisfied, never a planner and never a model. | What stops a run finishing unattended is rarely the code. Bigger programs with everything human done up front are worth more than small ones separated by waits. The perform-versus-observe distinction (the crew lacks permission to *do* it; the runner must have permission to *see* it was done) is where a `verifyCommand` usually goes wrong. |
| D-P7-06 | **Decisions the human wants are made before the run.** The plan lists the choices that can be seen coming, each with the options, a leaning and a reason, and the human answers the ones that matter. At ratification each answer is recorded as a `Decision` with authority `human` on the program node, and every orchestrator and worker whose scope it touches is handed it. | A decision made up front is a constraint, not a fork: nothing is built on the alternative, so there is nothing to replay. It shrinks the decision graph P9 has to manage rather than feeding it. |
| D-P7-07 | **A deterministic readiness check decides whether a plan can be ratified.** `nightshift plan check`, no model: the contract is valid; every success criterion is claimed by a strand; every strand's scope is inside the program's; `dependsOn` is acyclic; every strand has a non-empty section in the plan; every prerequisite has a remediation and a `verifyCommand` and is used by a strand; every listed decision has an answer; and **two strands with no dependency path between them whose scopes overlap are flagged**, because P6 will run them at once. It answers `READY` or every reason. | Ratifying is a judgement; whether a plan is *executable* is not. The overlap rule turns P6's likeliest failure into a planning-time finding, at the level where a human can fix it by moving a boundary. |
| D-P7-08 | **One skill, with the human, writing files.** `plan-program` reads the vision, the as-built, `AGENTS.md`, the context documents, the backlog and any prior report; **reads the code** to write each strand's approach; runs the actor audit; proposes the seams and the decisions; and writes `plan.md` and `contract.json` straight to disk as the review surface, revising them in place for as many rounds as it takes. The human edits anything by hand. `nightshift plan ratify` closes the stage. | The files are the review surface, not the chat window. The plan is written in the conversation where the human's understanding forms, because that understanding is the product of the stage. |
| D-P7-09 | **Execution follows the ratified plan with no human in the loop, and reports against it.** `nightshift run {program-id}` runs preflight, records the human's decisions, and starts a **headless root orchestrator** through the routed adapters whose brief is the plan. The engine enforces `dependsOn` between strands. A strand that cannot finish is **parked** with everything downstream of it while the rest of the program continues. A prerequisite still unmet at run time leaves its strand `awaiting_human` without blocking anything outside its cone, which a good plan never needs. `report.md` states each strand's outcome against its section, each success criterion, what was parked and why, and the decisions the run took; the next `plan-program` reads it. The human's own Claude Code session can still orchestrate; this adds the unattended path. | "Go off and build autonomously e2e." A failure that stops the whole run wastes the night; one that parks a cone wastes only the cone. |

### Non-guarantees

- **A ratified plan is not a correct plan.** The readiness check proves a plan is
  executable, not that it is wise.
- **The approach is medium fidelity on purpose.** It says what will exist and how
  it is shaped. The run still makes every local choice, and records it.
- **A `verifyCommand` is run verbatim**, in the same trust class as the
  program's verification commands. It is reviewed at planning time because it
  will be run.
- **Workers are still not contained** on the operator's machine (A-39, P10).

## 4. Design

### 4.1 The flow

```text
brief ──► plan-program (with the human; reads the code; writes files)
             docs/programs/{id}/plan.md  +  contract.json
             ▲                                   │
             └───── rounds of edits, by either ◄─┘
                              │
                  nightshift plan check    ──►  READY | reasons
                  nightshift plan ratify   ──►  hash recorded; status: ratified
                              │
                  nightshift run {id}
                     preflight   every HP's verifyCommand, deterministically
                     decisions   recorded, authority human
                     root        headless orchestrator, brief = the plan
                     strands     sub-programs, dependsOn enforced, parked cones
                     jobs        the run's own (P6): slots, merge queue, retry
                              │
                  docs/programs/{id}/report.md   ──►  read by the next plan
```

### 4.2 What the plan document contains

```text
# {Program name}
Overview            what this program delivers, and what it deliberately does not
Architecture        what changes from the system as built
Strands             one section each:
  S-01 {name}         what will exist afterwards
                      approach: modules touched, interface and data shapes
                      considered and rejected
                      (scope, acceptance and dependsOn are in the contract, by id)
Decisions           each: the question, the options, the leaning, the answer
Human prerequisites each HP by id: what it unblocks and why the crew cannot do it
                      (the runbook and verifyCommand are in the contract)
Program boundary    only if this program was split: which output of the run the
                      human's step depends on, and what the next program is
Risks
```

### 4.3 Mapping

| Plan | Execution (P6) |
|------|----------------|
| program | program node, headless root orchestrator |
| strand | sub-program node; its orchestrator's brief is its plan section. A single job when that is all it is |
| `dependsOn` | the engine holds a strand `queued` until the strands it depends on have succeeded |
| jobs inside a strand | the strand's orchestrator's own; not in the plan |
| prerequisite | preflight, before the run; unmet at run time leaves the strand `awaiting_human` |
| decision | a `Decision`, authority `human`, recorded at the start of the run |

### 4.4 Parking

A strand that ends `failed` or `cancelled` is parked. Its downstream cone
(everything that depends on it, transitively) is never started and is reported as
blocked, naming the strand that blocked it. Everything else runs to the end.
`core` computes the cone; it is the same cone P9 will replay.

### 4.5 Control-plane changes

| Change | Why |
|--------|-----|
| `ProgramContract` gains `status`, `strands`, `prerequisites`, `decisions`, `outOfScope`, all optional; the ratified plan hash | D-P7-02 … D-P7-06. A contract with no strands runs exactly as today |
| A run of a contract that has strands is refused unless it is ratified | D-P7-02 |
| `ExecutionNodeStatus.awaiting_human` | D-P7-09. Off the path to `verified`; no job-table edge leads through it |
| Prerequisite status is written by user principals only, with the command's exit code | D-P7-05 |

## 5. Scope

### In scope

- `packages/contracts`, `packages/core`: strands, prerequisites and decisions on
  the contract; readiness rules; strand gating; the downstream cone; the hash.
- `apps/api`: §4.5.
- `apps/cli`: `init`, `plan check`, `plan ratify`, `preflight`, and `run` as the
  unattended entry point; `nightshift.config.json`.
- `packages/execution`, `apps/mcp`: strand gating and parking in the engine; the
  headless root orchestrator; the plan-following brief; the report.
- `skills/`: `plan-program` and its plan template; the `nightshift` skill learns
  that a ratified plan is what it executes.
- `test/`: a planned fixture program; readiness negative fixtures; the e2e run.
- A restaging sweep: Routing & Examination becomes P8, Decision Graph P9, Remote
  Runner P10, Realtime P11, in every document and message that names one.

### Out of scope

- Planning jobs. D-P7-01.
- Cost- and risk-based routing, examination, budgets (P8).
- Reversing a decision and replaying its cone (P9). P7 computes the cone and
  parks it.
- Self-serve signup and publishing the package. `init` sets up a repository for
  a user who already has an account.
- A UI for plans, and any tracker integration. The documents are the UI.

## 6. Success criteria

- **SC-P7-01** `plan-program` takes a brief to `plan.md` and `contract.json` on
  disk in the D-P7-03 layout, with each strand's approach written from the code,
  and revises them in place over several rounds.
- **SC-P7-02** The actor audit turns a human-only step into an `HP` with a
  remediation and a `verifyCommand`, hoisted before the run; a program with none
  produces none; a split is proposed only with the run output it depends on named.
- **SC-P7-03** `nightshift plan check` refuses, with every reason, each of: an
  unclaimed success criterion; a strand scope outside the program's; a cycle; an
  unknown `dependsOn`; a strand with no section; a prerequisite with no
  `verifyCommand`; an unanswered decision; two independent strands with
  overlapping scopes. It answers `READY` otherwise.
- **SC-P7-04** Nothing executes for a planned program that is not ratified, and a
  plan edited after ratification is refused until ratified again.
- **SC-P7-05** Preflight runs every `verifyCommand` deterministically, marks only
  what passed, and prints the remediation for what did not. Nothing else can mark
  a prerequisite satisfied.
- **SC-P7-06** `nightshift run {id}` takes a ratified plan to a report with no
  human session.
- **SC-P7-07** A strand is never started before the strands it depends on have
  succeeded, under any finishing order.
- **SC-P7-08** A strand that fails is parked with its downstream cone, named as
  the blocker, and every strand outside the cone still finishes.
- **SC-P7-09** The human's decisions are recorded with authority `human` before
  any work starts and reach every agent whose scope they touch.
- **SC-P7-10** A strand's orchestrator is handed its plan section verbatim, and
  decides its own jobs.
- **SC-P7-11** The report states every strand's outcome, every success
  criterion's state, what was parked and why, and the run's own decisions, and
  `plan-program` reads it when re-planning.
- **SC-P7-12** A contract with no strands runs exactly as a program runs today;
  the P1 property tests, the P4 isolation suite, the P5 conformance suite and the
  P6 tree pass unchanged.
- **SC-P7-13** `nightshift init` takes a repository from nothing to plannable:
  config, project, skills, MCP registration.

**Exit gate**

- **SC-P7-14** A real program is planned with the skill on a real repository,
  edited by the owner, ratified, and run unattended to a report, with real
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
- One home per fact.
- No P1 rule, property test or job-table edge changes.
- The plan does not name jobs, and nothing in the engine requires it to.
- A-39: no adapter gains an allow-list, a sandbox or an approval policy.
- Pins exact; scripts run on Windows and Linux.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.5; running the
smoke, slice and conformance suites; running Claude Code and Codex headless on
the operator's subscriptions; planning and running a trial program on a
repository the owner names.

Forbidden:

- Letting anything but the preflight mark a prerequisite satisfied.
- Running an unratified plan by any path, including a test hook in production
  code.
- Weakening the P1, P4, P5 or P6 suites.
- Rebuilding this checkout's `dist/` while the owner's run is using it.
- Anything remote (P10). Settling O-02, O-03, O-05 or O-06.
- Inspecting the legacy Nightshift's branches or tags.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | The contract's growth, readiness rules, the cone, the hash; the API; the restaging sweep | — | AWS for the redeploy and smoke |
| T2 | The `plan-program` skill and the plan template | T1 | the keyart trial's observations (H-P7-03) |
| T3 | The CLI: `init`, `plan check`, `plan ratify`, `preflight`, config | T1 | — |
| T4 | Plan-following execution: strand gating, parking, the headless root orchestrator, `nightshift run {id}`, the report | T1, T3 | — |
| T5 | The planned fixture's proofs; then live: plan, ratify and run a real program unattended; as-built | T2, T4 | AWS, Claude Code, Codex, a repository the owner names |

```text
T1 ──┬── T2 ─────────┐
     └── T3 ── T4 ───┴── T5
```

Specs live in `tasks/p7-planning/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| Planning becomes a ceremony people skip | The plan is one document; a small program is one strand and a short one |
| The plan drifts towards naming jobs, because it feels safer | D-P7-01 and the template's absence of anywhere to put them; the skill says why |
| A strand's approach is wrong once the code is open | It is medium fidelity: the orchestrator may depart from the *how*, records that it did, and the report lists it first. The *what* and the scope hold |
| A `verifyCommand` needs the very credential the human holds | The perform/observe distinction is in the skill and the template, with examples |
| The overlap check cries wolf on broad scopes | It shows the two scopes side by side; a dependency or a narrower scope clears it, and either is a better plan |
| Hoisting every human step makes the prerequisite list long | It is one sitting, before the run, with a command per item that says when you are done. That is the trade the owner chose |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-21 | Program inserted after the first real-repository trial showed that a program of success criteria alone gives the developer nothing to review and leaves every structural choice to be made mid-run. Restaged: Routing & Examination → P8, Decision Graph → P9, Remote Runner → P10, Realtime → P11. Contract drafted. | Human (direction) and agent (draft) |
| 2026-09-21 | **First draft revised on review.** It had carried the earlier Nightshift's planning apparatus over whole: a manifest beside the contract, a task file per workstream written by isolated agents, sizes, an atomic or orchestrated mode, a fixed roster. The owner's correction: keep the planning *stage*, in the spirit of v1. That apparatus existed because the old runner could not decide anything at run time; v1's orchestrator and merge queue can, and recover when they are wrong. So planning now ends where a wrong choice becomes cheap (D-P7-01): strands, approach, decisions and prerequisites are the plan's; jobs are the run's. And on program boundaries the owner's rule is D-P7-05's: hoist a human step to a prerequisite and keep the program whole, splitting only when the step depends on an output of the run. D-P7-01 … D-P7-09 proposed; tasks T1 … T5 drafted. | Human (direction) and agent (draft), for human ratification |

## 13. As built

Not yet.
