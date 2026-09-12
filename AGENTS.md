<!-- BEGIN UNIVERSAL — source: @wildorder/nightshift packaged default -->
# Agent Directives: Universal

These directives apply to every agent working in this repository, regardless
of provider or harness.

## Scope and depth

1. SPEC-FIRST: When a workstream spec exists under `tasks/`, read it before
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
See `tasks/{program-id}/` for workstream specs.

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

**Nightshift v1 does not dogfood itself.** Do not use a prior Nightshift version
to plan, execute, verify, or review v1 delivery.

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
apps/        api, mcp, studio (reserved — not built in v1)
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

**Conventions still to be established by P1 (Foundation):** formatter and lint
configuration, test runner and file layout, naming and ID conventions, module
boundaries within packages, and CI. Record them here as P1 settles them rather
than leaving them implicit.

### Dependency Versions (pin these)

| Package | Version |
|---------|---------|
| aws-cdk-lib | pin in P1 |
| constructs | pin in P1 |
| typescript | pin in P1 |
| @modelcontextprotocol/sdk | pin in P3 |

Populate this table as each program introduces its dependencies. An unpinned
version in this table is a gap, not a default.
