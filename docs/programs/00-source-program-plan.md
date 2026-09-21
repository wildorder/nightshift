# Nightshift v1 — Greenfield Program Plan

## Program Overview

**Product:** `@wildorder/nightshift`
**Program:** Nightshift v1 — Autonomous Engineering Control Plane

Nightshift v1 is a greenfield rebuild of Nightshift around a different assumption:

> Frontier coding agents are capable of owning substantial engineering programs end-to-end. Nightshift should not prescribe their reasoning workflow. It should give them controlled delegation, model flexibility, deterministic verification, independent examination, reversibility, and complete operational visibility.

The existing Nightshift architecture was designed partly around limitations that are becoming less important: context decay, mandatory fresh-agent boundaries, static workstream decomposition, and fixed author/reviewer/implementer roles.

V1 removes those assumptions.

A capable top-level coding agent owns the program continuously. It plans, decomposes, implements, revises its plan, and decides what to delegate. Nightshift provides the execution/control plane beneath it.

The core value proposition becomes:

> **Autonomous engineering with observable execution, cheapest-capable model routing, independently verified outcomes, cross-model scrutiny where warranted, and reversible decisions.**

---

# Errata and restaging notes (2026-09-16)

This document is the source plan and is left as written. Where reality has
moved, the note is here rather than a silent edit in the stage text.

* **Programs, not stages, are the unit of delivery.** `staging.md` groups the
  eleven stages into programs and was adjusted on 2026-09-16: a program for
  identity and tenancy was inserted as P4, and the numbering after it shifted
  by one (Harness Neutrality is P5, the Remote Runner is P9, Realtime is P10).
  It was adjusted again on 2026-09-21: Planning was inserted as P7, so Routing &
  Examination is P8, Decision Graph P9, the Remote Runner P10 and Realtime P11.
* **Multi-user identity is in v1.** "Single-user/private v1 is settled" below
  described the assumption P2 was built on; P4 replaces it with enforced
  organisation isolation and per-execution credentials. See `docs/vision.md`,
  "Scope: After v1", for the amendment.
* **"AgentCore Harness" is a product.** Amazon Bedrock AgentCore harness became
  generally available in June 2026: a managed agent loop over any Bedrock,
  OpenAI or Gemini model that can be exported to Strands code. In this plan it is
  the cheap Bedrock worker; it runs as a process on the program's runtime
  instance (Stage 9), never as one hosted environment per leaf job, which the
  Non-Goals exclude.
* **"AgentCore Runtime Instance" is now a specific thing.** Runtime instances
  became generally available in August 2026: managed EC2 capacity hosting many
  agents on a shared session with a common filesystem for up to fourteen days,
  distinct from Runtime's serverless sessions, which are isolated environments
  capped at eight hours. Stage 9's "one AgentCore Runtime Instance" means the
  former.
* **Two anticipated decisions are resolved**: the control-plane runtime (O-01,
  `architecture.md` A-19) and local authentication to Nightshift MCP (O-04,
  A-27). The section below lists them as open.

---

# Greenfield Boundary

Nightshift v1 remains in the existing `wildorder/nightshift` repository but begins from an **orphan branch with a new root commit**.

Before creating it, tag the current implementation as legacy.

Conceptually:

```text
current Nightshift
    ↓
tag: v0-legacy
    ↓
orphan branch: v1
    ↓
new root commit
```

The v1 branch does not inherit the current working tree.

Do not copy forward:

* existing `docs/vision.md`;
* existing `docs/as-built.md`;
* historical programs or manifests;
* historical task specifications;
* current `/plan-program`;
* fixed agent-role configuration;
* current execution pipeline;
* old architectural directives in `AGENTS.md`;
* code solely supporting context-reset orchestration.

Legacy refs remain available only for deliberate human reference.

The new `AGENTS.md` must explicitly state:

> This is a greenfield implementation. Do not inspect legacy branches, tags, commits, or prior Nightshift source unless explicitly instructed by a human.

The v1 agent context must contain no accidental architectural inheritance from v0.

