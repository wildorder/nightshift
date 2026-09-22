# Nightshift — Vision Document

> **v1.** This document supersedes all prior Nightshift architecture. Nightshift
> v1 is a greenfield rebuild on the `v1` branch; nothing in this vision is
> constrained by, or compatible with, the v0 design.

## What Is Nightshift?

Nightshift is an **autonomous engineering control plane**. It sits beneath a
frontier coding agent and gives that agent controlled delegation, model and
harness flexibility, deterministic verification, independent examination,
reversible decisions, and complete operational visibility — without prescribing
how the agent thinks or plans.

**One-liner:** Autonomous engineering with observable execution, cheapest-capable
model routing, independently verified outcomes, cross-model scrutiny where
warranted, and reversible decisions.

## The Problem

Frontier coding agents can now own substantial engineering programs end-to-end.
What they cannot do on their own is prove it.

A capable agent left to run a multi-hour program produces work nobody can see
into, verify independently, cost-attribute, or undo. Specifically:

- **Invisible execution.** Sub-agents spawn and finish inside a harness. There is
  no durable record of what ran, under which model, against which commit.
- **Self-grading.** An agent reporting "done" is the only signal that the work is
  done. Completion and correctness are conflated.
- **Uniform cost.** Every task — a trivial bounded refactor and a cross-cutting
  architectural change alike — burns frontier tokens.
- **Harness lock-in.** Orchestration logic written against one provider's CLI
  cannot execute anywhere else.
- **Irreversibility.** A judgement call made in hour two silently shapes hours
  three through nine, with no way to reverse it short of discarding everything.
- **Terminal tethering.** Closing the laptop ends the run.

Earlier Nightshift designs answered a *different* problem — context decay — with
mandatory fresh agents, static workstream decomposition, and fixed
author/reviewer/implementer roles. Those constraints are becoming less relevant,
and the ceremony they required now costs more than it returns.

## The Solution

Invert the relationship. The agent owns the engineering; Nightshift owns the
control plane.

A capable top-level orchestrator — Claude Code, Codex, or an AgentCore harness —
runs continuously and owns the program. It plans, decomposes, implements, revises
its plan, and decides what to delegate. Nightshift never prescribes that reasoning
workflow.

**A human plans first, and only as far as it pays.** Before anything runs, a
developer and an agent work a program out together in a document: the outcomes,
the seams (a few **strands**), each strand's approach at the fidelity a developer
wants before saying yes, the decisions that are expensive to reverse, and
everything only a human can do, done *before* the run with a command that proves
it. Planning ends where a wrong choice becomes cheap: would undoing it throw away
more than one job's work, or need a human? Then it is the plan's. Otherwise it is
the run's, and no plan names a job. The human ratifies the plan, and only then
does an orchestrator run it end to end with nobody watching, and report against
it. A strand that fails costs its own cone and not the night; a check that needs
something only a human can supply is deferred, and the work carries on beside
the program branch until they are back.

What Nightshift provides beneath it:

1. **Controlled delegation.** Every delegated unit passes through Nightshift as a
   validated, persisted contract. Nothing executes without a Nightshift identity.
2. **Deterministic verification.** `implemented ≠ verified`. A worker may report
   completion; only Nightshift may report verification, and only verified work
   integrates.
3. **Model and harness routing.** Each job is routed to the cheapest execution
   path likely to produce a *verified* result — not the cheapest token.
4. **Risk-based examination.** Independent scrutiny is applied where the expected
   cost of failure warrants it, by a different model or a different provider.
5. **Reversible decisions.** Decisions are tied to checkpoints and to their causal
   descendants. Reversing one invalidates the minimum necessary execution cone.
6. **Central observability.** One authoritative control plane for local and remote
   runs, reconstructable without touching the runner's filesystem.
7. **Walk-away execution.** Dispatch a remote run and close the laptop.

## Architecture

