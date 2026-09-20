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

## Start a run

A run needs a Program Contract: the objective, the repository and its program
branch, the success criteria, the scope, and the verification commands. It is
authored by a human and it is the stable authority for the run. **Do not edit
it.** If it is wrong, say so and stop; a contract quietly revised to make an
implementation pass is the one failure this system exists to prevent.

Either the human has already run `nightshift run <contract>`, in which case:

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
  scope:      { includes: ["src/parser/**"], excludes: ["src/parser/generated/**"] }
  acceptance: ["parse('1+2') returns an AST with one BinaryExpr", "node --test passes"]
  risk:       "low" | "medium" | "high"
}
```

**Scope is authority, not advice.** It is what the worker may change, and
Nightshift checks every changed path against it when the job finishes — one file
outside it fails the whole job, durably, and nothing is integrated. Three
consequences worth internalising:

- **You can only narrow.** A job's scope must sit inside the program's. Ask for
  more and the delegation is refused with `scope_widening`, listing exactly which
  patterns were not covered.
- **Scope the job, not the repository.** `src/**` for a job that touches one
  module is how a worker ends up rewriting something you did not ask about.
- **Include what the job genuinely needs.** A job that must add a test needs the
  test directory in its scope. Refusing to include it does not make the worker
  careful; it makes the job fail at the last step.

**Acceptance criteria are what the worker is judged against**, so write them as
things that are checkable rather than as adjectives. "Handles empty input" is
worth more than "robust".

You may also pass `harness` (`claude` or `codex`) and `model` to pin where a job
runs, but the Program Contract decides: Nightshift picks the worker's harness and
model from the program's model policy, a pin is honoured only inside that policy,
and one outside it is refused with the reason.

`delegate` returns as soon as the worker is running. You get back `jobId`,
`nodeId`, `agentId`, the worktree path, and the `harness`, `provider` and `model`
the job was routed to.

## Wait, and read the result

```
job.wait { jobId }
```

This blocks for a bounded time and then answers whatever `job.get` would. If it
comes back with `timedOut: true`, the job is still running — call it again. The
cap exists so the wait never outlives your own tool timeout; it is not a failure.

Read the status carefully, because the words are not interchangeable:

| Status | What it means |
|--------|---------------|
| `implemented` | The worker says it is done. **This is not done.** Verification has not run. |
| `verifying` | Nightshift is running the contract's verification steps. |
| `verification_failed` | The commands failed. Nothing integrated. The `Verification` record names the failing step, and its log is an artifact. |
| `verified` → `sealed` → `integrated` | Passed, addressable, and fast-forwarded into the program branch. |
| `failed` | The worker failed, exited without reporting, or changed something outside its scope. `outcomeReason` says which. |
| `interrupted` | Something stopped it that nobody chose. Retryable. |

When a job fails, **read `outcomeReason` before doing anything else.** It is
written to be acted on: the offending paths for a scope violation, the failing
step for a verification failure, the two commits for a stale base.

A failed job is usually a delegation problem, not a worker problem. Ask why
before you retry: a vague objective, acceptance criteria that did not say what
mattered, a scope that excluded something the job needed.

## Record decisions

When you make a choice a later reader would want the reasoning for — a design
you picked over another, a constraint you decided to accept — record it:

```
decision.record { context, alternatives, choice, rationale, reversibility }
```

Be honest about `reversibility`. `irreversible` means irreversible. Nothing
downstream can undo an effect that was recorded as reversible and was not.

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
- **Do not work around a refusal.** `scope_widening`, `depth_limit_exceeded`,
  `concurrency_limit_exceeded` and `examination_unavailable` are the system
  telling you something true about the work. Restate the delegation, wait, or
  tell the human — do not go and do the job yourself to get past it.
- **Do not delegate a second job while one is running.** P3 runs one at a time;
  you will be refused and told to wait.

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