---

# Product Model

## Top-Level Orchestrator

A Nightshift program has one persistent top-level orchestrator.

Initially supported:

* Claude Code
* OpenAI Codex
* AgentCore Harness

For a local run, the user launches Claude Code or Codex and invokes the Nightshift skill.

```text
Human
  ↓
Claude Code / Codex
  ↓
Nightshift MCP
```

Nightshift does not spawn the local top-level orchestrator.

For a remote run, Nightshift starts the configured top-level harness on the AgentCore runner.

```text
nightshift run --remote
        ↓
Nightshift Control Plane
        ↓
AgentCore program instance
        ↓
Claude Code | Codex | AgentCore Harness
```

The initiating machine is no longer involved once dispatch succeeds.

Closing the terminal or shutting down the user's computer must not affect the run.

---

# Programs, Sub-Programs and Jobs

Execution is recursive.

```text
Program
├── Sub-program A
│   ├── Job A1
│   ├── Job A2
│   └── Job A3
│
└── Sub-program B
    ├── Job B1
    └── Sub-program B2
        ├── Job B2.1
        └── Job B2.2
```

A **Program** is the user-authorized body of work.

A **Sub-program** is a delegated body of work substantial enough to have its own orchestrator and further delegation authority.

A **Job** is a bounded unit of execution.

Nightshift enforces:

* parent/child relationships;
* inherited scope;
* maximum delegation depth;
* maximum concurrency;
* model/provider policy;
* resource budgets;
* execution location;
* project isolation.

Children may narrow inherited authority.

They may never widen it.

---

# Program Contract

The Program Contract is the stable authority for a run.

It contains:

* objective;
* project identity;
* repository;
* program branch;
* success criteria;
* constraints;
* permissions;
* forbidden actions;
* deterministic verification;
* model/provider policies;
* risk/examination policy;
* delegation limits;
* cost/resource policy.

The orchestrator may continuously revise its implementation plan.

It may not silently revise the Program Contract to make its implementation pass.

Example:

```yaml
program:
  id: tenant-billing
  projectId: example-app

objective:
  Add tenant-aware billing.

successCriteria:
  - id: SC-01
    outcome: Tenant billing data is isolated.
  - id: SC-02
    outcome: Existing customers remain compatible.
  - id: SC-03
    outcome: Webhook handling is idempotent.

constraints:
  - No production deployment.
  - Existing public APIs remain compatible.
  - Database migrations must be reversible.

verification:
  - npm run build
  - npm run typecheck
  - npm test
  - npm run integration

execution:
  maxDepth: 3
  maxConcurrency: 8
```

---

# Job Contract

Delegation must go through Nightshift.

The orchestrator does not directly spawn Nightshift workers.

It calls:

```text
nightshift.delegate(...)
```

Nightshift validates and persists the Job Contract before execution begins.

A Job Contract includes:

```yaml
objective: Add tenant ownership to invoice persistence.

scope:
  includes:
    - src/billing/**
    - migrations/**
  excludes:
    - public API changes

acceptance:
  - Existing invoices remain readable.
  - New invoices require tenant ownership.
  - Migration rollback succeeds.

dependencies:
  - billing-domain-model

risk: low
ambiguity: low
```

Nightshift then decides:

* harness;
* model;
* workspace;
* worktree;
* execution priority;
* examination requirement;
* fallback/escalation policy.

---

# Nightshift MCP

Nightshift MCP is mandatory infrastructure.

It is the semantic interface between agents and the Nightshift control plane.

All orchestrators receive Nightshift MCP access.

Workers receive enough Nightshift identity/telemetry integration to ensure no delegated work becomes invisible.

Initial MCP surface should center on capabilities such as:

```text
program.get
program.status

delegate
job.get
job.progress
job.complete
job.fail

decision.record

checkpoint.create

verification.request
verification.get

examination.request

artifact.record

execution.status
```

Exact names are implementation details.

The important rule is:

> No Nightshift-managed execution may happen without a Nightshift execution identity.

---

