# Program P10 — Remote Runner

| Field | Value |
|-------|-------|
| Status | **Deferred by the owner, 2026-09-28. Not ratified or ready to build.** |
| Source | Stage 9, `00-source-program-plan.md`; P10 in `staging.md` |
| Depends on | P9, closed; confirm the implementation base before building |
| Outcome | Dispatch a program, close the laptop, and return to verified output or a durable account of partial work |

Nightshift v1 is planned by the human in this document, not by Nightshift's
planning tools. This draft records the settled boundaries and proposed seams;
open decisions below require the owner's answers before task specs are written.

**Deferred, 2026-09-28:** the owner prioritizes P11 and the Studio UI for visibility
into attended runs on an always-on local machine. Retain this draft and capability evidence for future remote-runner planning.
The disposable probe implementation was removed at the owner’s request. The subsequent EC2/EBS
discussion did not ratify a replacement architecture. See `staging.md` for the
updated delivery order.

**Feasibility result, 2026-09-28:** the full probe now starts after exporting its
image as Docker schema v2 instead of OCI. Ordinary Docker-in-Docker fails inside
the tested AgentCore Instances environment: the process has zero permitted,
effective and bounding Linux capabilities, `NoNewPrivs=1` and seccomp enabled;
`dockerd` is denied mount propagation and socket ownership changes. Docker-based
service tests and CDK bundling are blocked. This is a measured blocker for the
runner proposed below, not a ratified replacement architecture. Details and
recovery results are recorded at the end of this draft.

## 1. Objective and existing foundation

Run the existing execution engine, root orchestrator and concurrent workers on
one AgentCore Runtime Instance per program run. Add the AgentCore harness worker
with a Bedrock model and prove it against the existing adapter conformance suite.
The control plane remains authoritative and the CLI becomes a dispatch client.

Today `apps/cli/src/commands/run.ts` refuses `--remote`, `startRun` records local
execution and resolves the base in a local checkout, and `apps/mcp/src/headless.ts`
launches the planned root. `packages/harness-agentcore/src/index.ts` is empty.
The engine's privileged HTTP session still comes from the operator; execution
tokens cannot mint tokens, and their maximum lifetime is eight hours. Moving
that session to a server unchanged would not solve remote identity.

## 2. Settled boundaries

- One runtime instance per run, with worktrees and worker processes sharing it;
  never a hosted environment per leaf job (A-14).
- Reuse the engine, verification, examination, routing and correction machinery.
  Remote completion cannot bypass any existing landing gate.
- All records remain project/program/run scoped. No runner reads DynamoDB or S3
  records directly in place of the HTTP API.
- A worker keeps its own execution identity. No operator Cognito refresh token
  is copied to the runner. Provider authentication and Nightshift authentication
  are separate concerns.
- The same dispatch API serves the CLI and future Studio. No Studio or realtime
  transport work is included.
- CDK remains the sole infrastructure definition. Existing architecture tests
  and adapter conformance suites remain intact.

## 3. Decisions to resolve with the owner

Only decisions explicitly marked agreed have the owner's approval. The remaining
rows are proposals or questions; the program as a whole is not ratified.

