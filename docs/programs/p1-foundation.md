# Program P1 — Foundation

| Field | Value |
|-------|-------|
| Program ID | `p1-foundation` |
| Project ID | `nightshift` |
| Repository | `https://github.com/wildorder/nightshift.git` |
| Base branch | `v1` |
| Program branch | `program/p1-foundation` |
| Source stages | Stage 0 (Greenfield Bootstrap, remainder) and Stage 1 (Contracts and Domain Core) |
| Status | Contract ratified 2026-09-13. **Implementation complete 2026-09-13**, pushed to `origin/program/p1-foundation`, pending human review. |
| Planned by | Human in an ordinary coding-agent session. No Nightshift tooling is involved (see `AGENTS.md`). |

This contract is the stable authority for P1. The implementation plan (task
specs under `tasks/p1-foundation/`) may be revised continuously. This contract
may not be revised to make an implementation pass. Amend it only through an
explicit human decision recorded in §11.

## 1. Objective

Turn the empty `v1` branch into a workspace that builds, typechecks, lints,
tests, and synthesizes CDK, and deliver the execution/control model as a
deterministic, offline domain library whose invariants are proven by property
tests. After P1 a human can demonstrate that the domain library refuses to let a
child execution node widen its parent's scope.

## 2. Human prerequisites

### Required before P1 implementation starts

| # | Prerequisite | Why | Status |
|---|--------------|-----|--------|
| H-01 | ~~Push branch `v1` to `origin` and enable GitHub Actions~~ | **Never a prerequisite.** `origin/v1` already existed and Actions was already enabled and running green on this repository. This row was written on an assumption instead of a check. | not applicable |
| H-02 | Create `program/p1-foundation` from `v1`, or authorize the implementing session to create it | Every program runs on its own branch and merges back to `v1` only after the exit gate passes. | satisfied |
| H-03 | Node 22 and npm 10 on the implementing machine | Verified present on 2026-09-13 (Node 22.22.3, npm 10.9.8). | satisfied |

### Explicitly NOT required for P1

**No AWS account, credentials, region, or bootstrap is needed for P1.** The
CDK app is environment-agnostic and `cdk synth` runs fully offline. If any P1
task finds it needs AWS credentials, that task has left P1 scope. Stop and
surface it.

### P2 environment — settled 2026-09-13

v1 runs in **one AWS account**: `755348349819` (`nightshift-prod`) in `us-west-2`.
A deliberate single-account start. The account is treated as a sandbox until
Nightshift is launched and supported; a development account arrives only if and
when that happens. Recorded as A-17 and A-18 in `docs/architecture.md`.

| # | Item | Status |
|---|------|--------|
| H-P2-01 | Which AWS account P2 targets | **settled** — `755348349819` / `us-west-2`, single account, sandbox posture |
| H-P2-02 | A working CLI profile for it | **done** — `[profile nightshift]` with `[sso-session nightshift]`, `AdministratorAccess` (the only permission set assigned), region `us-west-2`. `aws sts get-caller-identity --profile nightshift` resolves to the account. Re-auth with `aws sso login --sso-session nightshift`. |
| H-P2-03 | `cdk bootstrap` in that account and region | **done** — see §12 |
| H-P2-04 | A budget alarm on the account | **open** — not created. A budget notification needs a subscriber address, which is the human's to choose. More important here than it would be with a separate dev account, because there is only one environment. |
| H-P2-05 | Ratify **O-01**: control-plane compute/API shape and client authentication | **open** — a genuine architectural decision (§3 of `docs/architecture.md`). Recommendation on file: Lambda behind an API Gateway HTTP API with IAM SigV4 auth; the local MCP server and CLI sign with the user's AWS credentials. |
| H-P2-06 | Whether this account will also carry Bedrock model spend | **open** — needed by P6. With one account the answer is probably yes, but model access is enabled per region and per model, so it is worth confirming early. |

**What the single-account choice costs.** The original plan wanted a throwaway
development account partly to prove the stack destroys cleanly. v1 drops that
check (A-18): with one account and one user there is nothing to migrate to, so it
earns less than it costs. What is kept is the part that was doing the real work —
every stateful resource declares its removal policy explicitly, because CDK
defaults some of them to `RETAIN` and an unstated policy is one nobody chose.
Stacks holding state carry termination protection. Revisit teardown verification
if a second environment is ever stood up.

## 3. Ratified decisions

