---
name: nightshift
description: Delegate bounded coding jobs through Nightshift — an isolated worktree per job, deterministic verification, and a Nightshift-owned commit that only integrates once it has passed. Use when a task is large enough to hand off, or when the work needs a verified result rather than a plausible one.
---

# Delegating work through Nightshift

You are the orchestrator. You decide **what** the work is and **how it is cut
up**. Nightshift decides whether the result is real.

That division is the whole point. You can be wrong about whether a job is done —
so can the worker you delegate to — and nothing you or it believes changes
whether the tests pass. Nightshift runs the Program Contract's verification
steps on a clean checkout of the worker's commit, and only a passing run
integrates anything.

## A program with a ratified plan

Some programs are **planned**: a human worked out the seams, the approach and the
expensive decisions in `docs/programs/{id}/plan.md` and `contract.json` (the
`plan-program` skill), and ratified them with `nightshift plan ratify {id}`.
**A ratified plan is what you execute.** You do not re-plan it.

- The usual way to run one is unattended: `nightshift run {id}` (or the
  `run-program` skill, from a session) checks the plan is the one that was
  ratified, runs preflight, starts an orchestrator with nobody watching, and
  writes `docs/programs/{id}/report.md`.
- If the human would rather you orchestrate it from this session, they run
  `nightshift run {id} --attended` and you `run.attach` as below. Then:
  - Delegate **each strand, and nothing else**, with
    `strand.delegate { strandId }`. You say which strand; its orchestrator is
    handed its section of the plan word for word, the human's decisions that
    touch it, and where the plan expects the other strands' work. Plain
    `delegate` is refused to you
    (`plan_fixes_strands`): how a strand divides into jobs is its own
    orchestrator's decision, one level down. The one exception is a **repair**
    of a broken gate (below).
  - Delegate every strand at once. Nightshift holds a strand until the strands it
    depends on have succeeded.
  - A strand that fails is **parked** with everything that depends on it
    (`strand_blocked`). Leave those; let the rest finish.
  - A job that ends `deferred` is done for now: one of its checks needs something
    only a human can supply. It is not a failure. Its work is kept on a
    provisional line, and `nightshift resume {id}` lands it when they are back.
  - **A gate that breaks is repaired, never re-planned** (P15). A repair is
    `delegate { objective, acceptance, repair: { cause, gates, decision } }`:
    high risk, and a decision recorded in the same call (refused as `repair_needs_decision` without one). Only the root may
    open one. When the run starts red (`gate.red`), your first act is a repair
    `{ cause: "red_base" }`; the strands are held until it lands. On a flake
    (`gate.flaked`), the work landed: open one repair `{ cause: "flaky" }` per
    flaky gate, off the blocking path. The fix must keep the gate at least as
    strong; a weakened gate is a blocking finding unless the decision says why.
    Do not `run.finish` while a repair is in flight. The `run-program` skill
    has the detail.
  - Finish `succeeded` only if every strand succeeded; `deferred` if nothing
    failed and some work is deferred; otherwise `failed`, naming what was parked.
- If the plan on disk was edited after it was ratified, the run is refused until
  it is ratified again. That is the gate working. Tell the human; do not work
  around it.

The rest of this document is the unplanned case: a Program Contract with no
strands, which you cut into jobs yourself.

## Start a run

A run needs a Program Contract: the objective, the repository and its program
branch, the success criteria, the forbidden actions, and the verification
commands. It is
authored by a human and it is the stable authority for the run. **Do not edit
it.** If it is wrong, say so and stop; a contract quietly revised to make an
implementation pass is the one failure this system exists to prevent.

Either the human has already run `nightshift run <contract>` (or
`nightshift run {id} --attended` for a planned program), in which case:

```
run.attach { model: "<the model you are running as>" }
```

or you start it yourself:

```
run.start { programContractPath: "nightshift.program.json", model: "<your model>" }
```

Both give you a run id, a root node and a first checkpoint. Read the contract
back with `program.get` — that is the stored record, which is the authority, not
the file on disk.

## Write a delegation

```
delegate {
  objective:  "one bounded piece of work, stated as an outcome"
  acceptance: ["parse('1+2') returns an AST with one BinaryExpr", "node --test passes"]
  risk:       "low" | "medium" | "high"
}
```