| ID | Decision | Proposal / question |
|----|----------|---------------------|
| D-P10-01 | Git publication, resolving O-06 | **Agreed by the owner, 2026-09-27:** push each verified integrated head to the program branch as it lands, fast-forward only; never push worker branches, provisional work or main. Refuse concurrent branch movement and retain unpublished work. This is P10's explicit exception to A-29's no-push rule for remote execution; local behavior is unchanged. |
| D-P10-02 | Git authentication and dispatch input | **Scope, readiness and connection model agreed by the owner, 2026-09-27:** GitHub only; remote dispatch requires a clean checkout, an already-pushed program branch and a ratified plan. Bind dispatch to repository, branch, exact base SHA and ratified plan hash; refuse dirty or unpublished input. Dispatch does not create a missing remote branch or upload a local snapshot. Other Git hosts are deferred. Customers install a GitHub App on selected repositories; runners receive read-only credentials and a trusted publisher outside the worker environment holds publication credentials (§12). The detailed publication/recovery protocol still needs proof. |
| D-P10-03 | Harness authentication, O-05 | **Product requirement agreed by the owner, 2026-09-27:** support Claude Code and Codex through their subscriptions or provider API keys, plus Bedrock. The owner's reference is Zed's choice of subscription-backed ACP sessions or API keys; this does not select ACP as Nightshift's transport. Establish supported remote sign-in, credential provisioning, renewal and revocation for each mode before ratifying the implementation design. Secret storage remains open. No provider credentials in contracts, logs or general record responses. |
| D-P10-04 | Bedrock payer, O-05 | **Agreed by the owner, 2026-09-27:** bring-your-own inference for every mode. Bedrock usage is billed to the customer's AWS account, reached through A-25's role assumption with an external ID. Prove access to the selected models before dispatch. Nightshift-supplied inference and customer billing are future product work, excluded from P10 (§10). Routing records the actual provider/model and retains unknown-cost semantics. Runner infrastructure billing is a separate decision. |
| D-P10-05 | Sizing and lifecycle, O-03 | **Limits, retention and starting defaults agreed by the owner, 2026-09-27:** organization-wide ceilings for run duration, concurrency and compute spend; programs may lower these limits, never raise them. Defaults: 24 hours per run, four concurrent jobs per run, three automatic recovery attempts, seven-day recoverable workspace retention and 90-day report/verification-evidence retention. Configurable within organization ceilings. Recovery counts against the same limits and budget, without resetting either. Stop compute when work ends; retain recoverable work separately from reports and verification evidence. Initial instance class, disk capacity, compute dollar cap, spend measurement and detailed cleanup behavior remain open. Proposed: one fixed profile initially; stop compute while deferred work awaits human action. |
| D-P10-06 | Recovery promise | **Product requirement agreed by the owner, 2026-09-27:** automatically recover from runner process or instance failure and continue the authorized run without the laptop or a manual resume. A replacement must not race a stale runner or duplicate publication. Default: three recovery attempts within the original run limits (D-P10-05). Recovery protocol, detection/backoff timing, durable recovery points and treatment of uncertain external effects must be specified before build ratification. Persistent files alone do not reconstruct a running engine or harness session. |
| D-P10-07 | Remote identity | Design a run-scoped engine authority, distinct from an agent's authority, with bootstrap, renewal, cancellation and revocation. It may manage execution records and mint descendant credentials only within its authorized run; it cannot ratify plans, reverse human decisions or alter org policy. Exact principal and API design remains open. |
| D-P10-08 | Application and infrastructure seams | Proposed: runtime entrypoint and adapter composition in `apps/mcp`; lifecycle/dispatch handlers in `apps/api`; pure state rules and ports in `core`; storage adapters in `persistence`; AgentCore worker in `harness-agentcore`; infrastructure in `infra/cdk`. Ratify where the AWS lifecycle client belongs and whether a separate runner stack is warranted before adding either. |
| D-P10-09 | Supported remote program inputs | **Plan requirement agreed by the owner, 2026-09-27:** remote execution requires a ratified planned program; unplanned contracts cannot dispatch remotely. Repository toolchains, private package credentials and human prerequisite handling remain to be specified. |
| D-P10-10 | Runner ownership | **Agreed by the owner, 2026-09-27:** P10 runners run on Nightshift, in Nightshift's AWS account, managed by the service. Customers bring inference, not runner infrastructure. Private/customer-account runners are deferred (§11). Compute pricing and customer billing are not decided by this choice. |
| D-P10-11 | Runner environment | **Agreed by the owner, 2026-09-27:** no customer-supplied custom runner images in P10. Nightshift supplies the Linux environment; repository setup handles project dependencies. The project audit requires native ARM64 for FoodFly's real CDK bundling, Docker/container networking for Prempt, browser libraries, installable Node/Rust toolchains, private dependency access and substantial build storage. These capabilities must be proven, not inferred from “Linux” (§12). |

