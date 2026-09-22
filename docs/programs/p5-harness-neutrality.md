# Program P5 — Harness Neutrality

| Field | Value |
|-------|-------|
| Program ID | `p5-harness-neutrality` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p5-harness-neutrality` |
| Source stage | Stage 4 (Harness-Neutral Execution), less the AgentCore adapter, which moved to P9 at the 2026-09-16 restaging (`staging.md`) |
| Status | **Contract ratified 2026-09-16** (D-P5-01 … D-P5-07), superseding a withdrawn P4 draft of the same program. **Built 2026-09-19**: T1 … T5 done, deployed, and the exit gate passed for both adapters against the deployed control plane (§13). **Closed and merged into `v1` 2026-09-19**, all build-time decisions ratified (§12). |
| Depends on | P4 Identity and Tenancy (workers on execution tokens) |
| Blocking decisions | none. O-05 is untouched: every adapter runs on the operator's machine. |

> **Restaging note (2026-09-21).** P7 *Planning* was inserted after this contract was written. Where this document names a later program, read Routing & Examination as P8, Decision Graph as P9, Remote Runner as P10 and Realtime as P11 (`docs/programs/staging.md`).

This contract is the stable authority for P5. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Prove Nightshift is independent of the coding-agent harness for local execution.
The identical Job Contract executes through the Claude Code and Codex adapters
against one shared conformance suite, the adapter contract is finalised against
two real adapters and one scripted one, and harness and model are chosen from a
compatibility table by configuration. After P5, harness choice is configuration,
not architecture (source plan, Stage 4 exit gate), for every harness that runs
where the execution layer runs.

The third adapter, the AgentCore harness with a Bedrock model, is built in P9,
where the execution layer itself runs on the program's runtime instance and the
adapter has the Bedrock access and the cheap process spawn it needs. The
conformance suite P5 writes is the one it will have to pass.

Two smaller things ride along because the exit gate needs them and P3 left them
open on purpose: `RoutingDecision.usage` stops being empty, and program nodes get
a terminal status when their run ends.

## 2. Environment and human prerequisites

Everything from P3 and P4 stands.

| Item | Value |
|------|-------|
| Claude Code | 2.1.273, signed in with the operator's subscription |
| Codex CLI | 0.149.0 at `/opt/homebrew/bin/codex`, logged in using ChatGPT (confirmed 2026-09-16) |
| Workers | hold execution tokens (P4); no adapter passes a human credential |

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P5-01 | Ratify D-P5-01 … D-P5-07 | **satisfied 2026-09-16** |
| H-P5-02 | P4 merged, so the worker environment is a token and an identity | open |

**Explicitly not required.** No AWS change beyond the API additions in §4.4, no
model spend beyond the two subscriptions, no Bedrock, no AgentCore.

## 3. Ratified decisions

Ratified by the human on 2026-09-16. D-P5-01 and D-P5-04 are recorded in
`docs/architecture.md` as A-37 and A-38.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P5-01 | **Adapter contract, version 1.** `HarnessStartInput` gains `tools: WorkerTools`, the four worker operations (`progress`, `complete`, `fail`, `recordDecision`) as in-process functions the execution layer supplies, beside the existing `mcp: McpLaunch`. A local-process adapter keeps handing the worker the stdio MCP server, which calls the same functions; an adapter whose harness can call back directly (P9's) may use them without MCP. `Harness` gains `capabilities` (`usage: boolean`), and `HarnessExit` carries optional `usage` (tokens, cost, latency). Everything else in version 0 stands. | One implementation of "what a completed job is" (`packages/execution/src/worker.ts`) behind whichever transport a harness can use. The source plan says the abstraction must not flatten every harness to the least capable feature set; this is the seam that lets P9's adapter differ without the execution layer knowing. *Reinterpretation, stated:* Stage 4's "Nightshift MCP access" is read as "Nightshift tool access"; both local adapters still reach it through MCP, and a hosted MCP endpoint for remote agents is P9's, built over these same functions. |
| D-P5-02 | **Codex adapter**: `codex exec --json` as a child process in the worktree, `--sandbox workspace-write` with approval policy `never` (deterministic, no model deciding approvals), `--ephemeral`, `--ignore-user-config`, the worker MCP server through `-c mcp_servers.nightshift.*`, the model from routing. Provider `openai`, authenticated by the ChatGPT login already on the machine; only `CODEX_HOME` passes through from the operator's environment. Hook events from the JSONL stream; cancel by `SIGINT`, then `SIGTERM`, then `SIGKILL`. | The same shape as the Claude adapter with a different stream grammar. `--approve-for-me` was considered and rejected: it routes approvals through an automatic review, which is a second opinion rather than a policy. **Amended by the owner 2026-09-19 (§12): the sandbox and approval policy are replaced by `--dangerously-bypass-approvals-and-sandbox`; the rest stands.** |
| D-P5-03 | **The conformance fixture** is one Job Contract on the P3 fixture repository that requires repository exploration, modifying a source file, modifying a test, running the tests (shell), reporting progress at least once, recording at least one decision, and completing; plus a deterministic-failure fixture (the tests cannot pass) and a cancellation fixture (the worker is told to wait). The suite proves the nine Stage 4 items per adapter. It runs offline against the scripted harness in `npm test`, and opt-in against each real adapter via `npm run conformance`. | Verbatim from the source plan's Stage 4. The scripted harness runs the suite in CI so the suite itself is proven before any model is asked to pass it, and P9's adapter inherits a suite that two adapters already pass. |
| D-P5-04 | **Harness and model are independent axes chosen from a compatibility table.** `packages/routing` holds `HARNESS_COMPATIBILITY`: for each harness, the providers and model families it can run and how each is authenticated (Claude Code: Anthropic direct or through Bedrock; Codex: OpenAI direct; the AgentCore harness, added in P9: any Bedrock model). `configuredRoute` takes the Program Contract's model policy, intersects it with the table, honours a `delegate { harness?, model? }` request within that intersection and records it as an override, and otherwise picks the first compatible pair in the policy's provider order. Rule id `p5-configured`. No cost reasoning. | A provider is not a harness: Claude Code runs Bedrock-hosted Claude models, and the AgentCore harness runs anything. The earlier draft's one-to-one map was wrong. P7 replaces the *choice* with a policy that reasons about cost and risk over this same table. |
| D-P5-05 | **Who picks models.** The human picks the orchestrator's model by launching the orchestrator; `run.start` records it and, in P9, the dispatch request names it. Nightshift picks worker models within the Program Contract's policy; the orchestrator may request a harness or a model for a delegation, and the request is honoured only if compatible and allowed, recorded as an override. | The vision's sentence, made operational: "Nightshift, not the orchestrator, decides harness, model", with the orchestrator's request as the one permitted input. |
| D-P5-06 | **Two P3 observations close.** (1) `RoutingDecision` gains update semantics: `usage` may be set once, from empty, and `outcome` may move `pending → verified \| verification_failed \| failed \| cancelled`, governed by a table in `core`; everything else is immutable. (2) `ExecutionNodeStatus` gains **`succeeded`**, legal only for `program` and `sub-program` nodes, and `finishRun` in `core` moves the program node `running → succeeded \| failed \| cancelled` by the run's outcome. Job nodes cannot take `succeeded`, and the job-node table is untouched. | The first draft used `integrated` for a finished program node, which would have added a path to `integrated` that skips `verified` and forced the P1 property test for A-05 to be weakened. A distinct status for program nodes keeps that invariant exactly as P1 proved it. |
| D-P5-07 | **Codex and Claude stay local.** No credential of either subscription is transported anywhere; O-05 remains open and is not narrowed by anything P5 builds. | Stated so a reader does not infer from "two adapters run" that the remote-credential question has been answered. |

### Non-guarantees

- **No harness contains a worker** (as amended 2026-09-19, §12). Both adapters
  run with every permission check bypassed; what a worker does outside its
  worktree is not contained by Nightshift until P9 gives workers a machine of
  their own. Scope containment is enforced where it always was, at commit time
  (A-29).
- **The compatibility table describes what an adapter can run, not what is
  cheapest.** Until P7, the first compatible pair in policy order wins.

## 4. Design

### 4.1 One contract, one implementation of the worker operations

```text
execution layer ──── HarnessStartInput { …, mcp: McpLaunch, tools: WorkerTools, sink } ────► adapter
                                                                                                │
   local adapters (claude, codex):  spawn process in worktree ──► child: nightshift-mcp (worker role,
                                    execution token)  ──► worker calls job.* over stdio ──► WorkerTools
                                                                                                │
   P9's remote adapter:             reaches the same WorkerTools by whatever its harness supports
