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
│ apps/studio       the Studio: a browser client (P11)     │
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
| A-11 | Children may narrow inherited authority, never widen it | Enforced structurally in `core`, not by prompt. **Amended by A-55 (owner's ruling, 2026-10-09):** authority is delegation, depth and what an execution token reaches. A path scope is not authority: no job carries one, and nothing narrows, refuses or fails a job by the paths it changes. |
| A-12 | Examination is risk-based, not universal | Configurable policy maps risk to examiner requirements (different model / different provider). |
| A-13 | Routing optimizes cheapest path to a *verified* result | Not cheapest token. Every routing decision is persisted with its alternatives and outcome. |
| A-14 | One AgentCore **runtime instance** per remote program run. **Superseded 2026-10-01 by D-P10-12 (`p10-remote-runner.md`), ratified; recorded as A-51 when P10 closes:** one **EC2 instance** with an EBS workspace volume per remote program run, after the 2026-09-28 probe measured zero Linux capabilities on AgentCore Instances; the per-run, never-per-job half of this row stands. | Not one environment per leaf job. As understood on 2026-09-16: AgentCore Runtime's serverless sessions are isolated environments capped at eight hours and terminated after fifteen idle minutes, while a runtime instance is managed EC2 capacity that hosts many agents and a shared session, with a common filesystem, for up to fourteen days. The orchestrator and its workers are processes on one instance; the AgentCore harness worker (the vision's cheap Bedrock route) runs there too, as an exported Strands process. Built in P10. |
| A-15 | *Superseded by A-15a:* the Studio is a client, not a backend; v1 ships the data surface and not the UI | Ratified at the start of v1; the owner's restaging of 2026-09-28 (`staging.md`) brought the UI into v1 as P11. The first half stands. |
| A-15a | **The Studio is built in v1, in P11, and is a client of the control plane and nothing else** (D-P11-01 … D-P11-10). A static single-page app at `studio.<stage>.nightshift.wildorder.dev` (S3 behind CloudFront, its certificate in `us-east-1`), signed in through its own public Cognito client with PKCE, calling `api.<stage>` through the same store ports the CLI uses (`@nightshift/persistence/http/browser`) and rendering `core`'s read models (`gatherReport`, the decision graph, moved there from `execution`). It writes three things: the org's config, a project's name and description, and a human decision reversing another, built by the same `buildReversal` the CLI calls. Nothing starts, cancels or resumes a run from it. Realtime is polling the run's event cursor (resolves O-02 for v1). Artifact bodies are read through a presigned `GET` the control plane signs, its second S3 read after `plans/*`. Running it from this repository is for developing it, never a product mode. | A browser is one more client of the one control plane (A-06, A-16, A-28): every read and write is a route `authorize` already names, and the Lambda stays the only credential holder. The layer table's row for `apps/studio` is `contracts`, `core`, `persistence`. |
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

