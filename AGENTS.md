<!-- BEGIN UNIVERSAL -->
# Agent Directives: Universal

These directives apply to every agent working in this repository, regardless
of provider or harness.

## Scope and depth

1. SPEC-FIRST: When a task spec exists under `tasks/`, read it before
   implementing. Do not invent architecture that contradicts the spec or
   `docs/vision.md`. If the spec is ambiguous, ask — do not guess.

2. ROOT CAUSE OVER SYMPTOM: Prefer the smallest diff that fully solves the
   root cause, not the smallest diff that makes symptoms disappear. When the
   proper fix is out of scope, say so explicitly and propose it as a
   follow-up instead of silently shipping a band-aid.

3. STRUCTURAL FIXES STAY IN SCOPE: If architecture is flawed, state is
   duplicated, or patterns are inconsistent inside the files the task already
   touches, fix it. Do not expand into unrelated modules without asking. On
   question-only or review-only tasks, answer — do not rewrite code unless
   asked.

## Verification

4. VERIFY BEFORE CLAIMING COMPLETION: A successful file write proves nothing
   about correctness. Before reporting a task complete, run the project's
   configured build, type-check, test, and lint commands and fix every
   resulting error. If one of those commands is not configured, state that
   explicitly instead of claiming it passed.

## Edit safety

5. READ BEFORE EDITING: Read a file before modifying it, and re-read any file
   you have not seen recently in a long session before editing it again.

6. EXHAUSTIVE RENAMES: When renaming any function, type, or variable, search
   for direct references, type-level references, string literals, dynamic
   imports, re-exports, and test files. Do not assume one search pass caught
   everything.

## Large tasks

7. WORK IN VERIFIABLE PHASES: Break multi-file work into phases that each
   pass verification on their own. In interactive sessions, pause between
   phases for review; in automated pipeline runs, complete and verify each
   phase before starting the next.

8. PARALLELIZE INDEPENDENT WORK: When the harness supports sub-agents and the
   task spans many independent files, split the work rather than degrading a
   single context; keep tightly coupled changes together.
<!-- END UNIVERSAL -->

---

## Project: Nightshift v1

See `docs/vision.md` for the full product vision.
See `docs/architecture.md` for settled and open architectural decisions.
See `docs/programs/staging.md` for how v1 is split into programs.
See `docs/programs/` for program plans and manifests.
See `tasks/{program-id}/` for task specs.

### Greenfield Boundary — read first

**This is a greenfield implementation. Do not inspect legacy branches, tags,
commits, or prior Nightshift source unless explicitly instructed by a human.**

Nightshift v1 begins from an orphan `v1` branch with a new root commit. It
deliberately inherits nothing from v0. Concretely, you must not:

- check out, diff, `git show`, `git log`, or otherwise read any branch other than
  the current program branch and its base — this includes `main`, `origin/*`,
  `program/*`, `nightshift/*`, and every `v0.*` tag;
- restore, copy, or "port over" any v0 file, module, schema, config, manifest,
  task spec, skill, or directive;
- cite v0 behaviour as precedent, justification, or a compatibility requirement;
- use a v0 file as a template for its v1 equivalent, even loosely.

Accidental architectural inheritance is the specific failure this rule exists to
prevent. If a design question feels like it has a known answer from prior
Nightshift work, that instinct is not evidence — derive the answer from
`docs/vision.md`, `docs/architecture.md`, and the program plan, or surface it as a
decision.

Legacy refs remain in the repository solely for deliberate human reference. A
human may explicitly instruct you to consult one; absent that instruction, treat
them as absent.

**Nightshift v1 does not dogfood itself.** No Nightshift tooling of any version
plans, executes, verifies, or reviews v1 delivery. In particular, do not invoke
Nightshift skills installed at the user level, do not read or recreate a
`nightshift.config.json`, and do not expect a `docs/as-built.md`. A human plans
each program in an ordinary coding-agent session; the resulting Program Contract
lives under `docs/programs/` and task specs live under `tasks/{program-id}/`.

### Tech Stack

TypeScript monorepo (npm workspaces), Node.js, AWS CDK v2, MCP, Claude Code as
both orchestrator and worker (`claude -p`, pinned in
`packages/harness-claude/src/command.ts`).