All ratified by the human on 2026-09-13. They are settled for v1 unless a later
decision supersedes them. `AGENTS.md` carries the short form.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P1-01 | npm workspaces with TypeScript project references, `strict: true`, Node 22 runtime, package names `@nightshift/<dir-name>` | Matches the fixed monorepo layout; project references give incremental builds and enforce dependency direction at compile time. |
| D-P1-02 | Tests: vitest 5; property tests: fast-check 4; `*.test.ts` beside source; cross-package fixtures under `test/` | One runner for unit, property, CDK assertion, and later integration tests. |
| D-P1-03 | Formatter and linter: Biome 2, one root config. No ESLint, no Prettier. | One tool, one config, fast. Wall clock matters more than tool ubiquity. |
| D-P1-04 | Contract schemas: zod 4. Every persisted record carries a literal `schemaVersion`. | Runtime validation and static types from one definition; delegation validates a Job Contract before persisting it (A-03). |
| D-P1-05 | Pins: typescript 7.0.2, @types/node 22.20.2, aws-cdk-lib 2.269.0, constructs 10.8.1, aws-cdk 2.1141.0, vitest 5.0.0, fast-check 4.10.0, zod 4.6.4, @biomejs/biome 2.5.13, ulid 3.0.2 | Latest published on 2026-09-13. TypeScript 7 is the native compiler; vitest and Biome do not depend on `tsc`, so the only consumers of `tsc` are typecheck and build. If TypeScript 7 blocks project references, fall back to 5.9.3 and record it in §11. |
| D-P1-06 | CI: GitHub Actions on push and pull request, matrix of ubuntu-latest and windows-latest, running every command in §6 | The dev machine is Windows; CI is Linux. Both must pass. |
| D-P1-07 | IDs are prefixed ULIDs (`proj_`, `prog_`, `run_`, `node_`, `job_`, `agent_`, `dec_`, `ckpt_`, `ver_`, `exam_`, `route_`, `art_`, `evt_`). Generation takes an injected clock and randomness source. Files kebab-case, types PascalCase, fields camelCase. | ULIDs sort by time, which suits DynamoDB range keys and event ordering. Injection keeps `core` deterministic under test. |
| D-P1-08 | Persistence **port** interfaces live in `packages/core`. `packages/persistence` exposes `./memory` (test-only, no AWS import) and `./aws` (DynamoDB/S3, built in P2). Nothing above `persistence` imports `./aws` directly. | Lets `execution` and above test offline from P3 onward without any local canonical state (A-06). |
| D-P1-09 | Sterility and architecture checks are custom Node scripts and vitest tests. No dependency-cruiser or similar. | The rules are few and specific. A script is faster to run and to read than a rules DSL. |
| D-P1-10 | The CDK app entry runs compiled JavaScript (`node infra/cdk/dist/bin/app.js`), so `cdk synth` requires `npm run build` first and needs no TypeScript loader | Avoids an extra runtime dependency and keeps synth deterministic. |

## 4. Scope

### In scope

- Root workspace, tooling, and scripts (T1).
- Package skeletons for every directory in `docs/architecture.md` §1, including
  `apps/cli` (A-16) and `apps/studio` as an empty reserved package, each with a
  `package.json`, `tsconfig.json`, and a `src/index.ts`.
- CDK app skeleton with one environment-agnostic stack and CDK assertion tests
  (T2).
- Greenfield-sterility checks and architecture tests (T3).
- CI (T4).
- `packages/contracts`: versioned zod schemas and types for every Stage 1
  aggregate (T5).
- `packages/core`: pure domain rules and persistence port interfaces (T6).
- Property tests for every Stage 1 invariant, and the in-memory persistence
  adapter with its port conformance tests (T7).
- Updating `AGENTS.md` with anything P1 settles beyond what is already recorded.

### Out of scope

- Any AWS resource. The CDK stack in P1 defines **no resources**.
- Persistence adapters for DynamoDB or S3 (P2).
- The MCP server, CLI commands, harness adapters, execution scheduler, routing,
  verification runner, examination, or replay. Their packages exist as empty
  skeletons only.
- Any code path that talks to a network.
- Anything in `docs/architecture.md` §3 (O-01 … O-06).

## 5. Success criteria

Carried verbatim from the source plan. Each is an acceptance criterion, not
prose, and each maps to a deterministic check listed in §6.

### Stage 0 — automated checks prove

- **SC-P1-01** No legacy source files exist on the branch.
- **SC-P1-02** No v0 program/task artifacts exist.
- **SC-P1-03** No v0 configuration schema exists.
- **SC-P1-04** `AGENTS.md` forbids autonomous legacy-history inspection.
- **SC-P1-05** Workspace builds.
- **SC-P1-06** Typecheck succeeds.
- **SC-P1-07** Lint succeeds.
- **SC-P1-08** Empty test suite infrastructure executes.
- **SC-P1-09** `cdk synth` succeeds.

### Stage 1 — unit and property tests prove

- **SC-P1-10** Child nodes cannot widen parent scope.
- **SC-P1-11** Execution trees cannot cycle.
- **SC-P1-12** Jobs cannot move between projects.
- **SC-P1-13** Completed does not imply verified.
- **SC-P1-14** Verified requires verification evidence.
- **SC-P1-15** Illegal state transitions fail deterministically.
- **SC-P1-16** Depth limits are enforced.
- **SC-P1-17** Project IDs scope every aggregate.
- **SC-P1-18** No network or AWS dependency is required for these tests.

