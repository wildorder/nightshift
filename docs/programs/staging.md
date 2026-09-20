# Nightshift v1 — Program Staging

> **Recommendation, not decree.** `00-source-program-plan.md` defines eleven
> stages (0–10). This document groups them into programs, each with a single
> demonstrable exit capability, and states why each boundary falls where it
> does. It was adjusted once, on **2026-09-16**, after P3: identity and tenancy
> were pulled into v1 as their own program, and the third harness adapter moved
> to the remote-runner program. The reasons are in "Restaging, 2026-09-16" below.

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

| # | Program | Stages | Exit capability | Blocking decisions | State |
|---|---------|--------|-----------------|-------------------|-------|
| **P1** | Foundation | 0, 1 | Workspace builds, typechecks, lints, `cdk synth` succeeds; the execution/control model exists as a deterministic offline library with its invariants under property test | — | complete |
| **P2** | Control Plane | 2 | Centralized authoritative backend, deployed to the single v1 account and project-isolated, independent of any agent execution | O-01 (resolved) | complete |
| **P3** | First Vertical Slice | 3 | One real local delegated coding job: contract → worktree → worker → verification → sealed commit → integration → checkpoint, fully visible centrally; a stable hostname and a flagless login | O-04 (resolved) | complete |
| **P4** | Identity and Tenancy | — (inserted) | A second user in a second org cannot see, write to or execute in the first user's project; a worker holds a credential that can do exactly its four operations; A-04 is enforced by the API | amends A-19, A-21, A-27 | complete |
| **P5** | Harness Neutrality | 4 | The identical Job Contract executes through the Claude Code and Codex adapters against one conformance suite; the adapter contract is final; harness and model are chosen from a compatibility table by configuration | — | complete |
| **P6** | Parallel & Recursive Execution | 5 | Recursive execution graphs run concurrently in isolated worktrees with deterministic, stale-base-aware integration | — | drafted |
| **P7** | Routing & Examination | 6, 7 | Cheap bounded jobs route to inexpensive models and still integrate only when verified; risk policy drives independent examination without code changes | — | |
| **P8** | Decision Graph & Replay | 8 | Reversing a human-overridden decision invalidates the minimum execution cone and replays back to verified | — | |
| **P9** | Remote Runner | 9 | Dispatch, close the laptop, come back to a completed or partial run; the whole execution layer runs on one AgentCore runtime instance per program run; the AgentCore harness worker with a Bedrock model completes the conformance fixture there | O-03 instance sizing/lifecycle; O-05 harness credential transport; O-06 git remote/integration policy; who pays for Bedrock tokens | |
| **P10** | Realtime & Analytics Surface | 10 | Full run state and history reconstructable from centralized APIs alone, observable live | O-02 realtime transport | |

Open decision IDs refer to `docs/architecture.md` §3.

## Sequencing

```text
P1 Foundation
   ↓
P2 Control Plane
   ↓
P3 First Vertical Slice          ← first meaningful product milestone
   ↓
P4 Identity and Tenancy          ← inserted 2026-09-16
   ↓
P5 Harness Neutrality
   ↓
P6 Parallel & Recursive Execution
   ↓
P7 Routing & Examination
   ↓
P8 Decision Graph & Replay
   ↓
P9 Remote Runner
   ↓
P10 Realtime & Analytics Surface
```

Strictly sequential. This mirrors the source plan's preferred progression and its
instruction not to build ahead of the verified execution path. The only defensible
parallelism is late: **P10 could begin alongside P9**, since the analytics surface
reads state P8 already produces — but only if P9's open decisions are already
settled, and it costs the ability to reconstruct a *remote* run from APIs alone as
P10's exit demo. Recommendation: keep it sequential.

## Restaging, 2026-09-16

Two changes, both made by the owner after P3 closed and before P4 was ratified.

**Identity and tenancy became P4.** The source plan and the vision deferred
multi-user identity to after v1. P2 built authentication for that assumption and,
in doing so, conflated *who is calling Nightshift* with *what a running agent may
do*: a worker reads the operator's refresh token from disk, organisations are a
label rather than a fence (A-21), and "nothing executes without a Nightshift
execution identity" (A-04) is true only because our code always creates the
record first. Adding two more harness adapters on top of that would have made the
problem larger, so it is fixed first, as its own program with its own exit gate:
a second user who cannot see the first. The vision's "after v1" paragraph is
amended accordingly.

