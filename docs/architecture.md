# Nightshift v1 — Architecture

> Companion to `docs/vision.md`. This document records the settled architectural
> decisions for v1 and the boundaries implementation must respect. Full stage
> detail lives in `docs/programs/00-source-program-plan.md`; the program
> breakdown lives in `docs/programs/staging.md`.

## 1. Layering

```text
┌──────────────────────────────────────────────────────────┐
│ apps/cli          CLI: nightshift run / run --remote     │
│ apps/mcp          Nightshift MCP server                  │
│ apps/api          control-plane HTTP/runtime             │
│ apps/studio       reserved — not built in v1             │
├──────────────────────────────────────────────────────────┤
│ packages/routing        model + harness selection        │
│ packages/verification   deterministic verification       │
│ packages/execution      scheduling, worktrees, integrate │
├──────────────────────────────────────────────────────────┤
│ packages/harness        adapter contract (no providers)  │
│ packages/harness-claude │ -codex │ -agentcore            │
├──────────────────────────────────────────────────────────┤
│ packages/persistence    DynamoDB + S3 adapters           │
├──────────────────────────────────────────────────────────┤
│ packages/core           pure domain rules                │
│ packages/contracts      versioned schemas and types      │
├──────────────────────────────────────────────────────────┤
│ infra/cdk               AWS CDK v2 — sole IaC system     │
└──────────────────────────────────────────────────────────┘
```

**Dependency rule.** Dependencies point downward only.

- `contracts` and `core` depend on nothing outside themselves. No AWS SDK, no MCP
  SDK, no harness import, no network. Their tests run offline.
- `persistence` is the only layer that may import the AWS SDK for data access.
- Provider-specific imports live **only** inside a `harness-*` package. The
  execution scheduler and everything above the adapter layer must contain no
  harness-specific import. This is enforced by test, not by convention.
- `infra/cdk` is production code and carries the same testing requirements as
  application code.

## 2. Settled decisions

| # | Decision | Consequence |
|---|----------|-------------|
| A-01 | v1 is greenfield on an orphan branch | No v0 code, config schema, manifest, or directive is carried forward. Agents must not inspect legacy refs. |
| A-02 | The orchestrator owns the engineering plan; Nightshift owns the control plane | Nightshift never prescribes decomposition or reasoning workflow. |
| A-03 | Delegation goes through `nightshift.delegate()` | The orchestrator never directly spawns a Nightshift worker. Contracts are validated and persisted *before* execution. |
| A-04 | No execution without a Nightshift execution identity | Untracked delegated work is a defect, not a degraded mode. |
| A-05 | `implemented ≠ verified` | Worker completion and Nightshift verification are separate states. Only Nightshift asserts the second. Unverified work never integrates. |
| A-06 | One authoritative control plane | No independent local canonical state. The local spool is a buffer, not a store. |
| A-07 | Every record is project scoped | `projectId` / `programId` / `runId` form the ownership chain on every aggregate. |
| A-08 | DynamoDB for structured state, S3 for artifacts | Large output never lands in DynamoDB; DynamoDB holds metadata and references. |
| A-09 | AWS CDK v2 (TypeScript) is the sole IaC system | No SST, Terraform, or Pulumi alongside it without an explicit superseding decision. |
| A-10 | One isolated Git worktree per delegated coding job | Concurrency is safe by construction; integration into the program branch is serialized by Nightshift. |
| A-11 | Children may narrow inherited authority, never widen it | Enforced structurally in `core`, not by prompt. |
| A-12 | Examination is risk-based, not universal | Configurable policy maps risk to examiner requirements (different model / different provider). |
| A-13 | Routing optimizes cheapest path to a *verified* result | Not cheapest token. Every routing decision is persisted with its alternatives and outcome. |
| A-14 | One AgentCore Runtime Instance per remote program run | Not one VM per leaf job. |
| A-15 | The Studio is a client, not a backend | v1 ships the data surface; the UI is out of scope. |
| A-16 | The CLI lives in `apps/cli` and is a thin client | It calls the same control-plane and dispatch APIs a future Studio will call. No domain, routing, or execution logic lives in the CLI. |
| A-17 | v1 runs in **one** AWS account, `755348349819` (`nightshift-prod`), in `us-west-2` | Deliberate single-account start. The account is treated as a sandbox until Nightshift is launched and supported; a separate development account arrives only if and when that happens. Nothing in v1 may assume a second account exists. |
| A-18 | v1 does not verify teardown | The persistent stack is never destroyed to satisfy a test, and no throwaway stack is deployed to prove `destroy` works. With one account and one user there is nothing to migrate to, so the check earns less than it costs. Removal policies are still set **explicitly** per resource so retention is chosen rather than inherited from a default. Revisit if a second environment is ever stood up. |

