# Program P4 — Harness Neutrality

| Field | Value |
|-------|-------|
| Program ID | `p4-harness-neutrality` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p4-harness-neutrality` |
| Source stage | Stage 4 (Harness-Neutral Execution) |
| Status | **Drafted 2026-09-16.** Decisions D-P4-01 … D-P4-09 are proposed and await human ratification; tasks are drafted against them. |
| Depends on | P3 First Vertical Slice (complete, `v1` at `65e3035`) |
| Blocking decisions | none in `architecture.md` §3. O-05 (harness credentials in remote environments) is **touched but not settled**: P4 runs every adapter from the operator's machine, and the one remote environment it uses, an AgentCore session, is Nightshift's own and needs no subscription credential at all. |

This contract is the stable authority for P4. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Prove Nightshift is independent of the coding-agent harness. The identical Job
Contract executes through Claude Code, Codex and the Amazon Bedrock AgentCore
harness against one shared conformance suite, and nothing above the adapter
layer can tell which one ran. After P4, harness choice is configuration, not
architecture (source plan, Stage 4 exit gate).

Two smaller things ride along because the exit gate needs them and P3 left them
open on purpose: `RoutingDecision.usage` stops being empty, and the program node
gets a terminal status when its run ends.

## 2. Environment and human prerequisites

Everything from P3 stands: one account, `us-west-2`, the deployed stacks,
`api.dev.nightshift.wildorder.dev`, the operator's Cognito session.

| Item | Value |
|------|-------|
| Claude Code | 2.1.273, signed in with the operator's subscription (P3) |
| Codex CLI | 0.149.0 at `/opt/homebrew/bin/codex`, **logged in using ChatGPT** (confirmed 2026-09-16) |
| AgentCore | available in `us-west-2`; CDK 2.269.0 carries `AWS::BedrockAgentCore::Harness` as an L1 resource; SDK clients `@aws-sdk/client-bedrock-agentcore` and `-control` at `3.1134.0` |
| Bedrock model access (H-P2-06) | **closed 2026-09-16**: `anthropic.claude-haiku-4-5-20251001-v1:0`, `amazon.nova-2-lite-v1:0` and `amazon.nova-lite-v1:0` all report `AUTHORIZED` / `AVAILABLE` in `us-west-2` |
| Local AWS CLI | 2.33.13, which predates the AgentCore harness commands. Scripts use the SDK, not the CLI, for AgentCore. |

### Human prerequisites

| # | Prerequisite | Why | Status |
|---|--------------|-----|--------|
| H-P4-01 | Ratify D-P4-01 … D-P4-09 (§3) | D-P4-01 changes the adapter contract every later program builds on; D-P4-03 decides how a remote worker reaches Nightshift and how a repository crosses into a microVM | **open** |
| H-P4-02 | Accept real, metered spend | The AgentCore adapter bills Runtime compute and Bedrock tokens to the account; Codex and Claude remain on subscriptions. §9 bounds it. | open |
| H-P4-03 | Redeploy the API stack after T4 | The harness resource, its execution role and its JWT authorizer are new infrastructure | open |

**Explicitly not required.** No new account, no second region, no AgentCore
Runtime deployment of an orchestrator (that is P8), no Bedrock model beyond the
three above, no SES, no branded auth domain.

## 3. Decisions (proposed for ratification)

Drafted 2026-09-16 from `docs/vision.md`, `docs/architecture.md`, the source
plan's Stage 4, the P3 as-built, and the AgentCore developer guide as read that
day. On ratification, D-P4-01, D-P4-03 and D-P4-06 are recorded in
`docs/architecture.md` as A-33 … A-35, and `AGENTS.md` gains the short form.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P4-01 | **Adapter contract, version 1.** `HarnessStartInput` gains `tools: WorkerTools`, the four worker operations (`progress`, `complete`, `fail`, `recordDecision`) as in-process functions the execution layer supplies, beside the existing `mcp: McpLaunch`. An adapter chooses the transport its harness can use: a local process gets the stdio MCP server as in P3; a remote session gets the same four operations as **inline functions** it executes on the operator's machine. `Harness` gains `capabilities` (`workspace: "local" \| "remote"`, `usage: boolean`), and `HarnessExit` carries optional `usage` (tokens, cost, latency) when the harness reports it. Everything else in version 0 stands. | The AgentCore session cannot spawn a process on the laptop, so a contract whose only tool transport is "spawn this MCP server" cannot be implemented by it. Lifting the worker operations to functions keeps one implementation of "what a completed job is" (`packages/execution/src/worker.ts`) behind both transports, and D-P3-01 is untouched: still no listener, still the OS process boundary. `usage` is where the empty `RoutingDecision.usage` from P3 finally gets its data. |
| D-P4-02 | **Codex adapter**: `codex exec --json` as a child process in the worktree, `--sandbox workspace-write`, approvals resolved by policy (`--approve-for-me`), `--ephemeral`, `--ignore-user-config`, the worker MCP server passed through `-c mcp_servers.nightshift.*`, the model from routing. Provider `openai`, authenticated by the ChatGPT login already on the machine. Hook events from the JSONL event stream; cancel by `SIGINT`, then `SIGTERM`, then `SIGKILL`. | The same shape as the Claude adapter with a different stream grammar, which is what "breadth, low ambiguity" meant. Subscription authentication stays where it is, on the operator's machine; nothing about transporting it elsewhere is decided (O-05). |
| D-P4-03 | **AgentCore adapter.** CDK creates one harness per stage, `nightshift-<stage>-worker`, in the API stack, with a least-privilege execution role, **no memory**, the built-in `shell` and `file_operations` tools, and an **inbound JWT authorizer** whose issuer is the P2 user pool and whose allowed clients are the two P2 app clients. The adapter invokes it with the operator's Cognito ID token, the same token it sends the API, so the operator's machine still holds no AWS credentials (A-28). One `runtimeSessionId` per agent, derived from the agent id. The worktree crosses in and out as a **workspace tarball through the artifact bucket**: uploaded by presigned `PUT` (P3's route), fetched inside the session by presigned `GET` (new route, T2), and the reverse on completion. Verification, sealing and integration run on the operator's machine on the synced worktree, exactly as for a local worker. Default model `us.anthropic.claude-haiku-4-5-20251001-v1:0`; `amazon.nova-2-lite-v1:0` allowed. Session limits (`maxIterations`, `maxTokens`, `timeoutSeconds`) come from the Program Contract's cost policy. | This is the vision's "AgentCore Harness + inexpensive Bedrock model" route, made concrete. The JWT authorizer is the whole reason A-28 survives contact with a cloud harness. The tarball keeps A-29 exactly true, Nightshift owns the commit and the worker never touches a git remote, and leaves O-06 closed. A custom container is deliberately not used: the managed image has bash and Python, which is enough to move a tarball; the job's own toolchain (Node, for the fixture) is installed at session start by command, and if that proves too slow it becomes a container decision with numbers behind it. |
| D-P4-03a | **Contingency, decided by the T4 spike, not by an implementer:** if `InvokeAgentRuntimeCommand` or session stop cannot be authorised with the JWT, the adapter performs workspace transfer through the model's own `shell` tool with a fixed, deterministic first and last instruction, and cancellation abandons the stream and lets the session expire, recording `cancelled` locally. The spike records which path was taken and why. | The docs list the IAM actions for these operations but are silent on whether the JWT inbound path covers them. A contract that pretended to know would be discovered wrong at T5, which is the expensive place. |
| D-P4-04 | **The conformance fixture** is one Job Contract on the P3 fixture repository that requires repository exploration, modifying a source file, modifying a test, running the tests (shell), reporting progress at least once, recording at least one decision, and completing; plus a deterministic-failure fixture (the tests cannot pass) and a cancellation fixture (the worker is told to wait). The suite proves the nine Stage 4 items per adapter: spawn, identity propagation, Nightshift tool access, progress visibility, decision recording, cancellation, exit and result collection, verification, artifact collection. It runs offline against the scripted harness in `npm test`, and opt-in against each real adapter via `npm run conformance`. | Verbatim from the source plan's Stage 4, with "MCP access" read as "Nightshift tool access", since one adapter reaches the same tools through inline functions. The scripted harness runs the suite in CI so the suite itself is proven before any model is asked to pass it. |
| D-P4-05 | **Harness choice becomes configuration.** `fixedRoute` is replaced by `configuredRoute`: the Program Contract's `modelPolicy.allowedProviders`, in order, chooses the provider and therefore the adapter (`anthropic → claude`, `openai → codex`, `bedrock → agentcore`); `delegate` gains an optional `harness` alongside `model`, honoured within policy and recorded as an override. Rule id `p4-configured`. Still one deterministic rule and no cost reasoning. | The exit gate's sentence. P6 replaces the rule with a policy that reasons about cost and risk; P4 only makes the choice a matter of what the contract says. |
| D-P4-06 | **Two P3 observations close.** (1) `RoutingDecision` gains update semantics: `usage` may be set once, from empty, and `outcome` may move `pending → verified \| verification_failed \| failed \| cancelled`, governed by a table in `core`; everything else is immutable. (2) When a run finishes, its program node moves to a terminal status by a rule in `core`: `integrated` for `succeeded`, `failed` for `failed`, `cancelled` for `cancelled` or `interrupted`. | Both were left open in P3 because settling them at an exit gate would have been settling a rule the contract had not stated. This is the contract stating them. |
| D-P4-07 | **Cost posture.** AgentCore compute and Bedrock tokens are metered and bounded per job by the Program Contract's cost policy, translated into the harness's limits. A conformance run of the AgentCore adapter is budgeted at under one dollar per fixture; the as-built records the measured figure. The P2 budget alarm stands as the backstop. | The first program with spend beyond subscriptions should say what it expects to spend and then say what it spent. |
| D-P4-08 | **Pins.** `@aws-sdk/client-bedrock-agentcore` and `@aws-sdk/client-bedrock-agentcore-control` at `3.1134.0`, inside `packages/harness-agentcore` only. The architecture rule AR-2 already bans `@aws-sdk/client-bedrock*` above the adapter layer, which is the right side of the line for these. | The adapter layer is exactly where a provider SDK belongs. |
| D-P4-09 | **Codex and Claude stay local in P4.** No credential of either subscription is transported anywhere. The AgentCore adapter needs none. O-05 therefore remains open and is not narrowed by anything P4 builds. | Stated so a reader does not infer from "three adapters run" that the remote-credential question has been answered. It has been avoided. |

### Non-guarantees

- **A worker in an AgentCore session runs as the harness execution role**, which
  holds the Bedrock and artifact-bucket permissions listed in T4. It is
  Nightshift's own identity, not the operator's, and it is not scoped per job.
- **The workspace tarball is a snapshot, not a mount.** Two workers cannot share
  a session's filesystem, and a session that dies mid-job loses uncommitted
  work; the node ends `failed` or `interrupted` exactly as a killed local
  process would.
- **Codex's sandbox is Codex's.** `workspace-write` is enforced by Codex, not by
  Nightshift; scope containment is still enforced at commit time (A-29).

## 4. Design

### 4.1 One contract, two transports

```text
execution layer ──── HarnessStartInput { …, mcp: McpLaunch, tools: WorkerTools, sink } ────► adapter
                                                                                                │
   local adapters (claude, codex):  spawn process in worktree ──► child: nightshift-mcp (worker role)
                                    worker calls job.* over stdio ──► MCP server ──► WorkerTools (in that process)
                                                                                                │
   remote adapter (agentcore):      InvokeHarness(session, tools=[inline job.progress/complete/fail/decision])
                                    stream … toolUse(job.complete) ──► adapter executes WorkerTools locally
                                    ──► InvokeHarness(toolResult) ──► stream resumes