**The third harness adapter moved to P9.** The vision's "AgentCore Harness" is a
real product, Amazon Bedrock AgentCore harness, generally available since June
2026: a managed agent loop that can also be exported to Strands code and run as a
process. It only makes sense where that process has Bedrock access and where
spinning it up is cheap, which is inside the program's runtime instance in a
remote run. The first P4 draft had put it in the harness program with one
AgentCore *session* per job and the worktree shuttled across as a tarball; that
was a cloud VM per leaf job, which the source plan's non-goals exclude, and it
contradicted A-14 and SC-15, which put the orchestrator and its worktrees on one
runtime instance. So P5 finalises the adapter contract with two local adapters
and the shared suite, and P9 adds the third adapter in the environment it is
for. SC-04 is therefore discharged across P5 and P9, and SC-05 belongs to P9.

## Boundary rationale

**P1 merges Stages 0 and 1.** Stage 0 alone delivers scaffolding, not a
capability — there is nothing to demo and nothing meaningful to verify beyond
"the tools run." Stage 1 is pure, offline, deterministic work that belongs
directly inside that fresh scaffolding, and it gives P1 a real exit gate: the
domain library provably refuses to let a child widen its parent's scope.

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

**P4 stands alone** because its exit gate is a property, not a feature: a second
principal who cannot see the first. It touches the authorizer, the API, the
worker's environment and the execution layer, and every later program inherits
its principal model. Folding it into P5 would have let an identity change and
three adapters share one review.

**P5 and P6 stay separate** despite both being "generalize execution." They are
different shapes of work. P5 is breadth — adapters against one conformance
suite, highly parallelizable, low architectural ambiguity now that the remote
adapter has moved out. P6 is depth and the riskiest single stage in the plan: it
changes scheduling and integration semantics, and introduces stale-base
detection, conflict recovery, and whole-program verification.

**P7 merges Stages 6 and 7.** Both are policy layers over an already-working
engine, both are configuration-driven with table-driven determinism tests, and
both depend on the same precondition — multiple harnesses and models actually
available, which P5 delivers for local harnesses. They share fixtures heavily.
This is the largest merged program; if it runs long, Stage 7 splits off cleanly
at the point where routing decisions are persisted. Note that the cheap Bedrock
route itself lands in P9; P7 routes among what exists when it runs and its
policy must not assume a harness that has not been built.

**P8, P9, P10 each stand alone.** P8 is a distinct correctness property (minimum
cone, nothing unrelated replayed). P9 is a distinct execution location with
three unsettled decisions, the third adapter, and an extensive failure matrix.
P10 is a distinct consumer contract — the test is reconstructing everything
*without* runner filesystem access.

> **AgentCore, as understood on 2026-09-16.** Amazon Bedrock AgentCore is a suite:
> Runtime, Harness, Memory, Gateway, Identity, Code Interpreter, Browser,
> Observability, Policy, Evaluations, Registry and more. Two of them matter to
> Nightshift. **Runtime** hosts an agent container; in its serverless form every
> session is an isolated, sanitised environment that lives at most eight hours
> and is terminated after fifteen idle minutes; in its **runtime instance** form
> (generally available August 2026) the compute is managed EC2 capacity you
> choose, many agents share one instance, and a shared session with a common
> filesystem lives up to fourteen days. A-14's "one runtime instance per remote
> program run" means the second form: the orchestrator and its workers are
> processes on one instance, and a worker never costs a fresh environment.
> **Harness** is a managed agent loop (`CreateHarness` / `InvokeHarness`) over
> any Bedrock, OpenAI or Gemini model with built-in shell and file tools, remote
> MCP servers and inline functions; it can be exported to Strands code. The
> vision's "AgentCore harness" worker is that loop running as a process on the
> program's runtime instance with a Bedrock model, built in P9.

## Success-criteria coverage

| Program | Advances |
|---------|----------|
| P1 | foundations for SC-03, SC-07, SC-08 |
| P2 | SC-02, SC-03, SC-18 (partial) |
| P3 | **SC-01**, SC-02, SC-08 |
| P4 | SC-02 and SC-03 made enforceable for a second user; no source SC is owned, since the source plan deferred identity |
| P5 | **SC-04** (Claude Code and Codex halves) |
| P6 | **SC-06**, **SC-07** |
| P7 | **SC-09**, **SC-10**, **SC-11** |
| P8 | **SC-12**, **SC-13** |
| P9 | **SC-14**, **SC-15**, **SC-16**, SC-04 (AgentCore half), **SC-05** |
| P10 | **SC-17**, **SC-18** |

Every program-level success criterion in the source plan is claimed by a program
as its primary owner; SC-04 is the one split across two, and both halves are
named. If a re-staging leaves an SC unclaimed, the split is wrong.

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