## 4. Proposed design seams

### Dispatch and lifecycle

Nightshift provisions runner compute in its own AWS account (D-P10-10).
Customer AWS role assumption for Bedrock authorizes inference only; it does not
provision a runner in the customer's account. Private runner registration and
cross-account compute provisioning are outside P10.

An authenticated request authorizes one immutable run input and durably records
dispatch intent before provisioning. A caller-supplied idempotency key resolves
retries to the same run; an uncertain response cannot launch a second engine.
The response distinguishes accepted dispatch from a ready runner. Provisioning
continues without the client connection, and failures become inspectable records.

A dispatch record carries lifecycle state separately from the existing Run
outcome: requested, provisioning, ready, stopping, stopped and failure details
are design candidates, not a ratified state table. Persist the runtime/session
identity, immutable image version, authorized base, publication head and cleanup
result. Use a lease with fencing for competing launch/recovery attempts. A stale
runner must be unable to mutate state or publish, not merely told to stop.

Cancellation works during provisioning and execution. A reconciler independent
of the runner records lost heartbeats and retries cleanup. Control-plane loss
does not authorize unverified publication; spooled events replay idempotently.

### Automatic recovery

D-P10-06 makes recovery part of the walk-away outcome. The following protocol
is proposed, pending detailed design and ratification:

- Detect failure independently of the runner; establish exclusive authority for
  the replacement and fence the old runner before continuing execution.
- Recover under the same run ID, ratified plan, fixed routing policy, budgets
  and cancellation state. A recovery attempt does not reset spending or grant
  more authority. Record each attempt and its reason centrally.
- Reconcile central records, retained Git objects, worktrees, verification and
  examination evidence, and the actual published branch. A push that succeeded
  before its acknowledgement was lost must not be treated as new work to repeat.
- Reconstruct engine and orchestrator state explicitly. Resume harness sessions
  where supported and intact; otherwise derive a replacement agent's brief from
  durable records. Finished work stays finished; incomplete work must pass the
  normal gates before landing. Infrastructure failure is not evidence that a
  more expensive model is needed.
- Stop at an ambiguous irreversible external effect rather than blindly repeat
  it. Automatic recovery cannot promise exactly-once arbitrary shell commands.
  Surface that case, exhausted recovery limits, expired authorization or missing
  credentials as an actionable interruption with retained work.

Before implementation, define what survives process loss, instance loss and
storage loss separately, along with recovery latency and attempt limits. Test
crashes at record/commit/publication boundaries and a network partition in which
the old runner returns after its replacement has acquired authority.

### Workspace, publication and retained work

Refuse CLI dispatch from a dirty checkout or an unpublished program-branch head.
The service independently checks that the requested SHA matches the GitHub
program branch and that the plan is ratified; it does not trust client readiness
claims. Checkout the authorized SHA and verify the ratified plan before launching
an agent. Branch movement cannot silently change the authorized input.
Use the existing worktree and merge queue implementation. Publication is
a separate, observable external effect: verification success does not imply a
push succeeded. Never overwrite a remote branch that moved unexpectedly.

Retain enough Git objects and refs for unpublished verified work, deferred work,
decision briefs and correction, plus verification logs, reports and transcripts.
Define an explicit retrieval/resume path before deleting a session. A checkpoint
SHA in DynamoDB is not a retained Git object. Deferred work never reaches the
published program branch. Retention expiration and cleanup failure are visible.

Under the agreed D-P10-05 retention model, stopping compute does not delete
recoverable work. Temporary workspaces and recoverable Git state have an explicit,
configurable retention period; reports and verification evidence have an
independent lifecycle and remain accessible after workspace removal. Their exact
retention defaults are seven days for recoverable workspaces and 90 days for
reports and verification evidence (D-P10-05). Retention start times and deletion
rules still need to be specified; independent retention is not indefinite retention.

### Remote identity and credentials

