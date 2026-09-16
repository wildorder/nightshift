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
| 2026-09-15 | **Departure from T3 deliverable 3: the http adapter does not run `describePortConformance`.** It cannot, and the reason is a property of the design rather than a gap in the adapter. The conformance suite specifies a *storage* port: it writes a program contract with no project, an event with no run, and a project into any organisation it likes. The API is a *domain* surface over that store and deliberately refuses all three — referential integrity (`requireProject`, `requireRun`), the tree and transition rules, and D-P2-13's rule that the acting org comes from the validated token and never from a payload. T3's own note anticipates this: "either a route is missing or wrong (fix T2) or the suite predates a real change (a conversation)." This is the latter. In its place, `apps/api/src/http-adapter.test.ts` drives **every method of every project-scoped port** against the real handler over the local control plane, in the order the domain permits, and its `afterAll` fails if any port method went unexercised — so a method added later cannot go unproven. Error mapping, retry, paging, the A-22 unnumbered-append path and the presigned upload are covered there and in `packages/persistence/src/http/*.test.ts`. | Agent, for human ratification |
| 2026-09-15 | **`ProgramContractSchema` now requires unique `verification` and `successCriteria` ids.** Found while building T4: `toVerificationCommands` attaches an exit code and a log artifact per `stepId`, so two steps sharing an id would put two results under one label and silently lose a log. A tightening, not a widening: every contract that was valid and unambiguous still is. | Agent, for human ratification |
| 2026-09-15 | **Correction to T8 deliverable 4: exit 0 is not sufficient for `completed`.** The spec says "zero with a result message is `completed`". Measured against the installed 2.1.273: a `claude -p` interrupted with `SIGINT` **exits 0 and still prints a `result` frame**, carrying `is_error: true`, `subtype: "error_during_execution"` and `terminal_reason: "aborted_streaming"`. Taking the spec literally would record an abandoned run as a clean completion, and an abandoned run that looks completed goes on to be verified and integrated. The adapter therefore requires a *non-error* result; exit 0 with an error result, or with no result at all, is `failed`. | Agent, for human ratification |
| 2026-09-15 | **`run.attach` needs the repository's contract file, and takes its program identifiers from it.** §4.5 says attach binds to "the single `pending` run for this repository's program", which presumes the server can tell which program a repository belongs to. It cannot, from the checkout alone — so the server reads `nightshift.program.json` (overridable with `NIGHTSHIFT_CONTRACT_FILE`) for the `projectId` and `programId` only, then resolves the run through the control plane. The **stored** contract remains the authority for the contract's content, and `run.attach` reports when the file and the record have drifted rather than preferring either. | Agent, for human ratification |
| 2026-09-16 | **Two departures from the letter of T7, both in the CLI.** (a) `project create` sends `ProjectBodySchema` through `routes` + `send` rather than `stores.projects.put`. The store port takes a `Project`, which requires an `orgId` the adapter then strips — so calling it would mean inventing an org the CLI has no basis to pick and that a reader would mistake for the real one. Sending the API's own body shape means the CLI genuinely never constructs one (D-P2-13), and the response carries the org the control plane assigned, which `put` would discard. (b) `API_SCOPE = "nightshift/api"` is restated in `apps/cli/src/oauth.ts` rather than imported, because `infra/cdk` is not in the CLI's layer table and should not be; the data stack's own test pins the same literal and a drift surfaces as `invalid_scope` at the first login. | Agent, for human ratification |
| 2026-09-16 | **`test` gains `apps/cli` in the layer table.** T7 deliverable 8 asks for each command's output "against the local control plane", and `apps/cli` cannot do that — its layer entry is `contracts`, `core`, `persistence`, `execution`, and `apps/api` is deliberately absent. Its own tests therefore drive an injected transport and say so; `test/src/cli/commands.test.ts` now drives `whoami`, `project create`, `run` and `id` through the CLI's own `openSession` against `startLocalControlPlane`, the production handler on loopback, with only Cognito's token endpoint stood in for. A route the CLI spells differently from the API is now a 404 in a test, and referential integrity is proven to refuse a contract naming an unknown project. | Agent, for human ratification |
| 2026-09-16 | **The ending event belongs to whoever observed it.** Found at the exit gate: both the adapter (on `settle`, through the `HookSink`) and the execution layer (after awaiting `handle.exit`) emitted `hookTypeForExit(exit)` with `source: "hook"`, so one agent produced two `agent.completed` events. The agent *record* stays the execution layer's to write, because only it may; the *event* is now the adapter's when it emitted one, with the runner's as a backstop. D-P3-09 is unchanged in letter and in force — a harness that reports nothing still leaves terminal state behind, and `lifecycle.test.ts` pins that half explicitly. | Agent, for human ratification |
| 2026-09-16 | **Nightshift shapes the commit message it owns.** A real worker's `job.complete` summary is a paragraph, and `git commit -m` makes everything before the first blank line the subject — so the first integrated commit carried a 700-character subject. `commitMessageFor` derives a subject inside 72 characters and keeps the whole summary as the body. A change to how A-29's "Nightshift owns every commit" is executed, not to what it says. | Agent, for human ratification |
| 2026-09-16 | **SC-P3-16's `nightshift login` leg is deferred to a human, and everything else in it is done.** The interactive app client allows `ALLOW_REFRESH_TOKEN_AUTH` only, so a refresh token comes from the hosted UI with the operator's password and from nowhere else; `admin/user.ts` never stores that password, by design. An agent cannot complete the flow, and the alternatives — resetting the operator's password, or a throwaway user the client's flow list rules out anyway — are worse than leaving it. The exit-gate run therefore used the machine client's credentials grant, which `compose.ts` supports as a documented path. §13.4 records what that leaves unproven (the browser leg and the exchange against real Cognito), where the rest is proven, and the three commands that close it. | Agent, for human ratification |
| 2026-09-16 | **Two observations recorded rather than fixed**, because fixing either at the exit gate would settle a rule the contract left open. The program node stays `running` after a run succeeds — §4.3 covers job nodes and says P3 does not decide a run's outcome from its nodes, so no terminal status for the root is specified. And `RoutingDecision.usage` stays `{}`: the record is written at `queued` and is create-or-confirm, so carrying the adapter's token counts or the wall clock would need a widened `Harness` port and a mutable route. Both belong to P4/P6. | Agent, for human ratification |
| 2026-09-16 | **Line endings are Nightshift's, not the machine's.** `identityOverrides` now prepends `core.autocrlf=false` and `core.eol=lf` to every Nightshift `git` invocation. Found by CI's windows leg, but it is not a test fix: A-29 says Nightshift owns every commit, and owning one means owning its bytes. `completeJob` snapshots a worktree into a commit and `cleanCheckout` materialises that same commit again for verification — with `core.autocrlf=true`, the default on a Windows installation, those are not the same bytes, so a worker writes `\n`, verification reads `\r\n`, and a step comparing file contents fails for a reason invisible in the diff. Only the implicit platform conversion is disabled: a repository that declares `text eol=crlf` in `.gitattributes` still gets CRLF, because attributes outrank both settings. | Agent, for human ratification |

