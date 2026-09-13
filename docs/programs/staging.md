# Nightshift v1 — Program Staging

> **Recommendation, not decree.** `00-source-program-plan.md` defines eleven
> stages (0–10). This document groups them into **nine programs**, each with a
> single demonstrable exit capability, and states why each boundary falls where it
> does. Adjust before planning P1.

## Why split at all

The source plan's own development principle — *each stage must leave behind a
working, testable capability; do not implement three layers ahead of the currently
verified execution path* — is a program-boundary principle. A boundary is drawn
where one of these is true:

1. **The capability changes.** A human could demo something after it that they
   could not demo before.
2. **The dependency class changes.** First AWS credentials, first real model
   spend, first remote infrastructure.
3. **An open decision must be ratified.** A program whose plan depends on an
   unsettled decision should *start* by settling it, with a human in the loop —
   not drift into deciding it mid-implementation.

Stages are merged only when neither produces a standalone demo on its own, or when
they share a fixture and a theme so closely that splitting duplicates setup.

## The programs

| # | Program | Stages | Exit capability | Blocking decisions |
|---|---------|--------|-----------------|-------------------|
| **P1** | Foundation | 0, 1 | Workspace builds, typechecks, lints, `cdk synth` succeeds; the execution/control model exists as a deterministic offline library with its invariants under property test | — |
| **P2** | Control Plane | 2 | Centralized authoritative backend, deployed to the single v1 account and project-isolated, independent of any agent execution | **O-01** control-plane HTTP/runtime implementation |
| **P3** | First Vertical Slice | 3 | One real local delegated coding job: contract → worktree → worker → verification → sealed commit → integration → checkpoint, fully visible centrally | **O-04** local MCP authentication |
| **P4** | Harness Neutrality | 4 | The identical Job Contract executes through Claude Code, Codex, and AgentCore adapters against one conformance suite | — |
| **P5** | Parallel & Recursive Execution | 5 | Recursive execution graphs run concurrently in isolated worktrees with deterministic, stale-base-aware integration | — |
| **P6** | Routing & Examination | 6, 7 | Cheap bounded jobs route to inexpensive Bedrock models and still integrate only when verified; risk policy drives independent examination without code changes | — |
| **P7** | Decision Graph & Replay | 8 | Reversing a human-overridden decision invalidates the minimum execution cone and replays back to verified | — |
| **P8** | Remote Runner | 9 | Dispatch, close the laptop, come back to a completed or partial run | **O-03** instance sizing/lifecycle; **O-05** harness credential transport; **O-06** git remote/integration policy |
| **P9** | Realtime & Analytics Surface | 10 | Full run state and history reconstructable from centralized APIs alone, observable live | **O-02** realtime transport |

Open decision IDs refer to `docs/architecture.md` §3.

## Sequencing

```text
P1 Foundation
   ↓
P2 Control Plane
   ↓
P3 First Vertical Slice          ← first meaningful product milestone
   ↓
P4 Harness Neutrality
   ↓
P5 Parallel & Recursive Execution
   ↓
P6 Routing & Examination
   ↓
P7 Decision Graph & Replay
   ↓
P8 Remote Runner
   ↓
P9 Realtime & Analytics Surface
```

Strictly sequential. This mirrors the source plan's preferred progression and its
instruction not to build ahead of the verified execution path. The only defensible
parallelism is late: **P9 could begin alongside P8**, since the analytics surface
reads state P7 already produces — but only if P8's open decisions are already
settled, and it costs the ability to reconstruct a *remote* run from APIs alone as
P9's exit demo. Recommendation: keep it sequential.

## Boundary rationale

**P1 merges Stages 0 and 1.** Stage 0 alone delivers scaffolding, not a
capability — there is nothing to demo and nothing meaningful to verify beyond
"the tools run." Stage 1 is pure, offline, deterministic work that belongs
directly inside that fresh scaffolding, and it gives P1 a real exit gate: the
domain library provably refuses to let a child widen its parent's scope.

