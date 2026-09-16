# Program P3 — First Vertical Slice

| Field | Value |
|-------|-------|
| Program ID | `p3-vertical-slice` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p3-vertical-slice` |
| Source stage | Stage 3 (Nightshift MCP + First Local Vertical Slice) |
| Status | **Contract ratified 2026-09-15** (D-P3-01 … D-P3-17). Tasks T1 … T10 drafted. Implementation not started. |
| Depends on | P1 Foundation (complete), P2 Control Plane (deployed 2026-09-15) |
| Blocking decision | **O-04** local authentication to Nightshift MCP, resolved by D-P3-01 |

This contract is the stable authority for P3. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Prove the whole product model with one delegated coding job, locally. A frontier
orchestrator running in Claude Code delegates one bounded job through the
Nightshift MCP server; a separate worker executes it in an isolated worktree;
Nightshift verifies the result deterministically, integrates the verified commit
into the program branch, checkpoints, and the complete lifecycle is visible in the
deployed control plane. This is the first meaningful product milestone
(`00-source-program-plan.md`, Development Principle), and the invariant every
later program builds on.

No routing, no recursion, no examination, no remote execution. One harness, one
job, one worker, one worktree, one commit.

## 2. Environment and human prerequisites

Settled by P2. One account, no development account (A-17).

| Item | Value |
|------|-------|
| Control plane | `nightshift-dev-api` at `https://4xnsx809u6.execute-api.us-west-2.amazonaws.com`, data in `nightshift-dev-data` |
| User pool | `us-west-2_GKWK85Mub`; interactive client with loopback redirect `http://localhost:47821/callback`; machine client for scripts |
| CLI profile | `nightshift` (IAM Roles Anywhere, D-P2-18), used only by deploy, smoke and operator bootstrap scripts |
| Orchestrator harness | Claude Code 2.1.272 at `/opt/homebrew/bin/claude`, signed in with the operator's subscription |
| Other harnesses present | Codex CLI 0.149.0. Not used in P3 (D-P3-03). |
| Toolchain | Node 22.22.0, npm 10.9.4, git 2.39.5 |

### Human prerequisites

| # | Prerequisite | Why | Status |
|---|--------------|-----|--------|
| H-P3-01 | Ratify D-P3-01 … D-P3-17 (§3) | O-04 is the blocking decision; the rest fix the shape of the MCP server, the harness contract and the git model, which are expensive to change once a worker has run against them | **satisfied 2026-09-15** |
| H-P3-02 | A Cognito user for the operator, with `User` and `Membership` records in the table | The interactive login (T7) can only sign in a user the operator created; no self sign-up exists. | **satisfied 2026-09-15**: user `58819310-5081-70f2-81fe-66601586db46` (`tim+nightshift@wingitlabs.com`, `CONFIRMED`, created by hand in the console after a first attempt was deleted), `User` and `Membership` rows keyed by that sub, org `org_01M2K3A96ZZ7EJE93PQWR845T3`. The invitation appeared not to arrive because the recipient domain's DNS was down (its registrar account was suspended), not because of Cognito; see §12. |
| H-P3-03 | Redeploy the API stack after T2 | The control plane gains routes, an S3 permission and a dependency. Deploys run from a developer machine (D-P2-09). | open |
| H-P3-04 | Claude Code signed in on the machine that runs the deployed slice | The worker is `claude -p`, billed to the operator's subscription. There is no API-key spend in P3. | satisfied on the Mac mini |

**Explicitly not required.** No Bedrock access, no second harness, no AgentCore,
no new AWS resource beyond an IAM statement and a Lambda dependency. If a task
finds it needs one of those, it has left P3.

## 3. Ratified decisions