### Product

Autonomous engineering control plane: controlled delegation, deterministic
verification, model routing, and reversible decisions for frontier coding agents.

### Conventions

Repository layout is fixed by `docs/architecture.md` §1. Place new code according
to that layering; if something does not fit, that is a decision to surface, not a
directory to invent.

```text
apps/        api, cli, mcp, studio (reserved — not built in v1)
packages/    contracts, core, persistence, execution, routing,
             verification, harness, harness-claude, harness-codex,
             harness-agentcore
infra/cdk/   AWS CDK v2 — the sole IaC system
skills/      nightshift skill
docs/        vision.md, architecture.md, programs/
test/        cross-package fixtures and conformance suites
```

**Dependencies point downward only.**

- `contracts` and `core` import nothing external: no AWS SDK, no MCP SDK, no
  harness, no network. Their tests run fully offline.
- `persistence` is the only layer permitted to import the AWS SDK for data access.
- Provider-specific code lives **only** inside a `harness-*` package. No
  harness-specific import may appear in the execution scheduler or anything above
  the adapter layer. This is enforced by architecture tests — do not weaken them.
- `infra/cdk` is production code and carries the same testing requirements as
  application code.

**Invariants that must never be softened to make an implementation pass:**

- `implemented ≠ verified`. Worker completion and Nightshift verification are
  separate states. Only Nightshift asserts verification, and unverified work never
  integrates.
- Nothing executes without a Nightshift execution identity.
- Every aggregate is project scoped: `projectId` / `programId` / `runId`.
- Children may narrow inherited authority; never widen it. Enforce structurally,
  not by prompt.
- Large output goes to S3, never DynamoDB.
- An irreversible external effect is never recorded as reversible.

**Open decisions are not yours to settle.** `docs/architecture.md` §3 lists
decisions deliberately left open (O-02, O-03, O-05, O-06; O-01 and O-04 are
resolved). If your work depends on one,
surface it as a Nightshift decision for human ratification. Do not pick a default
and proceed silently.

**Contract authority.** You may continuously revise your implementation plan. You
may not revise a Program Contract to make your implementation pass.

**Conventions ratified for P1 (Foundation) on 2026-09-13.** Full rationale and
decision IDs live in `docs/programs/p1-foundation.md` §Ratified decisions.

- Workspace: npm workspaces, TypeScript project references, `strict: true`,
  Node 22 runtime. Package names are `@nightshift/<dir-name>`.
- Formatter and linter: Biome, one config at the repo root. No ESLint, no
  Prettier.
- Tests: vitest; property tests with fast-check. Test files sit beside the code
  they test as `*.test.ts`; cross-package fixtures live under `test/`.
- Contract schemas: zod. Every persisted record carries a literal
  `schemaVersion`.
- IDs: prefixed ULIDs (`org_`, `proj_`, `prog_`, `run_`, `node_`, `job_`, `agent_`,
  `dec_`, `ckpt_`, `ver_`, `exam_`, `route_`, `art_`, `evt_`). ID generation
  takes an injected clock and randomness source so tests are deterministic.
- Naming: kebab-case files, PascalCase types, camelCase fields.
- Module boundaries: persistence **port** interfaces live in `packages/core`.
  `packages/persistence` exposes `./memory` (test-only, no AWS import) and
  `./aws` (DynamoDB/S3, P2). Nothing above `persistence` imports `./aws`
  directly.
- CI: GitHub Actions on push and pull request, ubuntu and windows matrix.
  Every check in the Deterministic Verification list of the active program
  contract runs in CI.
- Scripts must run on Windows (Git Bash) and Linux. Repo scripts are Node
  scripts, not shell scripts.
- `.gitattributes` pins `eol=lf` for every text file, so the working tree is LF
  on every platform regardless of a developer's `core.autocrlf`. Biome's
  `lineEnding: "lf"` depends on it: a CRLF checkout makes the formatter reject
  every file in the repository. Do not relax the formatter to work around it.