### Architecture

- **SC-P1-19** No AWS SDK, MCP SDK, or harness import in `contracts` or `core`.
- **SC-P1-20** No harness-specific import above the adapter layer.
- **SC-P1-21** `@nightshift/persistence/memory` has no AWS import.

### Exit gate

An agent receiving the branch sees only the architecture in `docs/`, and the
execution/control model exists as a deterministic library. Concretely: every
command in §6 exits 0 on a clean checkout on both Windows and Linux, and CI is
green on `program/p1-foundation`.

## 6. Deterministic verification

Run from the repository root on a clean checkout. All must exit 0.

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run synth
npm run check:sterility
```

`npm test` includes the property tests (SC-P1-10 … SC-P1-17), the architecture
tests (SC-P1-19 … SC-P1-21), the CDK assertion tests, and the persistence port
conformance tests. `npm run check:sterility` covers SC-P1-01 … SC-P1-04.
`npm run synth` covers SC-P1-09 and depends on `npm run build` (D-P1-10).

## 7. Constraints

- Dependencies point downward only, exactly as `docs/architecture.md` §1.
- `contracts` and `core` import nothing external except `zod` and `ulid`. No
  AWS SDK, no MCP SDK, no harness package, no network, no filesystem.
- Every dependency version is pinned exactly (no `^`, no `~`). Adding a
  dependency not in D-P1-05 requires recording it in the `AGENTS.md` table.
- All scripts run on Windows (Git Bash) and Linux. Repo scripts are Node
  scripts, never shell scripts.
- No code reaches the network at build, lint, test, or synth time except
  `npm ci`.
- No file may be copied or adapted from any branch or tag other than `v1`
  (A-01). The sterility check is the enforcement, not this sentence.

## 8. Permissions and forbidden actions

Permitted: creating and editing files under the repository, running the §6
commands, installing the pinned dependencies, committing to
`program/p1-foundation`.

Forbidden:

- Reading, checking out, or diffing any ref other than `program/p1-foundation`
  and `v1`.
- Installing, invoking, or configuring any Nightshift tooling of any version.
- Creating AWS resources, or reading AWS credentials.
- Pushing to `v1` or `main` directly. Integration into `v1` is a human-reviewed
  merge after the exit gate.
- Weakening any check in §6 or any invariant listed in `AGENTS.md` to make a
  task pass.
- Settling any open decision O-01 … O-06.

## 9. Model, examination, delegation, and cost policy

P1 is delivered by a human working with a frontier coding agent in an ordinary
session, so these Program Contract fields are informational rather than
enforced by Nightshift.

- **Model/provider:** frontier model of the human's choosing. Delegation to
  sub-agents within the session is permitted for independent tasks (T2, T3, T5
  may run in parallel after T1).
- **Examination:** human review of each task's diff before it merges to the
  program branch, with T6 and T7 (the invariants) receiving the closest read.
- **Delegation limits:** none enforced. Keep tightly coupled changes (T6 and T7)
  in one context.
- **Cost:** no spend beyond existing subscriptions. Wall clock is the cost that
  matters.

## 10. Tasks and sequencing

| Task | Title | Depends on |
|------|-------|------------|
| T1 | Workspace scaffold and tooling | — |
| T2 | CDK app skeleton and assertion tests | T1 |
| T3 | Sterility check and architecture tests | T1 |
| T5 | Contracts: versioned schemas and types | T1 |
| T4 | CI workflow | T1, T2, T3 |
| T6 | Core: domain rules and persistence ports | T5 |
| T7 | Property tests and in-memory persistence adapter | T6 |

```text
T1 ──┬── T2 ──┐
     ├── T3 ──┼── T4
     └── T5 ──── T6 ── T7
