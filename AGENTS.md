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

TypeScript monorepo (npm workspaces), Node.js, AWS CDK v2, MCP

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
decisions deliberately left open (O-01 … O-06). If your work depends on one,
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
- IDs: prefixed ULIDs (`proj_`, `prog_`, `run_`, `node_`, `job_`, `agent_`,
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
- CDK stacks are named `nightshift-<stage>-control-plane`. `stage` defaults to
  `dev` and is overridden with `-c stage=...`.
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
| @modelcontextprotocol/sdk | pin in P3 (1.30.0 observed 2026-09-13) | P3 |

`fast-check` and `vitest` are also declared on `@nightshift/test`, which needs
them at build time because its generators and conformance suites are built
modules rather than test files.

Populate this table as each program introduces its dependencies. An unpinned
version in this table is a gap, not a default.