- CDK stacks are `nightshift-<stage>-data` (stateful: table, bucket, user pool,
  budget; termination protection on), `nightshift-<stage>-api` (stateless) and
  the unstaged `nightshift-dns` (the hosted zone; P3 T11),
  per D-P2-07. `stage` defaults to `dev` and is overridden with `-c stage=...`.
  The API stack reads the data stack only through its CloudFormation export names
  (`dataExportName`), never through a construct reference.
- **Vitest project configs do not inherit the root `test` options.** A package
  with its own `vitest.config.ts` must restate `testTimeout`, `hookTimeout` and
  the `dist` exclusions. A package without one inherits the root's, including
  `passWithNoTests`. The `test` package pins its project name to `test` so
  `--project test` selects it rather than matching nothing.
- Test-only libraries (fast-check, vitest) may not appear in `contracts` or
  `core`, whose runtime surface is limited to zod and ulid. Generators and
  conformance suites that need them live in `@nightshift/test`; the
  dependency-free fixture builders live in `@nightshift/core`'s `testing` module.
- Conformance suites live in `test/src/conformance/` and are shared across
  adapters. An adapter that cannot pass one unchanged is a conversation, not a
  reason to edit the suite.

**Conventions ratified for P3 (First Vertical Slice) on 2026-09-15.** Full
rationale and decision IDs live in `docs/programs/p3-vertical-slice.md` §3;
the lasting ones are A-27 … A-32 in `docs/architecture.md`.

- The Nightshift MCP server (`apps/mcp`) is one binary with two roles selected
  by `NIGHTSHIFT_ROLE`. It speaks stdio and opens no socket. The worker role
  requires its execution identity in environment variables and registers no
  delegation tool. (Until P4 lands, a worker also reads the operator's
  credentials file; P4 replaces that with a per-agent execution token and is
  the program that makes orgs a boundary. Do not build on the worker holding
  a human credential.) Nothing local ever holds AWS credentials for the Nightshift
  account; the control plane is reached only through the HTTP API with the
  operator's Cognito **ID** token, via `@nightshift/persistence/http`.
- Persistence now has three adapters: `./memory`, `./aws`, `./http`. The store
  ports are split into project-scoped stores and identity stores; the http
  adapter implements the project half. `ArtifactBodyStore` is a `core` port.
- Composition roots: `apps/mcp/src/compose.ts` is the only module that may
  import a `harness-*` package or `@nightshift/persistence/http`. `execution`,
  `routing`, `verification`, `core` and `contracts` import no adapter and no
  provider SDK. `apps/cli` may reference `core` and `persistence`; `test` may
  reference the packages its suites drive.
- Nightshift owns every commit. Workers never commit. Job completion snapshots
  the worktree into one Nightshift-authored commit with `Nightshift-Run`,
  `Nightshift-Node` and `Nightshift-Job` trailers; out-of-scope changes fail the
  job. Sealed and checkpoint refs live under `refs/nightshift/`. Integration is
  `--ff-only`. Nothing is pushed.
- Only the execution layer writes a `Verification`. No MCP tool creates one.
  Verification runs the Program Contract's steps on a clean checkout of the
  candidate commit with a sanitized environment.
- Events carry their writer: `mcp`, `hook`, `control-plane`. Idempotency keys
  are `<source>:<writerId>:<n>`. Every reader tolerates a null `sequence`.
- Local state lives under `NIGHTSHIFT_STATE_DIR` (worktrees, spool,
  transcripts) and `NIGHTSHIFT_CONFIG_DIR` (profile, credentials, mode 0600).
  Nothing is written into the program checkout except by fast-forwarding its
  branch.
- `npm test` includes the offline slice suite and must stay runnable with no
  AWS credentials, no Claude Code sign-in and no network beyond loopback. The
  real-harness, real-control-plane run is `npm run slice`, opt-in, never in CI.
- Worker permissions vocabulary: `fs.read`, `fs.write`, `shell.exec`, mapped to
  harness tool policy inside the adapter. Workers never get git write access
  and never have a human answering prompts.
- Starting a run is `nightshift run <contract> [--remote]`; the MCP `run.start`
  calls the same function. `--remote` is refused until the remote-runner
  program (P10 after the 2026-09-21 restaging in `docs/programs/staging.md`).
