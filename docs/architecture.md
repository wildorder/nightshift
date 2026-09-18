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
  **Amended by A-31 (P3):** each app has one named composition module that may
  instantiate adapters; that module is the only exception, and `execution`,
  `routing`, `verification`, `core` and `contracts` have none.
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
| A-14 | One AgentCore **runtime instance** per remote program run | Not one environment per leaf job. As understood on 2026-09-16: AgentCore Runtime's serverless sessions are isolated environments capped at eight hours and terminated after fifteen idle minutes, while a runtime instance is managed EC2 capacity that hosts many agents and a shared session, with a common filesystem, for up to fourteen days. The orchestrator and its workers are processes on one instance; the AgentCore harness worker (the vision's cheap Bedrock route) runs there too, as an exported Strands process. Built in P9. |
| A-15 | The Studio is a client, not a backend | v1 ships the data surface; the UI is out of scope. |
| A-16 | The CLI lives in `apps/cli` and is a thin client | It calls the same control-plane and dispatch APIs a future Studio will call. No domain, routing, or execution logic lives in the CLI. |
| A-17 | v1 runs in **one** AWS account, `755348349819` (`nightshift-prod`), in `us-west-2` | Deliberate single-account start. The account is treated as a sandbox until Nightshift is launched and supported; a separate development account arrives only if and when that happens. Nothing in v1 may assume a second account exists. |
| A-18 | v1 does not verify teardown | The persistent stack is never destroyed to satisfy a test, and no throwaway stack is deployed to prove `destroy` works. With one account and one user there is nothing to migrate to, so the check earns less than it costs. Removal policies are still set **explicitly** per resource so retention is chosen rather than inherited from a default. Revisit if a second environment is ever stood up. |
| A-19 | The control plane is a Lambda behind an API Gateway HTTP API, authenticated by a **Cognito JWT authorizer** | **Resolves O-01.** Supersedes the original IAM SigV4 form (see A-19a). The gateway validates the token and rejects bad requests before the function runs, so there is still no authentication code in the handler. The Lambda remains the entire API and the only holder of DynamoDB and S3 credentials. Tenancy comes from a claim in the validated token — never from the URL, and never from which AWS profile the caller happens to hold. **Amended by P4 (D-P4-04, A-36); ratified 2026-09-16, built 2026-09-17:** the built-in authorizer accepts one issuer, and P4 introduced a second token kind, Nightshift-issued execution tokens for agents. It is replaced by a Nightshift Lambda authorizer that verifies either kind and hands the handler a typed principal. The gateway still rejects before the handler runs, and the handler still contains no verification code; the verifying code is now Nightshift's, in one function. One behaviour moved: API Gateway answers 401 when the `Authorization` header is absent and 403 when the authorizer denies, where the JWT authorizer gave 401 for both. See `docs/programs/p4-identity-and-tenancy.md` §12. |
| A-19a | *Superseded:* IAM SigV4 authentication | Ratified 2026-09-13, reversed 2026-09-14 before implementation. SigV4 requires every caller to hold an IAM identity **in the Nightshift account**. Workable for one internal user, fatal for distribution: it would mean issuing IAM users to customers. It also forced the operator to juggle a Nightshift profile alongside the client-account credentials they were already using. Recorded rather than deleted because the reasoning that made it attractive — no auth code in the handler — is preserved by the JWT authorizer, and a future reader should know the trade was examined. |
| A-20 | One DynamoDB table with one GSI, and one S3 bucket | Every access pattern is prefixed by the ownership chain, so a second table buys nothing. `PK` always begins with `projectId`, which makes a cross-project query structurally impossible rather than merely forbidden. See `docs/programs/p2-control-plane.md` for the key schema. |
| A-21 | A project belongs to an **organisation**; the ownership chain is unchanged | `Project` carries `orgId` and an `ORG#` partition lists an org's projects. `orgId` is deliberately *not* added to the chain on every aggregate: `projectId` is a globally unique ULID, so project-scoped items need no org prefix to be unambiguous. **v1 provides org labelling, not org separation** — see the non-guarantee below. |
| A-22 | Event sequence numbers are assigned **after** durability, by a DynamoDB Streams consumer | An event is written synchronously with its ULID as the sort key, so the writer gets durability and an identifier immediately. A stream consumer, ordered and single-threaded per run partition, then stamps a dense `sequence`. A crash cannot burn a number, because numbering happens after the record is durable and the consumer resumes from its last committed position. The cost is a brief window in which an event is durable but unnumbered, so every reader must tolerate an absent `sequence`. |
| A-23 | **Project** isolation is enforced in the application, not in IAM | Single user in v1, and per-tenant IAM identities are not how multi-tenant products are usually built. Isolation lives in one place: the Lambda. This is what A-21's light org scoping depends on; if IAM ever becomes the tenant boundary, A-21 has to be revisited first. |
| A-24 | Infrastructure is split into a stateful stack and a stateless stack | The data stack holds DynamoDB and S3, carries termination protection, and changes rarely. The API stack holds the function, the API and the stream consumer, and can be replaced freely. With one account (A-17) that separation is the only thing standing between a bad deploy and the data. |