## 3. Open decisions

Deliberately unsettled. An implementation agent must **not** decide these
silently — surface them as decisions for human ratification at the stated point.

| # | Question | Resolve by |
|---|----------|-----------|
| O-01 | Control-plane HTTP/runtime implementation: the exact AWS compute/API shape **and** how its clients (local MCP server, CLI, remote runner) authenticate to it | Before Stage 2 implementation (P2) |
| O-02 | Realtime transport technology | Before Stage 10 |
| O-03 | AgentCore instance class, scaling, idle timeout, max lifetime, retention | During Stage 9 |
| O-04 | Local authentication between an orchestrator and the Nightshift MCP server (client-to-control-plane auth belongs to O-01) | Before Stage 3 (P3) |
| O-05 | Which harness subscription credentials may legitimately be transported into ephemeral AgentCore environments vs. API/Bedrock auth | Provider-specific work during Stage 9 — never assumed |
| O-06 | Git remote/integration policy: push timing, whether verified leaf branches are ever pushed independently | Before remote execution |

Contracts and CDK boundaries are settled; the items above are not.

## 4. Execution model

```text
Program ──┬── Job A                         ← bounded unit
          ├── Job B
          └── Sub-program C                 ← own orchestrator + delegation authority
                 ├── Job C1
                 └── Job C2
```

Nightshift enforces parent/child relationships, inherited scope, maximum
delegation depth, maximum concurrency, model/provider policy, resource budgets,
execution location, and project isolation.

### Job lifecycle

```text
Job Contract ─validated→ persisted ─→ worktree ─→ worker ─→ progress events
     → worker result (claimed)
     → Nightshift verification (authoritative)
     → [risk policy] examination
     → sealed commit
     → serialized integration
     → program verification
     → checkpoint
```

A commit that was green against an outdated base is not automatically accepted
once other jobs integrate. Stale bases must be detected and rebased, reconciled,
and reverified. Individually green jobs may still be collectively incompatible —
program-level verification exists to catch exactly that.

Killing a worker must leave durable failure/interruption state, never silence.

### Escalation

```text
cheap worker ──fail──→ stronger worker ──fail──→ frontier orchestrator
```

Every attempted route is recorded on the final outcome.

## 5. Observability: MCP vs. hooks

Two channels, deliberately redundant.

- **MCP carries intent.** Semantic actions the agent takes on purpose: delegate,
  progress, complete, fail, record a decision, request verification.
- **Hooks carry ground truth.** Lifecycle facts that must not depend on agent
  compliance: agent created/started/completed/failed/cancelled, tool
  called/completed, subagent created, checkpoint created, context compacted.

Use both wherever the harness supports it. An agent that neglects to report is an
observability gap MCP alone cannot close.

## 6. Decisions and replay

A decision records its context, alternatives, choice, rationale, reversibility
class, and the checkpoints bracketing it. Execution nodes consuming
decision-dependent output establish causal edges.

Human authority is highest. Reversing a decision computes the **smallest affected
execution cone**, invalidates only dependent work, preserves unrelated work and
all history, records the human override as a higher-authority event, and schedules
replay from a durably addressable Git state.

Reversibility classes are honest: `reversible`, `compensatable`, `irreversible`.
An irreversible external effect is never described as reversible.

## 7. Testing posture

- `contracts` / `core`: unit and property tests, offline, no AWS.
- `persistence` / `api`: CDK assertion tests, plus deploy → smoke against the
  single v1 account (A-17). Project-isolation tests must prove Project A queries
  cannot return Project B records.

  No teardown verification in v1 (A-18). Every stateful resource still declares
  its removal policy explicitly, because CDK defaults some of them to `RETAIN`
  and an unstated policy is one nobody chose. Stacks holding state carry
  termination protection.
- `harness-*`: one shared conformance suite. The same Job Contract must execute
  through every adapter, plus a deterministic failure fixture and a cancellation
  fixture.
- `execution`: fixture repositories exercising real delegation, real worktrees,
  real verification, stale-base detection, and concurrency.
- Architecture tests: no harness-specific import above the adapter layer; no AWS
  import in `contracts` or `core`.