- Public hostnames (D-P3-18): one account-wide, unstaged stack `nightshift-dns`
  holds the hosted zone `nightshift.wildorder.dev` (retained, termination
  protection on). The API is `api.<stage>.nightshift.wildorder.dev`, an alias
  the API stack creates in `full` mode by importing the zone id **by export
  name**. `-c hostnames=zone-only` omits the certificate and domain for a new
  account's first deploy. The CLI ships the rule (`apps/cli/src/hostnames.ts`)
  and `infra/cdk/src/lib/hostnames.ts` restates it; both pin
  `api.dev.nightshift.wildorder.dev` in a test. Never store a generated
  `execute-api` or account-suffixed hostname in a profile; the Cognito hosted
  domain is derived from stage and account and is not branded.
- The Cognito pool never depends on the invitation email: the bootstrap script
  sets a permanent password, the invite template carries the hosted sign-in
  URL, and delivery-error logging is in CDK.
- The interactive app client allows `ALLOW_REFRESH_TOKEN_AUTH` only, so a
  refresh token comes from the hosted UI with the operator's password and from
  nowhere else. **An agent cannot run `nightshift login`.** Never reach for
  `AdminSetUserPassword` on the operator's account to get around it; a machine
  token (`NIGHTSHIFT_API_ENDPOINT` + `NIGHTSHIFT_API_TOKEN`, which
  `apps/mcp/src/compose.ts` accepts) is the supported alternative for anything
  that does not need the operator's own identity.
- A worker's `job.complete` summary is a paragraph, not a subject line.
  `commitMessageFor` shapes it; nothing else should reshape a commit message,
  and nothing may discard the worker's own text.
- An adapter emits the ending it observed; the runner emits one only if the
  adapter did not. The agent **record** is always the execution layer's to
  write. Two emitters for one fact is how the exit-gate run got two
  `agent.completed` events.
- `apps/cli` may not reference `apps/api`. Commands are held to the real
  handler from `test/src/cli/commands.test.ts`, which may reference both.
- Verification logs are recorded for every step, including a step that printed
  nothing — a 0-byte log is the honest record, not a skipped one.

**Conventions ratified for P4 (Identity and Tenancy) and P5 (Harness
Neutrality) on 2026-09-16.** Rationale and decision IDs live in
`docs/programs/p4-identity-and-tenancy.md` §3 and
`docs/programs/p5-harness-neutrality.md` §3; the lasting ones are A-33 … A-38.

- Two principal kinds, `user` and `execution`; the handler receives a typed
  `Principal` and never verifies a token. `authorize(principal, operation,
  target)` in `core` is the one place a principal's reach is decided, and the
  API calls it in one place.
- Every project-scoped route refuses a caller whose org does not own the
  project, before reading anything. Orgs are a boundary from P4 on.
- An execution's `node.put` may only ask for `implemented` or `failed`
  (`EXECUTION_WRITABLE_NODE_STATUSES` in `core`); `authorize` takes the
  requested status and fails closed without one. When a token is granted a
  write, decide what the body may say as well as which route it may call.
- Workers hold only an execution token (`NIGHTSHIFT_EXECUTION_TOKEN`), minted by
  the control plane and signed by KMS; they never read `credentials.json` and
  their environment never carries `NIGHTSHIFT_CONFIG_DIR`. Never log a token.
- The API's authorizer is Nightshift's Lambda authorizer; every route is bound
  to it and none is anonymous.
- Adapter contract v1: `HarnessStartInput.tools: WorkerTools` beside
  `mcp: McpLaunch`; adapters report `usage` on exit; one implementation of the
  worker operations in `packages/execution/src/worker.ts`.
- Routing chooses `(harness, provider, model)` from `HARNESS_COMPATIBILITY` in
  `packages/routing`, intersected with the Program Contract's policy; never a
  one-to-one provider→harness map. The human picks the orchestrator's model;
  Nightshift picks workers'; an orchestrator's request is an override within
  policy.