```text
                 Human
                   │
                   ▼
   ┌───────────────────────────────┐
   │  Top-level orchestrator       │   Claude Code | Codex | AgentCore
   │  (owns the engineering plan)  │
   └───────────────┬───────────────┘
                   │  nightshift.delegate(...)
                   ▼
   ┌───────────────────────────────┐
   │       Nightshift MCP          │   semantic interface
   └───────────────┬───────────────┘
                   ▼
   ┌───────────────────────────────────────────────────────┐
   │              Nightshift Control Plane                 │
   │                                                       │
   │   routing ── execution ── verification ── decisions    │
   │                      │                                │
   │        DynamoDB (state)      S3 (artifacts)           │
   └───────────────┬───────────────────────────────────────┘
                   ▼
   ┌───────────────────────────────┐
   │      Harness adapters         │
   │  claude │ codex │ agentcore   │
   └───────────────┬───────────────┘
                   ▼
        isolated Git worktrees, one per Job
                   │
                   ▼
        Nightshift verification → sealed commit
                   │
                   ▼
        serialized integration → program branch
```

Local and remote execution share one authoritative control plane. There is no
independent local canonical state; a local event spool exists only to survive
connectivity loss and must replay idempotently.

## Core Concepts

**Program** — the user-authorized body of work, governed by a Program Contract.

**Sub-program** — a delegated body of work substantial enough to have its own
orchestrator and its own delegation authority.

**Job** — a bounded unit of execution, governed by a Job Contract.

**Plan** — a program's `plan.md` and `contract.json`, written with the human and
ratified by them before anything runs. It fixes the seams and the expensive
choices, never the jobs.

**Strand** — a seam chosen by a human: a sub-program with a scope, acceptance and
an approach, whose orchestrator is handed its section of the plan word for word
and decides its own jobs.

**Human prerequisite** — something only a human can do, found at planning time,
done before the run, and proven by a deterministic command.

Execution is recursive. Children may narrow inherited authority; they may never
widen it.

**Program Contract** — the stable authority for a run: objective, project
identity, repository, program branch, success criteria, constraints, permissions,
forbidden actions, deterministic verification, model/provider policy,
risk/examination policy, delegation limits, cost policy. The orchestrator may
continuously revise its *implementation plan*. It may not silently revise the
Program Contract to make its implementation pass.

**Job Contract** — objective, scope (includes/excludes), acceptance criteria,
dependencies, risk, ambiguity. Nightshift — not the orchestrator — then decides
harness, model, workspace, worktree, priority, examination requirement, and
fallback policy. An orchestrator may *request* a model; Nightshift honours it
only within the Program Contract's policy and records the routing decision as
an override, so the choice stays explainable.

**Execution node** — a node in the run's execution tree. Parentage, scope
inheritance, depth, and concurrency are enforced structurally.

**Verification** — deterministic, Nightshift-owned evidence tied to a job, agent,
commit, and where applicable a program success criterion.

**Examination** — independent scrutiny by a different model or provider, applied
by risk policy, judged against evidence (contract, diff, tests, verification
results) rather than the implementer's rationale.

**Decision** — a recorded choice with context, alternatives, rationale, a
reversibility class (`reversible` | `compensatable` | `irreversible`), and
checkpoints before and after. Human authority is always highest.

**Checkpoint** — a durably addressable Git state that replay can return to.

## API Surface

**Nightshift MCP** (mandatory infrastructure; the semantic interface between
agents and the control plane). Capability surface, names illustrative:

```text
program.get              job.progress          verification.request
program.status           job.complete          verification.get
delegate                 job.fail              examination.request
job.get                  decision.record       artifact.record
                         checkpoint.create     execution.status
```

**Hooks** capture lifecycle behaviour that must not depend on agent compliance —
agent created/started/completed/failed/cancelled, tool called/completed, subagent
created, checkpoint created, context compacted. MCP carries intent; hooks carry
ground truth. Use both where the harness supports it.

**CLI** — `nightshift run`, `nightshift run --remote`. The remote dispatch API is
the same one a future Studio will call.

**Harness adapter** — a deliberately small interface (`start`, `cancel`,
`status`) around only what Nightshift requires. Authentication, invocation, model
selection, MCP configuration, hooks, output parsing, and sandboxing stay inside
each adapter. The abstraction must not flatten every harness to the least capable
feature set.

## Data Model

Every record is project scoped; `projectId` / `programId` / `runId` form the
ownership chain.

**DynamoDB** — projects, program contracts, runs, execution nodes, jobs, agents,
decisions, checkpoints, routing decisions, examinations, verification summaries,
event metadata, current status.

**S3** — full transcripts, build and verification logs, examination reports, large
diffs, archived reports. DynamoDB holds structured metadata and references; large
output never lands in DynamoDB.