```

T2, T3, and T5 are independent and may run in parallel. T4 must run last among
the Stage 0 tasks so CI exercises the real checks. T6 and T7 are one line of
work and should stay in one context.

Specs live in `tasks/p1-foundation/`.

## 11. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-13 | Contract ratified, including D-P1-01 … D-P1-10 | Human |
| 2026-09-13 | TypeScript 7.0.2 confirmed working with `tsc -b` project references under npm workspaces, so the D-P1-05 fallback to 5.9.3 was not needed | Implementation |
| 2026-09-13 | ulid 3.0.2 has no `factory` export; `monotonicFactory(prng)` is the injection point. Verified deterministic and lexicographically ordered under a fixed clock and seed, so D-P1-07 stands as ratified | Implementation |
| 2026-09-13 | `ExecutionNode` gained `commitSha`. Without it, matching a verification to a node required the caller to assert the two belonged together, which is the assertion SC-P1-14 exists to check | Implementation |
| 2026-09-13 | The fast-check generators and the port conformance suite live in `@nightshift/test`, not `packages/core`, because both are built modules and importing a test library from `core` would add it to `core`'s runtime surface (architecture §1). The dependency-free fixture builders stayed in `core`. Deviates from T7 and T3's stated paths | Implementation |
| 2026-09-13 | Architecture rule AR-6 added beyond the T3 spec: every external dependency pinned exactly, enforcing contract §7 | Implementation |
| 2026-09-13 | `vitest` project configs do not inherit the root `test` options. Packages with their own config restate timeouts and exclusions, and the `test` package pins its project name so `--project test` selects it | Implementation |
| 2026-09-13 | Concurrency is enforced per parent, not run-wide, following T6's wording. A run-wide cap is scheduler policy and belongs to P5's execution layer, not to `core` | Implementation |
| 2026-09-13 | `interrupted` was added to the retryable set beyond T6's minimum table, so killing a worker leaves recoverable state rather than a dead end (architecture §4) | Implementation |

## 12. As built

Every gate in §6 exits 0 on a clean checkout on Windows. 658 tests across 22
files. `npm run verify` runs the whole chain.

| Criterion | Discharged by |
|-----------|---------------|
| SC-P1-01 … SC-P1-04 | `npm run check:sterility`; each rule tags the criteria it covers, visible in `--json` |
| SC-P1-05 … SC-P1-09 | `npm run build`, `typecheck`, `lint`, `test`, `synth` |
| SC-P1-10 | `test/src/properties/scope.property.test.ts`, stated as a biconditional with both directions generated plus a dimension-coverage assertion |
| SC-P1-11, SC-P1-12 | `test/src/properties/execution-tree.property.test.ts` |
| SC-P1-13 … SC-P1-15 | `test/src/properties/verification.property.test.ts`, plus the exhaustive 14×15 table enumeration in `packages/core/src/rules/transitions.test.ts` |
| SC-P1-16 | `test/src/properties/delegation.property.test.ts` |
| SC-P1-17 | `test/src/properties/project-scoping.property.test.ts`, driven from the contracts registry |
| SC-P1-18 | `test/src/architecture/offline.test.ts`, probed to confirm it detects both a network import and a bare `fetch` call |
| SC-P1-19 … SC-P1-21 | `test/src/architecture/` rules AR-1 … AR-6, each with a negative fixture |

Four defects were found and fixed by the checks that were meant to catch them:
the cycle check in `addChild` was unreachable behind the duplicate check; glob
containment treated a wildcard segment as a literal; the fixture builder let two
independent worlds mint identical identifiers, which would have made a Project A
versus Project B isolation test pass while proving nothing; and the missing
`eol=lf` pin broke lint on any Windows checkout, which only CI could reveal.

One process failure is worth recording too. H-01 and the original P2
prerequisite table were both written from assumption rather than from a check.
`origin/v1` already existed, Actions was already enabled and green, and sixteen
AWS profiles were already configured. Verify the environment before writing a
prerequisite into a contract.

**AWS environment (A-17).** One account, bootstrapped 2026-09-13.

| Item | Value |
|------|-------|
| Account | `755348349819` (`nightshift-prod`) |
| Region | `us-west-2` |
| CLI profile | `nightshift`, via `[sso-session nightshift]`, role `AdministratorAccess` |
| CDK bootstrap | `CDKToolkit` `CREATE_COMPLETE`, bootstrap version 32 |
| Termination protection | enabled on `CDKToolkit` |
| Asset bucket | `cdk-hnb659fds-assets-755348349819-us-west-2` |
| Execution policy | `arn:aws:iam::aws:policy/AdministratorAccess` |
| Trusted accounts | none — single account, so no cross-account trust was granted |

`cdk bootstrap` was run with `--termination-protection` deliberately: with one
account there is no spare environment, so losing the toolkit stack would be
losing the only deploy path. Still open: a budget alarm (H-P2-04), which needs a
notification address to send to.

**CI:** green on `program/p1-foundation`, both legs, every gate.

| Runner | Build | Typecheck | Lint | Test | Synth | Sterility |
|--------|-------|-----------|------|------|-------|-----------|
| ubuntu-latest | pass | pass | pass | pass | pass | pass |
| windows-latest | pass | pass | pass | pass | pass | pass |

The first run failed on Windows only, at lint. With no `.gitattributes`, the
runner's default `core.autocrlf=true` rewrote every file to CRLF on checkout and
Biome's `lineEnding: "lf"` rejected all of them. It had passed locally only
because the dev machine has `core.autocrlf=input`. Fixed by pinning `eol=lf`
rather than by relaxing the formatter. This is the whole argument for keeping the
Windows leg: a green local run on one developer's machine proved nothing about
the other platform.