Bootstrap only the run named by the accepted dispatch. Renew engine authority
without the laptop and without extending the run's authorized lifetime. Bind
renewal and writes to the current lease; reject ended or cancelled runs.
Authorization tests must distinguish engine, root agent, sub-orchestrator,
worker, examiner and arbiter powers.

The provider/Git credential design must account for workers having unrestricted
tools on a shared instance. Environment filtering alone is not an OS boundary.
Choose how privileged runner credentials and Git publication are isolated from
worker processes; do not reinstate harness tool allow-lists as a substitute.

The user chooses subscription authentication, provider API keys or Bedrock where
the harness/provider combination supports it (D-P10-03). This requirement does
not assume that a local subscription session can simply be copied to a server.
Document and prove each supported remote authentication flow, including renewal
without the initiating laptop. If a provider prevents a required flow, surface
the constraint to the owner rather than silently dropping subscription support.
Changing to a separately billed authentication mode requires explicit user
authorization; route fallback alone does not authorize changing the payer.

### AgentCore harness adapter

Use the exported AgentCore harness running as a process on the program instance.
Keep provider-specific code inside its adapter. Preserve start/cancel/status,
observed lifecycle events, usage, unavailable-route reporting, session resume
for examination questions, and worker operations under the worker's identity.
The Python export and its dependencies must be pinned, packaged and exercised
with the Node runtime image. No proprietary replacement agent loop.

## 5. Acceptance criteria to refine after decisions

1. Dispatch a ratified plan, obtain a run ID, terminate the local process and
   connection, and observe the remote run continue through central records.
   Dirty checkouts, unpublished branch heads, missing remote branches and
   unratified or changed plans are refused before provisioning. A direct API
   caller cannot bypass the remote branch and ratification checks.
2. Duplicate/retried dispatch produces one run and one active engine. A second
   tenant cannot dispatch, inspect, cancel, renew or recover the first's work.
3. Multiple jobs run in parallel worktrees on one instance; a cheap job uses
   AgentCore harness with Bedrock and passes the unchanged conformance suite.
4. Only verified, appropriately examined commits publish under the selected
   policy. Stale remote heads and failed pushes preserve recoverable output.
5. Engine credentials renew across their normal expiry without a human session;
   workers cannot obtain engine or sibling authority. Cancellation fences old
   credentials and stops work within a specified bound.
6. Provisioning, clone/auth, harness startup, control-plane interruption, MCP
   interruption, worker crash, cancellation and cleanup failure each leave a
   durable explanation. Runner recovery is tested to D-P10-06's chosen promise.
7. Deferred and partial work survives compute shutdown and can be retrieved or
   resumed through the chosen workflow without bypassing verification.
8. The report distinguishes execution, publication and cleanup outcomes. Compute
   ends under the selected policy; retained storage obeys its chosen lifetime.
9. Existing local behavior and P1–P9 verification remain green.
10. Claude Code and Codex each execute remotely with subscription authentication
    and with provider API keys; the Bedrock route executes with the selected AWS
    billing identity. Credential expiry, revocation and unavailable-auth behavior
    are tested. No authentication fallback silently changes the billing mode.
11. Deliberately kill the runner process and, separately, stop its backing
    instance during a live run. The service recovers automatically under the
    same run ID and continues to verified, published output without the laptop.
    Deterministic fault tests cover lost push acknowledgements, stale runners,
    cancellation during recovery, preserved budgets and bounded recovery failure.

The live exit gate must exercise real remote infrastructure, automatic recovery
and actual Git publication in a disposable repository. A local process with mocked provisioning
does not prove walk-away execution. Whether an owner's trial gates closure is
still to be agreed.

## 6. Human prerequisites

- Ratify the decisions above and confirm the P9 base for implementation.
- Confirm AgentCore Instances availability, capacity/quota and selected instance
  type in `us-west-2` in the existing account; confirm CDK/CloudFormation support
  for the chosen resources, or ratify a CDK-owned custom resource approach.
- Establish Git access for a disposable test repository and the publication rule.
- Provision the selected provider secrets and Bedrock access in the paying account.
- Approve remote infrastructure spending limits and retention/deletion policy.

