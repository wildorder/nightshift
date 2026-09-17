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
  program (P9 after the 2026-09-16 restaging in `docs/programs/staging.md`).
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
- Codex runs as `codex exec --json` with `approval_policy=never` and the
  `workspace-write` sandbox; `--approve-for-me` is not used.
- `ExecutionNodeStatus.succeeded` is legal for `program` and `sub-program`
  nodes only. A job node's table, and the A-05 property tests, are untouched.
- The AgentCore harness worker, Bedrock, and anything that runs on a runtime
  instance belong to P9. Nightshift never runs a worker as a per-job hosted
  environment.

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

`fast-check` and `vitest` are also declared on `@nightshift/test`, which needs
them at build time because its generators and conformance suites are built
modules rather than test files.

Populate this table as each program introduces its dependencies. An unpinned
version in this table is a gap, not a default.