## 13. As built

Built 2026-09-15/16 on `program/p3-vertical-slice`, ten commits from
`dee4373` (the ratified contract) to `9e3ae16`. 377 tracked files.

### 13.1 Task states and where each landed

| Task | State | Commit | Where it lives |
|------|-------|--------|----------------|
| T1 — harness adapter contract v0 | done | `e6fbdf1` | `packages/harness/src/{harness,hooks,brief,index}.ts`; `packages/core/src/rules/permissions.ts`; `"agent.interrupted"` added to `EventTypeSchema`; `test/src/conformance/harness.ts` |
| T2 — control-plane additions | done | `cd906f9` | ~20 routes in `apps/api/src/operations/{jobs,agents,uploads,records,nodes,projects}.ts`; `packages/core/src/rules/{run,agent}-transitions.ts`; `ProjectStores & IdentityStores`; `apps/api/src/testing/local-control-plane.ts`; `apps/api/src/admin/user.ts` + `scripts/admin-user.mjs`; CDK pool hardening, `s3:PutObject`, `AuthDomain` and `HostedSignInUrl` exports |
| T3 — http adapter and local session | done | `1c5d072` | `packages/persistence/src/http/{routes,errors,transport,stores,artifact-bodies}.ts` and `session/{paths,store,tokens,index}.ts`; `apps/api/src/http-adapter.test.ts` |
| T4 — verification runner | done | `1c5d072` | `packages/verification/src/{run,commands,environment,spawn}.ts` |
| T5 — execution layer | done | `4374eb8` | `packages/execution/src/{environment,hook-sink,outbox,runner,verify,integrate,shutdown,start-run,scope-check,worker}.ts` and `git/{runner,operations}.ts`; `test/src/execution/*` |
| T6 — MCP server, both roles | done | `4992567` | `apps/mcp/src/{role,compose,results,session,orchestrator,worker,server,index}.ts` + `bin/nightshift-mcp.ts` |
| T7 — the CLI | done | `761d1b7` | `apps/cli/src/{cli,environment,session,failures,pkce,loopback,oauth,browser}.ts`, `commands/*`, `bin/nightshift.ts`; `test/src/cli/commands.test.ts` |
| T8 — Claude Code adapter and the skill | done | `4992567` | `packages/harness-claude/*`; `skills/nightshift/SKILL.md`; `packages/routing/src/fixed.ts` |
| T9 — fixture repository and slice suite | done | `306b872` | `test/fixtures/slice-repo/*`; `test/src/harness/{scripted,worker}.ts`; `test/src/slice/*`; `apps/api/src/smoke/slice.smoke.ts`; `scripts/slice.mjs` |
| T10 — deployed slice and as-built | done, one step deferred to a human | `e0d8510` and this section | §13.4 names the one step |