Each prerequisite needs a concrete, non-secret-printing check in the final
contract. No deployment, credential upload or paid remote run is authorized by
this planning draft.

## 7. Candidate implementation phases

| Phase | Outcome | Depends on |
|-------|---------|------------|
| T1 | Dispatch/lifecycle contracts, authorization and idempotent API, offline proofs | Ratified decisions |
| T2 | CDK resources, immutable runtime package and identity bootstrap | T1 |
| T3 | Remote headless launch, workspace, Git publication and retained-work retrieval | T1, T2 |
| T4 | AgentCore worker adapter and shared conformance | Runtime packaging and credential decisions |
| T5 | Cancellation, renewal, fencing, recovery and cleanup failure proofs | T3, T4 |
| T6 | Live walk-away fixture, regression battery, documentation and as-built | T5 |

Exact tasks, file scopes and checkpoints follow the design decisions. Each phase
must pass its checks before the next; interactive implementation pauses for
review between phases.

## 8. Verification and planning status

The implementation baseline is `npm run verify` and `npm run check:architecture`.
Retain the existing live smoke, slice, conformance, routing and correction suites.
P10 needs a new opt-in remote suite; its command and cleanup contract are not yet
defined. Ordinary `npm test` remains offline apart from loopback.

This document has no implementation or validation claims. D-P10-01, D-P10-04 and
D-P10-10 are agreed, as are D-P10-02's GitHub App connection and dispatch readiness,
D-P10-09's ratified-plan requirement, D-P10-03's authentication, D-P10-05's limits
and retention model, D-P10-06's automatic recovery product requirement and
D-P10-11's deferral of customer images are agreed.
Their mechanisms, the remaining decisions and
the overall contract await ratification. No task
specifications have been issued and no cloud resources have been changed.

## 9. Research references

Checked 2026-09-27; documentation supports design feasibility, not account readiness.

- [AWS Instances](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html): shared instance sessions, persistent volumes and lifecycle behavior.
- [AWS instance data management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-data-management.html): storage ownership and deletion.
- [AWS instance security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-security.html): session security model and permissions.
- [AWS asynchronous execution](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html): work continuing after a response and runtime health signaling; validate with Instances in the live fixture.
- [AWS harness export](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-export.html): Python/Strands export used by the planned worker.

## 10. Future feature: Nightshift-supplied inference and customer billing

Captured from the owner's direction on 2026-09-27 while choosing P10's Bedrock
payer. P10 uses the customer's subscriptions, provider API keys or AWS account
for inference. A future product may offer inference supplied by Nightshift and
bill the customer for it. This is a deferred possibility, not a v1 commitment.

That product needs its own decisions about pricing, usage metering, billing,
spending authorization and responsibility for provider charges. P10's usage
reports are not a customer billing ledger, and unknown costs remain unknown.
No automatic fallback may move a customer from their own inference to
Nightshift-paid inference without their explicit authorization. Revisit this
alongside D-P10-03, D-P10-04 and A-25 if the product is pursued; do not build
resale, prepaid balances or customer invoicing as part of remote execution.

## 11. Deferred feature: Private runners

The owner deferred private runners on 2026-09-27. A future hosted offering may
coordinate execution in a customer's own AWS account or private environment.
P10 does not implement customer runner onboarding, cross-account provisioning
or private-network connectivity. Bring-your-own Bedrock inference is separate
from this feature and remains in P10.

This deferral concerns private runners attached to the hosted service; it does
not decide the packaging or support model for a complete self-hosted open-source
deployment. Product tiers, pricing and billing remain future product decisions.

## 12. Technical proposals and feasibility findings, 2026-09-27

These proposals make the remaining choices reviewable; they are not ratified
decisions or evidence from a deployed runner.

### Standard runner and repository setup

