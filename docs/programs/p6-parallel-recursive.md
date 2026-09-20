# Program P6 — Parallel and Recursive Execution

| Field | Value |
|-------|-------|
| Program ID | `p6-parallel-recursive` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p6-parallel-recursive` |
| Source stage | Stage 5 (Parallel and Recursive Execution) |
| Status | **Contract ratified 2026-09-19** (D-P6-01 … D-P6-09). Tasks T1 … T7 drafted. |
| Depends on | P5 Harness Neutrality (two adapters, contract v1, `succeeded` for program nodes) |
| Blocking decisions | none. O-05 is untouched: everything still runs on the operator's machine. |

This contract is the stable authority for P6. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Let an orchestrator build a real execution graph and have Nightshift run it:
several jobs at once in isolated worktrees, sub-programs whose own orchestrators
delegate further within enforced limits, and integration that stays Nightshift's,
serial and deterministic, so that nothing reaches the program branch unless it
was verified on exactly the commit it landed on.

After P6, Nightshift can execute recursive parallel engineering programs locally
(source plan, Stage 5 exit gate; SC-06 and SC-07 of the plan).

`staging.md` calls this the riskiest single stage, and it is: it changes
scheduling and integration semantics together. The design below is chosen to
keep the change small where the invariants live. **No P1 rule changes**, the job
transition table is untouched, and A-05 holds by construction rather than by
care.

## 2. Environment and human prerequisites

Everything from P3, P4 and P5 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P6-01 | Ratify D-P6-01 … D-P6-09 | **satisfied 2026-09-19** |
| H-P6-02 | P5 merged | **satisfied 2026-09-19** (PR #17) |

**Explicitly not required.** No new AWS resource: the API gains rules, not
infrastructure. No Bedrock, no AgentCore, nothing remote.

## 3. Ratified decisions

Ratified by the human on 2026-09-19.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P6-01 | **One engine per run, and delegation is a record.** Whoever delegates (the human's orchestrator, or a sub-program's) does one thing: writes a Job Contract and a `validated` child node. One **engine**, in the root orchestrator's MCP server process, does everything else for the whole run: enqueues, starts workers when a slot is free, verifies, integrates. A sub-orchestrator reaches the engine **only through the control plane**; the engine finds its delegations by reading the run's nodes. No local socket, no port, no second channel. | The integration queue (D-P6-05) must be single per run, so the thing that owns it must be too. Going through the control plane keeps A-06 literal (the record is the only truth), costs a second of polling latency, and is exactly the shape P9 needs when the engine moves to a runtime instance and P10 needs when polling becomes a push. |
| D-P6-02 | **The concurrency limit applies at start, not at delegation, and is counted per parent.** A delegation within authority, depth and scope is always accepted and its node goes `validated → queued`. The engine starts a queued node when its parent has fewer than `maxConcurrency` children holding a slot, which is P1's `checkDelegation` answer read as "not yet" instead of "no". The API stops refusing node *creation* for concurrency and refuses the `queued → running` edge instead, so a buggy engine still cannot exceed the limit. | Stage 5 says limits *queue* excess jobs; P3 refused them because it had nowhere to queue. P1's rule and its property test already count running children per parent and are unchanged. Per parent also cannot deadlock: a running sub-program holds a slot of its *parent's*, never one of its own children's. |
| D-P6-03 | **Sub-programs.** `delegate { kind: "sub-program" }` creates a `sub-program` node and an `orchestrator`-role agent, launched through the same adapters and routing as any worker, whose Nightshift MCP server runs in a new **sub-orchestrator** role: `delegate`, `job.get`, `job.wait`, `job.cancel`, `job.retry`, `decision.record`, `subprogram.progress`, `subprogram.complete`, `subprogram.fail`. **A sub-orchestrator plans and delegates; it does not write code.** Its working directory is a checkout for reading, and nothing in it is ever collected. It ends `succeeded` or `failed` by D-P5-06's rule, and may succeed only when none of its children is unsettled. | An orchestrator that also edits would need its own path to the branch, which is a second integration route. Keeping code changes to job nodes means there is still exactly one way anything lands. Its authority and scope narrow from its parent's like any node's (A-11), so a sub-program is how an orchestrator hands over a *bounded region* of the program. |
| D-P6-04 | **Delegating execution tokens.** The execution token gains a `role` claim. A `worker` token is exactly P4's. An `orchestrator` token may, **within the subtree under its own node and nowhere else**: write a Job Contract, create a `validated` node whose parent is its own node, read its descendants and their jobs, ask for a descendant's cancellation, record decisions, and end its own node. It cannot mint a token, start, verify, seal or integrate anything, and cannot see a sibling. `authorize` gains a second table, exhaustive over `Operation` like the first. | A-04 and A-35, extended the only way Stage 5 allows: "sub-program agents receive delegation authority", and nothing more. Everything a sub-orchestrator cannot do is something only the engine does, under the human's session. |
| D-P6-05 | **Integration is a merge queue, and it is where verification happens.** Workers run in parallel; per run there is one serial pipeline: take the next ready node, **reconcile** it (replay its snapshot onto the current program head), **verify it there**, seal, fast-forward, checkpoint. The next ready node is a pure function in `core`: the lowest delegation ordinal among nodes that are `implemented`. Verification therefore runs once per job, on the exact commit that will land. | Every commit on the program branch was verified on the head it landed on, so two jobs that are each green alone and broken together cannot both integrate: the second fails verification with the first already underneath it. That *is* whole-program verification, since a job's verification steps are the Program Contract's. Serial verification is the price; it is seconds against workers' minutes. The table is untouched: reconciling moves the commit of an `implemented` node, which P1 already allows, and never of a verified one, which it forbids. |
| D-P6-06 | **A stale base is detected and recorded; a conflict is never resolved by Nightshift.** When reconcile replays a snapshot onto a moved head it records `node.rebased` with both commits. When the replay conflicts, the node fails durably with `integration_conflict` and the conflicting paths, nothing is integrated, and the worktree is kept. `job.retry` requeues a failed node as a new attempt: fresh worktree from the current head, new agent, new `RoutingDecision` with `attempt` incremented and `previousRouteId` set. | P3's `stale_base` refusal becomes the normal case and stops being a failure. A conflict is a judgement about two pieces of work, and an orchestrator with the reason in hand is who should make it; an automatic resolution would be unverifiable intent. `retry` is the table's existing edge from `failed`. |
| D-P6-07 | **Of the budgets, P6 enforces wall clock.** Once the run's `costPolicy.maxWallClockSeconds` is spent the engine starts nothing new and says why; workers already die with their tokens at that limit (P4). `maxUsd` and `maxTokens` are **not** enforced until P7. | P5 measured that token counts are not comparable across harnesses and that Codex reports no cost. Enforcing a sum of incomparable numbers would be a budget in name only. P7 owns usage normalisation and gets budgets with it. |
| D-P6-08 | **Ending and interruption cover the whole tree.** `run.finish` refuses while anything is unsettled. Shutdown interrupts every running worker and sub-orchestrator, cancels what was only queued, and ends the run `interrupted`, leaving every node in a durable status. Cancelling a sub-program cancels its subtree. | SC-P3-11 (killing the process leaves durable state), for N processes instead of one. |
| D-P6-09 | **The orchestrator's tools grow by what parallel work needs**: `delegate { kind }`; `job.wait` takes several ids and returns when the first settles; `job.retry`; `program.status` shows the tree, the queue and the integration pipeline. The skill teaches delegating independent work together and reading a conflict. | An orchestrator that can only wait on one job serialises itself, whatever the engine can do. |

### Non-guarantees

- **Total concurrency is per parent, so it multiplies with depth**: up to
  `maxConcurrency` to the power of `maxDepth` workers. The program's author sets
  both numbers.
- **Verification is serial.** A program whose verification takes ten minutes
  integrates at most six jobs an hour however many workers it has. Speculative
  parallel verification is a later optimisation, not a correctness change.
- **A sub-orchestrator's delegation is seen within about a second**, not
  instantly (polling, until P10).
- **No worker or sub-orchestrator is contained by its harness** (A-39). Worktree
  isolation is a property of git and of commit-time scope checks, not of a
  sandbox: two workers on one machine can see each other's directories.

## 4. Design

### 4.1 Who does what

```text
human's orchestrator ──delegate──► records (JobContract, node: validated) ◄──delegate── sub-orchestrator C
                                          │                                              (execution token, role orchestrator,
                                          ▼                                               its own subtree only)
                       ENGINE (one per run, root MCP server process, the human's session)
                         schedule:  validated → queued → running        (slot free under the parent?)
                         workers:   N at once, one worktree each, via the routed adapters
                         queue:     implemented ─► reconcile ─► verify ─► seal ─► ff ─► checkpoint   (one at a time)
```

### 4.2 The job lifecycle, as P6 changes it

```text
delegated ─► validated ─► queued ─► running ─► implemented ─► [merge queue] verifying ─► verified ─► sealed ─► integrated
                                        │             │              │
                                   cancelled /   integration_conflict   verification_failed
                                   interrupted   (failed, retryable)    (retryable)
```

Every status and edge above exists in P1's table today. What changes is who
walks them and when.

### 4.3 The fixture

```text
Program  (maxDepth 2, maxConcurrency 2)
├── Job A            independent of B
├── Job B            independent of A
└── Sub-program C    a narrower scope than the program's
    ├── Job C1
    └── Job C2
```

Plus two deliberately bad pairs: one whose jobs **conflict** (both rewrite the
same lines), and one whose jobs are each green alone and **incompatible
together** (one renames what the other starts calling).

### 4.4 Control-plane changes

| Change | Why |
|--------|-----|
| Node creation no longer checks concurrency; `queued → running` does | D-P6-02 |
| Execution token `role` claim; `authorize`'s orchestrator table; subtree targets | D-P6-04 |
| `checkDelegation` treats `succeeded` (and every terminal status) as a terminal parent | A gap P5 left: `succeeded` did not exist when the rule was written |
| Smoke: a delegating token inside and outside its subtree; the start-edge limit | Every rule on a route is proven on the route |

## 5. Scope

### In scope

- `packages/core`: start-edge concurrency, the integration-order function, the
  sub-program ending rule, the orchestrator access table, terminal parents.
- `packages/contracts`: the token's `role`; `delegate`'s `kind`; new event types
  (`node.rebased`, `integration.conflict`).
- `apps/api`: §4.4; the token mint for orchestrator agents.
- `packages/execution`: the engine (scheduler, job registry, discovery of
  delegated nodes), the merge queue, reconcile, retry, tree-wide shutdown.
- `apps/mcp`: the sub-orchestrator role; the orchestrator tools of D-P6-09; the
  sub-orchestrator brief.
- `packages/harness`: the sub-orchestrator brief, provider-neutral.
- `skills/nightshift`, `test/` (the fixture, a scripted sub-orchestrator, the
  eleven Stage 5 proofs, the benchmark), smoke and slice.

### Out of scope

- Cost- or risk-based routing, escalation, examination, `maxUsd` and `maxTokens`
  (P7).
- Resolving conflicts automatically; decision-driven replay (P8).
- Anything remote (P9). Push instead of polling (P10).
- Speculative parallel verification.
- A sub-orchestrator that edits code.

## 6. Success criteria

**Stage 5, carried verbatim**

- **SC-P6-01** A and B run concurrently (overlapping `running` intervals, read
  from the event stream).
- **SC-P6-02** C operates as an orchestrator: it delegates C1 and C2 with its own
  token, and they are its children.
- **SC-P6-03** C1 and C2 can run concurrently.
- **SC-P6-04** Depth limits reject deeper delegation.
- **SC-P6-05** Concurrency limits queue excess jobs: a third job under a parent
  with two running stays `queued`, then runs.
- **SC-P6-06** Child scope cannot widen, for a sub-orchestrator's delegation as
  for the root's.
- **SC-P6-07** Independent worktrees remain isolated: no job's snapshot contains
  another's changes.
- **SC-P6-08** Integration order is deterministic: the same set of ready nodes
  always integrates in the same order.
- **SC-P6-09** Stale-base commits are detected, recorded, and integrate after
  reconcile and verification.
- **SC-P6-10** Conflicts produce explicit recovery state: `integration_conflict`,
  the paths, nothing integrated, and `job.retry` recovers it.
- **SC-P6-11** Whole-program verification catches incompatible individually-green
  jobs: the second of the incompatible pair ends `verification_failed`, and the
  program branch still passes.
- **SC-P6-12** The benchmark: the fixture forced serial (`maxConcurrency: 1`)
  against parallel, wall clock for both, in the as-built.

**P6 additions**

- **SC-P6-13** A delegating token cannot act outside its subtree, mint a token,
  start, verify or integrate anything (offline over every operation, and live in
  smoke).
- **SC-P6-14** The API refuses a start past the limit, whatever the engine asks.
- **SC-P6-15** Every commit on the program branch has a passed `Verification`
  whose commit is that commit (A-05, asserted over the whole fixture run).
- **SC-P6-16** Killing the orchestrator's process with several workers and a
  sub-orchestrator running leaves every node and agent in a durable status.
- **SC-P6-17** The P1 property tests, the P4 isolation suite and the P5
  conformance suite pass unchanged.

**Exit gate**

- **SC-P6-18** The fixture tree runs to `succeeded` against the deployed control
  plane with real adapters, at least one job on each of Claude Code and Codex,
  and the smoke suite passes.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy`, `npm run smoke` (twice),
`npm run conformance -- --harness all`, `npm run slice`.

## 8. Constraints

- Dependencies point downward only; the engine is in `packages/execution` and
  names no adapter.
- A-39: no adapter gains an allow-list, a sandbox or an approval policy.
- Nothing integrates except through the merge queue.
- Pins exact; scripts run on Windows and Linux.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.4; running the
smoke, slice and conformance suites; running Claude Code and Codex headless on
the operator's subscriptions.

Forbidden:

- Changing a P1 rule or property test, or the job transition table. If the
  implementation finds it needs to, stop: the design is wrong, not the rule.
- Weakening the P4 isolation suite or the P5 conformance suite.
- Anything AgentCore, Bedrock or remote (P9).
- Settling O-02, O-03, O-05 or O-06.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Rules and the control plane: start-edge concurrency, delegating tokens, integration order | — | AWS for the redeploy and smoke |
| T2 | The engine: scheduler, job registry, queueing, wall clock, tree-wide shutdown | T1 | — |
| T3 | The merge queue: reconcile, verify on the head, conflict, retry | T2 | — |
| T4 | Sub-programs: `delegate { kind }`, the sub-orchestrator role and brief, discovery | T1, T2 | — |
| T5 | Orchestrator tools and the skill | T2, T3 | — |
| T6 | The fixture, the scripted sub-orchestrator, the eleven proofs, the benchmark | T3, T4, T5 | — |
| T7 | Live: deploy, smoke, the fixture with real adapters, as-built | T6 | AWS, Claude Code, Codex |

```text
T1 ──┬── T2 ──┬── T3 ──┬── T5 ──┐
     │        └── T4 ──┴────────┼── T6 ── T7
     └────────────┘             │
```

Specs live in `tasks/p6-parallel-recursive/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| Two integrations race | There is one pipeline per run and it is in one process; the fast-forward is additionally a compare-and-swap on the branch ref |
| A sub-orchestrator delegates forever | Depth and per-parent concurrency bound the tree; the wall clock bounds the run; its token dies with the wall clock |
| A real model, as sub-orchestrator, edits files anyway | Nothing collects them; the brief says so; the fixture asserts its directory's changes never reach a commit |
| Reconcile changes what a worker's summary describes | The rebased commit keeps the worker's message and trailers and adds `Nightshift-Rebased-From` |
| Polling load | One `listByRun` per second per run, only while a sub-orchestrator is running |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-19 | Contract drafted; D-P6-01 … D-P6-09 proposed; tasks T1 … T7 drafted | Agent, for human ratification |
| 2026-09-19 | **Contract ratified**, D-P6-01 … D-P6-09 as drafted. | Human |

## 13. As built

Not yet.