- **Workers run with permissions bypassed, and no adapter passes a list of
  allowed tools** (owner's ruling, 2026-09-19, A-39, amending D-P3-15 and D-P5-02). Limit a
  worker's reach by the environment it runs in, never by a list.
  Claude: `--permission-mode bypassPermissions`, no `--tools`, no
  `--allowedTools`. Codex: `--dangerously-bypass-approvals-and-sandbox`. A worker
  must never stop for approval or be denied a tool nobody listed. Do not
  reintroduce an allow-list, a sandbox mode or an approval policy in an adapter.
  `--approve-for-me` is not used.
- `ExecutionNodeStatus.succeeded` is legal for `program` and `sub-program`
  nodes only. A job node's table, and the A-05 property tests, are untouched.
- The AgentCore harness worker, Bedrock, and anything that runs on a runtime
  instance belong to P10. Nightshift never runs a worker as a per-job hosted
  environment.

**As built for P6 (Parallel and Recursive Execution), 2026-09-20.** The details
a later program needs and cannot derive; full account in
`docs/programs/p6-parallel-recursive.md` §12 and §13. The lasting decisions are
A-40 and A-41.

- **Delegation is a record; the engine starts work.** `delegate` (root or
  sub-orchestrator) writes a Job Contract and a node and returns. One `Engine`
  per run (`packages/execution/src/engine.ts`), in the root orchestrator's
  process, starts a `queued` node when `core`'s `maySlotStart` says its parent
  has a slot. Nothing else starts, verifies or integrates anything. A queued node
  has no agent, token or worktree.
- **The concurrency limit is the start edge's, per parent.** The API refuses
  `queued → running` past the limit (429, "not yet"), and no longer refuses node
  creation for concurrency. `checkDelegation` and its P1 property are unchanged;
  `checkAuthority` is the same rule asked with concurrency held open. **Do not
  change a P1 rule to make P6 work: nothing in P6 needed to.**
- **The merge queue is the only route to the program branch**
  (`packages/execution/src/merge-queue.ts`): reconcile onto the current head,
  **verify there**, seal, fast-forward, checkpoint, one node at a time, in
  `core`'s `nextToIntegrate` order among what is ready *now*. Never verify a node
  anywhere but on the commit that will land, and never move a verified node's
  commit. A conflict is `integration_conflict` with the paths, and **Nightshift
  never resolves one**. `runJob` without an engine still integrates inline, and
  is only correct with one job in flight.
- **Sub-programs.** `delegate { kind: "sub-program" }` starts an
  `orchestrator`-role agent through the same adapters, in MCP role
  `sub-orchestrator` (`apps/mcp/src/sub-orchestrator.ts`), with a **delegating
  execution token** (`role: "orchestrator"`), a detached checkout to read, and
  nothing to integrate. It has a Job Contract like a job. It ends `succeeded` or
  `failed`; the engine cancels its subtree when its process goes.
- **`authorize` has two tables**, `EXECUTION_ACCESS` (worker) and
  `ORCHESTRATOR_ACCESS`, both exhaustive over `Operation`. A delegating token
  reaches only its own subtree, and where a node stands (`NodeRelation`) is
  resolved by `enforce` **from the stored tree, never from the request**. It may
  ask a node to be: `validated` (a new child of its own node), `cancelled` or
  `queued` (a descendant: stop, or retry), `succeeded` or `failed` (itself).
  Never `running` or anything past it. Add an operation and you decide it in
  both tables, with a cell in both `authorize*.test.ts` files.
- **A sub-orchestrator has no channel to the engine but the control plane.** The
  engine reads the run's nodes once a second while one is running and adopts what
  it finds. Do not add a socket, a port or an IPC path: P10 and P11 depend on this
  being the only channel.
- No program or sub-program node may end `succeeded` while anything under it is
  unsettled (`mayEndProgramNode`, enforced by the API). `core`'s `isSettled` is
  the one definition of settled; use it rather than a local list.
- A retry is a new attempt at the same node: fresh worktree from the current
  head, new agent, `RoutingDecision.attempt + 1` linked by `previousRouteId`. The
  API lets `outcomeReason` be cleared on the `retry` edge and nowhere else.
- **A process outlives its node's ending** with a real model. `run.finish` calls
  `engine.releaseSettled`, which waits briefly for such a process and then stops
  it, and never touches one whose node is in flight.
- The scripted harness picks a job's script from a tag at the front of its
  objective (`[add-module alpha wait=2 group=root]`), and barriers between worker
  processes are files under the state directory. **Assert concurrency from the
  event sequence, never from timing.** A run has more events than one page.
- `npm run slice` ends with a **tree** phase (`apps/api/src/smoke/tree.smoke.ts`):
  both real adapters at once and a real sub-orchestrator, against the deployed
  plane. `NIGHTSHIFT_TREE_MAX_CONCURRENCY=1` forces it serial for the benchmark.
  `npm run benchmark:parallel` is the scripted one. Smoke is 86 tests.

**As built for P5 (Harness Neutrality), 2026-09-19.** The details a later
program needs and cannot derive; full account in
`docs/programs/p5-harness-neutrality.md` §12 and §13.

- The worker operations have **one implementation**, `createWorkerTools` in
  `packages/execution/src/worker.ts`, and two callers: the worker-role MCP server
  and `HarnessStartInput.tools`. The function form is built over
  `ExecutionEnvironment.workerEnvironment(launch)`, which the composition root
  supplies: stores and an outbox holding **that worker's execution token and
  nothing else**. Never call a worker operation with the orchestrator's stores.
- An adapter uses exactly one transport per worker. Both local adapters use the
  MCP launch and never call `input.tools`.
- `succeeded` is **not in the node transition table**: no event reaches it and
  `transition()` cannot produce it. `maySucceed` and `finishRun` in `core` are
  the only way in, for a `running` program or sub-program node; the API refuses a
  node created as `succeeded`. Legality in the table still depends on status and
  event alone (SC-P1-15). Do not add a kind guard to the table.
- A `RoutingDecision` may be updated once: `usage` from empty, `outcome` from
  `pending` (`explainRoutingUpdate` in `core`). The runner does both in one write
  when a job settles, and always records its own `wallClockMs`.
- **Token counts are not comparable across harnesses.** Claude's `inputTokens`
  excludes cache reads; Codex's includes cached input and carries no cost on a
  ChatGPT login. `RouteUsage` records what each harness said. Normalising is
  P8's job.
- What bounds a worker is **not** the harness: A-29 (Nightshift owns every
  commit and checks every changed path against scope before integrating), the
  execution token, and the environment allowlist. `Scope.permissions` is told to
  the worker and reported, not enforced. A worker can write outside its worktree
  and reach the network; on the operator's machine it is trusted as the operator
  is, until P10.
- The one list that remains is a **deny** of git write commands, on both
  adapters: Claude's `--disallowedTools` patterns (verified to hold in
  `bypassPermissions`), and for Codex a `git` guard script on
  `shell_environment_policy.set` with `allow_login_shell=false`. **Never put the
  guard on the Codex process's own `PATH`**: the worker's MCP server inherits it
  and `job.complete` needs the real `git`. It is a courtesy; A-29 is the
  enforcement.