### 13.2 Pins, as measured on the build machine

Node 22.22.0 · TypeScript 7.0.2 · vitest 5.0.0 · biome 2.5.13 · zod 4.6.4 ·
aws-cdk 2.1141.0 · aws-cdk-lib 2.269.0 · `@modelcontextprotocol/sdk` 1.30.0 ·
fast-check 4.10.0 · git 2.39.5 · **Claude Code 2.1.273**.

The contract §2 says 2.1.272. The installed CLI is 2.1.273 and the adapter
pins `VERIFIED_CLAUDE_VERSION` to what it was actually verified against, which
is 2.1.273. The contract's number is the drift; this is the correction.

### 13.3 The adapter's command line, as it actually ran

`packages/harness-claude` spawns `claude` with:

```
claude -p <the rendered brief> --output-format stream-json --verbose \
  --model claude-sonnet-5 \
  --mcp-config <temp file naming only the worker's nightshift server> \
  --strict-mcp-config --settings <temp file> --setting-sources "" \
  --permission-mode acceptEdits --permission-prompts none \
  --tools <…> --allowedTools <…> --disallowedTools <…> \
  --no-session-persistence
```

`--strict-mcp-config`, `--setting-sources ""` and `--no-session-persistence`
are the three that matter and are easy to miss: together they mean the worker
sees **only** the MCP server and settings Nightshift wrote for it, inherits
nothing from the operator's own Claude Code configuration, and leaves no
session behind. `buildMcpConfig` passes the `McpLaunch` through unchanged —
that is the whole of D-P3-01.

What the first real worker reported in `agent.started` (exit-gate run,
sequence 8): `harnessVersion 2.1.273`, `permissionMode acceptEdits`,
`model claude-sonnet-5`, `mcpServers [{ nightshift, connected }]`,
`toolCount 15`, and the two Nightshift tools as
`mcp__nightshift__job_complete` and `mcp__nightshift__decision_record` —
Claude Code renders an MCP tool's dotted name with underscores, so the worker
role's `job.complete` reaches the model as `job_complete`. Worth knowing
before reading a transcript; nothing depends on it.

### 13.4 The exit-gate run-through (SC-P3-16)

Run by hand on 2026-09-16 against the deployed stack (`755348349819`,
`us-west-2`, stage `dev`, endpoint `4xnsx809u6`), in a fresh clone of the
fixture at `~/exit-gate/repo` with the skill installed and the MCP server
configured exactly as `skills/nightshift/SKILL.md` documents.