Use a versioned Nightshift image with a pinned Linux distribution and harness
binaries. Record its digest on the run and retain that version for recovery.
Run the repository's declared setup command from the authorized commit before
agents start, recording its output and exit status. Setup must be repeatable
after recovery. Private package credentials are explicit inputs, not assumed
to follow from GitHub access. Cache dependencies by toolchain/lockfile/image
identity; never treat a cache hit as verification evidence.

Declare authorized sibling repositories with exact revisions and checkout
locations. They are read inputs by default; P10 still publishes only the primary
program branch. Prempt's stack tests motivate this requirement. Changes needing
coordinated publication across repositories are outside this proposal.

The audit evidence is local configuration, not executed builds:

| Project | Evidence | Required capability |
|---------|----------|---------------------|
| FoodFly | `yaku/foodfly/.github/workflows/deploy-dev.yml`, `infra/lib/constructs/image-optimizer.ts` | Native ARM64, Docker bundling, Node 20, workload AWS credentials |
| Keki | `keki-backend/.github/workflows/ci.yml` | Node 22, pnpm, Chromium libraries, Neon branch credentials |
| Prempt | `prempt/ACS-prempt/.github/workflows/ci.yml`, `node/src/__tests__/db/global-setup.ts` | Docker daemon/networking, Rust/Node, private sibling repositories, large build disk |
| Keyart | `keyart/.github/workflows/ci.yml`, `src/surface/scan.browser.test.ts` | Node 22.18+, real Chromium; absent Chromium skips browser coverage |

Paths above are relative to the owner's `projects/` directory and are research
references, not runtime dependencies of Nightshift.

**Unproven capability:** AWS documents Instances and persistent volumes, but its
[container configuration](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ContainerConfiguration.html)
does not expose privileged mode or a host Docker socket. That does not prove
Docker impossible; it does mean this plan cannot promise Docker yet. Prove
Prempt-style service containers and FoodFly-style ARM64 CDK bundling inside the
actual runtime, including networking, bind mounts and recovery. If that fails,
return to the owner on A-14 or the supported workload scope; do not silently
replace AgentCore or offload jobs to another execution service.

### GitHub access and publication

The owner agreed to a GitHub App with selected-repository installations. Mint renewable,
repository-scoped read credentials for checkout; keep the App private key and
publication credentials outside the environment executing repository code.
Authorize installation-to-Nightshift-org binding, rather than accepting a client
installation ID as proof of ownership. Grant sibling reads only when explicitly
declared. GitHub Packages credentials require separate treatment.

The trusted publisher needs Contents write and, for workflow-file edits,
Workflows permission. Respect branch rules; do not request administrative bypass
or weaken protection to make a push succeed. Check branch compatibility before
dispatch and report later protection changes as publication blocked.

Publication uses durable intents naming target branch, verified commit and
expected predecessor. An intent accepted under valid engine authority survives
runner replacement. Serialize publication for each repository/branch; resolve
an outstanding intent before accepting a competing successor. Keep verified
commit objects durably before accepting the intent. Reconcile lost push replies
against the actual branch. A branch advanced by an unrelated writer is a conflict,
not permission to force-push.

GitHub's ref update is not atomic with a Nightshift lease. A lease check followed
by a push is insufficient fencing. The final protocol must prove publisher
crash/retry and external branch movement behavior, including actual Git transport
predecessor checks; do not call this exactly-once publication.