- Codex, measured on 0.154.0: a `SIGTERM`ed `codex exec` exits 0, so completion
  is exit 0 **and** `turn.completed`.
- `apps/mcp/src/compose.ts` names both adapters and builds one only when a route
  first chooses it (`createRoutedHarness`). `NIGHTSHIFT_HARNESS_MODULE` still
  replaces the lot, for the scripted harness.
- Two conformance suites: `test/src/conformance/harness.ts` (version 0, a
  handle's lifecycle) and `adapter.ts` (version 1, three fixture jobs and the
  nine Stage 4 items, read from the control plane). `npm test` runs version 1
  over the scripted harness on both transports. `npm run conformance -- --harness
  claude|codex|all` runs it for real against the deployed plane;
  `NIGHTSHIFT_CONFORMANCE_HARNESS=codex npx vitest run
  test/src/harness/adapter-conformance.test.ts` runs it against the local plane,
  on the system clock, because the stepping clock expires a real worker's token.
- When a real worker fails a fixture, read its transcript before touching the
  suite: both P5 failures were Nightshift's, and the worker said so.

**As built for P4 (Identity and Tenancy), closed 2026-09-17.** The details a
later program needs and cannot derive; full account in
`docs/programs/p4-identity-and-tenancy.md` §12.

- `Operation` in `packages/core/src/rules/authorize.ts` is a closed union with
  **one member per API route**, and `EXECUTION_ACCESS` is a `Record` over it, so
  adding a route without deciding what an execution may do with it is a type
  error. `apps/api/src/route-table.test.ts` holds the two halves total against
  each other in both directions. Add a route and you add an operation, a table
  entry, and a cell in `packages/core/src/rules/authorize.test.ts`.