| | |
|---|---|
| org | `org_01M2M2EMEHCX52GAXGQMPDFKMT` |
| project | `proj_01M2M2EMEHCX52GAXGQMPDFKMV` |
| program | `prog_01M2M2EMEHCX52GAXGQMPDFKMW` |
| run | `run_01M2M2G1XMPK10610ZVGSCHZK8` (`succeeded`) |
| root node | `node_01M2M2G1XNRBMNY1ZYK70GCZBN` |
| job node | `node_01M2M2GEYADSS0FTPF9XVV0XV6` (`integrated`) |
| job contract | `job_01M2M2GEP34W3GF810NMR804BE` |
| agent | `agent_01M2M2GEYADSS0FTPF9XVV0XV7` (`completed`) |
| verification | `ver_01M2M2H92Z4S6X8Q5X5724AZ5K` (`passed`) |
| decision | `dec_01M2M2HR8ZQRN7TYWERCGEGPT6` |
| base commit | `ca36f0c` · integrated commit `e31c183` |
| checkpoints | `ckpt_01M2M2G2F5VYH6F8KZ4YD0MDNY` ("run start", `ca36f0c`), `ckpt_01M2M2H9GMBKXKBSYH1FRQ284H` ("integrated …", `e31c183`) |

**The orchestrator was a real Claude Code session** — `claude -p` in the
clone, 14 turns, 91.6 s, $0.42 — which invoked the skill, called `run.start`,
read the contract back with `program.get`, delegated one job narrowed to three
named files, waited (`job.wait` settled in 55 s without timing out), recorded
a decision and called `run.finish`. Its own account is in §13.6.

**Durations, measured from the event timestamps.**