| A-25 | Nightshift reaches a project's AWS account by **assuming a role in that account**, with an external ID | The standard cross-account pattern. The account owner creates the role and controls its permissions; Nightshift stores the role ARN and external ID against the Project and calls `sts:AssumeRole` per job, receiving short-lived credentials. Nightshift never holds long-lived credentials for anyone's account. The external ID prevents the confused-deputy problem. Identical for local and remote execution, which is what keeps A-16's "same canonical model" true. Expressed through `Scope.permissions`, so A-11's narrowing applies for free: a child may be granted fewer assumable roles than its parent and structurally cannot widen. |
| A-26 | Secrets are stored in DynamoDB in plaintext for now, with a stated upgrade path | An explicit, time-boxed risk decision, not an oversight. In a single-account single-user deployment anyone with read access to the table already holds admin, so the marginal exposure is small. It stops being acceptable the moment a second tenant exists or the account gains non-admin principals. Upgrade path and the distinction between kinds of secret are below. |
| A-27 | The Nightshift MCP server is a **stdio child process** of the harness that uses it, and the operating-system process boundary is its local authentication | **Resolves O-04.** The server opens no listener; whoever can spawn it is the operator. It authenticates *itself* to the control plane with the operator's Cognito session (`nightshift login`), and carries its **execution identity** (role, run, node, agent) from whoever spawned it: the operator's MCP configuration for the orchestrator, Nightshift's execution layer for a worker. Non-guarantee, stated: a worker runs as the same OS user and therefore shares the operator's control-plane identity in v1. See `docs/programs/p3-vertical-slice.md` D-P3-01. **Closed by P4 (D-P4-06, A-35); ratified 2026-09-16, built 2026-09-17:** a worker's MCP server holds only a Nightshift-issued execution token bound to its agent, and no longer reads the operator's credentials — its environment carries neither `NIGHTSHIFT_CONFIG_DIR` nor any other credential, and a worker-role server refuses to start without a token rather than falling back. The process-boundary model for spawning is unchanged. See `docs/programs/p4-identity-and-tenancy.md` §12. |
| A-28 | Local machinery reaches the control plane **only through the HTTP API**, never with AWS credentials | `@nightshift/persistence/http` implements the store ports over the API with the Cognito ID token, so `execution` depends on one port interface whichever adapter is wired. Artifact bodies go to S3 through presigned URLs the API signs; the Lambda stays the only credential holder (A-19). Keeps A-25's two credential worlds apart: an orchestrator on a laptop needs no AWS profile for Nightshift. |
| A-29 | **Nightshift owns every commit.** Workers never commit; job completion snapshots the worktree into one Nightshift-authored commit and refuses changes outside the effective scope; sealing is `refs/nightshift/sealed/<node>`; integration is fast-forward only; checkpoints are `refs/nightshift/checkpoints/<id>`; nothing is pushed | Makes A-10 and A-11 structural at the one point that matters. A non-fast-forward is a durable `stale_base` failure until P6 reconciles it (P5 before the 2026-09-16 restaging). O-06 is untouched. |
| A-30 | **Three event sources, three writers**: `mcp` from tool calls, `hook` from the adapter observing the harness process, `control-plane` from the execution layer | Sharpens §5. Hook-sourced lifecycle events must arrive without any cooperation from the worker; an adapter that cannot produce them is not conformant. Idempotency keys are deterministic per writer so replay converges (A-06). |
| A-31 | Apps are **composition roots**: one named module per app may import adapters | Amends the §1 dependency rule, which as written let nothing instantiate a harness. The intent, a harness-neutral scheduler, is preserved by keeping the ban on every package above the adapter layer. `apps/cli` may reference `core` and `persistence`; `test` may reference what its suites drive. |
| A-32 | **Starting a run is one CLI verb**, `nightshift run <contract> [--remote]` | Sharpens A-16. The first half, persist program, run, root node and initial checkpoint, is identical local and remote; the local form then prints the run id for the orchestrator's MCP server to attach to, and remote (P9, the remote-runner program) adds dispatch. Authorizing work stays a human act at a terminal, distinct from the orchestrator that does it. |
| A-33 | **Two principal kinds**: a *user* (a Cognito token, human or machine) and an *execution* (a Nightshift-issued token bound to one agent, one node and one run). The authorizer decides which; the handler receives a typed `Principal`, never a raw claim set. | P4, D-P4-01. Naming the kinds is what keeps "who is calling Nightshift" and "what a running agent may do" from being conflated again, which is how P2's single-user assumption shaped the design. Every authorisation rule in `core` is written over `Principal`. |
| A-34 | **Organisation isolation is enforced on every project-scoped route.** The caller's acting org must own the target project, or the request is refused before any record is read. Project→org is cached per function instance. | P4, D-P4-02. Retires the A-21 non-guarantee by the mechanism it described. A-23 stands: isolation lives in the application. |
| A-35 | **Execution tokens.** A worker holds a short-lived JWT signed with a Nightshift-owned asymmetric KMS key, carrying its ownership chain, node, agent and role, expiring within the cost policy's wall clock. It can read its own run and write only its own node's progress, completion, failure and decisions; `authorize` in `core` is the table. Workers never hold a human credential. | P4, D-P4-03, D-P4-05, D-P4-06. Makes A-04 something the API enforces. Closes the A-27 non-guarantee for workers; the orchestrator keeps the human's session until P9 gives remote orchestrators tokens. |
| A-36 | **The Nightshift authorizer**: one Lambda authorizer verifies either a Cognito token (pool JWKS) or an execution token (KMS public key) and passes the typed principal to the handler. Every route requires it; none is anonymous; the handler contains no verification code. | P4, D-P4-04. Amends A-19: the built-in JWT authorizer accepts one issuer, and two token kinds need either Nightshift as an OIDC issuer or one small function. The function keeps the public surface unchanged. |
| A-37 | **Adapter contract v1**: the execution layer hands every adapter the four worker operations as functions (`WorkerTools`) beside the stdio MCP launch, and adapters report `usage` on exit. One implementation of "what a completed job is" behind whichever transport a harness can use. | P5, D-P5-01. Stage 4's "Nightshift MCP access" is read as "Nightshift tool access"; both local adapters still reach it through MCP, and P9's hosted MCP endpoint for remote agents is built over these same functions. |
| A-38 | **Harness and model are independent axes** chosen from a compatibility table: per harness, the providers and model families it can run and how each authenticates. A route is a compatible pair the Program Contract's policy allows; the orchestrator may request a pair and Nightshift honours it only within that intersection, recorded as an override. The human picks the orchestrator's model; Nightshift picks workers'. | P5, D-P5-04, D-P5-05. A provider is not a harness: Claude Code runs Bedrock-hosted Claude models and the AgentCore harness runs anything. P7's cost-aware policy chooses over this same table. |