| A-25 | Nightshift reaches a project's AWS account by **assuming a role in that account**, with an external ID | The standard cross-account pattern. The account owner creates the role and controls its permissions; Nightshift stores the role ARN and external ID against the Project and calls `sts:AssumeRole` per job, receiving short-lived credentials. Nightshift never holds long-lived credentials for anyone's account. The external ID prevents the confused-deputy problem. Identical for local and remote execution, which is what keeps A-16's "same canonical model" true. It was to be expressed through `Scope.permissions`; since A-55 (2026-10-09) no job carries a scope or a permission list, so how a role reaches a job is for the program that builds A-25 to decide. |
| A-26 | Secrets are stored in DynamoDB in plaintext for now, with a stated upgrade path | An explicit, time-boxed risk decision, not an oversight. In a single-account single-user deployment anyone with read access to the table already holds admin, so the marginal exposure is small. It stops being acceptable the moment a second tenant exists or the account gains non-admin principals. Upgrade path and the distinction between kinds of secret are below. |
| A-27 | The Nightshift MCP server is a **stdio child process** of the harness that uses it, and the operating-system process boundary is its local authentication | **Resolves O-04.** The server opens no listener; whoever can spawn it is the operator. It authenticates *itself* to the control plane with the operator's Cognito session (`nightshift login`), and carries its **execution identity** (role, run, node, agent) from whoever spawned it: the operator's MCP configuration for the orchestrator, Nightshift's execution layer for a worker. Non-guarantee, stated: a worker runs as the same OS user and therefore shares the operator's control-plane identity in v1. See `docs/programs/p3-vertical-slice.md` D-P3-01. **Closed by P4 (D-P4-06, A-35); ratified 2026-09-16, built 2026-09-17:** a worker's MCP server holds only a Nightshift-issued execution token bound to its agent, and no longer reads the operator's credentials — its environment carries neither `NIGHTSHIFT_CONFIG_DIR` nor any other credential, and a worker-role server refuses to start without a token rather than falling back. The process-boundary model for spawning is unchanged. See `docs/programs/p4-identity-and-tenancy.md` §12. |
| A-28 | Local machinery reaches the control plane **only through the HTTP API**, never with AWS credentials | `@nightshift/persistence/http` implements the store ports over the API with the Cognito ID token, so `execution` depends on one port interface whichever adapter is wired. Artifact bodies go to S3 through presigned URLs the API signs; the Lambda stays the only credential holder (A-19). Keeps A-25's two credential worlds apart: an orchestrator on a laptop needs no AWS profile for Nightshift. |
| A-29 | **Nightshift owns every commit.** Workers never commit; job completion snapshots the worktree into one Nightshift-authored commit (until A-55, 2026-10-09, it also refused changes outside the node's scope; it refuses none now); sealing is `refs/nightshift/sealed/<node>`; integration is fast-forward only; checkpoints are `refs/nightshift/checkpoints/<id>`; nothing is pushed | Makes A-10 structural at the one point that matters. A non-fast-forward is a durable `stale_base` failure until P6 reconciles it (P5 before the 2026-09-16 restaging). O-06 is untouched. |
| A-30 | **Three event sources, three writers**: `mcp` from tool calls, `hook` from the adapter observing the harness process, `control-plane` from the execution layer | Sharpens §5. Hook-sourced lifecycle events must arrive without any cooperation from the worker; an adapter that cannot produce them is not conformant. Idempotency keys are deterministic per writer so replay converges (A-06). |
| A-31 | Apps are **composition roots**: one named module per app may import adapters | Amends the §1 dependency rule, which as written let nothing instantiate a harness. The intent, a harness-neutral scheduler, is preserved by keeping the ban on every package above the adapter layer. `apps/cli` may reference `core` and `persistence`; `test` may reference what its suites drive. |
| A-32 | **Starting a run is one CLI verb**, `nightshift run <contract> [--remote]` | Sharpens A-16. The first half, persist program, run, root node and initial checkpoint, is identical local and remote; the local form then prints the run id for the orchestrator's MCP server to attach to, and remote (P10, the remote-runner program) adds dispatch. Authorizing work stays a human act at a terminal, distinct from the orchestrator that does it. |
| A-33 | **Two principal kinds**: a *user* (a Cognito token, human or machine) and an *execution* (a Nightshift-issued token bound to one agent, one node and one run). The authorizer decides which; the handler receives a typed `Principal`, never a raw claim set. | P4, D-P4-01. Naming the kinds is what keeps "who is calling Nightshift" and "what a running agent may do" from being conflated again, which is how P2's single-user assumption shaped the design. Every authorisation rule in `core` is written over `Principal`. |
| A-34 | **Organisation isolation is enforced on every project-scoped route.** The caller's acting org must own the target project, or the request is refused before any record is read. Project→org is cached per function instance. | P4, D-P4-02. Retires the A-21 non-guarantee by the mechanism it described. A-23 stands: isolation lives in the application. |
| A-35 | **Execution tokens.** A worker holds a short-lived JWT signed with a Nightshift-owned asymmetric KMS key, carrying its ownership chain, node, agent and role, expiring within the cost policy's wall clock. It can read its own run and write only its own node's progress, completion, failure and decisions; `authorize` in `core` is the table. Workers never hold a human credential. | P4, D-P4-03, D-P4-05, D-P4-06. Makes A-04 something the API enforces. Closes the A-27 non-guarantee for workers; the orchestrator keeps the human's session until P10 gives remote orchestrators tokens. |
| A-36 | **The Nightshift authorizer**: one Lambda authorizer verifies either a Cognito token (pool JWKS) or an execution token (KMS public key) and passes the typed principal to the handler. Every route requires it; none is anonymous; the handler contains no verification code. | P4, D-P4-04. Amends A-19: the built-in JWT authorizer accepts one issuer, and two token kinds need either Nightshift as an OIDC issuer or one small function. The function keeps the public surface unchanged. |
| A-37 | **Adapter contract v1**: the execution layer hands every adapter the four worker operations as functions (`WorkerTools`) beside the stdio MCP launch, and adapters report `usage` on exit. One implementation of "what a completed job is" behind whichever transport a harness can use, and over either it runs as the **worker's** execution principal, never the orchestrator's. | P5, D-P5-01. Stage 4's "Nightshift MCP access" is read as "Nightshift tool access"; both local adapters still reach it through MCP, and P10's hosted MCP endpoint for remote agents is built over these same functions. |
| A-38 | **Harness and model are independent axes** chosen from a compatibility table: per harness, the providers and model families it can run and how each authenticates. A route is a compatible pair the Program Contract's policy allows; the orchestrator may request a pair and Nightshift honours it only within that intersection, recorded as an override. The human picks the orchestrator's model; Nightshift picks workers'. | P5, D-P5-04, D-P5-05. A provider is not a harness: Claude Code runs Bedrock-hosted Claude models and the AgentCore harness runs anything. P8's cost-aware policy chooses over this same table. |
| A-39 | **A worker's reach is limited by where it runs, never by a list of what it may use.** Every adapter runs its harness with permission checks bypassed: no tool allow-list, no approval policy, nothing that can stop a worker or deny it a tool nobody thought to name. Containment is the environment's job (the worktree, the execution token, the environment allowlist, Nightshift owning every commit, and from P10 a machine of the run's own). Since A-55 (2026-10-09) no path scope is enforced at commit time or anywhere else. | Owner's ruling, 2026-09-19, amending D-P3-15 and D-P5-02. The previous Nightshift arrived at the same place: an allow-list is a guess made in advance, the first miss fails a job with nobody there, and the list never ends. A deny of one family of commands (git writes) is allowed, because it cannot starve a worker. P10's runtime instance is what makes this containment real rather than trust in the operator's machine. |
| A-40 | **One engine per run, and delegation is a record.** Whoever delegates (the human's orchestrator, or a sub-program's) writes a Job Contract and a node and does nothing else. One engine, in the root orchestrator's process, starts work when a parent has a free slot, and is the only thing that starts, verifies or integrates anything. A sub-program's orchestrator holds a delegating execution token limited to the subtree under its own node and reaches the engine only through the control plane. The concurrency limit applies at the start edge, per parent, and the API enforces it there. | P6, D-P6-01 … D-P6-04. The integration queue must be single per run, so its owner must be. Going through the control plane keeps A-06 literal, costs about a second of polling, and is the shape P10 needs when the engine moves to a runtime instance and P11 needs when polling becomes a push. No P1 rule changed: P1's own per-parent count is read as "not yet" instead of "no". |
| A-41 | **Integration is a merge queue, and verification happens in it.** Workers run in parallel; per run one serial pipeline takes each `implemented` node in delegation order among what is ready, replays its snapshot onto the current program head, verifies it *there*, seals, fast-forwards and checkpoints. A stale base is recorded and rebased; a conflict fails the node with the paths and is never resolved by Nightshift; a retry runs the node again from the current head as a new attempt. | P6, D-P6-05, D-P6-06. The commit that was verified and the commit that landed are the same commit by construction, so two jobs that are each green alone and broken together cannot both integrate: that is whole-program verification on every integration, and A-05 holding by construction rather than by care. Serial verification is the price. |
| A-42 | **Planning ends where a wrong choice becomes cheap** (P7, D-P7-01). A human fixes, in a document and a contract, what would cost more than one job's work or a human to undo: outcomes, the seams (**strands**), each strand's approach at medium fidelity, the expensive decisions, and the human prerequisites. Everything else is the run's: how a strand is cut into jobs, in what order, on which model, with what retries, decided by an orchestrator with the code in front of it and recorded. A program is `planning` until a human **ratifies** it; ratification records a hash of the contract and the plan document and stores the document itself in the control plane, a run of a planned program is refused unless what is on disk matches a ratified hash, and the run's program node carries the plan it ran, so a run is reconstructable from the control plane alone (A-06). Two artifacts per program for the life of a product, `docs/programs/{id}/plan.md` and `contract.json` (and `report.md` after a run), with one home per fact. A strand is a sub-program whose Job Contract is **built from the plan**, never written by whoever delegates it: its objective opens with its plan section verbatim. The root of a planned run delegates strands and nothing else, and cannot be finished as succeeded unless every strand succeeded. |
| A-43 | **Human steps are hoisted to before the run, and only a deterministic check says they are done** (P7, D-P7-05). Planning audits every piece of work for a credential or access the crew does not hold; each hit is a prerequisite with a remediation a human can follow cold and a `verifyCommand` that exits zero iff it is done, runnable headless with what the runner holds (the crew lacks permission to *perform* it; the runner needs only to *observe* it). A program is split only when the human's step depends on an output of the run itself. Nothing but the preflight marks a prerequisite satisfied: the write carries the command's exit code and the status follows from it, no route lets anyone say "satisfied", and an execution token may read prerequisites and write none. Whether a plan is *executable* is likewise deterministic (`checkPlan`, in `core`, run by the CLI and again by the control plane at ratification), including that two strands the engine may run at once do not overlap in scope. |
| A-44 | **A run follows its plan unattended, a failure costs a cone, and a hurdle costs a check** (P7, D-P7-09, D-P7-10). `nightshift run {id}` starts a headless root orchestrator through the routed adapters, an agent like any other whose MCP server hosts the run's engine exactly as a human's session does. The engine holds a strand until the strands it depends on have succeeded. A strand that fails is **parked** with its downstream cone, named as the blocker, and everything outside the cone finishes. A verification step that **cannot run** for an unmet human prerequisite is **deferred**: every other step runs, the node is `deferred`, and its commit lands on `refs/nightshift/provisional/{run}` through the same merge queue, never on the program branch; later work is cut from the provisional head. `deferred` leads nowhere but back to `verifying` (or `cancelled`), so nothing reaches the program branch that has not passed every check on the commit that lands (A-05): claiming a hurdle buys provisional progress and nothing else. A step that ran and failed is a failure, never a deferral. `nightshift resume` runs the deferred checks over the provisional commits in order, lands what passes **unchanged**, and on a check that fails records the failure and discards what was built on it; a refused landing is no verdict and discards nothing. |
| A-45 | **The org owns routing, and a run fixes it** (P8, D-P8-02 … D-P8-07). An organisation's configuration holds a **ladder per provider** (rungs tagged `cheap`, `standard`, `frontier`, each one or more routes of harness, model and optional reasoning effort), first-match **rules** from a job's classification (risk, ambiguity, testability, kind) to a ladder and tier, a price table, and a default examination policy, stored in the control plane with a version compare-and-swap. A repository's `nightshift.config.json` and a contract may only **narrow** it (drop ladders, forbid routes, raise a minimum tier; examination is the stricter of the two, field by field); a widening is refused by name. `startRun` records the effective policy on the run and nothing changes it mid-run. No model chooses a route: an unset classification is the conservative one; a route that cannot start falls back sideways on its rung, then the **same tier on another provider's ladder**, then up, never down, and stays skipped for the run; a retry after a failure of the work **climbs one rung**, after a conflict, stale base, interrupt or unavailable route it does not. An orchestrator may pin within policy, recorded as an override. Usage says whether its cost was reported or estimated, and a spent `maxUsd` or `maxTokens` starts nothing new. | Sharpens A-13 and A-38: the cheapest path to a verified result is configuration, not code or a prompt. Every attempt is a `RoutingDecision` with its ladder, rung, rule, classification and policy version, exported by `nightshift routes export`. |
| A-46 | **Examination is beside the merge queue, by an agent of its own, and a disagreement ends in a ruling** (P8, D-P8-09 … D-P8-15). A job the run's policy says to examine is verified on its own base (a *candidate* verification, never evidence for landing) and examined there by an **examiner**: its own role and execution token, a detached checkout of the commit, the evidence and none of the builder's reasoning, on a model (and, where the policy says, a provider) the builder did not use. It may ask the builder up to three questions once, answered by resuming the builder's own session. Its verdict is bound to the commit and a **patch id** and carries through the queue only for the same change. Every finding needs evidence. Findings under an advisory policy (and minor ones always) are recorded and the work lands; under a blocking one (the default for medium and high, since 2026-09-26) a material finding fails the job, a retry is a **fix** carrying the findings, at most **two**; a dispute, or a finding standing after two fixes, goes to an **arbiter** (a fresh invocation on the highest tier, a model neither side used when there is one, otherwise a side's, and never a lower tier) whose ruling is a `Decision` with authority `agent` and a checkpoint on each side. Overturned, the examined work lands as it is; upheld, the ruling is final and carried out: the engine starts the next attempt with it as a binding instruction, examined only against it and not open to dispute, at most twice, after which it is the work's failure. The owner reverses a ruling with a superseding `human` decision (`nightshift ruling reverse`), which replays nothing until P9. | A-05 holds: examination is after verification and never instead of it. `core` refuses self-examination and an arbiter that is either side's agent, and the API refuses them again; the report counts how often an arbiter on a side's model sides with it. |
| A-47 | **A decision is reversed by correction, not replay** (P9, D-P9-01 … D-P9-08). Every decision is stamped, when the node it was made on lands, with the commits that node's work landed (`produced`, `checkpointAfter`): a job's its one commit, a strand's its subtree's after the decision, a plan decision the strands it touches. Nothing downstream is tagged. `nightshift decision reverse` records the owner's superseding decision and moves nothing; `decision brief` gathers the fork in the road (the choice, what was weighed and why each lost, what it produced, everything after); `plan-program` plans the correction with the owner into a contract naming what it `corrects`, checked and ratified as any plan, and a reversal of an irreversible or compensatable decision is flagged and confirmed by the owner before the correction runs. A broken result is retried; a changed decision is corrected: `resume` retries a check that fails and discards nothing. | The owner's reframing of Stage 8, 2026-09-27. SC-13's minimum cone is replaced: what a correction changes is the planner's judgement, ratified by the owner. |
| A-48 | **A local instance is the same control plane on one machine** (P12, D-P12-01 … D-P12-09). `nightshift local` spawns `nightshift-local`, the production handler on loopback over `@nightshift/persistence/local` (the memory store's code over `node:sqlite` tables, one file), bytes as files, a persisted RS256 key for execution tokens, and the Studio at `/` with the API under `/api`. One operator, an ordinary `User` with an ordinary `Membership`; the bearer is a secret in a file only its owner can read, and a `test-principal.` header is never accepted. Profiles are per stage (`<config>/profiles/<stage>/`, `current`), switched by `nightshift use`. The repository is Apache-2.0. | Clarifies A-06: the rule forbids two truths, not a local instance of the one plane. Authorisation runs unchanged; nothing above `persistence` learns which table is under it. The test harness is the same server over test doubles, so the offline suites prove the product. |
| A-49 | **The Studio is styled from one file** (P13, D-P13-01 … D-P13-11). shadcn/ui components live in `apps/studio/src/components/ui/`; every colour, radius, font and status tone is a CSS variable in `apps/studio/src/theme.css`, for light and dark, mapped through Tailwind's `@theme inline`; everything else uses semantic utilities or component variants, and a guard test fails a colour anywhere else. What colour a status is lives in one table, `lib/status.ts`. A program's status (`programStatus` in `core`) is one computation shown on the program card and the run's Status tab. The run graph shows a decision's recorded reach as two sets, what it produced and what was built after it, never a cause. | A restyle is an edit to one file, proven by compiling the stylesheet with a changed theme. The graph honours A-47: the record, not an inferred cone. |
| A-50 | **A program keeps why it exists, and every record reaches it by derivation** (P14, D-P14-01 … D-P14-12). A contract holds **user stories** (`US-nn`: who, what goes wrong for them today, what changes, and the human's own words), and each success criterion names the stories it `serves`; `plan check` refuses a plan without them. Which stories a strand, job, decision or commit serves is **derived** from records that already exist (`storiesOf` in `core`), never written at run time. The planning conversation is kept as `conversation.md` beside the plan: a summary labelled as the model's, and the exchanges that shaped the plan **copied word for word** from the harness's transcript (the skill chooses, the CLI copies, a harness reads). It is stored and served like the plan document, outside the plan hash. The control plane holds every quote to the bytes it stores. | The Studio and the report lead with why. No agent writes user-facing prose, so a story says what the human said. The raw transcript never leaves the planner's machine. |
| A-51 | **A remote run is one EC2 instance, its workspace on the instance's local NVMe, an EBS volume beside it as the durability sidecar, and nothing else** (P10, D-P10-12 … D-P10-27). The customer picks a tier (`good` c8id.2xlarge, `better` c8id.4xlarge, `best` c8id.8xlarge: compute-optimised x86, D-P10-26, chosen by a measured benchmark); the dispatch Lambda launches the machine from a Nightshift AMI built for both architectures and parks a one-time engine token; the runner mounts the NVMe as the workspace and the volume as the sidecar, copies the workspace to the sidecar every minute and at every exit, and restores it on a warm or replacement start (D-P10-27); the root orchestrator and every worker are processes on the machine, the engine as `engine` and each job's agent as its own `worker-N` user in a shared group, the engine handing a worktree over once and running the program's setup and verification in it as that worker (D-P10-25); a worker's token is a tmpfs file the engine keeps fresh; the heartbeat carries the generation, which fences a stale machine at the API; a lapsed lease is replaced on the same volume by the reconciler, generation plus one, up to three machines, and the replacement's root resumes the running run (D-P10-18, T6); landings are published to the program branch alone, fast-forward, through a publisher Lambda with a lease (D-P10-22); an org's provider credentials are envelope-encrypted in a table of their own and handed to a running engine on its heartbeat (D-P10-23). Supersedes A-14 for compute; the per-run, never-per-job half of A-14 stands. | The 2026-09-28 probe found AgentCore Instances unable to run Docker, browsers or a second user. EC2 gives the machine, the disk and the users; the volume gives recovery; the NVMe gives the speed the owner's integration suites need. Built and live-accepted in P10, 2026-10-01 to 2026-10-04: a program ran to a published head on a machine, survived the machine's termination mid-run, and the heavy benchmark priced the tiers. Not built, by the owner's decision of 2026-10-04: the AgentCore harness worker and Bedrock through A-25 (subscription and API-key credentials cover every live run so far), and T7's recommendation surfaces (the probe, the rule and the sampling exist; nothing shows them yet). |
| A-52 | **A run's gates are audited on its base before any agent starts** (2026-10-06, after keki-backend's playspace-time-reservations run). The audit runs the program's setup and every check **once** in a fresh checkout of the base, exactly as verification runs them. Deterministic: commands and exit codes, no model. A gate that fails is **red**: no job can pass verification on that base, so the run is not started, and there is no override. A program with committed lockfiles and no setup is told so. A check that needs an unmet prerequisite is not run. A laptop run is audited by `nightshift run` before the run exists, its output on stderr so the run id stays the first line out. A remote run is audited by its runner on its own machine, as the worker user, before the root starts, and a red base ends the run `failed` with each red gate's output on the program node; a replacement machine does not audit again. `nightshift gates {id}` runs the audit on its own. Planning keeps it (P15, D-P15-07, D-P15-08): `nightshift gates {id} --record [--findings <file>]` runs the same audit, by the same contract, and writes the project's **gate-health record** on the control plane: the commit audited, a fingerprint at it over the setup and gate commands, the lockfiles and the gate machinery the review named, the verdict (`healthy`, or `repairing` with findings, each answered by a contract decision; a red gate needs one), and who recorded it, which the control plane takes from the caller. `--recorded` runs nothing and says whether the record still holds. `plan check`, and so `plan ratify`, is READY only on a healthy record whose fingerprint matches the program branch's head, or a matching repairing one whose findings' decisions are all answered, with a gate-health strand `S-00` that every other strand depends on; not being able to read the record is a reason too. | Until a run started, nothing ran the gates under Nightshift's conditions: the first job's verification did, hours in. keki-backend lost a night to a build that failed only in reused worker worktrees. A red base fails every job for a reason none of them caused, and the human is present before the run and absent during it. One run, not two, and no override, by the owner's direction of 2026-10-06; a flaky gate is the run's to notice, not the audit's. |
| A-53 | **A new run of a ratified plan carries over the strands an earlier run of it finished** (2026-10-07, after P15's first run). When a run starts, Nightshift reads the earlier runs of the same program whose program node records the **same plan hash**, newest first. A strand that succeeded in one of them, and every commit it landed is an ancestor of the new run's base, is recorded on the run as carried (`Run.carriedStrands`: the strand, the run that built it, what it landed). A carried strand counts as succeeded for gating, `run.finish` and the report, and `strand.delegate` refuses it (`strand_carried`). The root is told at attach and in its brief. `nightshift run` prints each one after the run id. A changed plan, or a branch that no longer holds a strand's work, carries nothing of it. Deterministic: records and git, no model. | A failed run had no way on but a new run of the whole plan, which handed landed strands to orchestrators again: repeated verifications and examinations at best, landed work rebuilt and colliding with the strand being finished at worst. P15's S-01 had landed and S-02 was parked by a full machine, and nothing could start S-02 alone. The owner: "the carry-over fix seems important way beyond this one build". |
| A-54 | **An upheld ruling is the program's memory, and follows the work it was made on** (2026-10-07, after P15's run). Every upheld ruling in the program, in any of its runs, and not reversed by a human, is gathered from the records and given to each worker, orchestrator and examiner Nightshift starts, as a section of its brief: the finding, why it was upheld, the paths it cited. Workers and orchestrators are told to follow one where their work touches what it covers, and that one which does not concern the work is context, not a task. Examiners are told a change contradicting one that applies is a material finding. Whether a ruling applies is the reader's judgement, never a match on file names. As a requirement, a ruling follows only the work it was made on: a change with the same patch, or whose commits include the ruled-on commit, is examined as the ruling's own follow-up is (`followsRulings`), and its examiner must confirm it is carried out. | A ruling lived only on its job. In P15's run the same work was re-landed by another job, its examiner was never told, and it landed without the ruling. The owner: "keeping a memory of a ruling that future workers can access is critical information they need to do their job". Matching by files was rejected: two jobs with different objectives in one file are not the same work, and could reach different, correct conclusions. |
| A-55 | **Jobs carry no path scope** (owner's ruling, 2026-10-09: "give them the scope to do the job"). No Job Contract, execution node, delegation, tool input or brief names the paths a job may change, and nothing confines, refuses or fails a job (worker, sub-program orchestrator, repair, examiner checkout) for the paths it changes. A job's reach is the environment it runs in, as A-39 has it for tools. The program contract's `forbiddenActions` are rules, not paths, and every agent's brief lists them, read from the contract. Its `includes`/`excludes` and a plan's strand scopes are planning information: `plan check` holds strands inside the program and finds strands that may overlap, and a strand's brief says where the plan expects its work, as guidance. Its `permissions` are read so old contracts parse and are told to nobody. A node or Job Contract stored with a `scope` parses, with the key dropped. | A P16 job failed because three files it needed were outside its strand's scope, and its orchestrator then routed around them. A path list is the same guess an allow-list is (A-39): made in advance, wrong at the first miss, with nobody there. Amends A-11, A-25, A-29 and A-39. |

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
| ~~O-02~~ | ~~Realtime transport technology~~ | **Resolved 2026-09-28 — see A-15a (D-P11-05): polling the event cursor; a push transport is a later decision, when there are several watchers or the poll shows in the bill.** |
| ~~O-03~~ | ~~Runner instance class, scaling, idle timeout, max lifetime, retention.~~ **Resolved 2026-10-04 — see A-51:** D-P10-26 (three c8id tiers, by benchmark; D-P10-13's Graviton ladder superseded), D-P10-27 (NVMe workspace, EBS sidecar), D-P10-05 and D-P10-19 (ceilings, retention, spend). Previously answered 2026-10-01 as D-P10-13. Previously: AgentCore runtime instance class, scaling, idle timeout, max lifetime, retention. Known on 2026-09-16: instances are managed EC2 capacity chosen through a capacity provider (for example `c7g.2xlarge`), a shared session lives up to fourteen days, and pricing is EC2 plus a management fee. Still to decide: the class per program size, when an idle instance stops, the maximum lifetime, and what is retained after a run. | During P10 |
| ~~O-04~~ | ~~Local authentication between an orchestrator and the Nightshift MCP server~~ | **Resolved 2026-09-15 — see A-27.** |
| ~~O-05~~ | **Resolved 2026-10-04 — see A-51 and D-P10-23:** an org's provider credentials (an API key or a subscription token, a Codex login file) are sealed through `org providers set` and handed to a running engine on its heartbeat, placed in tmpfs for the run and copied per worker; Bedrock through A-25 was not built, by the owner's decision. Previously: **Answered in P10's plan (D-P10-03, D-P10-04; mechanisms in §4.4), ratified 2026-10-01.** Which harness subscription credentials may legitimately be transported onto an AgentCore runtime instance vs. API/Bedrock auth; and **who pays for Bedrock tokens** on the cheap route, Nightshift's account or the project's account through A-25 | Provider-specific work during P10 — never assumed |
| ~~O-06~~ | ~~Git remote/integration policy: push timing, whether verified leaf branches are ever pushed independently.~~ **Resolved 2026-10-04 — see A-51:** D-P10-01 (program branch only, fast-forward, as each head lands), built as D-P10-22's publisher and live. | **Resolved.** |

Contracts and CDK boundaries are settled; the items above are not.

## 4. Execution model

```text
Program ──┬── Job A                         ← bounded unit
          ├── Job B
          └── Sub-program C                 ← own orchestrator + delegation authority
                 ├── Job C1
                 └── Job C2
```

Nightshift enforces parent/child relationships, maximum
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

Every attempted route is recorded on the final outcome. As built in P8 (A-45):
a rung of the org's ladder per failure of the work; a route that cannot start
goes sideways, then across providers at the same tier, before it goes up.

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

Human authority is highest. **As built in P9 (A-47)**, reversing a decision does
not compute a cone or replay one: it records the human override as a
higher-authority decision, and the correction is a new plan, made with the human
from the decision's record, the commits it produced and the history since,
ratified and run like any program. Every decision is stamped with the commits its
own work landed. The original decision, its work and all history stay. (The
source plan's minimum cone was the owner's to drop, 2026-09-27: a new decision
may need changes anywhere, and only a planner reading the code can see where.)

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