> **Note:** part of Stage 0 is already complete. This initialization created the
> orphan `v1` branch, `AGENTS.md` (including the legacy-inspection prohibition),
> `docs/vision.md`, and `docs/architecture.md`. P1's remaining Stage 0 scope is
> the monorepo/package structure, TypeScript and tooling conventions, the CDK app
> skeleton, and CI — plus the automated greenfield-sterility checks.
>
> P1 also defines the persistence **port interfaces** together with an in-memory
> implementation used only by tests. That lets `execution` and everything above it
> be tested offline from P3 onward without creating any local canonical state
> (A-06). The real DynamoDB/S3 adapters remain P2 scope.

**P2 stands alone.** It is the first program needing AWS credentials and the
first whose verification includes a real deploy against a live account. It also
carries O-01, which should be ratified at program-planning time rather than
invented by an implementer.

> **Account posture (A-17, A-18).** v1 uses one account, `755348349819`
> (`nightshift-prod`) in `us-west-2`, treated as a sandbox until Nightshift is
> launched and supported. There is no development account and nothing may assume
> one. v1 does not verify teardown at all: nothing is destroyed to satisfy a test.
> The trade is deliberate — a single account means the blast radius of a mistake
> is the only environment there is, so stateful resources carry termination
> protection and an explicit removal policy rather than relying on defaults.

**P3 stands alone** because the source plan says so explicitly: this is the first
meaningful product milestone, and the invariant everything else builds from. It
deserves its own contract, its own review, and its own stopping point.

**P4 and P5 stay separate** despite both being "generalize execution." They are
different shapes of work. P4 is breadth — three adapters against one conformance
suite, highly parallelizable, low architectural ambiguity. P5 is depth and the
riskiest single stage in the plan: it changes scheduling and integration
semantics, and introduces stale-base detection, conflict recovery, and
whole-program verification. Merging them would let low-risk adapter work and
high-risk scheduler work share one risk posture and one review.

> **Note:** before planning P4, confirm what "AgentCore Harness" concretely is as
> a runnable coding harness. If that adapter can only execute through a hosted
> runtime, its conformance run needs cloud access, which changes P4's dependency
> class and must be stated in P4's contract rather than discovered mid-program.

**P6 merges Stages 6 and 7.** Both are policy layers over an already-working
engine, both are configuration-driven with table-driven determinism tests, and
both depend on the same precondition — multiple harnesses and models actually
available, which P4 delivers. They share fixtures heavily. This is the largest
merged program; if it runs long, Stage 7 splits off cleanly at the point where
routing decisions are persisted.

**P7, P8, P9 each stand alone.** P7 is a distinct correctness property (minimum
cone, nothing unrelated replayed). P8 is a distinct execution location with three
unsettled decisions and an extensive failure matrix. P9 is a distinct consumer
contract — the test is reconstructing everything *without* runner filesystem
access.

## Success-criteria coverage

| Program | Advances |
|---------|----------|
| P1 | foundations for SC-03, SC-07, SC-08 |
| P2 | SC-02, SC-03, SC-18 (partial) |
| P3 | **SC-01**, SC-02, SC-08 |
| P4 | **SC-04** |
| P5 | **SC-06**, **SC-07** |
| P6 | **SC-05**, **SC-09**, **SC-10**, **SC-11** |
| P7 | **SC-12**, **SC-13** |
| P8 | **SC-14**, **SC-15**, **SC-16** |
| P9 | **SC-17**, **SC-18** |

Every program-level success criterion in the source plan is claimed by exactly one
program as its primary owner. If a re-staging leaves an SC unclaimed, the split is
wrong.

## Running a program

Each program gets its own program branch and its own Program Contract. A human
drafts the contract in an ordinary coding-agent session, with no Nightshift
tooling involved, from:

- `docs/vision.md`
- `docs/architecture.md`
- this file, for the program's scope boundary
- `00-source-program-plan.md`, for that program's stage detail, verification list,
  and exit gate

A program's contract must restate its stages' verification requirements as
deterministic commands. The source plan's per-stage "Prove:" lists are acceptance
criteria, not prose — carry them across verbatim.