### A-25 / A-26: the two credential worlds, and where secrets live

**Two unrelated uses of AWS credentials.** Conflating them is the most likely way
to get this wrong, so they are named separately.

- **Control-plane credentials** answer *who is calling Nightshift*. Under A-19
  these are no longer AWS credentials at all — they are a Cognito token. Which
  AWS profiles a user holds is irrelevant to the control plane.
- **Workload credentials** answer *what a job may do inside a project's account*.
  These come from A-25's role assumption, are short-lived, and are scoped by a
  policy the account owner wrote. The control plane never sees them.

A **Nightshift organisation is not an AWS Organization.** The collision is
accidental and it is a genuine trap: an operator may hold credentials in several
unrelated AWS Organizations while working under a single Nightshift org, or work
under several Nightshift orgs from one AWS identity. Nothing maps between them.

**Kinds of secret, and where each belongs.**

| Kind | Count | Sensitivity | Now | Later |
|------|-------|-------------|-----|-------|
| Cross-account external IDs | one per project | AWS states an external ID is *not* a secret; it must simply be unpredictable | DynamoDB, plaintext | unchanged, or encrypted with the rest |
| Provider API keys (O-05) | a handful | genuinely secret | DynamoDB, plaintext (A-26) | **Secrets Manager** — few enough that per-secret cost is trivial, and rotation comes free |
| Per-project sensitive attributes | many | varies | DynamoDB, plaintext (A-26) | **AWS Database Encryption SDK** for DynamoDB |