# Hooks and Telemetry

MCP records semantic actions.

Hooks capture lifecycle behavior that should not depend on agent compliance.

Use both where harness support permits.

Examples:

```text
agent created
agent started
tool called
tool completed
subagent created
checkpoint created
context compacted
agent completed
agent failed
agent cancelled
```

Hooks are used for observability and enforcement.

MCP carries intent and semantic meaning.

---

# Harness Architecture

Nightshift does not implement a general-purpose agent harness.

Define a small harness adapter interface around the functionality Nightshift requires.

Initial adapters:

```text
Claude Code
Codex
AgentCore Harness
```

Conceptually:

```ts
interface Harness {
  start(input: HarnessRunInput): Promise<AgentHandle>;
  cancel(agentId: string): Promise<void>;
  status(agentId: string): Promise<AgentStatus>;
}
```

Harness-specific concerns remain inside each adapter:

* authentication;
* command invocation;
* model selection;
* MCP configuration;
* hooks;
* output parsing;
* sandbox configuration;
* provider-specific capabilities.

The abstraction must not force all harnesses down to the least capable feature set.

---

# Model and Harness Routing

Nightshift routes each delegated job to a **model + harness combination**.

Initial routing is deterministic.

The goal is not:

> cheapest token.

The goal is:

> cheapest execution path likely to produce a verified result.

Inputs may include:

```text
risk
ambiguity
blast radius
scope breadth
repository context required
cross-cutting impact
availability of deterministic tests
task type
prior model performance
required tools
```

Typical policy:

```text
bounded + unambiguous + strongly testable
    ↓
AgentCore Harness + inexpensive Bedrock model

moderate engineering work
    ↓
stronger coding model/harness

cross-cutting / architectural / poorly specified
    ↓
frontier Claude Code or Codex
```

Failures may escalate:

```text
cheap worker
    ↓ failure
stronger worker
    ↓ failure
frontier orchestrator
```

Every routing decision records:

* eligible options;
* chosen harness;
* chosen model;
* policy/rule responsible;
* estimated/actual cost when available;
* latency;
* verification result;
* retry/escalation result.

This creates the dataset required for later learned routing.

---

# Risk-Based Independent Examination

"No self-grading" becomes risk-based rather than universal.

Default policy should be configurable.

Example:

```text
LOW
implementation
→ deterministic verification
→ integrate

MEDIUM
implementation
→ deterministic verification
→ different-model examiner
→ integrate

HIGH
implementation
→ deterministic verification
→ different-provider frontier examiner
→ resolution
→ integrate
```

Examiner input should favor evidence:

* Program/Job Contract;
* diff;
* changed tests;
* verification results;
* relevant interfaces.

Where practical, do not initially expose the implementer's rationale so the examiner forms an independent judgment.

---

# Deterministic Verification

Agent completion and Nightshift verification are separate states.

```text
implemented ≠ verified
```

A worker may report completion.

Only Nightshift may report deterministic verification.

Verification output becomes first-class evidence tied to:

* job;
* agent;
* commit;
* program criterion where applicable.

A successful worker result cannot integrate if mandatory verification fails.

---

# Git and Parallel Execution

Every delegated coding Job receives an isolated Git worktree.

Example:

```text
program checkout
    program/foo

worktrees/
    JOB-001/
    JOB-002/
    JOB-003/
```

Independent Jobs may execute concurrently.

Each successful job produces a Nightshift-owned verified commit.

Nightshift serializes integration into the program branch.

```text
JOB-001 ── verified ──┐
JOB-002 ── verified ──┼─→ integration → program verify
JOB-003 ── verified ──┘
```

A commit that was green against an outdated base is not automatically accepted after other jobs integrate.

Nightshift must detect stale bases and rebase/reconcile/reverify as necessary.

Individually green jobs may still be collectively incompatible.

Program-level verification catches that.

---

# Decisions and Reversibility

Decision reversibility remains a core Nightshift property.

A Decision records:

```text
decisionId
projectId
programId
runId
executionNodeId
agentId

context
alternatives
choice
rationale

reversibility:
  reversible | compensatable | irreversible

checkpointBefore
checkpointAfter

affectedNodes
```

Execution nodes consuming decision-dependent output establish causal relationships.

Human authority remains highest.

A human may later reverse a decision.

Nightshift determines the smallest affected execution cone, invalidates dependent work, preserves unrelated work, and schedules replay.

Git state before replay must remain durably addressable.

Irreversible external effects are never described falsely as reversible.

---

# Central Control Plane

Local and remote execution share one authoritative control plane.

```text
Local execution ───┐
                   ├── Nightshift Control Plane
Remote execution ──┘
```

There is no independent local canonical state.

## DynamoDB

Structured operational state:

* projects;
* program contracts;
* runs;
* execution nodes;
* jobs;
* agents;
* decisions;
* checkpoints;
* routing;
* examinations;
* verification summaries;
* event metadata;
* current status.

Every record is project scoped.

At minimum:

```text
projectId
programId
runId
```

must be part of the ownership chain.

## S3

Large or durable artifacts:

* full transcripts;
* build logs;
* verification logs;
* examination reports;
* large diffs;
* archived reports;
* other run artifacts.

DynamoDB contains structured metadata and references.

## Connectivity Loss

Local execution may maintain a temporary event spool when the control plane is unreachable.

The spool is not authoritative storage.

Events must be idempotently replayable when connectivity returns.

---

# Future Studio

The control plane must be designed so that a Studio can eventually operate purely as a client.

The Studio should be able to display:

```text
Projects
Programs
Runs

execution tree
active agents
real-time progress
models/harnesses
decisions
verification
examinations
commits
failures
retries
cost
tokens
latency
critical path
```

The Studio is not part of this program.

Its required data surface is.

The same remote-run API used by the CLI will eventually allow the Studio to trigger a run.

---

# Infrastructure

Nightshift v1 uses **AWS CDK v2 with TypeScript** as its sole infrastructure-as-code system.

Do not introduce SST, Terraform, or Pulumi alongside it unless a later architectural decision explicitly changes this.

Infrastructure lives with the product:

```text
infra/
  cdk/
```

CDK owns:

* DynamoDB;
* S3;
* control-plane compute/API resources;
* MCP hosting;
* IAM;
* AgentCore resources;
* remote runner configuration;
* logging/observability resources;
* networking where required.

Infrastructure code is production code and receives the same testing requirements as application code.

---

# Proposed Repository

```text
nightshift/
├── apps/
│   ├── api/
│   ├── mcp/
│   └── studio/               # reserved, not built here
│
├── packages/
│   ├── contracts/
│   ├── core/
│   ├── persistence/
│   ├── execution/
│   ├── routing/
│   ├── verification/
│   ├── harness/
│   ├── harness-claude/
│   ├── harness-codex/
│   └── harness-agentcore/
│
├── infra/
│   └── cdk/
│
├── skills/
│   └── nightshift/
│
├── docs/
│   ├── vision.md
│   └── architecture.md
│
├── test/
│
├── AGENTS.md
├── package.json
└── README.md
```

A workspace/monorepo layout is appropriate because the infrastructure, MCP server, CLI/runtime libraries, harness adapters, and future Studio share versioned domain contracts.

---

# Stage 0 — Greenfield Bootstrap

## Objective

Create a sterile v1 environment before an implementation agent sees the project.

## Deliverables

1. Tag legacy Nightshift.
2. Create orphan `v1` branch.
3. Remove inherited files.
4. Establish monorepo/package structure.
5. Create new:

   * `AGENTS.md`
   * `docs/vision.md`
   * `docs/architecture.md`
6. Establish TypeScript/tooling conventions.
7. Establish CDK app.
8. Establish CI.

The new vision explicitly supersedes the old architecture.

## Verification

Automated checks prove:

* no legacy source files exist on the v1 branch;
* no v0 program/task artifacts exist;
* no v0 configuration schema exists;
* `AGENTS.md` forbids autonomous legacy-history inspection;
* workspace builds;
* typecheck succeeds;
* lint succeeds;
* empty test suite infrastructure executes;
* `cdk synth` succeeds.

## Exit Gate

An agent receiving the v1 branch sees only the architecture described in this document.

---

# Stage 1 — Contracts and Domain Core

## Objective

Define Nightshift's enduring domain independently of AWS, MCP, or any harness.

## Deliverables

Implement versioned schemas/types for:

```text
Project
ProgramContract
Run
ExecutionNode
JobContract
Agent
Decision
Checkpoint
Verification
Examination
RoutingDecision
Artifact
Event
```

Implement pure domain rules for:

* project ownership;
* execution-tree parentage;
* scope inheritance;
* authority narrowing;
* recursion depth;
* concurrency policy;
* state transitions;
* decision authority;
* verification state.

## Verification

Unit/property tests prove:

* child nodes cannot widen parent scope;
* execution trees cannot cycle;
* jobs cannot move between projects;
* completed does not imply verified;
* verified requires verification evidence;
* illegal state transitions fail deterministically;
* depth limits are enforced;
* project IDs scope every aggregate.

No network or AWS dependency is required for these tests.

## Exit Gate

The execution/control model exists as a deterministic library.

---

# Stage 2 — AWS Control Plane

## Objective

Make centralized project/run state real before agents depend on it.

## Deliverables

CDK infrastructure for:

```text
DynamoDB
S3
control-plane API
IAM
logs/metrics
```

Implement persistence adapters.

Implement APIs sufficient to:

```text
create/read project
create/read program
create/read run

create/update execution node

append/query event

record decision
record checkpoint
record verification
record routing decision
record artifact reference

query current run state
```

Event writes use idempotency keys.

## Verification

### Infrastructure

* `cdk synth`
* CDK assertion tests
* clean deploy into dedicated development AWS account
* smoke test
* clean destroy where supported

> **Superseded by A-17 and A-18 (2026-09-13).** There is no dedicated development
> account. v1 runs in one account, `755348349819` in `us-west-2`, treated as a
> sandbox until launch. "Clean destroy" is dropped entirely: with one account and
> one user there is nothing to migrate to, so the check earns less than it costs.
> Removal policies are still declared explicitly per resource. See
> `docs/architecture.md` §2 and §7 for the authoritative wording. The rest of this
> stage's verification list stands unchanged.

### Data isolation

Create:

```text
Project A / Program X
Project B / Program X
```

Prove:

* no collisions;
* Project A queries cannot return Project B records;
* S3 object prefixes are project scoped;
* IAM/API access respects expected boundaries.

### Events

Prove:

* duplicate submissions are idempotent;
* event ordering is reconstructable;
* current state can be rebuilt from stored records;
* large output stays out of DynamoDB.

## Exit Gate

Nightshift has a centralized authoritative backend independent of agent execution.

---

# Stage 3 — Nightshift MCP + First Local Vertical Slice

## Objective

Prove the entire new product model with one delegated coding job.

Do not build routing, recursion, or remote execution yet.

## Deliverables

Build the Nightshift MCP server.

Build local execution machinery for:

```text
Job Contract
→ worktree
→ worker
→ progress
→ worker result
→ Nightshift verification
→ verified commit
→ integration
→ checkpoint
```

Use one real harness adapter initially.

The exact first adapter may be chosen during implementation, but the execution-domain code must not embed provider-specific assumptions.

## Verification

Create a fixture repository where a worker must:

1. inspect existing code;
2. implement one bounded feature;
3. modify/add tests;
4. finish.

Prove:

* delegation requires a valid Job Contract;
* central job record exists before worker starts;
* worker receives an isolated worktree;
* worker edits do not appear in program checkout before integration;
* MCP receives progress events during execution;
* worker-reported success does not mark verification green;
* intentionally failing tests block integration;
* passing tests produce a sealed commit;
* verified commit integrates into program branch;
* checkpoint follows integration;
* killing the worker leaves durable failure/interruption state.