**A job carries no path scope** (the owner's ruling, 2026-10-09: "give them
the scope to do the job"). The worker changes whatever the job needs, anywhere in
the repository, and nothing is refused or failed for the paths it touched: what
decides whether it lands is verification, and examination where the policy asks
for it. Bound a job by its objective and acceptance instead. Two jobs that change
the same lines at once will conflict, so give overlapping work to one job or run
it one after the other. Every worker is told the program's forbidden actions.

**Acceptance criteria are what the worker is judged against**, so write them as
things that are checkable rather than as adjectives. "Handles empty input" is
worth more than "robust".

### Say what the job is, and Nightshift says where it runs

Where a job runs is the org's routing policy, not yours: **ladders** of models
(one per provider, cheap to frontier), and **rules** that say where a job starts
from what it says about itself. So say it honestly:

- `risk`: what goes wrong if this is wrong. It also decides **examination**:
  under the usual policy low is not examined, medium is examined by a different
  model, high by another provider's frontier model, and at both a material
  finding stops it landing until it is fixed or an arbiter rules. Minor findings
  are reported and never stop anything.
- `ambiguity`: how much of the job is judgement rather than specification. Say
  `low` when the objective and acceptance say exactly what to change and how to
  know it is done: a copy change, a rename, a deletion, a function whose behaviour
  and tests you specified. Split work so the mechanical parts are such jobs.
- `testability`: `strong` when the program's own checks exercise this change, so a
  cheap model's mistake would be caught; `weak` when they touch it in passing;
  `none` when nothing checks it. Only a job that is low risk, unambiguous and
  strongly tested usually starts on the cheap rung.
- `jobKind`: `implement`, `fix`, `refactor`, `test` or `docs`.

**Leaving a field unset is the conservative choice, not the cheap one**: unset
risk is the program's default, ambiguity medium, testability weak. Do not label a
job low risk to get it a cheaper model or to skip its examiner; the
classification is on every routing record and in the report.

You may pin `ladder`, `tier`, `harness`, `model` or `effort` when you know
better than the rules. A pin is honoured only within the run's policy, recorded
as an override, and never skips examination or escalation. One outside the policy
is refused with the reason.

A route that cannot start (rate-limited, not signed in) falls back by itself: the
next model on the same rung, then the same tier on the other provider's ladder,
then one rung up. You see nothing of it but a line in `job.wait`.

`delegate` returns as soon as the worker is running. You get back `jobId`,
`nodeId`, `agentId`, the worktree path, the `harness`, `provider` and `model` it
was routed to, and the rule, ladder and tier that put it there.

## Delegate work that can run together, together

Jobs run at the same time, each in its own isolated worktree, up to the program's
`maxConcurrency`; past that they queue and start as slots free. So delegate every
job that does not depend on another **before you wait on any of them**, and then
wait on them all at once. Delegating one, waiting, delegating the next is the
slow way to do the same work.

Two things decide whether jobs can run together:

- **Do they change the same lines?** Then they will conflict. Give overlapping
  work to one job, or delegate the second after the first has integrated.
- **Does one depend on what the other produces?** Then it has to come after.

Integration is one at a time and Nightshift's: each finished job is replayed onto
the current program branch, **verified there**, and only then fast-forwarded. A
job that was fine on its own and breaks against what landed before it ends
`verification_failed`, and the branch stays green.

### Sub-programs

```
delegate { kind: "sub-program", objective, acceptance }
```

hands a **bounded region** of the program to an orchestrator of its own, which
delegates the jobs within it. Use one when a part of the work is big enough to
need its own planning: give it a whole outcome. It delegates only as deep as
the program's `maxDepth` allows, and it writes no code itself. You wait for it
like a job; it ends `succeeded` or `failed`.

## Wait, and read the result

```
job.wait { jobIds: [a, b, c] }     or     job.wait { jobId }
```

With several jobs it returns when the **first** of them settles, and says which;
call it again with the rest. It blocks for a bounded time and then answers
whatever `job.get` would. If it
comes back with `timedOut: true`, the job is still running — call it again. The
cap exists so the wait never outlives your own tool timeout; it is not a failure.

Read the status carefully, because the words are not interchangeable:

| Status | What it means |
|--------|---------------|
| `implemented` | The worker says it is done. **This is not done.** Verification has not run. |
| `verifying` | Nightshift is running the contract's verification steps. |
| `verification_failed` | The commands failed. Nothing integrated. The `Verification` record names the failing step, and its log is an artifact. |
| `verified` → `sealed` → `integrated` | Passed, addressable, and fast-forwarded into the program branch. |
| `queued` | Delegated and waiting for a slot. `job.get` says what it is waiting for. Not a problem. |
| `failed` | The worker failed, exited without reporting, **conflicted** with work integrated since it started (`integration_conflict`, with the paths), or was **stopped by its examiner** (`examination_failed`, with the findings). `outcomeReason` says which. |
| `succeeded` | A sub-program whose orchestrator reported its objective met. |
| `interrupted` | Something stopped it that nobody chose. Retryable. |

When a job fails, **read `outcomeReason` before doing anything else.** It is
written to be acted on: the worker's own reason for a failure, the failing step
for a verification failure, the two commits for a stale base.

`job.retry { jobId }` runs a job again **from the current program branch** as a
new attempt. It is usually right for an `integration_conflict`, where the work
was fine and the ground moved, and for `interrupted`. For `verification_failed`
it repeats the delegation exactly as written, so ask first whether the delegation
was the problem. Nightshift never resolves a conflict for you.

Where a retry runs is Nightshift's: after a failure of the work (verification, the
worker's own failure, an examination) it **climbs one rung** of its ladder; after
a conflict, a stale base or an interrupt it keeps the model it had, because those
say nothing about the model.

### When an examiner stops a job

A job whose risk calls for it is **examined** before it lands, by a different
model or provider that sees the work and the checks but not the worker's account
of it. It may ask the worker up to three questions. Its findings each point at
evidence: lines of code, a command and its output, or a clause of the contract.

When a material finding stops a job, it ends `failed` with an `outcomeReason`
beginning `examination_failed:` and naming the findings. You have two moves:

- **Fix it**: `job.retry { jobId }`. The findings go into the worker's brief and
  it climbs a rung; the fix is examined again. At most **two** fixes; a third is
  refused.
- **Dispute it**: `finding.dispute { jobId, reason }`, when the examiner is wrong.
  An **arbiter** (a fresh frontier invocation, on a model neither side used when there is one) rules.
  Overturned, the work that was examined lands as it is. Upheld, the ruling is
  final: Nightshift starts the next attempt itself, with the ruling as a binding
  instruction, and its examination checks only that the ruling was carried out.
  Wait for it with `job.wait`. Say why in the reason: the arbiter reads it.

After two fixes, a finding still standing goes to the arbiter on its own, and the
work keeps going either way: an overturn lands, an uphold is carried out. A
ruling cannot be disputed. If two attempts cannot carry a ruling out, the job
fails as the work's failure (`examination_ruling_unmet:`), and it is yours to
delegate differently. Every ruling is a decision the human can reverse later.
Do not dispute a finding to get past it; dispute it when it is wrong.

A failed job is usually a delegation problem, not a worker problem. Ask why
before you retry: a vague objective, acceptance criteria that did not say what
mattered, a job cut so that it conflicts with another in flight.

## Record decisions

When you make a choice a later reader would want the reasoning for — a design
you picked over another, a constraint you decided to accept — record it:

```
decision.record { context, alternatives, choice, rationale, reversibility }
```

Be honest about `reversibility`. `irreversible` means irreversible. Nothing
downstream can undo an effect that was recorded as reversible and was not.

Record the alternatives you weighed and why each lost. Nightshift ties each
decision to the commits it produced, the report shows them all as the run's
decision graph, and when the human reverses one, the correction is planned from
exactly this record: the option you rejected is often the one they choose, and
your reason for rejecting it is what that plan has to watch for.

## Finish

```
run.finish { outcome: "succeeded" | "failed" | "cancelled", reason }
```

Refused while a job is still running. Anything but `succeeded` needs a reason.

## What you must not do

- **Do not edit the Program Contract.** You may revise your own plan
  continuously. The contract is not your plan.
- **Do not commit, and do not ask a worker to.** Nightshift authors every
  commit, from a snapshot of the worktree at completion. A worker that commits
  is not helping; its commits are squashed away.
- **Do not treat `implemented` as done.** It is a claim, and claims are exactly
  what verification exists to check. Wait for `integrated`.
- **Do not work around a refusal.** `depth_limit_exceeded`,
  a refused third fix and a routing refusal are the system telling you something
  true about the work. Restate the delegation, wait, or
  tell the human — do not go and do the job yourself to get past it.
- **Do not finish the run while anything is running or queued.** `run.finish`
  refuses; wait for it or cancel it.

## Configuring the server

The MCP server is a stdio child process. In the repository you are orchestrating:

```json
{
  "mcpServers": {
    "nightshift": {
      "command": "node",
      "args": ["<path to>/apps/mcp/dist/bin/nightshift-mcp.js"]
    }
  }
}
```

It signs in with the operator's `nightshift login` session and holds no AWS
credentials. Its working directory must be the program checkout, because that is
the clone a verified commit is fast-forwarded into.