```

### 4.2 What the conformance suite asserts per adapter

| Stage 4 item | Assertion |
|-------------|-----------|
| spawn | `start` returns a handle with the given `agentId`; `agent.started` arrives |
| identity propagation | the worker's first `job.progress` is recorded against the right node and agent, and a worker's attempt to act for another node is refused by the API (P4's `authorize`) |
| Nightshift tool access | `job.progress`, `decision.record` and `job.complete` each reach the control plane |
| progress visibility | `node.progress` events with source `mcp` appear before `node.implemented` |
| decision recording | one `Decision` exists on the node, `checkpointBefore` set |
| cancellation | the cancellation fixture ends `cancelled` on both agent and node, within the grace period |
| exit and result collection | `exit` settles once; `outcomeReason` on failure; `usage` present where `capabilities.usage` is true |
| verification | the completing fixture ends `verified` then `integrated`; the failing fixture ends `verification_failed` with the failing step's log artifact |
| artifact collection | a `transcript` artifact for every adapter that keeps one |

Plus the architecture assertion: no harness-specific import above the adapter
layer, and `apps/mcp/src/compose.ts` is still the only module naming one.

### 4.3 The compatibility table

```text
claude   : anthropic (direct, operator subscription) | bedrock/anthropic.* (P9, instance role)
codex    : openai (direct, operator login)
agentcore: bedrock/* (P9, instance role)              ← row added by P9, shape fixed here
```

A route is `(harness, provider, model)` such that the table allows the pair and
the Program Contract's policy allows the provider and the model.

### 4.4 Control-plane additions

| Addition | Why |
|----------|-----|
| `PUT routing decision` update semantics (D-P5-06) | `usage` once from empty; `outcome` from `pending`. |
| `succeeded` on `ExecutionNodeStatus`, program nodes only; `finishRun` | D-P5-06. |
| Smoke: the rule and the route | Every route the smoke suite has to cover. |

## 5. Scope

### In scope

- `packages/harness`: contract version 1, `WorkerTools`, capabilities, usage on
  exit; the brief gains what Codex needs.
- `packages/harness-codex`: the adapter.
- `packages/harness-claude`: to version 1; `usage` from the `result` frame.
- `packages/execution`: `WorkerTools` over `worker.ts`; the runner passes both
  transports; `finishRun`; usage and outcome written to the routing decision.
- `packages/routing`: the compatibility table and `configuredRoute`.
- `apps/mcp`: `delegate { harness?, model? }`; the composition root's switch over
  the two adapters, constructing only the one chosen; the worker role calls
  `WorkerTools`.
- `apps/api`, `core`, `contracts`: §4.4.
- `test/`: the conformance fixture and suite; the scripted harness gains the
  fixture scripts; the slice axis gains `codex`; `npm run conformance`.

### Out of scope

- The AgentCore harness adapter, Bedrock, AgentCore infrastructure, and the
  question of who pays for Bedrock tokens (P9).
- Running an orchestrator anywhere but the operator's machine (P9).
- Transporting a Claude or Codex credential anywhere (O-05).
- More than one job in flight, stale-base reconciliation, program-level
  verification (P6).
- Cost- or risk-based routing, escalation, examination (P7).

## 6. Success criteria

**Stage 4, carried verbatim, for each of the two adapters**

- **SC-P5-01** spawn; **SC-P5-02** identity propagation; **SC-P5-03** Nightshift
  tool access; **SC-P5-04** progress visibility; **SC-P5-05** decision
  recording; **SC-P5-06** cancellation; **SC-P5-07** exit and result collection;
  **SC-P5-08** verification; **SC-P5-09** artifact collection.
- **SC-P5-10** The identical Job Contract executes through both adapters.
- **SC-P5-11** The deterministic-failure fixture ends `verification_failed`, and
  the cancellation fixture ends `cancelled`, through both.
- **SC-P5-12** No harness-specific import reaches the domain or the execution
  scheduler (regression of SC-P3-14, with one more package to leak from).

**P5 additions**

- **SC-P5-13** The conformance suite passes against the scripted harness in
  `npm test`, on both CI legs, before any real adapter is asked to pass it.
- **SC-P5-14** `RoutingDecision.usage` is non-empty for every adapter that
  reports usage, and `outcome` is terminal on every finished node.
- **SC-P5-15** A finished run's program node is `succeeded`, `failed` or
  `cancelled`, and no job node can take `succeeded`; the P1 property tests are
  unchanged.
- **SC-P5-16** Harness choice is configuration: changing the policy's providers
  or passing `harness` on `delegate` changes which adapter runs, with no code
  change and a `RoutingDecision` that says why; an incompatible request is a
  typed refusal.

**Exit gate**

- **SC-P5-17** `npm run conformance` passes for `claude` and `codex` against
  the deployed control plane, and the smoke suite passes. The as-built records
  wall clock and, where reported, tokens per adapter.

## 7. Deterministic verification

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm test                 # now includes the conformance suite over the scripted harness
npm run synth
npm run check:sterility
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy` (for §4.4), `npm run smoke`,
`npm run conformance` (claude, codex), `npm run slice` with the new harness value.

## 8. The conformance run (D-P5-03)

`npm run conformance [--harness claude|codex|all]` materialises the fixture
repository, starts the orchestrator-role MCP server as the slice suite does,
delegates the three fixture jobs through the chosen adapter against the deployed
control plane, and asserts §4.2. It prints the run identifiers and the wall
clock per job, plus tokens where the adapter reports them. Cleanup follows the
smoke suite's rules. Two runs must not overlap.

## 9. Constraints

- Dependencies point downward only; the adapters import `@nightshift/harness`,
  never each other; `execution`, `routing`, `verification`, `core` and
  `contracts` import no adapter and no provider SDK.
- No worker gets git write access, and no worker's environment carries anything
  but its execution token and identity (P4).
- Pins exact, recorded in `AGENTS.md`; scripts run on Windows and Linux.

## 10. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.4; running the
smoke, slice and conformance suites; running Claude Code and Codex headless on
the operator's subscriptions.

Forbidden:

- Anything AgentCore or Bedrock (P9).
- Putting a Claude or Codex credential in any environment but the operator's
  machine (O-05).
- Editing the P1 … P4 conformance and smoke assertions to make an adapter pass;
  in particular, weakening the A-05 property test.
- Settling O-02, O-03, O-05 or O-06.

## 11. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Adapter contract v1, `WorkerTools`, and the conformance fixture | — | — |
| T2 | Control-plane additions: routing-decision table, `succeeded`, `finishRun` | — | AWS for the redeploy and smoke |
| T3 | The Codex adapter | T1 | Codex, for the real run |
| T4 | Claude to v1, the compatibility table, `delegate { harness, model }`, the composition switch | T1, T2 | — |
| T5 | Conformance for real, slice axis, as-built | T3, T4 | AWS, Claude Code, Codex |

```text
T1 ──┬── T3 ──┐
     └── T4 ──┼── T5
T2 ─────┘     │
```

Specs live in `tasks/p5-harness-neutrality/`.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-16 | A first draft of this program, numbered P4, was withdrawn the same day. It had put the AgentCore adapter here as one hosted session per job with the worktree shuttled across as a tarball, mapped providers to harnesses one to one, given the harness's execution role bucket-wide S3 access, and finished program nodes as `integrated`. Each was wrong against the vision or the P1 invariants; the owner caught the first three. The restaging in `staging.md` records where the third adapter went. | Human and agent |
| 2026-09-16 | Contract drafted as P5; D-P5-01 … D-P5-07 proposed; tasks T1 … T5 drafted | Agent, for human ratification |
| 2026-09-16 | **Contract ratified**, D-P5-01 … D-P5-07 as drafted. D-P5-01 and D-P5-04 recorded as A-37 and A-38. | Human |
| 2026-09-19 | **`succeeded` has no edge in the job transition table.** T2's first implementation put `running → succeeded` in the table behind a guard on node kind. That made legality depend on something other than status and event, which is SC-P1-15, a P1 property; T2's own note says to stop at that point. `succeeded` is now a status with no incoming and no outgoing event. `maySucceed` and `finishRun` in `core` are the only way in, for a `running` program or sub-program node, and the API refuses a node *created* as `succeeded`. The property tests are untouched; the one edit is the cardinality guard, 14 statuses to 15, with the 15 events unchanged. | Agent, within D-P5-06 |
| 2026-09-19 | **D-P5-02 amended by measurement: the Nightshift MCP server's tools are pre-approved.** With `approval_policy="never"` alone, Codex refuses every MCP tool call ("MCP tool call requires approval, but approval policy is never"), so a worker could neither report nor finish. The adapter passes `mcp_servers.<name>.default_tools_approval_mode="approve"` for the one server Nightshift supplies. This is the decision the Claude adapter makes with `--allowedTools mcp__nightshift__*`: made ahead of time by Nightshift, not at run time by a model or a human, which is what D-P5-02 forbids. `--approve-for-me` is still not used. | Agent, within D-P5-02 |
| 2026-09-19 | **The `workspace-write` sandbox does not stop `git commit` in a job worktree** (measured on 0.154.0: exit 0, commit made). Codex takes no per-command deny list on its command line, so the adapter writes a `git` guard script and puts it first on the `PATH` of **model-run commands only** (`shell_environment_policy.set`, with `allow_login_shell=false` so a login shell cannot rebuild `PATH`). It is a guard at the point of use, as strong as the Claude adapter's `Bash(git commit:*)` denials and no stronger; the enforcement is A-29, because `completeJob` parents its snapshot on the base and a worker's own commits never become history. Not installed on Windows. | Agent, within D-P3-15 |
| 2026-09-19 | **Verified against codex-cli 0.154.0, not 0.149.0.** The machine's Codex had moved on since the contract was written. Every flag in D-P5-02 still exists; `--ignore-rules` was added so the operator's execpolicy rules cannot vary a worker's behaviour. | Agent |
| 2026-09-19 | **Workers run with permissions bypassed, and no adapter passes a list of allowed tools.** The owner's ruling, on reviewing this log: a worker must never stop for approval and must never be denied a tool because nobody listed it in advance; earlier iterations of Nightshift failed exactly that way. The Claude adapter now runs `--permission-mode bypassPermissions` with no `--tools`, no `--allowedTools` and no `--permission-prompts`; the Codex adapter runs `--dangerously-bypass-approvals-and-sandbox`. This **amends D-P5-02** (the `workspace-write` sandbox and `approval_policy=never` are gone) and **amends D-P3-15** (`Scope.permissions` is still told to the worker and reported on `agent.started`, but no harness flag enforces it). It **supersedes the second entry above**: with approvals bypassed the Nightshift MCP server needs no pre-approval, and that setting is removed. `--approve-for-me` is still not used. The git write guard stays on both adapters, because a deny of one family of commands cannot starve a worker of a tool; verified that Claude's denials hold in `bypassPermissions` and Codex's guard holds with the sandbox off. What bounds a worker is A-29 (Nightshift owns every commit, and checks every changed path against scope before integrating), the execution token (A-35) and the environment allowlist. **What is given up, stated plainly:** a worker can now write outside its worktree and reach the network (both measured), so on the operator's machine a worker is trusted as the operator is. Conformance re-run for both adapters against the deployed plane afterwards: passed. | **Human** |
| 2026-09-19 | **Build-time decisions ratified**: `succeeded` outside the transition table, the git write guard, and verification against codex-cli 0.154.0, as recorded above. The pre-approval entry was already superseded. P5 closed; merged into `v1`. | **Human** |

## 13. As built

Closed 2026-09-19 on `program/p5-harness-neutrality`. Everything below was
measured or run, against codex-cli 0.154.0, Claude Code 2.1.273 and the deployed
`dev` control plane.

### 13.1 Task states

| Task | State | Where |
|------|-------|-------|
| T1 | Done | `packages/harness/src/{harness,tools,brief}.ts`; `packages/execution/src/{worker,environment,runner}.ts`; `test/src/conformance/{adapter,fixture}.ts`; `test/src/harness/{scripts,scripted,worker,adapter-conformance.test}.ts` |
| T2 | Done, deployed | `packages/core/src/rules/{transitions,routing-transitions}.ts`; `apps/api/src/operations/{nodes,records}.ts`; `packages/execution/src/{runner,shutdown}.ts`; smoke in `apps/api/src/smoke/p2.smoke.ts` |
| T3 | Done | `packages/harness-codex/src/` |
| T4 | Done | `packages/harness-claude/src/{stream,adapter}.ts`; `packages/routing/src/{compatibility,configured}.ts`; `apps/mcp/src/{compose,orchestrator}.ts`; `skills/nightshift/SKILL.md` |
| T5 | Done | `apps/api/src/smoke/{conformance.smoke,deployed-slice,slice.smoke}.ts`; `scripts/{conformance,slice}.mjs`; this section |

### 13.2 The two command lines, as they ran

```text
claude -p <brief> --output-format stream-json --verbose --model claude-sonnet-5
       --mcp-config <tmp>/mcp.json --strict-mcp-config
       --settings <tmp>/settings.json --setting-sources ""
       --permission-mode bypassPermissions
       --disallowedTools <the git write denials>
       --no-session-persistence

codex exec --json -C <worktree> --dangerously-bypass-approvals-and-sandbox
      -c allow_login_shell=false
      -c shell_environment_policy.set={"PATH" = "<guard dir>:<PATH>"}
      -c mcp_servers.nightshift.command="<node>"
      -c mcp_servers.nightshift.args=["<…>/nightshift-mcp.js"]
      -c mcp_servers.nightshift.env={…seven identity variables, the endpoint, the execution token…}
      --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
      -m gpt-5.5 <brief>
```

The Codex process's environment is `PATH`, `HOME`, `CODEX_HOME` and the proxy
and certificate variables when set. Nothing of the operator's Nightshift
session, no `AWS_*`, and no `OPENAI_API_KEY`: D-P5-02 pins Codex to the
operator's login, and a key passed through would change who pays.

### 13.3 The exit gate, per adapter (SC-P5-17)

`npm run conformance -- --harness all`, twice, against the deployed control
plane. Each fixture job runs in its own throwaway project, removed afterwards;
no cleanup failed in either run.

| Adapter | Model | Job | Ended | Wall clock (run 1 / run 2) | Usage recorded on the route (run 1) |
|---------|-------|-----|-------|----------------------------|--------------------------------------|
| claude | claude-sonnet-5 | completing | `integrated` | 31.4 s / 21.2 s | 12 in, 2 717 out, $0.111, 28.7 s wall |
| claude | claude-sonnet-5 | deterministic failure | `verification_failed` | 18.9 s / 17.5 s | |
| claude | claude-sonnet-5 | cancellation | `cancelled` | 5.7 s / 5.1 s | |
| codex | gpt-5.5 | completing | `integrated` | 77.3 s / 73.2 s | 320 711 in, 2 635 out, 75.5 s wall |
| codex | gpt-5.5 | deterministic failure | `verification_failed` | 57.9 s / 42.3 s | |
| codex | gpt-5.5 | cancellation | `cancelled` | 9.9 s / 10.7 s | |

**The two token columns are not comparable, and P7 must not compare them as they
stand.** Claude's `usage.input_tokens` excludes cache reads, which is nearly all
of a Claude Code run's input; Codex's `input_tokens` includes its cached tokens
(in the recorded run checked in as the stream fixture, 227 968 of 253 722). Codex reports no
cost on a ChatGPT login. `RouteUsage` records what each harness said, faithfully;
normalising it is routing's problem, not the adapter's.

After the owner's ruling on permissions (§12, last entry) both adapters were
changed and the gate was run a third time, in bypass mode: all six jobs ended as
the table says (Claude 25.3 s / 17.3 s / 6.8 s; Codex 76.4 s / 45.1 s / 8.7 s).

`npm run slice` then ran its three phases (scripted 5.5 s, Claude 20.7 s, Codex
63.5 s), the Codex phase differing from the Claude one **only in the program's
model policy**. `npm run smoke`: 83 passed, three times, after the one redeploy.

### 13.4 What the first real Codex worker found

As T5's notes predicted, and none of it was findable with the scripted harness.
Each is a brief or enforcement change; the suite was not edited for any of them.

1. **`approval_policy="never"` refuses every MCP tool call.** §12, second entry.
   Found before any job ran, by a probe. Moot since the owner's ruling (§12,
   last entry): approvals are bypassed altogether.
2. **The sandbox allows `git commit` in a worktree.** §12, third entry.
3. **The git guard, first version, broke `job.complete`.** It was put on the
   Codex *process's* `PATH`. The worker's Nightshift MCP server is a child of
   that process, inherits its environment, and `job.complete` is where Nightshift
   itself runs `git add` to collect the work; the guard refused Nightshift its
   own commit. The worker reported this precisely, in its `job.fail` reason. The
   guard now rides on `shell_environment_policy.set`, which applies to commands
   the model runs and to nothing else.
4. **A `SIGTERM`ed `codex exec` exits 0**, having printed two lines; a `SIGINT`ed
   one exits 1. So exit 0 is not completion, exactly as P3 found for Claude by a
   different route. The condition is exit 0 **and** `turn.completed` **and** no
   `turn.failed`.
5. **The local test plane's stepping clock expired a real worker's token.** It
   advances a second per reading; a job of real minutes reads it thousands of
   times, and `job.complete` was refused as expired after flawless work. Not a
   product defect: the deployed plane keeps real time. The opt-in local
   real-adapter leg now runs on the system clock (`LocalContextOptions.realTime`).

The brief itself needed one paragraph for Codex and no corrections: on its first
run with working tools the worker read `job.get`, explored with `rg` and `sed`,
edited source, test and the entry point, recorded its decision, ran both
verification commands, and completed.

### 13.5 Stream and hook mapping (T3 deliverable 2)

In `packages/harness-codex/src/stream.ts`, recorded from real runs and tested
against `__fixtures__/codex-stream-completing.jsonl`, the transcript of the
completing fixture job. `agent.subagent_created` and `agent.context_compacted`
have no source in `codex exec --json`; both are observations an adapter makes
when its harness has them (D-P3-09), not lifecycle, and nothing is configured to
fake them. The lifecycle never depends on the stream.

### 13.6 Departures from the task specs

- **T1.** `ExecutionEnvironment` gained `workerEnvironment(launch)`, supplied by
  the composition root. The spec has `createWorkerTools(environment, identity)`
  and says nothing about *whose* credentials the function transport writes with.
  Called in the orchestrator's process with the orchestrator's stores, a
  worker's operations would be recorded as the human's and allowed what a worker
  is not (A-35). So the function form runs over stores holding that worker's
  execution token and nothing else, exactly as the worker-role MCP server does.
- **T1.** The scripted harness gained a `functions` transport (the same scripts
  over `input.tools`, in-process) and keeps a transcript, so artifact collection
  and the transport P9 will use are both proven offline. The version 0 suite
  (`conformance/harness.ts`) stays, as the spec asks; version 1 is
  `conformance/adapter.ts`.
- **T1.** Identity propagation's refusal half is asserted in the *cancellation*
  job: a token can only be minted for a live agent, and that is the one fixture
  whose worker is reliably still running.
- **T2.** `succeeded` is outside the transition table rather than guarded within
  it. §12, first entry.
- **T2.** The runner writes Nightshift's own `wallClockMs` on every route, so an
  adapter that reports no usage still leaves a measured one. `escalated` counts
  as an ending of a route.
- **T3.** `--ignore-rules`, `allow_login_shell=false` and the guard are additions
  to D-P5-02's command line, each measured; the sandbox and approval policy were
  then replaced outright by the owner's ruling. §12.
- **T4.** "Constructing only the adapter the route chose" is a `Harness` in the
  composition root (`createRoutedHarness`) that builds an adapter the first time
  a route names it. The execution layer still holds exactly one `Harness`.
- **T4.** The table's default OpenAI model is `gpt-5.5`, chosen from what the
  operator's Codex login lists; a program that cares names its models.
- **T5.** Conformance pins the harness on `delegate` against a policy that allows
  both providers, so the override path is exercised live and recorded
  (`wasOverride: true`); the slice's Codex phase changes the policy instead.
  Between them both halves of SC-P5-16 run against the deployed plane.

### 13.7 Success criteria

| SC | Discharged by |
|----|---------------|
| SC-P5-01 … 09 | `describeAdapterConformance`, passing for `claude` and `codex` against the deployed plane (§13.3), and for the scripted harness over both transports in `npm test` |
| SC-P5-10 | `test/src/conformance/fixture.ts`: three Job Contracts, no adapter named in any, run unchanged through all four legs |
| SC-P5-11 | The failure and cancellation rows of §13.3 |
| SC-P5-12 | `npm run check:architecture`; `compose.ts` is the only module naming either adapter |
| SC-P5-13 | `test/src/harness/adapter-conformance.test.ts`, in `npm test` |
| SC-P5-14 | Conformance asserts a terminal `outcome` on all three jobs and tokens where `capabilities.usage`; `routing-transitions.test.ts`; the smoke test |
| SC-P5-15 | `transitions.test.ts` (no event reaches `succeeded`; `maySucceed` over every kind and status); `nodes.test.ts`; the smoke test; the completing job ends its run and reads the root back `succeeded` |
| SC-P5-16 | `configured.test.ts`; live, both ways (§13.6, last item) |
| SC-P5-17 | §13.3 |

### 13.8 What P5 deliberately did not do

- Nothing remote. Both adapters are local processes on the operator's login
  (D-P5-07); the `bedrock` and `agentcore` rows of the table are refused by name
  until P9.
- No cost or capability reasoning in routing. The first compatible pair in the
  policy's order wins; P7 replaces the rule and inherits the record.
- More than one job at a time is still P6's.