## Exit Gate

Nightshift is usable for one real local delegation end-to-end.

This is the first meaningful product milestone.

---

# Stage 4 — Harness-Neutral Execution

## Objective

Prove Nightshift is actually independent of coding-agent harness.

## Deliverables

Finalize the harness adapter contract.

Implement:

* Claude Code adapter;
* Codex adapter;
* AgentCore Harness adapter.

Create one shared conformance suite.

## Conformance Fixture

The identical Job Contract must be executable through all three adapters.

The job must require:

* repository exploration;
* file modification;
* test modification;
* shell/tool use;
* progress reporting;
* at least one semantic decision;
* successful completion.

Also provide:

* deterministic failure fixture;
* cancellation fixture.

## Verification

Every adapter proves:

* spawn;
* identity propagation;
* Nightshift MCP access;
* progress visibility;
* decision recording;
* cancellation;
* exit/result collection;
* verification;
* artifact collection.

Tests prove no harness-specific imports reach the domain/execution scheduler above the adapter layer.

## Exit Gate

Harness choice is configuration, not architecture.

---

# Stage 5 — Parallel and Recursive Execution

## Objective

Enable frontier orchestrators to dynamically create real execution graphs.

## Deliverables

`nightshift.delegate()` supports both:

```text
job
sub-program
```

Sub-program agents receive delegation authority.

Nightshift enforces:

* max depth;
* max concurrency;
* inherited project/program identity;
* inherited permission boundaries;
* parent scope;
* budgets.

Independent work executes concurrently in independent worktrees.

Integration remains controlled by Nightshift.

## Verification

Fixture:

```text
Program
├── Job A
├── Job B
└── Sub-program C
    ├── Job C1
    └── Job C2
```

Prove:

* A and B run concurrently;
* C operates as an orchestrator;
* C1 and C2 can run concurrently;
* depth limits reject deeper delegation;
* concurrency limits queue excess jobs;
* child scope cannot widen;
* independent worktrees remain isolated;
* integration order is deterministic;
* stale-base commits are detected;
* conflicts produce explicit recovery state;
* whole-program verification catches incompatible individually-green jobs.

Benchmark forced-serial versus parallel execution on the same fixture.

## Exit Gate

Nightshift can execute recursive parallel engineering programs locally.

---

# Stage 6 — Model/Harness Routing

## Objective

Exploit cheaper models without weakening the verification contract.

## Deliverables

Implement deterministic routing.

Job metadata includes enough classification to route based on:

```text
risk
ambiguity
blast radius
scope
testability
context requirement
job type
```

Routing configuration defines eligible model/harness combinations.

AgentCore Harness provides the primary cheap/model-flexible path.

Support:

* routing rules;
* explicit model override;
* explicit harness override;
* fallback chain;
* provider restrictions;
* escalation after failure;
* model/harness availability.

Every decision is persisted.

## Verification

Table-driven tests prove routing determinism.

Real integration tests prove:

1. low-risk bounded job routes through AgentCore Harness to cheaper Bedrock model;
2. job passes verification and integrates;
3. override selects a different model;
4. unavailable model falls back correctly;
5. failed cheap model escalates;
6. final outcome records all attempted routes;
7. cost/token/timing metadata is captured where providers expose it.

## Exit Gate

Nightshift can materially substitute cheaper intelligence for frontier intelligence where appropriate.

---

# Stage 7 — Risk-Based Examination

## Objective

Apply independent scrutiny where expected failure cost warrants it.

## Deliverables

Configurable risk policy:

```text
low
medium
high
```

mapped to examination requirements.

Enforce:

* examiner differs from implementer invocation;
* policies may require different model;
* policies may require different provider;
* examination occurs against verified artifacts;
* examiner findings are evidence-backed.

The originating orchestrator receives material findings for resolution.

## Verification

Fixtures prove:

* low-risk job integrates without examiner when configured;
* medium-risk job invokes different model;
* high-risk job invokes frontier different-provider examiner;
* self-examination is rejected;
* examination findings remain attached to exact commit/diff;
* material unresolved findings prevent final acceptance when policy requires it;
* changing policy changes behavior without code changes.