Event writes carry idempotency keys. Event ordering must be reconstructable and
current state rebuildable from stored records alone.

## Target Users

**Primary — the solo or small-team engineer running autonomous programs.** Wants
to authorize a body of work, walk away, and return to verified output plus a
complete account of what happened and what it cost.

**Secondary — the frontier coding agent itself.** Nightshift's real interface
surface is MCP. Ergonomics for the agent are a product requirement, not an
implementation detail.

**Future — Studio operators.** Not built in v1, but the control plane is designed
so that a Studio is a UI over existing APIs rather than a new backend project.

## Technology Stack

**Primary stack:** TypeScript monorepo (npm workspaces), Node.js, AWS CDK v2, MCP

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript | Shared versioned domain contracts across CLI, MCP, infra, and future Studio |
| Repo layout | Workspace monorepo | Infra, MCP server, runtime libraries, harness adapters and Studio share contracts |
| Infrastructure | AWS CDK v2 (TypeScript) | Sole IaC system — no SST, Terraform, or Pulumi alongside it without an explicit architectural decision |
| State | DynamoDB | Project-scoped structured operational state, single-digit-ms reads for run status |
| Artifacts | S3 | Transcripts, logs, diffs, reports — anything too large or durable for DynamoDB |
| Agent interface | MCP | Semantic, harness-neutral interface between orchestrators and the control plane |
| Cheap execution path | AgentCore harness + Bedrock | Model-flexible low-cost route for bounded, strongly testable jobs: the AgentCore harness loop, exported to code, running as a worker process on the program's runtime instance with a Bedrock model |
| Remote execution | AgentCore Runtime, runtime instances | One runtime instance per remote program run: managed EC2 capacity hosting the orchestrator and its concurrent workers as processes, never one environment per leaf job |

Infrastructure code is production code and carries the same testing requirements
as application code.

## Scope: v1

The first meaningful milestone is not AgentCore, routing, or recursion. It is:

> A local frontier orchestrator delegates one bounded coding job through
> Nightshift, a separate worker executes it in an isolated worktree, Nightshift
> independently verifies it, integrates the verified commit, and the complete
> lifecycle is visible in centralized state.

Everything else builds from that invariant. See `docs/programs/staging.md` for how
the v1 stages are grouped into programs, and
`docs/programs/00-source-program-plan.md` for the full stage detail.

**Build (v1):**
- Versioned domain contracts and pure domain rules, independent of AWS and MCP
- Centralized AWS control plane (DynamoDB, S3, API, IAM) via CDK
- Nightshift MCP server and local execution machinery
- Harness adapters for Claude Code, Codex, and AgentCore, behind one conformance suite
- Multi-user identity: organisations enforced as a boundary, and every executing agent holding its own scoped credential rather than a human's
- Parallel and recursive execution in isolated worktrees, with serialized integration
- Deterministic model/harness routing with fallback and escalation
- Risk-based independent examination
- Decision graph with checkpointed replay over the minimum affected cone
- AgentCore remote runner and walk-away dispatch
- Realtime and analytics surface sufficient for a future Studio

**Do not build in v1:**
- Nightshift Studio (its required data surface is in scope; the UI is not)
- Learned model routing (`expected_cost_to_green`) — v1 captures the dataset only
- A proprietary general-purpose agent harness
- v0 execution compatibility, v0 manifests, v0 agent-role configuration, or the
  v0 static author/reviewer/implementer workflow
- Context-decay mitigation through mandatory fresh agents
- An independent authoritative local database
- One cloud VM per leaf job by default
- Universal examination — examination is risk-based, not blanket ceremony

Legacy Nightshift remains reachable only through its tags and history, for
deliberate human reference.

## Scope: After v1

Learned routing trained on the v1 outcome dataset; Nightshift Studio as a pure
client of the v1 APIs; self-service sign-up and org administration. These inform
architectural decisions now — project scoping, API-first state, normalized
analytics — but nothing is built for them.

*Amended 2026-09-16.* Multi-user identity was originally listed here as
post-v1. It moved into v1 as program P4 (`docs/programs/staging.md`, "Restaging")
once P3 showed that a single-user assumption had shaped the authentication
design: a worker held the operator's own credential, and organisations were a
label rather than a boundary. v1 now ships org isolation and per-execution
credentials; what stays post-v1 is the administration surface around them.
