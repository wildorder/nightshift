# Program P7 — Planning

| Field | Value |
|-------|-------|
| Program ID | `p7-planning` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p7-planning` |
| Source stage | — (inserted 2026-09-21; not in the source plan, which assumes the orchestrator plans for itself) |
| Status | **Contract ratified 2026-09-21** (D-P7-01 … D-P7-10). **Built 2026-09-21**: T1 … T5 done, deployed. SC-P7-01 … SC-P7-13 proven offline and, where they touch the control plane, live; **SC-P7-14, the exit gate, passed 2026-09-22** on the owner's `foodfly` repository (§13). Every build decision in §12 ratified. **Closed and merged into `v1` 2026-09-24**, the post-merge fixes the exit gate found with it. |
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
| H-P7-01 | Ratify D-P7-01 … D-P7-10 | **satisfied 2026-09-21** |
| H-P7-02 | P6 merged | **satisfied 2026-09-21** (PR #18) |
| H-P7-03 | The keyart trial run has finished, so its observations can shape T2's skill and template | **satisfied 2026-09-21** (11 jobs landed, gate green). The owner's observations were never needed: on 2026-09-24 they ruled keyart no part of the exit gate, and the skill was held to the foodfly run instead (§13) |

**Explicitly not required.** No new AWS resource. The API gains a little (§4.5).

## 3. Ratified decisions

Ratified by the human on 2026-09-21.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P7-01 | **Planning ends where a wrong choice becomes cheap.** The plan fixes outcomes, seams, approach, the expensive decisions and the human prerequisites. It does not fix jobs: how a strand is cut into jobs, in what order, on which model and with what retries is the run's, decided by an orchestrator with the code in front of it and recorded as it goes. | v1's engine already makes job-level mistakes recoverable: a conflict is a retry, every landing is verified on the real head. A plan of jobs would duplicate it and be wrong by the first stale base. What is *not* recoverable cheaply is a wrong boundary, a wrong architectural call, or a run that stops at 3 a.m. for a credential. |
| D-P7-02 | **Planning is a stage with a gate.** A program is `planning` until a human ratifies it, and nothing executes before that. Ratifying records a hash of the plan document and the contract in the control plane, **and uploads the plan document itself, referenced from the contract beside that hash**, so the record holds exactly what was approved; a run refuses to start when what is on disk no longer matches a ratified hash, so an edited plan is re-ratified, never silently run. | "Only after we're happy with the plan after back and forth editing the planning docs should we let the orchestrator go off and build autonomously." A gate that an edit after approval can walk around is not a gate. And a run must be reconstructable from the control plane alone (A-06): a remote engine (P10) has no checkout to read the plan from until it is given one, and the analytics surface (P11) has none at all. |
| D-P7-03 | **Two artifacts per program, in one place, for the life of a product.** `docs/programs/{program-id}/plan.md`, written for a developer to read, and `docs/programs/{program-id}/contract.json`, the Program Contract. After a run, `docs/programs/{program-id}/report.md` beside them. **One home per fact**: structured facts (success criteria, strands and their scopes, prerequisites, decisions' answers) live in the contract; the plan carries what the contract cannot (why, how, what was considered) and refers to the rest by id. Project-wide defaults move to `nightshift.config.json`. The single root `nightshift.program.json` is retired: a product runs many programs. There is no third layer: Job Contracts stay what they are, records written at run time. | The owner wants structure and location consistent across many programs. Two files is the fewest that keeps a machine contract and a human document each honest; a task file per job is the layer D-P7-01 says the run owns. |
| D-P7-04 | **Strands are the seams, and a strand's section of the plan is its spec.** The contract gains `strands`: an id (`S-01`), a name, a `scope` (`summary`, `includes`, `excludes`), acceptance, the success criteria it claims, `dependsOn`, and `prerequisites`. The plan has one section per strand saying what will exist and how: the modules touched, the shapes of the interfaces, what was considered and rejected. At run time a strand is a **sub-program** (or a single job when it is that small), and its orchestrator is handed exactly that section. What the human read is what the agent is told. Strands are fixed by ratification; the jobs inside one are free. Every strand must be independently green given only the strands it depends on, and shared-contract changes are sequenced expand → migrate → contract. | P6 already gives a bounded region to an orchestrator of its own; a strand is that, chosen by a human. `excludes` is how a strand tells its neighbours "not here". Independently green is what P6's merge queue will hold it to anyway. |
| D-P7-05 | **The actor audit: hoist human steps, keep programs whole.** Planning asks of every piece of work: *what credential or access does this consume, and does the crew hold it?* Each hit becomes a prerequisite `HP-nn` with a description, a **remediation** written as the exact commands or console steps, and a **`verifyCommand`** that exits zero iff it is done, runnable headless with credentials the runner holds. A prerequisite is something the crew *cannot* do, never something merely tedious. **The first resort is always to hoist the step to before the run**; the program is split only when the human's action depends on an output of the run itself and so cannot come first, and the plan says which output. Only the deterministic preflight ever marks a prerequisite satisfied, never a planner and never a model. | What stops a run finishing unattended is rarely the code. Bigger programs with everything human done up front are worth more than small ones separated by waits. The perform-versus-observe distinction (the crew lacks permission to *do* it; the runner must have permission to *see* it was done) is where a `verifyCommand` usually goes wrong. |
| D-P7-06 | **Decisions the human wants are made before the run.** The plan lists the choices that can be seen coming, each with the options, a leaning and a reason, and the human answers the ones that matter. At ratification each answer is recorded as a `Decision` with authority `human` on the program node, and every orchestrator and worker whose scope it touches is handed it. | A decision made up front is a constraint, not a fork: nothing is built on the alternative, so there is nothing to replay. It shrinks the decision graph P9 has to manage rather than feeding it. |
| D-P7-07 | **A deterministic readiness check decides whether a plan can be ratified.** `nightshift plan check`, no model: the contract is valid; every success criterion is claimed by a strand; every strand's scope is inside the program's; `dependsOn` is acyclic; every strand has a non-empty section in the plan; every prerequisite has a remediation and a `verifyCommand` and is used by a strand; every listed decision has an answer; and **two strands with no dependency path between them whose scopes overlap are flagged**, because P6 will run them at once. It answers `READY` or every reason. | Ratifying is a judgement; whether a plan is *executable* is not. The overlap rule turns P6's likeliest failure into a planning-time finding, at the level where a human can fix it by moving a boundary. |
| D-P7-08 | **One skill, with the human, writing files.** `plan-program` reads the vision, the as-built, `AGENTS.md`, the context documents, the backlog and any prior report; **reads the code** to write each strand's approach; runs the actor audit; proposes the seams and the decisions; and writes `plan.md` and `contract.json` straight to disk as the review surface, revising them in place for as many rounds as it takes. The human edits anything by hand. `nightshift plan ratify` closes the stage. | The files are the review surface, not the chat window. The plan is written in the conversation where the human's understanding forms, because that understanding is the product of the stage. |
| D-P7-09 | **Execution follows the ratified plan with no human in the loop, and reports against it.** `nightshift run {program-id}` runs preflight, records the human's decisions, and starts a **headless root orchestrator** through the routed adapters whose brief is the plan. The engine enforces `dependsOn` between strands. A strand that cannot finish is **parked** with everything downstream of it while the rest of the program continues. A prerequisite still unmet at run time defers the checks that need it and the work carries on provisionally (D-P7-10). `report.md` states each strand's outcome against its section, each success criterion, what was parked and why, and the decisions the run took; the next `plan-program` reads it. The human's own Claude Code session can still orchestrate; this adds the unattended path. | "Go off and build autonomously e2e." A failure that stops the whole run wastes the night; one that parks a cone wastes only the cone. |
| D-P7-10 | **A hurdle defers a check; it does not stop the work.** When a verification step *cannot run* for want of something only a human can supply (a declared prerequisite still unmet, or a hurdle nobody saw coming), Nightshift (1) records the hurdle as a prerequisite, with a proposed remediation and `verifyCommand` when it was discovered mid-run, (2) **defers** that step and runs every other one, (3) carries on, best effort, on a **provisional line**, and (4) tees it up for the human. Deferred work lands on `refs/nightshift/provisional/{run}`, never on the program branch, and downstream strands build on the provisional head. When the human returns and preflight passes, the deferred steps run over the provisional commits in order: what passes fast-forwards onto the program branch; what fails gets a fix job at that point and **its downstream cone is replayed** onto the fix, or discarded if the fix invalidates it. **Only a step that could not run is deferred. A step that ran and failed is a failure.** Parking (D-P7-09) remains for real failures, where there is nothing for dependents to build on; `awaiting_human` is replaced by this. | The owner's proposal, 2026-09-21. Parking a cone for a missing credential wastes the night on the chance the work was wrong; carrying on bets the work was right, which it usually is, and loses only the cone when it was not. A-05 holds by construction: the program branch still receives nothing that has not passed every one of its checks on the commit that lands, so claiming a hurdle to dodge a failing test buys provisional progress and nothing else. The cone replayed here is the one P9 replays for a reversed decision, so P7 builds the smaller half of P9's machinery early. |

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
| prerequisite | preflight, before the run; unmet at run time defers the checks that need it, and the work continues on the provisional line |
| decision | a `Decision`, authority `human`, recorded at the start of the run |

### 4.4 Parking

A strand that ends `failed` or `cancelled` is parked. Its downstream cone
(everything that depends on it, transitively) is never started and is reported as
blocked, naming the strand that blocked it. Everything else runs to the end.
`core` computes the cone; it is the same cone P9 will replay.

### 4.5 Control-plane changes

| Change | Why |
|--------|-----|
| `ProgramContract` gains `status`, `strands`, `prerequisites`, `decisions`, `outOfScope`, all optional; the ratified plan hash; the plan document stored at ratification through a program-scoped presigned upload and referenced from the contract (`planDocument`), one per ratified hash | D-P7-02 … D-P7-06. A contract with no strands runs exactly as today |
| A run of a contract that has strands is refused unless it is ratified | D-P7-02 |
| `ExecutionNodeStatus.deferred`, between `verifying` and a later return to `verifying`; `Verification` commands may be `deferred` with the prerequisite they wait on; a run-time prerequisite write for the engine | D-P7-10. No edge from `deferred` reaches `sealed` or `integrated` except back through `verified`, so the A-05 properties hold unchanged. **This adds edges to P1's table and needs the owner's explicit say-so, which ratifying D-P7-10 is** |
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
  plan edited after ratification is refused until ratified again. The ratified
  plan document is readable from the control plane alone, byte for byte, by its
  hash.
- **SC-P7-05** Preflight runs every `verifyCommand` deterministically, marks only
  what passed, and prints the remediation for what did not. Nothing else can mark
  a prerequisite satisfied.
- **SC-P7-06** `nightshift run {id}` takes a ratified plan to a report with no
  human session.
- **SC-P7-07** A strand is never started before the strands it depends on have
  succeeded, under any finishing order.
- **SC-P7-08** A strand that fails is parked with its downstream cone, named as
  the blocker, and every strand outside the cone still finishes.
- **SC-P7-08a** A verification step that cannot run for an unmet prerequisite is
  deferred, the rest run, the work continues on the provisional line, and the
  program branch receives none of it. When the prerequisite is met the deferred
  steps run in order: passing work reaches the program branch; a failure gets a
  fix and its cone is replayed or discarded. A step that ran and failed is never
  deferred.
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
- No P1 property test changes, and A-05 holds as P1 proved it. The one table
  change is D-P7-10's `deferred`, which no path to `integrated` can use to skip
  `verified`.
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
| 2026-09-24 | **P7 closed.** The owner ran the exit gate on `foodfly` and accepted it: it worked. keyart is no part of it and the question of what the owner saw there is withdrawn. The fixes the exit gate found (§13) merge into `v1` with the close. | **Human** |
| 2026-09-21 | **Owner's ruling on two of the build decisions below.** (1) The `deferred → cancelled` edge is fine: P1's law that `cancel` is legal from every non-terminal status stands, and the edge adds no path toward `sealed` or `integrated`. (2) No fix job or cone replay at `resume` is accepted as **temporary**: the replay is P9's machinery, and `resume` gains it when P9 lands. (3) `s3:GetObject` on `plans/*`, `interrupted` as the run status of a deferred run, and `VerificationStep.requires` are **ratified**. (4) A hurdle nobody planned must be **detected, not failed**: the owner's ruling, on the note that nothing detected one. Built the same day as a deterministic convention in `packages/verification/src/defer.ts`: a command exits **75** (`EX_TEMPFAIL`) **and** prints `NIGHTSHIFT_DEFER HP-nn <description>` (optionally `NIGHTSHIFT_REMEDIATION <how>`); both, or it is a failure. The step is deferred and the prerequisite recorded as discovered with the command as its `verifyCommand`. The `plan-program` skill shows how to wrap a step. Every build decision in §12 is now ratified. | **Human** |
| 2026-09-21 | **Build decisions in T4, provisional until the owner ratifies or reverses them.** (1) **No automatic fix job or cone replay at `resume`.** D-P7-10 says a check that fails at resume "gets a fix job at that point and its downstream cone is replayed onto the fix, or discarded if the fix invalidates it". Built: the failure is recorded as one, and what was built on it is **discarded**, each node saying which node it stood on; the fix is the next program, planned with the report in hand. A fix is model work, which means an orchestrator at resume, a second brief and a replay the merge queue does not have; discard is the branch D-P7-10 already allows, and it is the one that cannot make things worse unattended. (2) **A run that ends with deferred work is recorded as run status `interrupted`**, through `run.finish { outcome: "deferred" }`, and the CLI exits 3. The run table has no `deferred` and D-P7-10 authorised a change to the *node* table only. (3) **Once anything is deferred, every later node is deferred too**, even when all of its own steps ran and passed, because it sits on the provisional line and is not yet known to be the commit that lands. The API therefore accepts a `defer` on a verification at that commit in which nothing failed (`deferred` or `passed`), never one that failed. (4) **`mayEndProgramNode`, a P6 rule, treats `deferred` as done for now**, or no strand could ever finish with a check deferred under it; its P6 test gained that one status. (5) **A verification step names the prerequisites it cannot run without** (`VerificationStep.requires`), which the contract implied and did not spell. A hurdle *discovered* mid-run has its record and its route (`prerequisite.put { kind: "discovered" }`), but nothing in the engine detects one yet: there is no honest deterministic signal for "this step could not run" short of a convention every verification command would have to follow, and that convention is the owner's to choose. | Agent, for human ratification |
| 2026-09-21 | **Build decision in T1, provisional until the owner ratifies or reverses it.** D-P7-10's `deferred` met two existing tests. (1) P1's table law, and its test, make `cancel` legal from every non-terminal status, so `deferred` has **three** edges, not two: `verifying → deferred` (`defer`), `deferred → verifying` (`resume_verification`) and `deferred → cancelled`. (2) The exhaustiveness pin in `test/src/properties/verification.property.test.ts` counts statuses and events, so it moves from 15/15 to 16/17, as P5 moved it for `succeeded`; no property changed, and a new table test proves no path from `deferred` reaches `sealed` or `integrated` except through `verified`. P5's list of unsettled statuses in `routing-transitions.test.ts` gains `deferred`. The owner was asked and was not there to answer; §8's "no P1 property test changes" is read as "no property weakened". Also in T1: the API role gains `s3:GetObject` on `plans/*` only, because ratification hashes the stored plan document itself (D-P7-02, SC-P7-04), and the P3 test that pinned "exactly `s3:PutObject`" now pins the pair. | Agent, for human ratification |
| 2026-09-21 | Program inserted after the first real-repository trial showed that a program of success criteria alone gives the developer nothing to review and leaves every structural choice to be made mid-run. Restaged: Routing & Examination → P8, Decision Graph → P9, Remote Runner → P10, Realtime → P11. Contract drafted. | Human (direction) and agent (draft) |
| 2026-09-21 | **D-P7-10 added on the owner's proposal**: a hurdle defers a check rather than parking the work; provisional line; checks, fix and cone replay when the human returns. It replaces `awaiting_human`. It is the one place P7 touches P1's transition table, and only ratification authorises that. | Human (proposal) and agent (draft) |
| 2026-09-21 | **Contract ratified**, D-P7-01 … D-P7-10 as drafted. Ratifying D-P7-10 is the owner's explicit authorisation to add the `deferred` status and its two edges to P1's transition table, and nothing else in it. | **Human** |
| 2026-09-21 | **The plan document goes to the control plane at ratification**, as an artifact named by the plan hash, not only its hash. The owner's call, on the agent's note that P10 and P11 both need a run reconstructable without the repository. Added to D-P7-02, §4.5, SC-P7-04 and T1. | Human |
| 2026-09-21 | **First draft revised on review.** It had carried the earlier Nightshift's planning apparatus over whole: a manifest beside the contract, a task file per workstream written by isolated agents, sizes, an atomic or orchestrated mode, a fixed roster. The owner's correction: keep the planning *stage*, in the spirit of v1. That apparatus existed because the old runner could not decide anything at run time; v1's orchestrator and merge queue can, and recover when they are wrong. So planning now ends where a wrong choice becomes cheap (D-P7-01): strands, approach, decisions and prerequisites are the plan's; jobs are the run's. And on program boundaries the owner's rule is D-P7-05's: hoist a human step to a prerequisite and keep the program whole, splitting only when the step depends on an output of the run. D-P7-01 … D-P7-09 proposed; tasks T1 … T5 drafted. | Human (direction) and agent (draft), for human ratification |

## 13. As built

Built 2026-09-21 in one sitting, on `program/p7-planning`.

### Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | **done**, deployed | `npm run smoke` green twice (87). Found live: S3 answers a missing key with `AccessDenied` when the role has no `ListBucket`, which reached the caller as a 500 |
| T2 | **done** | The skill and template are written from this contract and the record of the keyart trial, then corrected by what the foodfly run found (below) |
| T3 | **done** | `init`, `plan check`, `plan ratify`, `preflight`, `run {id}`, `nightshift.config.json` |
| T4 | **done**, less one branch of D-P7-10 | No fix job or cone replay at resume (§12). Discovered hurdles have a record and a route and no detector (§12) |
| T5 | **done** | The planned fixture runs end to end through the real CLI. Deployed; smoke twice, conformance and slice as below. The exit gate passed on `foodfly` 2026-09-22 |

### What was proven, and where

| SC | State | By |
|----|-------|----|
| SC-P7-01, -02 | met | `skills/plan-program`; `test/src/skills/plan-program.test.ts` holds the template to `checkPlan`. Proven with a real model only by SC-P7-14 |
| SC-P7-03 | met | `packages/core/src/rules/plan.test.ts`, one test per reason and all at once; `test/src/properties/plan.property.test.ts` (the overlap rule is symmetric, cleared by a dependency either way and by an exclude, and never misses two scopes that both allow a path); through the CLI in `test/src/cli/planning.test.ts`; and again by the control plane at ratification |
| SC-P7-04 | met, **live** | `apps/api/src/operations/plans.test.ts`; smoke ratifies against the deployed stack with a real S3 upload and reads the document back byte for byte |
| SC-P7-05 | met, **live** | `packages/execution/src/preflight.test.ts` over real subprocesses; smoke proves no body can say "satisfied" |
| SC-P7-06 | met | `test/src/planning/unattended.test.ts`, `cli-e2e.test.ts`: the real launcher, MCP server, engine, merge queue and git; the models scripted |
| SC-P7-07 | met | A property over random plans and finishing orders, pure (`plan.property.test.ts`) and through the engine with real git (`test/src/execution/engine.test.ts`), asserted from the event sequence |
| SC-P7-08 | met | Engine and unattended tests: exactly the cone is parked, the blocker is named, the rest finishes |
| SC-P7-08a | met, **less the fix branch** | Engine tests and the CLI end to end: a step defers, the rest run, six commits land on the provisional line and none on the program branch, `resume` refuses while the prerequisite is unmet and then lands the very commits that were deferred; a check that fails at resume discards what stood on it; a step that ran and failed is never deferred |
| SC-P7-09 | met | Decisions are recorded with authority `human` by `startRun`, before the first `node.started`, and reach exactly the strands they touch |
| SC-P7-10 | met | `strandBrief` in `core`; the unattended test compares the strand's objective with the ratified document byte for byte |
| SC-P7-11 | met | `packages/execution/src/report.ts`, gathered from the control plane alone; a departure leads its strand |
| SC-P7-12 | met, **live** | 2026-09-21, against the deployed plane after T4's redeploy: `npm run smoke` twice (87 each); `npm run conformance -- --harness all` passed 3/3 for claude and 3/3 for codex (the deterministic failure fixture `verification_failed` after 19.4 s and 42.2 s, as it should); `npm run slice` passed every phase, the real two-harness tree with a real sub-orchestrator in 55.4 s at `maxConcurrency` 2. What changed in those suites is listed below |
| SC-P7-13 | met | `test/src/cli/init.test.ts`, with a recorded `claude` and a temporary home |
| SC-P7-14 | met, **live**, 2026-09-22 | The owner's `foodfly` repository (npm workspaces), brief "add Shopify to POS integrations": `nightshift init`, planned with `plan-program` into four strands and five decisions the owner answered, `plan check` READY, ratified, and run with real workers against the deployed control plane. All four strands landed, eight commits on `program/shopify-pos`, each verified by the repository's gate; the owner's verdict: it worked. The run was attended (the session as orchestrator), and it wrote no `report.md`, because `run.finish` did not write one for an attended run until the fix below |

### What changed in earlier programs' suites, and why

Nothing was weakened. Each change admits a status, an access level or a grant
that P7's ratified decisions add.

- **P1** `verification.property.test.ts`: the exhaustiveness pin is 16 statuses
  and 17 events (§12). `deferred` has a third edge, `cancel`, because P1's own
  table law and its test require it of every non-terminal status.
- **P3** `api-stack.test.ts`: the API role's S3 grant was pinned as exactly
  `s3:PutObject`. It is now that, plus `s3:GetObject` on `plans/*` and nothing
  else, asserted as its own statement.
- **P4** the two `authorize` suites and both isolation suites: five operations
  and the `own_program` access level, with cells in both tables.
- **P5** `routing-transitions.test.ts` lists `deferred` among the unsettled
  statuses. The adapters pass the contract to `nightshiftToolNames`.
- **P6** `integration.test.ts`: `mayEndProgramNode` allows a `deferred` descendant.

### What the run departed from, what was parked, how long it took

Nothing was parked or deferred. The eight commits landed between 08:36 and
09:11 UTC on 2026-09-22, the first 43 minutes after the plan was committed; S-03 and
S-04 ran side by side, as planned. One departure, and it was Nightshift's, not
the plan's: the root orchestrator found no `nightshift.program.json`, which a
planned repository does not have, and wrote one by hand to get past
`run.attach`. That dirtied the checkout and failed S-01's first attempt; the
retry landed.

### What the exit gate found, fixed after the merge

On `program/p7-followups`, merged into `v1` with the close.

- **Two skill defects** (`c559599`). The model invented an `authority` key on
  decisions; the contract example now says those are all the fields. A v0
  `nightshift` on the PATH was read as a CLI to upgrade; both skills now check
  `nightshift --help` first.
- **Planning and running stay in one session** (`c559599`, `e216715`).
  `plan-program` creates and checks out the program branch, commits the plan and
  ratifies on an explicit yes; the new `run-program` skill starts the run and
  reads it back, departures first. The run is a background command of the
  session, not a `nohup`.
- **`run.attach` finds a planned program** under `docs/programs/` (`442abd5`),
  choosing by the run named or the only pending run; `cli-e2e.test.ts` runs
  without the old file and fails without the fix.
- **An attended session can see below the root** (`442abd5`). Every `job.wait`
  returns what happened since the last one, labelled by strand and job, from the
  record; `run.activity` replays the whole run; strand orchestrators narrate
  their decisions in a sentence each. `run.finish` writes a planned run's
  `report.md` beside its plan, attended or not. `run-program` is attended by
  default; dark is the opt-in.