Sources: [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
[App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[reference updates](https://docs.github.com/en/rest/git/refs#update-a-reference).

### Provider authentication

Keep native CLI authentication and pin an explicit billing mode for each route.
API keys can use an org/user-authorized secret reference, with Secrets Manager
proposed for storage; never mix an API key into a subscription process's
environment. Bedrock uses the customer's authorized role, with renewable
short-lived credentials. Route availability includes credential readiness.

**Claude:** [Anthropic's hosting conditions](https://code.claude.com/docs/en/legal-and-compliance)
permit hosted unmodified Claude Code with the user's own inference. They require
native sign-in and prohibit platform collection/storage/intermediation of
Claude.ai session credentials. Propose user sign-in directly to the hosted CLI,
not a Nightshift OAuth/token-upload service. How native credentials persist
through recovery without a platform-managed token vault must be validated.
Do not assume `setup-token` resolves that product boundary.

**Codex:** [official authentication guidance](https://learn.chatgpt.com/docs/auth)
documents headless device login. Its [CI auth guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
allows native refresh with preserved credentials for trusted private workflows,
but warns against concurrent reuse of the same auth file/session and use of that
CI pattern for public repositories. Propose native login on the hosted runner;
prove a supported strategy for parallel workers and recovery before promising
subscription concurrency. Copying one refresh-token cache into every worker is
not a solution. The existing Codex adapter excludes API-key auth deliberately;
P10 must explicitly implement the newly agreed mode.

Native credential expiry/revocation may still require the owner to sign in
again. Preserve work and explain why it paused; do not bill a different mode.
No authentication proof has been executed during planning.

### Engine recovery and authority

The existing engine keeps active process handles in memory and adopts queued or
validated nodes; it does not reconstruct arbitrary running jobs after a crash.
P10 therefore needs an explicit durable execution-attempt recovery protocol,
not just a process restart. Existing `Run.interrupted` is terminal. Proposed:
keep a recovering run logically running and express recovery on its dispatch
record; interrupt the run only when recovery is exhausted or cannot proceed.
Specify reconciliation for each job phase before introducing state transitions.

AWS treats the whole Instances session as one trust boundary; co-resident agents
are not isolated merely by separate containers. The plan must demonstrate how
unrestricted repository code is prevented from reading engine signing/renewal
authority or forging verification. Proposed Git publication is already outside
that boundary. A-04/A-05/A-11 are not satisfied by environment filtering alone.
Source: [Instances security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-security.html).

### Agreed defaults and remaining sizing proposals

Propose an initial native ARM64 profile with 8 vCPUs, 32 GiB RAM and 100 GiB of
persistent build storage, subject to availability and the workload proof. Select
the exact instance class and calculate its compute price before ratification.
The owner agreed to starting defaults of a 24-hour run ceiling, four concurrent
leaf jobs per run, three automatic runner recovery attempts, seven-day workspace
recovery retention and 90-day report/verification-evidence retention. These are
configurable within organization ceilings; recovery does not reset the budget.
The hardware profile above remains a proposal. Total agent concurrency,
including orchestrators and examiners, needs a
separate explicit resource bound. No unpriced compute launches under a dollar
cap: require an operator-configured price and cap, with teardown allowance.
Specify whether organization ceilings bound each run or aggregate concurrent
usage; the agreed narrowing model alone does not settle that distinction.

### Proofs required before the build contract is ready

| Proof | What must be demonstrated |
|-------|---------------------------|
| F1 | Actual Instances Docker daemon, service networking, mounts, ARM64 bundling and browser execution; repeat after recovery |
| F2 | Native Claude/Codex subscription onboarding, parallel use and recovery within documented credential boundaries; API and customer Bedrock paths |
| F3 | Worker access cannot obtain engine authority or manufacture verification; same-session trust handled explicitly |
| F4 | Publisher protocol survives lost replies, competing generations and external branch writes without unverified or duplicate integration |
| F5 | Exact CDK/CloudFormation resource support, instance class, account quota, price and lifecycle controls |

These are planning blockers to a fully executable contract, not grounds for
silently narrowing the agreed product. A paid feasibility deployment requires a
separately scoped, reviewable experiment and spending authorization. The owner
authorized the prepared experiment on 2026-09-27; its two attempts provisioned
successfully but failed during the initial container download, before diagnostics.

The disposable F1 capability probe used a separate CDK app and runner script.
It was designed to test Docker, service networking, bind mounts, ARM64 bundling
and sandboxed Chromium twice, retaining a storage marker across actual
managed-instance replacement. Its implementation was removed when P10 was
deferred; the experimental observations and raw first-pass evidence remain here. Preparing and validating
this test locally does not satisfy F1. Both cloud attempts returned
`RuntimeClientError: The agent artifact could not be downloaded. Verify the
artifact URI is accessible and retry.` The second attempt's runtime log group
contained no events. CloudTrail recorded runtime-role image-manifest and
layer-download-URL requests without an error code. The image was a single OCI
manifest with gzip layers. These observations do not identify the download
failure's root cause and do not demonstrate any restriction on nested Docker.
F1 remains unproven; successful provisioning is only partial evidence for F5.

Local evidence directories: `/tmp/nightshift-agentcore-live-20260927` and
`/tmp/nightshift-agentcore-retry-20260927`. Each holds the deployment identifiers,
failure and cleanup record; the retry also captured startup logs. The probe was updated to capture those logs before teardown when an invocation fails. Repository
verification passed: 144 test files, 3,118 tests passed and two skipped; build,
type-check, lint, synthesis and sterility checks passed.
Both cleanup records report no failures: the sessions and dedicated stacks were
deleted, managed-instance termination was checked and the probe image tag was
removed. A final CloudFormation lookup confirmed the retry stack no longer exists.

The owner then authorized a minimal-image control. The `run-minimal` variant deployed the same
infrastructure with the same `node:22-bookworm-slim` base and only a built-in HTTP
server: no Docker, Chromium, CDK or npm dependencies. Both endpoints passed in a
local ARM64 container. A synthesis test confirmed that only the image changes.
The cloud control failed with the identical artifact-download error, before the
server started; the runtime log group was empty and the EC2 boot console showed
no matching download/error messages. This excludes the added packages as a
necessary cause, but does not isolate the shared base image/packaging from the
AWS image-loading path. Evidence is in
`/tmp/nightshift-agentcore-minimal-20260927`; the boot console was saved separately
as `/tmp/nightshift-agentcore-minimal-console.json`. Repository verification
passed again: 144 files, 3,119 tests passed and two skipped, plus all other checks.
The minimal control's cleanup record reports no failures: its session, stack
and image tag were removed and managed-instance termination was checked.

### Completed Docker capability test — 2026-09-28

The owner asked to get past startup and reach the test. Exporting the same full
probe with CDK DockerImageAsset `outputs: ["type=docker,oci-mediatypes=false"]`
changed the ECR manifest from `application/vnd.oci.image.manifest.v1+json` to
`application/vnd.docker.distribution.manifest.v2+json`. The full probe then
started on AgentCore Instances. This resolves the packaging failure for this
experiment; it is not evidence that all OCI images fail in every AgentCore mode.
No IAM expansion, host socket or privileged-container workaround was used.

The [raw first-pass evidence](p10-agentcore-capability-evidence.json) records:

- ARM64 execution and the mounted `/mnt/workspace` volume passed.
- UID and GID were 0, but all Linux capability sets were zero, with
  `NoNewPrivs: 1` and `Seccomp: 2`.
- Ordinary `dockerd` failed: mount propagation returned `operation not permitted`,
  then changing ownership of its Unix socket returned `operation not permitted`.
- PostgreSQL container networking/bind mounts and CDK Docker bundling were blocked
  because the Docker daemon was unavailable.
- The browser attempt failed at `runuser: cannot set groups: Operation not permitted`.
  Chromium itself was not reached; this does not prove all browser configurations fail.
- A persistent marker was written successfully. After stopping the runtime, AWS's
  idle policy stopped the same EC2 instance instead of terminating it. The local
  waiter was ended and explicit cleanup invoked. No second pass or replacement
  proof was collected. The probe was updated to recognize either shutdown state, while
  retaining its strict requirement for a different instance ID to prove replacement.

**Conclusion:** ordinary Docker-in-Docker is unavailable in the tested Instances
configuration. F1 fails for the proposed Docker-dependent runner. Rootless or
externally hosted Docker was not tested, and no alternative architecture is
ratified by this result. Local run evidence is at
`/tmp/nightshift-agentcore-dockerformat-20260928`.
Explicit cleanup completed with no reported failures: the session and dedicated
stack were deleted, managed-instance termination was checked, and the recorded
probe image tag was removed from ECR.