Drafted 2026-09-15 from `docs/vision.md`, `docs/architecture.md`, the source
plan's Stage 3 and the P2 as-built, and ratified by the human the same day. The
lasting ones are recorded in `docs/architecture.md`: O-04 resolves as A-27, and
D-P3-02, D-P3-05, D-P3-09, D-P3-12 and D-P3-17 are A-28 … A-32. `AGENTS.md`
carries the short form.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P3-01 | **Local authentication to Nightshift MCP** (resolves **O-04**): the MCP server is a **stdio child process** of the harness that uses it. It opens no network listener, so the operating-system process boundary is the authentication: whoever can spawn the process is the operator. The server authenticates *itself* to the control plane with the operator's Cognito session from `nightshift login`. Its **execution identity** arrives from whoever spawned it: the operator's MCP configuration sets the orchestrator role, and `run.start` then binds the run; Nightshift's execution layer sets the worker role and the worker's run, node, agent and job in environment variables. | v1 is single-user and private (source plan). A local token or socket handshake would authenticate the same user to the same user. What matters is *which execution identity* a server instance carries, and that is fixed at spawn time by a party the worker does not control. See the non-guarantee below. |
| D-P3-02 | The local machinery reaches the control plane **only through the HTTP API** with a Cognito token. It never holds AWS credentials for the Nightshift account. `@nightshift/persistence/http` implements the `NightshiftStores` ports over the API, so `execution` depends on the same port interface whichever adapter is wired. | A-19 makes the Lambda the sole holder of DynamoDB and S3 credentials, and A-25 keeps control-plane credentials and workload credentials in separate worlds. An orchestrator on a laptop must not need an AWS profile for Nightshift. |
| D-P3-03 | **First harness adapter: Claude Code**, driven headless (`claude -p`) as a child process of the execution layer with the worktree as its working directory. Nightshift MCP is injected with `--mcp-config`; hooks and tool policy are the adapter's concern. Codex and AgentCore arrive in P4. | Installed, signed in, and the harness the operator already orchestrates from. Its headless mode exposes a structured event stream and a hook system, which is what the hook channel (§4.7) needs. The execution package must not know which adapter it has; the architecture tests enforce that. |
| D-P3-04 | **Execution runs inside the orchestrator's MCP server process.** `delegate` returns as soon as the Job Contract, node, agent and routing decision are persisted and the worker has started; `job.wait` blocks for a bounded time. There is no local daemon in P3. | The smallest thing that works, and it keeps the orchestrator responsive during a long job. The cost is stated: the run dies with the session, which the server turns into durable `interrupted` state on shutdown. Recovery after a hard kill of the server is not in P3 (§5). P8 revisits the process model for remote execution. |
| D-P3-05 | **Nightshift owns every commit.** Workers never commit. `job.complete` snapshots the worktree into one Nightshift-authored commit; changes outside the job's effective scope fail the job at that moment, durably. **Sealing** is the node reaching `sealed` plus a ref `refs/nightshift/sealed/<nodeId>` at the verified commit. **Integration** is a fast-forward of the program branch onto the sealed commit; a non-fast-forward is a durable `stale_base` failure, and reconciling it is P5. **Checkpoints** are refs under `refs/nightshift/checkpoints/<checkpointId>`. Nothing is ever pushed. | Matches the source plan's "Nightshift-owned verified commit" and A-10's serialized integration, and makes the scope rule structural at the one point that matters rather than a prompt. Refs make commits durably addressable (checkpoint contract). O-06 stays open: no push policy is decided or exercised. |
| D-P3-06 | **Deterministic verification** runs the Program Contract's `verification` steps, in order, in the worktree on a clean checkout of the candidate commit. Step output goes to S3 as `verification-log` artifacts. The `Verification` record is written by the execution layer and by nothing else: no MCP tool can create one, and a worker's `job.complete` moves the node to `implemented` and no further. | A-05, structurally. The evidence rule in `core` already refuses `verified` without a matching record; this decision makes sure the only writer of such records is Nightshift. |
| D-P3-07 | **Examination is unavailable in P3.** A delegation whose risk level maps to `required: true` in the program's examination policy is refused up front with a typed `examination_unavailable` error. Verified nodes go `verified → sealed` directly. | Building an examiner is P6. Refusing loudly is better than silently skipping a step the contract asked for. |
| D-P3-08 | **Routing is one fixed rule** (`ruleId: "p3-fixed"`) that chooses the Claude Code adapter and the model the policy allows, records a real `RoutingDecision` with every option listed, and honours an orchestrator's model override with `wasOverride: true`. `packages/routing` holds it. | The dataset for learned routing (A-13) starts with the first job, not with P6. P6 replaces the rule, not the record. |
| D-P3-09 | **Three event sources, three writers.** `mcp` events come from tool calls the agent makes on purpose; `hook` events come from the adapter's observation of the harness process (its structured output stream and, where needed, configured hooks) and must arrive without any cooperation from the worker; `control-plane` events come from the execution layer's own actions. An adapter that cannot produce the P3 lifecycle set (§4.7) without worker cooperation is not conformant. | Architecture §5: MCP carries intent, hooks carry ground truth. Distinguishing the writer is what makes "the worker never reported" a detectable gap. |
| D-P3-10 | **Local state** lives under an OS state directory (`NIGHTSHIFT_STATE_DIR`, default the platform's state dir), never inside the program checkout: worktrees, pending transcripts, and the **event outbox**. The outbox delivers events in order with retry; on shutdown it spills to a spool file that the next server for that run replays. It is a buffer, not a store (A-06). | Keeps the operator's checkout untouched, and makes durable failure state survive a flaky connection to the control plane. The spool is what the source plan's Connectivity Loss section asks for, sized to P3. |
| D-P3-11 | **`npm test` gains the offline slice suite.** A local control plane (`node:http` over the real API handler and the in-memory stores), a scripted harness that spawns a real worker process, real git worktrees, and a real MCP server over stdio prove the eleven Stage 3 outcomes with no LLM and no AWS, on both CI legs. The same suite runs opt-in against the deployed stack, and against the real Claude Code adapter, via `npm run slice`. | The proofs are about Nightshift, not about the model. Everything but the LLM can be real offline, so it is. The credential-free CI gate from P1 survives untouched. |
| D-P3-12 | **Architecture rules amended.** Apps are composition roots: `apps/mcp` may import `harness-*` packages in exactly one named wiring module. `apps/cli` may reference `core` and `persistence`. `test` may reference every package the slice suite drives. Unchanged and still enforced: no harness implementation or provider SDK in `execution`, `routing`, `verification`, `core` or `contracts`. | P1's rule had no composition root, so nothing could legally instantiate an adapter. The intent of SC-P1-20, a harness-neutral scheduler, is preserved by keeping the ban on the packages that matter. |
| D-P3-13 | **The control-plane API grows** to cover every port method the local machinery uses, plus a presigned artifact upload. `PUT run` and `PUT agent` gain update semantics governed by small transition tables in `core`. Every new route is covered by the smoke suite. The API function gains `s3:PutObject` on the bucket, for signing only. | P2 left the surface at what its smoke suite covered and told P3 to ask for what it needs. This is the ask, in one place, rather than a route per surprise. |
| D-P3-14 | **`@modelcontextprotocol/sdk` pinned at 1.30.0**, the version AGENTS.md observed on 2026-09-13 and still the latest on 2026-09-15. It appears in `apps/mcp` and, for the scripted harness's client, in `test`. Nowhere else. | The pin AGENTS.md reserved for P3. |
| D-P3-15 | **Worker permissions** use a small vocabulary on `Scope.permissions`: `fs.read`, `fs.write`, `shell.exec`. The adapter maps them to the harness's tool policy and runs the worker non-interactively, with permission prompts resolved by that policy and never by a human. Git write operations are never granted to a worker. | The vocabulary already appears in P1's fixtures. Mapping it inside the adapter is what the source plan's harness section asks for: sandbox configuration is a harness-specific concern. Scope containment is then enforced twice, by tool policy during the job and structurally at commit time (D-P3-05). |
| D-P3-16 | **The user pool never depends on the invitation email.** The operator bootstrap finds or creates the Cognito user with the invitation suppressed and a permanent password set; the invitation template carries the hosted sign-in URL; delivery-error logging (`userNotification`, ERROR) moves into the CDK data stack, where it was enabled by hand on 2026-09-15. | The day's incident: an invitation that appeared lost was a dead recipient domain, and it took an afternoon to prove because the pool logged nothing. Cognito's default mailer is best-effort, capped at 50 a day, and keeps its own suppression list. A hosted zone and SES sender for `nightshift.wildorder.dev` are deferred until an invitation fails with working DNS. |
| D-P3-17 | **Starting a run is one CLI verb**, `nightshift run <contract> [--remote]`. Its first half, validate the contract and persist program, run, root node and initial checkpoint, is identical in both modes; the local form then prints the run id for the orchestrator's MCP server to attach to, and P8 adds the dispatch call behind `--remote`. The MCP `run.start` stays as a convenience and calls the same function. | The vision names `nightshift run` as the CLI entry and A-16 says the CLI calls the APIs a Studio would. One command with one flag is what makes SC-16's "same canonical model" a workflow rather than a claim, and it keeps authorizing the work a human act at a terminal, distinct from the orchestrator that later does it. |

### Non-guarantees, stated so they are not mistaken for guarantees

- **A worker shares the operator's control-plane identity.** It runs as the same
  OS user, so it can read the same credentials file and could call the API
  directly. v1 is single-user; per-agent control-plane credentials are not built.
  Recorded beside the A-21 non-guarantee, for the same reason: a label must not be
  mistaken for a fence.
- **Scope is not a filesystem sandbox.** A worker granted `shell.exec` can run
  arbitrary commands and can read outside its scope. What P3 guarantees is that
  nothing outside scope *integrates*, and that a worker cannot widen its own
  authority.
- **A hard kill of the orchestrator's MCP server** (SIGKILL, power loss) leaves
  the worker process orphaned and the node in `running`. The next server for
  that run does not yet reconcile it. Graceful shutdown does.

## 4. Design

### 4.1 Process model

```text
Human
 └─ Claude Code (interactive orchestrator; Nightshift does not spawn it)
     └─ nightshift-mcp  role=orchestrator                     apps/mcp, stdio child
         ├─ persistence/http ──── HTTPS + Cognito ID token ──► control plane (P2)
         └─ execution layer, in-process (D-P3-04)
             ├─ git worktree add  <state>/worktrees/<runId>/<nodeId>
             ├─ harness-claude.start ──► claude -p   (cwd = worktree)
             │                              └─ nightshift-mcp  role=worker
             │                                   identity from env: run, node, agent, job
             │                                   tools: job.get / job.progress /
             │                                          job.complete / job.fail / decision.record
             │                                   persistence/http ──► control plane
             ├─ observe process: hook events, exit
             ├─ verification (Program Contract steps, clean checkout)
             ├─ seal ref, fast-forward program branch, checkpoint ref
             └─ job result available to job.get / job.wait
```

Two instances of one server binary, distinguished by `NIGHTSHIFT_ROLE`. The
orchestrator instance registers the delegation tools; the worker instance does
not, so a worker cannot delegate by construction, and if it somehow tried, the
API's `CAN_DELEGATE` rule refuses a job node as a parent anyway.

### 4.2 Identity and authentication (D-P3-01)

Two identities, never conflated.

- **Control-plane identity** is the operator. `nightshift login` runs the
  authorization-code-with-PKCE flow against the interactive client using the
  loopback redirect P2 reserved, and stores the refresh token in the config
  directory with owner-only permissions. Both the CLI and the MCP server read it
  and mint fresh tokens themselves. The **ID token** is sent, because the
  authorizer lists the interactive client in its audience and because
  `custom:active_org` appears only in ID tokens (P2, `acting-org.ts`).
- **Execution identity** is the node and agent a server instance acts for.
  Orchestrator: chosen by `run.start` and held in memory for the session.
  Worker: `NIGHTSHIFT_PROJECT_ID`, `NIGHTSHIFT_PROGRAM_ID`, `NIGHTSHIFT_RUN_ID`,
  `NIGHTSHIFT_NODE_ID`, `NIGHTSHIFT_AGENT_ID`, `NIGHTSHIFT_JOB_ID` and
  `NIGHTSHIFT_WORKTREE`, written by the execution layer into the MCP
  configuration it hands the harness. A worker instance refuses to start without
  all of them, and every record it writes carries them.

Nothing executes without a Nightshift execution identity (A-04): the `Agent`
record exists, `created`, before the harness process is spawned, and the node is
`queued` before that.

### 4.3 The job lifecycle

The node statuses are P1's; the events in the right column are appended at each
step (§4.7 gives the sources).

| Step | Who | Node | Events |
|------|-----|------|--------|
| `delegate` validates the request as a `JobContract`, narrows scope against the parent, checks depth and concurrency, refuses examination-requiring risk (D-P3-07) | MCP, orchestrator role | `validated` | `node.delegated` |
| Persist contract, node, agent (`created`), routing decision (D-P3-08) | execution | `queued` | `node.queued`, `agent.created`, `routing.decided` |
| Create the worktree from the program branch head | execution | | |
| Start the harness with the worker MCP configuration | adapter | `running` | `node.started`, `agent.started` |
| Worker reads code, edits, runs tests, reports | worker | | `node.progress` (mcp), `tool.called` / `tool.completed` (hook), `decision.recorded` (mcp) |
| `job.complete`: scope check, snapshot commit, `commitSha` on node | MCP, worker role | `implemented` | `node.implemented` |
| Worker process exits; adapter reports exit | adapter | | `agent.completed` |
| Clean checkout of the candidate commit; run verification steps; upload logs; write `Verification` | execution | `verifying` → `verified` or `verification_failed` | `verification.requested`, `artifact.recorded`, `verification.completed` |
| Seal: ref at the verified commit | execution | `sealed` | |
| Integrate: fast-forward the program branch | execution | `integrated` | `node.integrated` |
| Checkpoint: ref and record at the integrated commit | execution | | `checkpoint.created` |

Failure paths, each durable before anything else happens:

- `job.fail` → `failed`, `outcomeReason` from the worker, `node.failed`,
  `agent.failed`.
- Exit without `job.complete` → `failed` ("worker exited N without reporting
  completion"), `agent.failed`.
- Exit by signal → `interrupted`, `agent.interrupted`, `node.interrupted`. On a
  platform that reports no signal for a killed process (Windows), the exit is
  recorded as `failed` with the exit code; the proof is durable failure state,
  not the label.
- `job.cancel` → adapter `cancel`, `cancelled`, `agent.cancelled`, `node.cancelled`.
- Verification fails → `verification_failed`, the `Verification` record with the
  failing step and its log artifact. The node is not sealed, nothing integrates,
  the worktree is kept for inspection.
- Program branch moved since the worktree was cut → `failed` with reason
  `stale_base` and the two commits named. No rebase in P3.
- Scope violation at `job.complete` → `failed` with the offending paths listed.
- Server shutdown with a running worker → worker cancelled, node and agent
  `interrupted`, outbox spooled.

The `Run` moves `pending → running` at `run.start` and to a terminal status at
`run.finish` or on shutdown; P3 does not decide a run's outcome from its nodes.

### 4.4 Git model (D-P3-05)

| Item | Where | Notes |
|------|-------|-------|
| Program checkout | the operator's clone, on `repository.programBranch` | Must be clean at integration time or integration fails durably; Nightshift never touches its working tree except by fast-forwarding the branch. |
| Worktree | `<state>/worktrees/<runId>/<nodeId>`, branch `nightshift/<runId>/<nodeId>` | Cut from the program branch head at `delegate`. Recorded on the node's result, not on the contract. Removed after integration; kept on failure. |
| Candidate commit | worktree branch | Author and committer `Nightshift`, trailers `Nightshift-Run`, `Nightshift-Node`, `Nightshift-Job`. Any commit the worker made is squashed into it: the snapshot is the tree, not the worker's history. |
| Clean checkout | `git reset --hard <sha>` and `git clean -fd` in the worktree | Ignored files survive, so dependencies need no reinstall. What is verified is the tracked tree plus whatever is ignored, and the notes say so. |
| Sealed ref | `refs/nightshift/sealed/<nodeId>` | Created at `sealed`, points at the verified commit. |
| Integration | `git merge --ff-only` on the program branch | The verified commit is the integrated commit; its `Verification` still matches (`isVerificationStale` is false). |
| Checkpoint ref | `refs/nightshift/checkpoints/<checkpointId>` | Also created at `run.start` so the first decision has a `checkpointBefore`. |
| Push | never | O-06 is untouched. |

### 4.5 MCP tool surface

Names are implementation details (source plan); shapes are validated with zod
from `@nightshift/contracts` types so that a client is typed against the same
schemas. Every tool result carries the identifiers it created.

**Orchestrator role**

| Tool | Does |
|------|------|
| `run.start { programContractPath, model, repoPath? }` | The same function `nightshift run` calls (D-P3-17): validates the authored contract, `PUT`s the program (create-or-confirm, so a revised contract under the same id is a 409 and the tool says so), creates the run and its root node, the initial checkpoint, then attaches as below. |
| `run.attach { runId?, model }` | Binds the session to a run: the one named, or, when omitted, the single `pending` run for this repository's program (two pending runs is a refusal that lists them). Creates the orchestrator's `Agent` (harness from the MCP client's name, model from the argument), moves the run to `running`, replays the spool if one exists. |
| `run.finish { outcome, reason? }` | Terminal run status. Refused while a job is running. |
| `program.get` / `program.status` | The contract; the run, nodes, latest checkpoint and event lag from `GET …/state`. |
| `delegate { objective, scope, acceptance, dependencies?, risk?, ambiguity?, model? }` | §4.3. Returns `{ jobId, nodeId, agentId, worktree }` once the worker has started. Refusals are typed: `scope_widening`, `depth_limit_exceeded`, `concurrency_limit_exceeded`, `examination_unavailable`, `validation_failed`. |
| `job.get { jobId }` | Node status, agent status, commit, verification summary, integration and checkpoint identifiers, worktree path, `outcomeReason`. |
| `job.wait { jobId, timeoutSeconds? }` | Blocks until the node is terminal or `verification_failed`, or the timeout (capped so the harness's tool timeout is never hit), then returns `job.get`. |
| `job.cancel { jobId }` | Adapter `cancel`, durable `cancelled`. |
| `decision.record { context, alternatives, choice, rationale, reversibility, affectedNodes? }` | A `Decision` on the root node, `checkpointBefore` the latest checkpoint. |
| `checkpoint.create { label? }` | A checkpoint at the program branch head. |
| `execution.status` | The tree with each node's status and agent, one line each. |

**Worker role**

| Tool | Does |
|------|------|
| `job.get` | Its own job: objective, scope, acceptance, worktree. No argument; the identity is fixed. |
| `job.progress { message, percent? }` | `node.progress`, source `mcp`. |
| `job.complete { summary }` | D-P3-05. Returns the commit, or the typed refusal with the out-of-scope paths. |
| `job.fail { reason }` | Durable failure with the reason. |
| `decision.record { … }` | On its own node. |

`delegate`, `run.*`, `checkpoint.create` and `job.cancel` are not registered in
the worker role. `verification.*` and `examination.*` are not registered in
either role in P3: verification is automatic and examination does not exist yet.

### 4.6 Harness adapter contract, version 0

`packages/harness` defines the interface around what Nightshift needs and nothing
a specific harness offers. P4 finalizes it against three adapters; P3 states the
version 0 shape so the execution layer is written against an interface, not a
process.

```ts
interface Harness {
  readonly id: string;                                      // "claude"
  start(input: HarnessStartInput): Promise<HarnessHandle>;
  cancel(handle: HarnessHandle, grace: Duration): Promise<void>;
  status(handle: HarnessHandle): Promise<AgentStatus>;
}

interface HarnessStartInput {
  readonly agent: Agent;               // identity, created before start (A-04)
  readonly node: ExecutionNode;
  readonly job: JobContract;
  readonly program: ProgramContract;   // constraints and verification steps, for the prompt
  readonly worktree: string;
  readonly model: RouteTarget;
  readonly mcp: McpLaunch;             // command, args, env for the worker MCP server
  readonly sink: HookSink;             // where hook events go, in order
}

interface HarnessHandle {
  readonly agentId: AgentId;
  readonly pid?: number;
  readonly exit: Promise<HarnessExit>; // completed | failed(exitCode) | interrupted(signal) | cancelled
  readonly transcript?: string;        // path to the raw transcript, uploaded by the execution layer
}
```

Everything provider-specific stays behind `start`: authentication, command line,
model flag, MCP configuration format, hook mechanism, output parsing, tool
policy. `HookSink` is the only way an adapter reports lifecycle facts, and it
carries `EventType`s from `@nightshift/contracts`, never harness event names.

### 4.7 Events and their sources (D-P3-09)

| Source | Writer | Events in P3 |
|--------|--------|--------------|
| `mcp` | the MCP server, on a tool call | `node.delegated`, `node.progress`, `node.implemented`, `node.failed` (via `job.fail`), `decision.recorded` |
| `hook` | the adapter, from observing the harness process | `agent.started`, `tool.called`, `tool.completed`, `agent.subagent_created`, `agent.context_compacted`, `agent.completed`, `agent.failed`, `agent.cancelled` |
| `control-plane` | the execution layer | `run.created`, `run.started`, `run.completed` / `run.failed` / `run.interrupted`, `node.queued`, `node.started`, `node.cancelled`, `node.interrupted`, `node.integrated`, `agent.created`, `routing.decided`, `verification.requested`, `verification.completed`, `artifact.recorded`, `checkpoint.created` |

Idempotency keys are deterministic per writer: `<source>:<writerId>:<n>` where
`n` is that writer's own monotonic counter, so a retried or replayed submission
converges (A-06). Payloads stay under the inline bound; anything larger is an
artifact reference. Every reader tolerates an unnumbered `sequence` (A-22) and
uses the `core` event-stream helpers.

### 4.8 Control-plane additions (D-P3-13)

| Addition | Why |
|----------|-----|
| `PUT`/`GET …/jobs/{jobContractId}`, `GET …/jobs` | The Job Contract is persisted before execution (A-03) and read back by the worker's `job.get`. |
| `PUT`/`GET …/agents/{agentId}`, `GET …/nodes/{nodeId}/agents` | The execution identity, with status updates `created → started → completed / failed / cancelled / interrupted`, table in `core`. |
| `PUT run` update semantics | `pending → running → succeeded / failed / cancelled / interrupted`, table in `core`. Terminal statuses require `endedAt`; non-success requires `outcomeReason`. |
| `GET …/nodes`, `GET …/nodes/{nodeId}/children` | `execution.status` and the http adapter's `listByRun` / `listChildren`. |
| `GET` and list routes for decisions, checkpoints, verifications (by node), routing decisions (by node), artifacts; `GET …/programs`, `GET …/runs` | The remaining port reads, so the http adapter implements every project-scoped port. |
| `PUT`/`GET …/examinations/{examinationId}`, `GET …/nodes/{nodeId}/examinations` | Port completeness. Nothing in P3 writes one. |
| `POST …/artifacts/{artifactId}/upload-url` | Returns a presigned S3 `PUT` for `<projectId>/<programId>/<runId>/<artifactId>` with the declared content type and size, and the `s3://` URI the `Artifact` record will carry. The function signs; the client uploads; the record is written after the bytes are durable. |
| `NightshiftStores` split into project-scoped stores and `IdentityStores` | Identity is administered by the operator, not by a run. The http adapter implements the project half; the conformance suite runs its identity section only for adapters that supply the identity half. |
| `ArtifactBodyStore` lifted from `persistence/aws` into `core` ports | So the execution layer uploads through a port, and the http adapter's presigned implementation and the S3 implementation are interchangeable. |
| Operator bootstrap | `npm run admin:user`: given an email, finds or creates the Cognito user **without relying on the invitation email**, and writes the `User` and `Membership` records for its sub. Opt-in, needs the AWS profile, never in CI. |

No route is added that the slice does not use, and each is exercised by the
smoke suite (§8).

### 4.9 Local state and the outbox (D-P3-10)

```text
<NIGHTSHIFT_CONFIG_DIR>/                 default: platform config dir / nightshift
  profile.json                           api endpoint, auth domain, client id, stage
  credentials.json                       refresh token, mode 0600
<NIGHTSHIFT_STATE_DIR>/                  default: platform state dir / nightshift
  worktrees/<runId>/<nodeId>/
  runs/<runId>/
    spool.ndjson                         outbox spilled at shutdown, replayed on attach
    agents/<agentId>/transcript.jsonl    until uploaded
```

The outbox is one ordered queue per server process. It posts with bounded retry
and backoff, never reorders within a writer, and refuses to drop: on shutdown it
waits a bounded time, then spills. A spool that exists at `run.attach` is
replayed before any new event is accepted, and the idempotency keys make replay
safe. Nothing here is read to answer a question about run state; the control
plane is (A-06).

## 5. Scope

### In scope

- `packages/harness`: the version 0 adapter contract (§4.6) and `HookSink`.
- `packages/harness-claude`: the Claude Code adapter.
- `packages/execution`: worktrees, the job runner, snapshot commits, scope check
  at commit, seal, fast-forward integration, checkpoints, the outbox and spool,
  local paths, graceful shutdown.
- `packages/verification`: running the contract's steps with per-step logs, exit
  codes and durations.
- `packages/routing`: the fixed rule (D-P3-08).
- `packages/persistence/http` and the local session (profile, credentials,
  token refresh).
- `apps/mcp`: the server, both roles, the composition root, the skill under
  `skills/nightshift/`.
- `apps/cli`: `login`, `logout`, `whoami`, `run` (local form only), `project
  create`, `id`.
- `apps/api` and `infra/cdk`: the additions in §4.8, their tests, the smoke
  suite extension, one redeploy.
- `core`: run and agent transition tables, the stores split, the artifact-body
  port, the `Scope.permissions` vocabulary as constants.
- `test/`: the fixture repository, the scripted harness, the local control
  plane wiring, the offline slice suite, and the opt-in deployed slice.
- Pins recorded in `AGENTS.md`: `@modelcontextprotocol/sdk`,
  `@aws-sdk/s3-request-presigner`.

### Out of scope

- A second adapter, the conformance fixture shared across adapters, and the
  final adapter contract (P4).
- More than one job in flight, sub-programs, stale-base reconciliation, program
  level verification after integration (P5). P3 allows exactly one running child
  under the root, whatever `delegationLimits.maxConcurrency` says, and records
  that as the reason when it refuses a second.
- Routing policy, escalation, retry, Bedrock, cost capture beyond wall clock (P6).
- Examination (P6), replay (P7), remote execution (P8), realtime (P9).
- Pushing anything, or deciding when to (O-06).
- Recovery after a hard kill of the MCP server (§3, non-guarantees).
- Per-agent control-plane credentials.
- Any change to the P2 key schema.

## 6. Success criteria

The eleven outcomes from the source plan's Stage 3 verification list, verbatim,
plus four P3 additions that make the invariants structural rather than observed.

**Stage 3, carried verbatim**

- **SC-P3-01** Delegation requires a valid Job Contract.
- **SC-P3-02** Central job record exists before worker starts.
- **SC-P3-03** Worker receives an isolated worktree.
- **SC-P3-04** Worker edits do not appear in program checkout before integration.
- **SC-P3-05** MCP receives progress events during execution.
- **SC-P3-06** Worker-reported success does not mark verification green.
- **SC-P3-07** Intentionally failing tests block integration.
- **SC-P3-08** Passing tests produce a sealed commit.
- **SC-P3-09** Verified commit integrates into program branch.
- **SC-P3-10** Checkpoint follows integration.
- **SC-P3-11** Killing the worker leaves durable failure/interruption state.

**P3 additions**

- **SC-P3-12** Hook-sourced lifecycle events arrive without any cooperation from
  the worker (D-P3-09).
- **SC-P3-13** A change outside the job's effective scope never integrates
  (D-P3-05).
- **SC-P3-14** No harness-specific import exists in `execution`, `routing`,
  `verification`, `core` or `contracts`, and `apps/mcp` names an adapter in one
  module only (D-P3-12, regression of SC-P1-20).
- **SC-P3-15** `npm test` proves SC-P3-01 … SC-P3-14 with no LLM, no AWS
  credentials and no network beyond the loopback control plane, on ubuntu and
  windows (D-P3-11).

**Exit gate**

- **SC-P3-16** The deployed slice passes: a real Claude Code worker, driven by a
  real Claude Code orchestrator through the Nightshift skill, completes the
  fixture job against the deployed control plane, and the lifecycle above is
  readable from `GET …/state` and `GET …/events` alone.
- **SC-P3-17** The P2 smoke suite, extended for §4.8, passes against the
  redeployed stack, and every P1 and P2 gate is unchanged.

## 7. Deterministic verification

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm test                 # now includes the offline slice suite; still credential-free
npm run synth
npm run check:sterility
npm run check:architecture
```

Plus, from a developer machine with `AWS_PROFILE=nightshift`:

```text
npm run deploy           # after T2, before T10
npm run smoke            # P2 suite plus the P3 routes
npm run slice            # deployed control plane; scripted harness, then Claude Code
```

`npm test` must remain runnable with no AWS credentials, no Claude Code sign-in,
and no network beyond loopback. It needs `git` on the path, which both CI runners have. The
slice suite's own timeouts are set in `test/vitest.config.ts`, because project
configs do not inherit the root's (AGENTS.md).

## 8. The slice suite (D-P3-11)

One suite, two axes, chosen by environment variables and defaulting to the
offline pair.

| Axis | Offline (`npm test`) | Deployed (`npm run slice`) |
|------|----------------------|----------------------------|
| Control plane | `node:http` over `handleRequest` and `createInMemoryStores`, fixed claims, in-memory artifact bodies | the real endpoint with a machine token, throwaway `slice-<ulid>` project, cleanup as the smoke suite does |
| Harness | the scripted harness: a real `node` child that spawns the worker MCP server over stdio and follows a script (edit files, call tools, exit or hang) | `@nightshift/harness-claude` driving `claude -p` |

`npm run slice` runs the deployed control plane with the scripted harness first,
then with Claude Code, so a failure is attributable to the network or the model
rather than to both. Its Claude Code leg is SC-P3-16's evidence, and it prints
the run identifiers so the human can read the lifecycle back from the API.

The fixture repository is materialised into a temporary directory by the suite
(`git init`, initial commit, program branch) from `test/fixtures/slice-repo/`. It
is a small Node project using the built-in test runner, so verification needs no
install. It ships one program contract and one job; what varies is the scripted
harness's behaviour: implement it correctly, leave a failing test, edit outside
scope, report progress then hang until killed, fail on purpose, or exit without
reporting. T9 lists the scripts.

## 9. Constraints

- Dependencies point downward only. `execution` imports `@nightshift/harness`,
  never an adapter; `apps/mcp`'s composition module is the only place an
  adapter is named (D-P3-12).
- `@nightshift/contracts` and `@nightshift/core` stay offline and free of the
  MCP SDK, the AWS SDK and Node builtins. The transition tables and the stores
  split must not change that.
- The local machinery holds no AWS credentials and no AWS SDK import outside
  `persistence/aws` and the opt-in scripts. `apps/mcp` and `apps/cli` never
  import `@nightshift/persistence/aws`.
- Every external dependency pinned exactly and recorded in `AGENTS.md`.
- Every script runs on Windows and Linux; repo scripts are Node scripts.
- Nothing is written into the program checkout other than by fast-forwarding
  its branch. Worktrees, spools and transcripts live in the state directory.
- A worker's MCP instance exposes no tool that creates a `Verification`, a
  `Checkpoint`, a child node or a run.
- No MCP tool blocks longer than the harness's tool timeout; `job.wait` caps
  its own wait and says so in its result.

## 10. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack to the v1 account
after T2; running the smoke and slice suites; running the operator bootstrap
once for the human's user; running Claude Code headless on the operator's
subscription for the deployed slice.

Forbidden:

- Pushing any ref from a worktree, a fixture, or the program checkout as part of
  execution (O-06).
- Granting a worker `git` write operations, or running it with a human answering
  permission prompts.
- Letting any code path other than the execution layer write a `Verification`.
- Editing the P1 or P2 conformance suites, or the P2 smoke suite's existing
  assertions, to make a new adapter or route pass.
- Weakening AR-1 … AR-6 beyond the amendment in D-P3-12.
- Putting the operator's refresh token anywhere but the credentials file, or
  printing it.
- Deploying to any account other than `755348349819`; putting AWS credentials
  in CI, the repository or agent context.
- Settling O-02, O-03, O-05 or O-06.

## 11. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Harness adapter contract, version 0 | — | — |
| T2 | Control-plane additions and the local control plane | — | AWS for the redeploy and smoke only |
| T3 | The HTTP adapter and the local session | T2 | — |
| T4 | The verification runner | — | — |
| T5 | The execution layer | T1, T2, T4 | git |
| T6 | The MCP server, the fixed route and the skill | T3, T5 | — |
| T7 | The CLI: login, run, and project bootstrap | T3 | a Cognito user, for the manual check |
| T8 | The Claude Code adapter | T1 | Claude Code, for the manual check |
| T9 | Fixture repository, scripted harness and the offline slice suite | T6 | git |
| T10 | Deployed slice, skill run-through and as-built | T7, T8, T9 | AWS, Claude Code |

```text
T1 ─────┬──────────────── T8 ─────────┐
        │                             │
T4 ─────┼─── T5 ───┐                  │
T2 ──┬──┘          ├── T6 ── T9 ──────┼── T10
     └── T3 ───┬───┘                  │
               └────── T7 ────────────┘
```

**Eight of ten tasks need neither AWS nor a model.** T1, T2 and T4 are
independent and can start together; T2 is the one with a deploy at its end and
should start first. T5 and T6 are one line of work and should stay in one
context. T8 can be built and unit-tested on recorded harness output before T10
runs it for real.

Specs live in `tasks/p3-vertical-slice/`.

### Carried over from P2

- The API's `PUT run` is create-or-confirm; P3 needs to move a run's status
  (T2).
- `acting-org.ts` already documents that interactive callers must present the
  ID token; T3 sends it, T7 stores what is needed to mint it.
- The API function has no S3 statement; the first route that needs one is the
  presigned upload (T2).
- The P2 open items stand: the budget email delivery is still unconfirmed and
  point-in-time recovery is off. Neither blocks P3.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-15 | Contract drafted; D-P3-01 … D-P3-15 proposed; tasks T1 … T10 drafted | Agent, for human ratification |
| 2026-09-15 | **Contract ratified**, D-P3-01 … D-P3-17, after a consistency review against the vision and the source plan. Three departures from the letter accepted knowingly: D-P3-12 amends architecture §1 with a composition root; the orchestrator may pin a model within policy, recorded as an override, which P1's Job Contract already allowed and the vision now states; and the MCP surface defers `verification.request`, `verification.get`, `examination.request` and `artifact.record` until something can call them. D-P3-16 and D-P3-17 added at ratification. | Human |
| 2026-09-15 | H-P3-02 satisfied by hand. The invitation seemed lost, and the cause was that `wingitlabs.com` had stopped resolving because the AWS account holding its hosted zone was suspended over an unpaid bill; Cognito's sends were accepted every time (CloudTrail). Once DNS returned, the default invitation carried only a temporary password, so the operator finished sign-in on the hosted UI directly. The user was deleted and recreated once, so the `User` and `Membership` rows were moved to the new sub. T2's bootstrap is respecified to never depend on the invitation email, and to put the hosted sign-in URL in the invite template. Delivery-error logging (`userNotification`, ERROR) was enabled on the pool during diagnosis and left on. | Human and agent |
| 2026-09-15 | **T2 amendment to the port conformance suite**, in the D-P2-16 tradition and recorded here rather than made quietly. `NightshiftStores` is now `ProjectStores & IdentityStores`, and `describePortConformance` takes an `identity` option: an adapter that supplies it runs the identity section, and one that does not has that section **skipped with a message in its name**, never silently passed. The http adapter (T3) supplies only the project half, because the API exposes no route that administers a user — identity is administered by the operator with an AWS profile, not by a run. The memory and DynamoDB adapters supply both, so nothing that could pass the section stopped running it. | Agent, for human ratification |
| 2026-09-15 | **`EventTypeSchema` gains `agent.interrupted`.** §4.3 requires a killed worker to leave durable interruption state on the agent as well as the node, and the closed union P1 wrote had no type for it (§4.7's hook row lists the eight types known at drafting). Widening the union is the deliberate extension P1's module comment reserved for later programs; nothing narrows. Emitted by the adapter as a `hook` event, since a signal is something the adapter observes rather than something a worker reports. | Agent, for human ratification |
| 2026-09-15 | **Departure from T2 7a: the invitation template carries the hosted *domain*, not the complete sign-in URL.** A complete Cognito hosted-UI URL needs `client_id`, and a user pool that named its own app client is a CloudFormation **circular dependency** — the client refers to the pool, so the pool cannot refer back. CDK's validator reports it (F3004) and CloudFormation refused the deploy outright; this was found by deploying, not by reasoning. The template therefore names the hosted domain, the placeholders, and where the complete link is; the complete URL, client id included, is the new `HostedSignInUrl` stack export, which `npm run admin:user` prints and `nightshift login` will open. D-P3-16's intent — nobody is left holding a password and no URL — is met; its letter is not. Note also that the bootstrap suppresses the invitation and sets a permanent password, so on the intended path the template is never read. | Agent, for human ratification |

## 13. As built

Not yet.