## Exit Gate

"No self-grading" exists as configurable risk management rather than blanket ceremony.

---

# Stage 8 — Decision Graph and Replay

## Objective

Make autonomous decisions observable and operationally reversible.

## Deliverables

Connect:

```text
decision
→ checkpoint
→ execution outputs
→ consuming execution nodes
```

Human overrides create higher-authority decision events.

Replay computes affected execution cone.

Preserve unaffected branches/jobs.

Implement handling for:

```text
reversible
compensatable
irreversible
```

## Verification

Fixture:

```text
Job A → D-01
          ↓
       Job B
       Job C

Job D independent
```

Reverse D-01.

Nightshift must:

* invalidate B and C;
* preserve D;
* preserve historical state;
* preserve original decision;
* record human override;
* regenerate/requeue affected work;
* return to a verified state.

Tests must demonstrate no unrelated work is unnecessarily replayed.

## Exit Gate

Decision reversibility works across dynamic recursive execution, not merely static workstreams.

---

# Stage 9 — AgentCore Remote Runner

## Objective

Make Nightshift truly walk-away.

## Infrastructure

CDK provisions/configures the AgentCore runner infrastructure.

Remote model:

```text
one program run
      ↓
one AgentCore Runtime Instance
      ↓
top-level harness
      ↓
parallel worktrees / delegated agents
```

## Dispatch

```text
nightshift run --remote
```

must:

1. create central run;
2. request runner provisioning;
3. establish program workspace;
4. clone/checkout repository and program branch;
5. start configured top-level harness;
6. inject Program Contract;
7. inject Nightshift MCP credentials/identity;
8. report successful dispatch;
9. return control to caller.

No terminal attachment remains necessary.

The Studio will eventually call the same dispatch API.

## Verification

End-to-end test:

1. launch remote run;
2. receive `runId`;
3. kill local CLI process;
4. shut down initiator connection;
5. verify remote run continues;
6. top-level agent delegates multiple jobs;
7. jobs execute in parallel worktrees;
8. one cheap job uses AgentCore Harness + Bedrock model;
9. all central events remain visible;
10. program verifies;
11. program branch contains expected output;
12. runner shuts down according to policy.

Failure tests:

* provisioning failure;
* Git clone/auth failure;
* harness startup failure;
* control-plane interruption;
* MCP interruption;
* worker crash;
* runner cancellation;
* runner restart where supported;
* cleanup failure.

## Exit Gate

A user can dispatch Nightshift, close the laptop, and later inspect the completed or partial run.

---

# Stage 10 — Realtime and Analytics Surface

## Objective

Expose everything Nightshift Studio will eventually need.

Do not build the Studio itself.

## Deliverables

Realtime/event APIs sufficient to answer:

```text
What is running?
What is each agent doing?
What just completed?
What is blocked?
What failed?
What retried?
What model is being used?
What harness is being used?
What has this run cost?
Which verification is failing?
What decisions were made?
What depends on this decision?
What is the critical path?
```

Normalize analytics data for:

```text
model
provider
harness
job characteristics
tokens
cost
latency
wall time
verification outcome
examiner findings
retries
escalations
final outcome
```

This becomes the dataset for future `expected_cost_to_green` routing.

## Verification

Run a recursive parallel program.

Using **only the centralized APIs**, reconstruct:

* complete execution tree;
* chronological event history;
* active state;
* final state;
* all models/harnesses;
* verification outcomes;
* decision history;
* cost/timing summary.

Do not inspect runner-local files to reconstruct state.

Realtime subscriber must observe progress before the run finishes.

## Exit Gate

A future Studio is a UI over existing APIs rather than a new backend project.

---

# Program-Level Success Criteria

Nightshift v1 is successful when:

**SC-01** — A local Claude Code or Codex orchestrator can delegate through Nightshift without Nightshift prescribing its engineering plan.

**SC-02** — Every delegated execution is centrally identifiable and observable.