```

`WorkerTools` is implemented once, over `packages/execution/src/worker.ts`. The
worker MCP role calls it; the AgentCore adapter calls it. Neither knows about
the other.

### 4.2 The AgentCore job, step by step

| Step | Who | Mechanism |
|------|-----|-----------|
| Persist contract, node, agent, routing decision | execution | unchanged from P3 |
| Snapshot the worktree | adapter | tarball of tracked and untracked files, minus ignored ones (list computed locally with git); uploaded via presigned `PUT` as an `Artifact` of kind `workspace` |
| Start the session | adapter | `InvokeAgentRuntimeCommand`: fetch the tarball by presigned `GET`, unpack to `/workspace`, install the job's toolchain. **`agent.started`** on the first successful command |
| Run the worker | adapter | `InvokeHarness` with the brief, the model from routing, limits from the cost policy, the inline tool definitions. Each `toolUse` block is a `tool.called`, each result a `tool.completed`; `metadata` events accumulate `usage` |
| `job.progress`, `decision.record` | adapter ← stream | inline function → `WorkerTools` locally → result back into the session |
| `job.complete` | adapter ← stream | inline function: export the tree from the session (tarball, presigned `PUT` from inside the microVM, kind `workspace-result`), download it, apply it to the local worktree, then `WorkerTools.complete(summary)`, which performs the scope check and the snapshot commit exactly as for a local worker; the result goes back to the model |
| End | adapter | `messageStop` with `end_turn` after a completed job is `completed`; `timeout_exceeded`, `max_iterations_exceeded`, `max_output_tokens_exceeded` are `failed` with the reason; the ending event is emitted once. `usage` totals are on the exit |
| Verify, seal, integrate, checkpoint | execution | unchanged: on the operator's machine, on the synced worktree |

### 4.3 What the conformance suite asserts per adapter

| Stage 4 item | Assertion |
|-------------|-----------|
| spawn | `start` returns a handle with the given `agentId`; `agent.started` arrives |
| identity propagation | the worker's first `job.progress` is recorded against the right node and agent, and a worker's attempt to act for another node is refused |
| Nightshift tool access | `job.progress`, `decision.record` and `job.complete` each reach the control plane |
| progress visibility | `node.progress` events with source `mcp` appear before `node.implemented` |
| decision recording | one `Decision` exists on the node, `checkpointBefore` set |
| cancellation | the cancellation fixture ends `cancelled` on both agent and node, within the grace period |
| exit and result collection | `exit` settles once; `outcomeReason` on failure; `usage` present where `capabilities.usage` is true |
| verification | the completing fixture ends `verified` then `integrated`; the failing fixture ends `verification_failed` with the failing step's log artifact |
| artifact collection | a `transcript` artifact for every adapter that keeps one; `workspace` and `workspace-result` for the remote adapter |

Plus the architecture assertion: no harness-specific import above the adapter
layer, and `apps/mcp/src/compose.ts` is still the only module naming one.

### 4.4 Control-plane additions

| Addition | Why |
|----------|-----|
| `GET …/artifacts/{artifactId}/download-url` | The session fetches the workspace, and the adapter fetches the result, by presigned `GET`. The function gains `s3:GetObject` for signing only, the same posture as the `PUT` in P3. |
| `ArtifactKind` gains `workspace` and `workspace-result` | So a reader can tell a shipped tree from a transcript. |
| `PUT routing decision` update semantics (D-P4-06) | `usage` once from empty; `outcome` from `pending`. |
| `PUT node` for the program node's end (D-P4-06) | `finishRun` in `core`, applied by `run.finish` and by shutdown. |
| Smoke: the two routes and the two rules | Every route the smoke suite has to cover, as P2 and P3 did. |

### 4.5 Infrastructure (T4)

In the API stack, stateless: the `AWS::BedrockAgentCore::Harness`
`nightshift-<stage>-worker`; its execution role (trust `bedrock-agentcore.amazonaws.com`;
`bedrock:InvokeModel*` on the three inference profiles only; `s3:GetObject` and
`s3:PutObject` on the artifact bucket's objects; the CloudWatch and X-Ray
statements the docs require; **no** browser, code interpreter, memory or gateway
statements); the JWT authorizer (discovery URL of the P2 pool, allowed clients
the two P2 app clients); system prompt from the shared brief; `allowedTools`
restricted to the two built-ins plus the inline functions; no memory
configuration. Outputs: the harness ARN. Assertion tests for each.

## 5. Scope

### In scope

- `packages/harness`: contract version 1 (D-P4-01), `WorkerTools`, capabilities,
  usage on exit; the brief gains the provider-neutral sentences the two new
  adapters need.
- `packages/harness-codex`, `packages/harness-agentcore`: the adapters.
- `packages/harness-claude`: to version 1; `usage` from the `result` frame.
- `packages/execution`: `WorkerTools` over `worker.ts`; the runner passes both
  transports; `finishRun`; usage and outcome written to the routing decision.
- `packages/routing`: `configuredRoute` (D-P4-05).
- `apps/mcp`: `delegate { harness? }`; the composition root's switch over three
  adapters; the worker role calls `WorkerTools`.
- `apps/api`, `infra/cdk`: §4.4 and §4.5; one redeploy.
- `core`: the routing-decision table, `finishRun`, the artifact kinds.
- `test/`: the conformance fixture and suite (D-P4-04); the scripted harness
  gains the fixture scripts; the slice axis gains `codex` and `agentcore`;
  `npm run conformance`.
- Pins in `AGENTS.md` (D-P4-08).

### Out of scope

- Running an orchestrator anywhere but the operator's machine (P8).
- Transporting a Claude or Codex credential anywhere (O-05).
- More than one job in flight, stale-base reconciliation, program-level
  verification (P5).
- Cost- or risk-based routing, escalation, examination (P6).
- A custom container image for the AgentCore session, unless the T4 spike shows
  the managed image cannot install the fixture's toolchain in acceptable time,
  in which case it is a recorded decision.
- AgentCore memory, gateway, browser, code interpreter, skills, VPC mode.

## 6. Success criteria

**Stage 4, carried verbatim.** For each of the three adapters:

- **SC-P4-01** spawn; **SC-P4-02** identity propagation; **SC-P4-03** Nightshift
  tool access; **SC-P4-04** progress visibility; **SC-P4-05** decision
  recording; **SC-P4-06** cancellation; **SC-P4-07** exit and result collection;
  **SC-P4-08** verification; **SC-P4-09** artifact collection.
- **SC-P4-10** The identical Job Contract executes through all three adapters.
- **SC-P4-11** The deterministic-failure fixture ends `verification_failed`, and
  the cancellation fixture ends `cancelled`, through all three.
- **SC-P4-12** No harness-specific import reaches the domain or the execution
  scheduler (regression of SC-P3-14, with two more packages to leak from).

**P4 additions**

- **SC-P4-13** The conformance suite passes against the scripted harness in
  `npm test`, on both CI legs, before any real adapter is asked to pass it.
- **SC-P4-14** `RoutingDecision.usage` is non-empty for every adapter that
  reports usage, and `outcome` is terminal on every finished node.
- **SC-P4-15** The program node is terminal after `run.finish`, and
  `GET …/state` shows a `succeeded` run with an `integrated` root.
- **SC-P4-16** The operator's machine holds no AWS credential during an
  AgentCore job: the adapter's only credential is the Cognito ID token, and the
  offline test that plants an `AWS_*` variable proves nothing reads it.
- **SC-P4-17** Harness choice is configuration: changing
  `modelPolicy.allowedProviders` or passing `harness` on `delegate` changes
  which adapter runs, with no code change and a `RoutingDecision` that says why.

**Exit gate**

- **SC-P4-18** `npm run conformance` passes for `claude`, `codex` and
  `agentcore` against the deployed control plane, and the smoke suite passes
  against the redeployed stack. The as-built records wall clock, tokens and
  dollars per adapter.

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

Plus, from a developer machine with `AWS_PROFILE=nightshift` for the deploy and
smoke, and the operator's `nightshift login` session for the rest:

```text
npm run deploy           # after T4
npm run smoke
npm run conformance      # claude, codex, agentcore in turn; prints per-adapter cost
npm run slice            # existing, with the two new harness values
```

`npm test` stays free of credentials, sign-ins and non-loopback network.

## 8. The conformance run (D-P4-04)

`npm run conformance [--harness claude|codex|agentcore|all]` materialises the
fixture repository, starts the orchestrator-role MCP server as the slice suite
does, delegates the three fixture jobs through the chosen adapter against the
deployed control plane, and asserts §4.3. It prints the run identifiers, the
wall clock per job, and, where the adapter reports it, tokens and cost. Cleanup
follows the smoke suite's rules. Two runs must not overlap.

## 9. Constraints

- Dependencies point downward only; the three adapters import
  `@nightshift/harness`, never each other; `execution`, `routing`,
  `verification`, `core` and `contracts` import no adapter and no provider SDK.
- The provider SDKs live inside their adapter package and nowhere else
  (D-P4-08).
- The operator's machine never holds AWS credentials for the Nightshift account
  (A-28); the AgentCore adapter is bound by this exactly as the http adapter is.
- No worker gets git write access; the AgentCore session gets no git remote and
  no credential that could reach one.
- Every AgentCore invocation carries the limits from the cost policy; an
  unbounded session is a defect.
- Pins exact, recorded in `AGENTS.md`.
- Scripts run on Windows and Linux.

## 10. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack after T4; running
the smoke, slice and conformance suites; spending within D-P4-07 on Bedrock and
AgentCore; running Claude Code and Codex headless on the operator's
subscriptions.

Forbidden:

- Deploying an orchestrator to AgentCore Runtime, or anything that survives the
  operator's terminal (P8).
- Putting a Claude or Codex credential in any environment but the operator's
  machine (O-05).
- Granting the harness execution role a browser, code interpreter, memory,
  gateway or `sts:AssumeRole` statement.
- Granting `bedrock-agentcore:InvokeAgentRuntimeCommand` to any principal but
  the one the T4 spike decides needs it, and documenting that decision.
- Editing the P1, P2 or P3 conformance and smoke assertions to make an adapter
  pass.
- Settling O-02, O-03, O-05 or O-06.

## 11. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Adapter contract v1, `WorkerTools`, and the conformance fixture | — | — |
| T2 | Control-plane additions: download URL, routing-decision table, `finishRun` | — | AWS for the redeploy and smoke (with T4) |
| T3 | The Codex adapter | T1 | Codex, for the real run |
| T4 | AgentCore infrastructure and the JWT spike | — | AWS |
| T5 | The AgentCore adapter | T1, T2, T4 | AWS, Bedrock spend |
| T6 | Claude to v1, `configuredRoute`, `delegate { harness }`, the composition switch | T1, T2 | — |
| T7 | Conformance for real, slice axis, as-built | T3, T5, T6 | AWS, Claude Code, Codex |

```text
T1 ──┬── T3 ─────────────┐
     ├───────── T6 ──────┼── T7
T2 ──┼───────────┘       │
T4 ──┴── T5 ─────────────┘
```

T1, T2 and T4 are independent and start together; T4's spike (D-P4-03a) is the
first thing to run, because its answer shapes T5. T3 and T6 are parallelisable.
Specs live in `tasks/p4-harness-neutrality/`.

### Carried over from P3

- `RoutingDecision.usage` is `{}` and the record is create-or-confirm (T2).
- The program node stays `running` after `run.finish` (T2).
- `compose.ts` selects the adapter with one `switch`; the T9 harness-module
  injection stays for the scripted harness (T6).
- The Claude adapter reads `usage.input_tokens`, `output_tokens` and
  `total_cost_usd` from the `result` frame and discards them (T6).
- The staging note asked what "AgentCore Harness" is. Answered: a managed agent
  loop, GA June 2026, cloud-hosted; P4's dependency class is therefore
  "AWS, with metered spend", and this contract says so rather than discovering
  it.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-16 | Contract drafted; D-P4-01 … D-P4-09 proposed; tasks T1 … T7 drafted. An earlier working assumption that AgentCore was only a runtime was wrong and was corrected before drafting: AgentCore Harness is a product, and it is the third adapter. | Agent, for human ratification |

## 13. As built

Not yet.