On the upgrade path: hand-rolled `kms:Encrypt` on a field works, but the AWS
Database Encryption SDK for DynamoDB is the better tool for the many-items case.
It does envelope encryption per item, caches data keys so KMS cost stays flat,
and binds the ciphertext to the item's primary key as additional authenticated
data — so a ciphertext cannot be lifted from one item and replayed into another.
That last property is the one a hand-rolled `kms:Encrypt` usually misses.
DynamoDB's encryption at rest is already on by default; the concern A-26 defers is
readability from the console and by any principal with table read access, which
client-side encryption is what actually addresses.

### A-21 non-guarantee: orgs are a label, not a boundary

> **Closed by P4 (D-P4-02, A-34); ratified 2026-09-16, built 2026-09-17.** Org isolation is
> enforced on every project-scoped route by the mechanism this section
> describes: resolve the caller's org, load the project through a cache, refuse
> a mismatch — with one correction, that the cache never remembers a *miss*,
> because doing so would leave a newly created project invisible to the check.
> Proven live by two principals in two organisations across all forty
> project-scoped routes (`docs/programs/p4-identity-and-tenancy.md` §12.4). The
> text below is kept as the record of what was true through P3 and why.

v1 does not enforce organisation separation anywhere. `Project.orgId` and
`listByOrg` support *grouping* — filtering is not authorisation. Nothing maps a
caller to an organisation, so any principal able to sign a request can read any
project in any org. With one user and one org that is the right amount of work,
but the label must not be mistaken for a fence.

When separation is needed it belongs in the API handler (A-19, A-23): resolve the
caller's principal to an org, then verify the target project belongs to it, on
every request.

**The cost this defers.** A-21's light shape makes *retrofitting the data* cheap —
an attribute, not a key migration. It makes *enforcement* more expensive, and that
trade was not stated when the decision was taken. Because `orgId` lives only on
`Project`, authorising a run-scoped request requires resolving
`projectId` → project → `orgId` first, which is an extra read per request. Had
`orgId` been in the partition key, the check would be free. Workable when the time
comes — cache the mapping, or denormalise `orgId` onto records at write time,
which is still an attribute plus a backfill rather than a key change — but it is a
real cost, and it is the reason to revisit A-21 before building anything
multi-tenant rather than after.

## 3. Open decisions

Deliberately unsettled. An implementation agent must **not** decide these
silently — surface them as decisions for human ratification at the stated point.

| # | Question | Resolve by |
|---|----------|-----------|
| ~~O-01~~ | ~~Control-plane HTTP/runtime implementation and client authentication~~ | **Resolved 2026-09-13 — see A-19.** |
| O-02 | Realtime transport technology | Before Stage 10 |
| O-03 | AgentCore runtime instance class, scaling, idle timeout, max lifetime, retention. Known on 2026-09-16: instances are managed EC2 capacity chosen through a capacity provider (for example `c7g.2xlarge`), a shared session lives up to fourteen days, and pricing is EC2 plus a management fee. Still to decide: the class per program size, when an idle instance stops, the maximum lifetime, and what is retained after a run. | During P9 |
| ~~O-04~~ | ~~Local authentication between an orchestrator and the Nightshift MCP server~~ | **Resolved 2026-09-15 — see A-27.** |
| O-05 | Which harness subscription credentials may legitimately be transported onto an AgentCore runtime instance vs. API/Bedrock auth; and **who pays for Bedrock tokens** on the cheap route, Nightshift's account or the project's account through A-25 | Provider-specific work during P9 — never assumed |
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
  real verification, stale-base detection, and concurrency. From P3, `npm test`
  carries the offline slice suite: the real MCP server over stdio, a scripted
  worker process, real git, and the production API handler on loopback over the
  in-memory stores. Only the LLM is scripted; the real-harness run is opt-in.
- Architecture tests: no harness-specific import above the adapter layer except
  in each app's named composition module (A-31); no AWS import in `contracts` or
  `core`.