**SC-03** — All state and artifacts are project scoped.

**SC-04** — Claude Code, Codex and AgentCore Harness execute the same canonical Job Contract through a common harness abstraction.

**SC-05** — Cheap bounded jobs can execute through AgentCore Harness using lower-cost Bedrock models.

**SC-06** — Independent jobs execute concurrently in isolated Git worktrees.

**SC-07** — Sub-program orchestrators can recursively delegate within enforced limits.

**SC-08** — Agent completion never substitutes for Nightshift verification.

**SC-09** — Examination policy is configurable and can require different models/providers.

**SC-10** — Routing is deterministic, explainable and overrideable.

**SC-11** — Routing captures enough outcome data to support future learned optimization.

**SC-12** — Decisions are tied to executable checkpoints and causal descendants.

**SC-13** — Reversing a decision invalidates the minimum necessary execution cone.

**SC-14** — `--remote` execution survives termination of the initiating terminal/computer.

**SC-15** — One AgentCore Runtime Instance can host a program's top-level orchestrator plus concurrent delegated worktrees.

**SC-16** — Local and remote runs produce the same canonical control-plane model.

**SC-17** — A realtime client can observe a run while it is executing.

**SC-18** — Full run state can be reconstructed centrally without access to the runner filesystem.

---

# Non-Goals

Nightshift v1 does not:

* preserve v0 execution compatibility;
* execute historical v0 manifests;
* maintain v0 agent-role configuration;
* carry forward the v0 static author/reviewer/implementer workflow;
* solve context decay through mandatory fresh agents;
* build a proprietary general-purpose agent harness;
* build Nightshift Studio;
* implement learned model routing;
* require examination for every job;
* require remote execution;
* support an independent authoritative local database;
* spawn one cloud VM per leaf job by default;
* optimize for backwards compatibility at the expense of the new architecture.

Legacy Nightshift remains available through its tag/history.

---

# Anticipated Decisions Still to Be Made During Implementation

These were not settled in planning and should not be accidentally decided by an implementation agent.

## Control-plane HTTP/runtime implementation

The contracts and CDK boundaries are settled.

The exact AWS compute/API implementation is not yet settled.

Resolve before Stage 2 implementation.

## Realtime transport

The requirement is settled: realtime run events must be centrally consumable.

The exact transport technology is not yet selected.

Resolve before Stage 10.

## AgentCore instance sizing and lifecycle policy

One Runtime Instance per remote program is settled.

Default machine class, scaling options, idle timeout, maximum lifetime and retention are not.

Resolve during Stage 9.

## Local authentication to Nightshift MCP

Single-user/private v1 is settled.

The exact local authentication mechanism is not.

Resolve before Stage 3.

## Harness subscription authentication in remote execution

Supporting Claude Code and Codex as remote harnesses is desired.

Which subscription/login credentials may safely and legitimately be transported into ephemeral AgentCore environments versus API/Bedrock authentication must be treated as provider-specific implementation work rather than assumed.

## Git remote/integration policy

Git worktrees and Nightshift-owned commits are settled.

Exact remote push timing and whether verified leaf branches are ever pushed independently are not yet settled.

Resolve before remote execution.

---

# Development Principle

Each stage must leave behind a working, testable capability.

Do not implement three layers ahead of the currently verified execution path.

The preferred progression is:

```text
domain
  ↓
central state
  ↓
one real local job
  ↓
three harnesses
  ↓
parallel recursion
  ↓
cheap routing
  ↓
independent examination
  ↓
decision replay
  ↓
remote execution
  ↓
Studio-ready realtime data
```

The architecture should grow around observed working executions rather than abstractions invented in anticipation of them.

The first meaningful milestone is not AgentCore, routing, or recursion.

It is:

> **A local frontier orchestrator delegates one bounded coding job through Nightshift, a separate worker executes it in an isolated worktree, Nightshift independently verifies it, integrates the verified commit, and the complete lifecycle is visible in centralized state.**

Everything else builds from that invariant.