- `enforce` in `apps/api/src/auth/enforce.ts` is the **only** caller of
  `authorize`, and `handleRequest` is its only caller. Nothing else may check a
  principal; an operation that wants to is a sign the target is missing
  something.
- Two of a worker's three writes name their node in the **body**, not the path
  (`event.append`, `decision.put`). `targetFrom` reads `executionNodeId` from
  the body when the path names no node. Do not move that check into those
  routes.
- The project → org cache **never caches a miss**. Remembering "no such project"
  leaves a window in which a newly created project is invisible to the check and
  every caller sails past it.
- The execution-token key is **RSA-2048 / RS256**, asymmetric sign/verify,
  retained, in the data stack. Verification is the hot path and KMS returns
  ECDSA signatures DER-encoded where JOSE wants raw `r‖s`. Do not switch to ECC
  without re-reading `apps/api/src/tokens/mint.ts`.
- The gateway answers **401** when the `Authorization` header is absent (the
  request never reaches the authorizer) and **403** when the authorizer denies.
  That is API Gateway's choice for a request authorizer, not Nightshift's; the
  JWT authorizer gave 401 for both.
- `@nightshift/api/testing`'s local control plane signs and verifies execution
  tokens with a process-wide key pair and routes bearers by `iss`, exactly as
  the deployed authorizer does. A suite switches caller with
  `encodeTestPrincipal(...)` as a bearer; anything else falls through to the
  plane's default principal.
- A worker's environment is the seven identity variables, the execution token
  and the API endpoint — and **nothing else**. No `NIGHTSHIFT_CONFIG_DIR`, no
  `NIGHTSHIFT_API_TOKEN`. `apps/mcp/src/compose.test.ts` asserts the absences.
- `npm run smoke` runs two files, `fileParallelism: false`, because both seed a
  membership for the machine principal and two memberships make the acting org
  unresolvable.

### Dependency Versions (pin these)

| Package | Version | Introduced |
|---------|---------|------------|
| typescript | 7.0.2 | P1 |
| @types/node | 22.20.2 | P1 |
| aws-cdk-lib | 2.269.0 | P1 |
| constructs | 10.8.1 | P1 |
| aws-cdk | 2.1141.0 | P1 |
| vitest | 5.0.0 | P1 |
| fast-check | 4.10.0 | P1 |
| zod | 4.6.4 | P1 |
| @biomejs/biome | 2.5.13 | P1 |
| ulid | 3.0.2 | P1 |
| @aws-sdk/client-dynamodb | 3.1131.0 | P2 |
| @aws-sdk/lib-dynamodb | 3.1131.0 | P2 |
| @aws-sdk/util-dynamodb | 3.996.9 | P2 |
| @aws-sdk/client-s3 | 3.1131.0 | P2 |
| @aws-sdk/client-cognito-identity-provider | 3.1131.0 | P2 |
| @aws-sdk/client-cloudformation | 3.1131.0 | P2 |
| @aws-sdk/client-sts | 3.1131.0 | P2 |
| @types/aws-lambda | 8.10.163 | P2 |
| esbuild | 0.28.2 | P2 |
| @modelcontextprotocol/sdk | 1.30.0 | P3 |
| @aws-sdk/s3-request-presigner | 3.1131.0 | P3 |
| @aws-sdk/client-kms | 3.1131.0 | P4 |

`fast-check` and `vitest` are also declared on `@nightshift/test`, which needs
them at build time because its generators and conformance suites are built
modules rather than test files.

Populate this table as each program introduces its dependencies. An unpinned
version in this table is a gap, not a default.
