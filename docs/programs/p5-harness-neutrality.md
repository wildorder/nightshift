# Program P5 — Harness Neutrality

| Field | Value |
|-------|-------|
| Program ID | `p5-harness-neutrality` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p5-harness-neutrality` |
| Source stage | Stage 4 (Harness-Neutral Execution), less the AgentCore adapter, which moved to P9 at the 2026-09-16 restaging (`staging.md`) |
| Status | **Drafted 2026-09-16, superseding a withdrawn P4 draft of the same program.** Decisions D-P5-01 … D-P5-07 are proposed and await human ratification; tasks are drafted against them. |
| Depends on | P4 Identity and Tenancy (workers on execution tokens) |
| Blocking decisions | none. O-05 is untouched: every adapter runs on the operator's machine. |

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
| H-P5-01 | Ratify D-P5-01 … D-P5-07 | **open** |
| H-P5-02 | P4 merged, so the worker environment is a token and an identity | open |

**Explicitly not required.** No AWS change beyond the API additions in §4.4, no
model spend beyond the two subscriptions, no Bedrock, no AgentCore.

## 3. Decisions (proposed for ratification)

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P5-01 | **Adapter contract, version 1.** `HarnessStartInput` gains `tools: WorkerTools`, the four worker operations (`progress`, `complete`, `fail`, `recordDecision`) as in-process functions the execution layer supplies, beside the existing `mcp: McpLaunch`. A local-process adapter keeps handing the worker the stdio MCP server, which calls the same functions; an adapter whose harness can call back directly (P9's) may use them without MCP. `Harness` gains `capabilities` (`usage: boolean`), and `HarnessExit` carries optional `usage` (tokens, cost, latency). Everything else in version 0 stands. | One implementation of "what a completed job is" (`packages/execution/src/worker.ts`) behind whichever transport a harness can use. The source plan says the abstraction must not flatten every harness to the least capable feature set; this is the seam that lets P9's adapter differ without the execution layer knowing. *Reinterpretation, stated:* Stage 4's "Nightshift MCP access" is read as "Nightshift tool access"; both local adapters still reach it through MCP, and a hosted MCP endpoint for remote agents is P9's, built over these same functions. |
| D-P5-02 | **Codex adapter**: `codex exec --json` as a child process in the worktree, `--sandbox workspace-write` with approval policy `never` (deterministic, no model deciding approvals), `--ephemeral`, `--ignore-user-config`, the worker MCP server through `-c mcp_servers.nightshift.*`, the model from routing. Provider `openai`, authenticated by the ChatGPT login already on the machine; only `CODEX_HOME` passes through from the operator's environment. Hook events from the JSONL stream; cancel by `SIGINT`, then `SIGTERM`, then `SIGKILL`. | The same shape as the Claude adapter with a different stream grammar. `--approve-for-me` was considered and rejected: it routes approvals through an automatic review, which is a second opinion rather than a policy. |
| D-P5-03 | **The conformance fixture** is one Job Contract on the P3 fixture repository that requires repository exploration, modifying a source file, modifying a test, running the tests (shell), reporting progress at least once, recording at least one decision, and completing; plus a deterministic-failure fixture (the tests cannot pass) and a cancellation fixture (the worker is told to wait). The suite proves the nine Stage 4 items per adapter. It runs offline against the scripted harness in `npm test`, and opt-in against each real adapter via `npm run conformance`. | Verbatim from the source plan's Stage 4. The scripted harness runs the suite in CI so the suite itself is proven before any model is asked to pass it, and P9's adapter inherits a suite that two adapters already pass. |
| D-P5-04 | **Harness and model are independent axes chosen from a compatibility table.** `packages/routing` holds `HARNESS_COMPATIBILITY`: for each harness, the providers and model families it can run and how each is authenticated (Claude Code: Anthropic direct or through Bedrock; Codex: OpenAI direct; the AgentCore harness, added in P9: any Bedrock model). `configuredRoute` takes the Program Contract's model policy, intersects it with the table, honours a `delegate { harness?, model? }` request within that intersection and records it as an override, and otherwise picks the first compatible pair in the policy's provider order. Rule id `p5-configured`. No cost reasoning. | A provider is not a harness: Claude Code runs Bedrock-hosted Claude models, and the AgentCore harness runs anything. The earlier draft's one-to-one map was wrong. P7 replaces the *choice* with a policy that reasons about cost and risk over this same table. |
| D-P5-05 | **Who picks models.** The human picks the orchestrator's model by launching the orchestrator; `run.start` records it and, in P9, the dispatch request names it. Nightshift picks worker models within the Program Contract's policy; the orchestrator may request a harness or a model for a delegation, and the request is honoured only if compatible and allowed, recorded as an override. | The vision's sentence, made operational: "Nightshift, not the orchestrator, decides harness, model", with the orchestrator's request as the one permitted input. |
| D-P5-06 | **Two P3 observations close.** (1) `RoutingDecision` gains update semantics: `usage` may be set once, from empty, and `outcome` may move `pending → verified \| verification_failed \| failed \| cancelled`, governed by a table in `core`; everything else is immutable. (2) `ExecutionNodeStatus` gains **`succeeded`**, legal only for `program` and `sub-program` nodes, and `finishRun` in `core` moves the program node `running → succeeded \| failed \| cancelled` by the run's outcome. Job nodes cannot take `succeeded`, and the job-node table is untouched. | The first draft used `integrated` for a finished program node, which would have added a path to `integrated` that skips `verified` and forced the P1 property test for A-05 to be weakened. A distinct status for program nodes keeps that invariant exactly as P1 proved it. |
| D-P5-07 | **Codex and Claude stay local.** No credential of either subscription is transported anywhere; O-05 remains open and is not narrowed by anything P5 builds. | Stated so a reader does not infer from "two adapters run" that the remote-credential question has been answered. |

### Non-guarantees

- **Codex's sandbox is Codex's.** `workspace-write` is enforced by Codex, not by
  Nightshift; scope containment is still enforced at commit time (A-29).
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

## 13. As built

Not yet.