| Interval | Observed |
|----------|----------|
| `run.started` → `node.delegated` (the orchestrator thinking) | 11.8 s |
| `node.delegated` → `agent.started` (Nightshift's own share: contract, node, agent, routing decision, worktree, spawn) | 1.0 s |
| `agent.started` → `node.implemented` (the worker) | 22.0 s |
| `node.implemented` → `verification.requested` (clean checkout, transcript upload) | 3.0 s |
| `verification.requested` → `verification.completed` | 0.7 s — `test` 110 ms, `shape` 37 ms, the rest being the two log uploads |
| `verification.completed` → the integration checkpoint | 0.3 s |
| `run.created` → `run.completed` | 58.6 s |

Worth separating the first two rows: the 11.8 s is a model composing a
delegation, and the 1.0 s is Nightshift. Ten `tool.called`/`tool.completed`
pairs in between.

**Read back with a fresh token, from a different process, API only.** A second
client-credentials token (`jti f202cba7…`, issued 03:02:48Z, not the
orchestrator's) against `GET …/state`, `GET …/events?limit=100`,
`GET …/nodes/<node>/verifications`, `GET …/checkpoints`, `GET …/artifacts` and
`GET …/decisions`. The §4.3 lifecycle reconstructs from the 41 events alone,
numbered densely 0…40 with `pendingEvents: 0`:

```
 0 control-plane run.created          21 hook tool.called
 1 control-plane checkpoint.created   22 hook tool.completed
 2 control-plane run.started          …
 3 mcp           node.delegated       28 mcp  node.implemented
 4 control-plane node.queued          30 hook agent.completed
 5 control-plane agent.created        32 control-plane artifact.recorded
 6 control-plane routing.decided      33 control-plane verification.requested
 7 control-plane node.started         34 control-plane artifact.recorded
 8 hook          agent.started        35 control-plane artifact.recorded
 9 hook          tool.called          36 control-plane verification.completed
10 hook          tool.completed       37 control-plane node.integrated
   … nine more tool pairs …           38 control-plane checkpoint.created
                                      39 mcp  decision.recorded
                                      40 control-plane run.completed
```

**A verification log, from S3 by its recorded URI.** The `test` step's
`logArtifactId` is `art_01M2M2H8R8T0RKYVTMW937W1K6`; the `Artifact` record's
`uri` is `s3://nightshift-dev-data-artifactbucket7410c9ef-rslqnihuwhgm/proj_…/prog_…/run_…/art_…`.
Fetched with `aws s3 cp`: 1130 bytes of TAP output, seven passing subtests
including the four the worker added, and `sha256`
`3e7a85e8…606c65cc` matching the record byte for byte. There is no download
route by design (A-08), so this is exactly the path a human has.

**The operator's checkout.** `program/slice` fast-forwarded `ca36f0c` →
`e31c183`; `main` unmoved at `ca36f0c`; `git status --porcelain` empty;
`refs/nightshift/checkpoints/*` at both commits and
`refs/nightshift/sealed/node_…` at the verified one; `git worktree list` shows
only the checkout itself, and the job's worktree directory under
`~/exit-gate/state/wt/` is empty. The transcript (39,950 bytes) is both on
disk under the state directory and in S3 as an `Artifact`. Nothing Nightshift
wrote landed inside the checkout.

**The one step a human must still run.** `nightshift login` was not exercised
against the real hosted UI, and therefore neither were `nightshift project
create` and `nightshift run` under the operator's own identity. The reason is
not a gap in the CLI: the interactive app client allows
`ALLOW_REFRESH_TOKEN_AUTH` **only**, so a refresh token can be obtained in
exactly one way — the authorization-code flow through Cognito's hosted UI with
the operator's password, which `apps/api/src/admin/user.ts` deliberately never
stores (`AdminSetUserPassword`, typed at a terminal, never printed). An agent
cannot complete it, and the alternatives were both worse than leaving it: an
`AdminSetUserPassword` on the operator's own account, or a throwaway user, and
the client's flow list rules out even that. The exit-gate run therefore used
the **machine** client's credentials grant, which `apps/mcp/src/compose.ts`
supports as a documented path (`NIGHTSHIFT_API_ENDPOINT` +
`NIGHTSHIFT_API_TOKEN`) and which the deployed slice already uses.

What that leaves unproven is the browser leg and the token exchange against
real Cognito. Everything downstream of a session — the ID token on every
request, `custom:active_org`, the org resolution, every route the CLI calls —
is proven against the real handler by `test/src/cli/commands.test.ts`, and the
PKCE flow itself end to end (real loopback listener, real `state` check, the
challenge verified as SHA-256 of the verifier, the files at `0600`) by
`apps/cli/src/commands/login.test.ts`. Three commands, in this order, close
it:

```sh
npm run build
./node_modules/.bin/nightshift login \
  --api https://4xnsx809u6.execute-api.us-west-2.amazonaws.com \
  --auth-domain nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com \
  --client-id hs42ak267ticrk2calntvc7a9
./node_modules/.bin/nightshift whoami
./node_modules/.bin/nightshift project create --name slice-demo
```

`whoami` will print `no_membership` until the operator's sub has one; the
`User` and `Membership` rows from H-P3-02 are already in the table, so it
should resolve. Port 47821 is fixed by the data stack and the CLI says so if
it is taken.

### 13.5 What the first real worker cost us

Two defects, both fixed in `e0d8510`, and neither findable by the scripted
harness — which is the argument for having run this at all.

1. **A paragraph became a commit subject.** `snapshotCommit` handed the
   worker's `job.complete` summary to `git commit -m`, and git makes
   everything before the first blank line the subject. The model's summary was
   one 700-character paragraph. `commitMessageFor` now derives a subject inside
   72 characters and keeps the full text as the body.
2. **The ending was emitted twice.** The adapter emits
   `hookTypeForExit(exit)` through the `HookSink` on `settle`, and the runner
   emitted it again after awaiting `handle.exit` — so the run carried two
   `agent.completed` events, sequences 30 and 31, the second empty. The record
   stays the execution layer's to write; the event now belongs to whoever
   observed it, with the runner's emit as a backstop for a harness that
   reports nothing (D-P3-09 unchanged).

**Nothing had to be changed to prevent the model misbehaving.** It did not
commit, did not edit outside the scope it was given, did not call
`job.complete` before running the tests, and did not touch the Program
Contract. The brief as T1 and T8 wrote it held on the first try, across four
real-model runs (the exit gate plus three `npm run slice` Claude phases).

Two observations recorded rather than fixed:

- **The root node stays `running` after the run succeeds.** §4.3's table
  covers job nodes and says explicitly that "P3 does not decide a run's
  outcome from its nodes"; nothing specifies a terminal status for the program
  node, and inventing one at the exit gate would be settling a rule the
  contract left open. It reads oddly in `GET …/state` — a `succeeded` run with
  a `running` root — and is worth a decision in P4.
- **`RoutingDecision.usage` is `{}` and will stay `{}` in P3.** The record is
  written at `queued`, before the worker runs, and `putRoutingDecision` is
  create-or-confirm — so a second write with usage in it is a 409. The Claude
  adapter *does* see `usage.input_tokens`, `output_tokens` and
  `total_cost_usd` in the `result` frame, and the execution layer knows the
  wall clock; carrying either to the record needs a widened `Harness` port and
  a mutable-or-new route, which is a contract change, not an exit-gate fix.
  D-P3-08's claim that "the dataset for learned routing starts with the first
  job" is true of the choice and its options, and not yet true of the cost.

### 13.6 What the windows runner cost us

CI's windows leg failed twenty tests on the first push, and two of the four
causes were in production code rather than in the suite. Recorded here because
the slice suite is new in T9 and this was its first exposure to a Windows
runner — every earlier program's CI had nothing cross-platform to break.

1. **A child spawned with `PATH` and `HOME` does not start on Windows.** The
   slice suite and the scripted harness each built a small environment by
   hand; without `SystemRoot`, `PATHEXT` and `TEMP` the process dies before it
   runs, and it surfaces as the MCP client's "Connection closed" through
   `cross-spawn`'s ENOENT — which says nothing about environments. Both now
   call `sanitizeEnvironment` from `@nightshift/verification`, the same
   allowlist the verification runner uses. Thirteen of the twenty.
2. **`await import()` cannot take a Windows path.** `NIGHTSHIFT_HARNESS_MODULE`
   carries an absolute path, and the ESM resolver reads `C:` as a URL scheme
   and refuses it. `harnessModuleSpecifier` in `apps/mcp/src/compose.ts`
   converts a path to a `file://` URL and leaves a bare package name alone.
3. **Line endings were the machine's, not Nightshift's.** `identityOverrides`
   now carries `core.autocrlf=false` and `core.eol=lf`. This is the one worth
   reading twice: A-29 says Nightshift owns every commit, and owning a commit
   means owning its bytes. `completeJob` snapshots a worktree and
   `cleanCheckout` materialises that same commit again for verification — and
   with `autocrlf=true`, the Windows default and the runner's, those are not
   the same bytes. A worker writes `\n`, verification reads `\r\n`, and a step
   that compares file contents fails for a reason invisible in the diff. A
   repository that declares `text eol=crlf` in `.gitattributes` still gets
   CRLF, because attributes outrank both settings.
4. **Two tests asserted POSIX separators** against paths built with
   `node:path`. Both now build their expected prefixes with `join` too.

Only the third would have been felt by an operator on Windows; the other three
are the suite and one test-only seam. But the third is a data-integrity
property, and it was being left to whatever `git config --global` said.

### 13.7 Observed runs

| Run | Harness | Worker start | Settled | Artifacts |
|-----|---------|--------------|---------|-----------|
| exit gate (`run_01M2M2G1XM…`) | claude | 14.0 s (model deliberation) | 25.6 s | transcript 39,950 B; logs 1,130 B + 0 B |
| slice, scripted | scripted | 700 ms | 3.09 s | logs 824 B + 0 B |
| slice, claude | claude | 626 ms | 25.1 s | transcript 41,438 B; logs 962 B + 0 B |
| slice, scripted (prior) | scripted | 1,367 ms | 4.33 s | logs 825 B + 0 B |
| slice, claude (prior) | claude | 701 ms | 26.5 s | transcript 33,403 B; logs 833 B + 0 B |

The second verification log is 0 bytes every time: the `shape` step is a
`node -e` that prints nothing when it passes, and an empty log is recorded
rather than skipped so a reader finds a log for every step.

`npm run slice` ran twice end to end, both phases green both times; the
second run's setup found no leftovers from the first, which is what confirms
cleanup. `routing p3-fixed chose claude-sonnet-5` in every run;
`wasOverride: true` in the exit-gate run because the orchestrator named the
model, which the policy allowed.

### 13.8 The gates

| Gate | Result |
|------|--------|
| `npm run build` | clean |
| `npm run typecheck` | clean |
| `npm run lint` | clean, 329 files |
| `npm test` | **88 files, 1,653 passed, 1 skipped**, ~32 s, no credentials, green on **ubuntu and windows** |
| `npm run check:architecture` | 21 files, 279 tests |
| CI (`verify`, ubuntu + windows matrix) | both legs green on `9e3ae16` |
| `npm run check:sterility` | 5 rules, 0 offenders, 376 tracked files |
| `npm run synth` | both stacks |
| `AWS_PROFILE=nightshift npm run smoke` | 67 passed, twice consecutively (SC-P3-17) |
| `AWS_PROFILE=nightshift npm run slice` | 2+2 passed, twice consecutively |

The one skipped test is the identity section of the port conformance suite
under the http adapter, skipped **with the reason in its name** (the T2
amendment in §12), never silently.

### 13.9 Discharging the success criteria

| Criterion | Where it is proven | Status |
|-----------|--------------------|--------|
| SC-P3-01 delegation requires a valid Job Contract | `test/src/slice/refusals.test.ts`; `apps/mcp/src/orchestrator.ts` parses before it writes | pass |
| SC-P3-02 record exists before the worker starts | `test/src/execution/lifecycle.test.ts` ("has the job, the node and the agent in the control plane before the worker starts"), via `onStart`; `test/src/slice/integrated.test.ts` | pass |
| SC-P3-03 isolated worktree | `lifecycle.test.ts`, `slice/integrated.test.ts` | pass |
| SC-P3-04 no worker edit in the program checkout before integration | `lifecycle.test.ts` ("leaves the program checkout alone until integration") | pass |
| SC-P3-05 progress events during execution | `lifecycle.test.ts`, `slice/integrated.test.ts`; 10 `tool.called`/`tool.completed` pairs in the exit-gate run | pass |
| SC-P3-06 worker-reported success is not verification | `lifecycle.test.ts` ("implemented but not verified at completion"); `test/src/harness/worker.ts` | pass |
| SC-P3-07 failing tests block integration | `test/src/execution/failures.test.ts`, `test/src/slice/failures.test.ts` (`implement-broken`) | pass |
| SC-P3-08 passing tests produce a sealed commit | `slice/integrated.test.ts`; `refs/nightshift/sealed/node_…` present in the exit-gate clone | pass |
| SC-P3-09 verified commit integrates | `slice/integrated.test.ts`; exit gate `ca36f0c` → `e31c183` | pass |
| SC-P3-10 checkpoint follows integration | `slice/integrated.test.ts`; exit gate `ckpt_01M2M2H9GM…` | pass |
| SC-P3-11 a killed worker leaves durable state | `test/src/slice/interruption.test.ts`, `execution/failures.test.ts`, `harness-claude/src/adapter.test.ts` | pass |
| SC-P3-12 hook events without the worker's cooperation | `slice/interruption.test.ts`; the `silent-exit` script calls nothing and prints nothing and still yields `agent.started` and `agent.failed` | pass |
| SC-P3-13 out-of-scope change never integrates | `execution/failures.test.ts`, `slice/failures.test.ts` (`out-of-scope`) | pass |
| SC-P3-14 no harness-specific import above the adapter layer | AR-2 over the tracked tree in `test/src/architecture/`, plus negative fixtures; pointed at by `slice/offline.test.ts` | pass |
| SC-P3-15 `npm test` proves 01…14 offline | `slice/offline.test.ts` asserts the endpoints are all `127.0.0.1`, that no `AWS_*` variable reaches the server, and that the default target is `local`; green on both CI legs as of `9e3ae16`, which took four fixes (§13.6) | pass |
| SC-P3-16 the deployed slice, orchestrator included | §13.4 — a real Claude orchestrator through the skill, a real Claude worker, the deployed plane, read back from the API alone | **pass, with the `nightshift login` leg deferred to a human** (§13.4) |
| SC-P3-17 the smoke suite against the redeployed stack | `npm run smoke`, 67 tests, twice consecutively; every P1 and P2 gate unchanged | pass |

### 13.10 Carried forward

- `nightshift login` by hand (§13.4). Until then, the CLI's interactive leg is
  proven only offline.
- The root node's terminal status and `RoutingDecision.usage` (§13.5), both
  for P4/P6.
- The P2 open items still stand: budget email delivery unconfirmed,
  point-in-time recovery off.
- O-02, O-03, O-05 and O-06 untouched. O-04 resolved in P3
  (`docs/architecture.md`).
- The exit-gate run's records are still in the table and the bucket, under the
  identifiers in §13.4. The machine principal's membership in that org was
  released after the run so the slice suite's "one org" guard stops tripping
  on it; re-add a `Membership` row for the org to read it back through the API.
  `~/exit-gate/` holds the clone, the state directory and the transcript.
