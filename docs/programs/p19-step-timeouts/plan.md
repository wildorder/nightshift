# P19 Step Timeouts

## Overview

Every setup and verification step is killed at ten minutes, whatever it is.
`environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS`
(`packages/execution/src/environment.ts`) is the only value any step ever
gets, a step has no field for it, and when it fires the step's whole process
group is `SIGKILL`ed at once (`killProcessTree`, `packages/verification/src/spawn.ts`).
keki-backend's `aws-postgres` run (`run_01M5ANBX8TKYWXR6M3H51DCFM4`,
2026-10-19) hit both halves:

- its `trial` end gate deploys a throwaway stage with RDS and removes it, which
  takes 30 to 60 minutes, so it could never pass;
- when it was killed, its `trap … EXIT` never ran, which left the stage billing
  and SST's state lock held.

The backlog item
`docs/backlog/verification-steps-declare-their-own-timeout-and-get-a-grace-period-to-clean-up.md`
holds the evidence.

P19 makes a step's time the step's own, three ways:

- **The plan declares it.** It sits in the contract, with a cleanup time beside
  it, and `nightshift gates` says before the run when a measured step is close
  to its cap.
- **A step that overruns is asked to stop.** It gets `SIGTERM`, then the
  cleanup time it declared, and only then `SIGKILL`.
- **The run's agents can correct it.** They may raise a step's time mid-run,
  or, when waiting longer has not worked, skip that one timed-out step. Each is
  a recorded decision, so the build carries on and the run finishes.

Out of scope, in prose:

- Raising the ten-minute default for steps that say nothing; that would hide
  hung steps everywhere to fix one.
- A cleanup command per step; the step's own `trap` already has it.
- Graceful termination when a run is cancelled or a machine stops.
- Studio screens beyond what the run already narrates.
- Deploying, images and the live trial; the owner does those after it lands.

## Who it is for

All three stories are one developer at three moments:

- **US-01** is the root fix: a step gets the time it needs, from the plan,
  and from the run when the plan was wrong.
- **US-02** is what the step does when it overruns anyway: it cleans up after
  itself.
- **US-03** is the fallback the owner asked for when waiting longer does not
  work: the run skips the one gate, records why, and finishes, instead of
  failing everything else.

The owner shaped two of these directly. Asked whether only the planner should
set a timeout, they said the agents must be free to fix what blocks them,
because a plan meets reality the moment the build starts (D-01). Asked about a
ceiling, they added the skip (D-05). Asked which steps may be skipped, they
chose only timed-out ones (D-06): a red test is fixed, never skipped.

## Architecture

**What changes:**

- **Two optional fields on every step.** `timeoutSeconds` and
  `cleanupSeconds` go on `VerificationStepSchema` and `SetupStepSchema`, with
  `DEFAULT_STEP_TIMEOUT_SECONDS = 600` (today's value, unchanged),
  `DEFAULT_STEP_CLEANUP_SECONDS = 30`, and the maximums
  `MAX_STEP_TIMEOUT_SECONDS = 7200` and `MAX_STEP_CLEANUP_SECONDS = 3600`
  (D-02, D-04).
- **The runner's timeout is per step.** It reads the step's own values; the
  run-wide `timeoutMs` input and `environment.verificationTimeoutMs` go away
  rather than survive as a second source of truth. The kill becomes
  `SIGTERM`, then the step's cleanup time, then `SIGKILL`. `KILL_GRACE_MS`
  keeps its job after `SIGKILL`, bounding the wait for `close`.
- **The run's adjustments are decisions.** Raising a step's time and skipping
  a step are each a decision recorded under the node that asked: the root's,
  or a strand's. Their contexts carry a fixed prefix (`STEP TIMEOUT:` and
  `STEP SKIPPED:`), the way `STRAND PLAN:` decisions already work.
  - The engine derives the run's effective steps from the contract plus those
    decisions, with one pure function.
  - Nothing is written into the contract, so the plan hash and carry-over are
    untouched. That's the constraint the backlog item found: carry-over needs
    an identical plan hash.
- **A skipped step is visible in the record.** A `VerificationCommandResult`
  gains `skipped: { decisionId }`, beside today's `deferred`. It has no exit
  code. The outcome is decided by the steps that ran: a skipped step neither
  passes nor fails a verification.

**What stays exactly as it is:**

- exit 124 for a timeout;
- exit 75 and `NIGHTSHIFT_DEFER` for a deferral;
- `"at": "end"` (A-57);
- the order steps run in;
- every step that declares nothing behaves as today.

## Strands

### S-01 A step takes its own time and cleans up after itself

Afterwards, a contract can say `"timeoutSeconds": 5400, "cleanupSeconds":
2700` on keki's `trial` step, and three things follow:

- `plan check` holds it to the limits;
- `nightshift gates` shows the measured 41 minutes beside the 90-minute cap;
- every place Nightshift runs the step gives it those 90 minutes. When it
  overruns, its `trap` gets 45 minutes to remove the stage before anything is
  killed.

#### Approach

- **Contract** (`packages/contracts/src/v1/program-contract.ts`): add the two
  optional positive integers to both step schemas, bounded by the maximums in
  the schema itself. Export the defaults, the maximums, and one helper:
  `stepTime(step) → { timeoutMs, cleanupMs }`, used everywhere a step runs.
- **`plan check`** (`packages/core/src/rules/plan.ts`): refuse a step whose
  timeout plus cleanup exceeds `costPolicy.maxWallClockSeconds` when one is
  set, naming the step. The schema already refuses values over the maximums.
  Make sure `plan check`'s reasons say which field and which step, in words.
- **Runner** (`packages/verification/src/run.ts`, `spawn.ts`):
  - `runStep` takes the step's time from `stepTime`.
  - On timeout it marks `timedOut` and notes the timeout in the step's log. It
    sends `SIGTERM` to the process group, arms a cleanup timer for
    `cleanupMs`, and on that timer sends `SIGKILL`. Then the existing
    `KILL_GRACE_MS` bounds the wait for `close`.
  - `close` before the cleanup timer clears it. The exit code is forced to 124
    either way.
  - On Windows, `taskkill /T` without `/F` first, then `/F` when the cleanup
    timer fires. Console programs often ignore the soft request, so Windows
    cleanup is best effort, and the force is not.
  - `killProcessTree` takes the signal as a parameter rather than knowing
    `SIGKILL`.
- **Callers:** setup (`setup.ts`), landing verification (`verify.ts`),
  examination's checkout (`examine.ts`), flake reruns (`flaky.ts`), the gate
  audit (`gate-audit.ts`), end gates, `nightshift gates`
  (`apps/cli/src/commands/gates.ts`) and the machine's gates
  (`apps/mcp/src/runner/gates.ts`). Each stops passing a timeout; the runner
  reads it from the step. The preflight's own short timeout for
  prerequisite checks is not a step and stays as it is.
- **`nightshift gates`** (`packages/core/src/forecast/`): show each step's
  timeout beside its measured duration. Add a recommendation, ranked like the
  others, for a step over 80% of its timeout or killed by it: the measured
  time, the cap, and the contract edit (`timeoutSeconds` at about 1.5× the
  measurement, capped at the maximum). A step that timed out in the
  measurement gets the recommendation with "at least" before its measured
  time.
- **Guidance:**
  - `skills/plan-program/SKILL.md` §3a and `gate-standard.md` tell the planner
    to set `timeoutSeconds` from the measurement for any step that runs long,
    and `cleanupSeconds` for any step that creates something outside the
    checkout (a cloud stack, a container, a lock).
  - The skill also says that the run may raise either, or skip a timed-out
    step (S-02), so the plan's value is a start, not a cage.
- **Tests:**
  - schema tests for the defaults and limits;
  - a `plan check` test for the wall-clock refusal;
  - runner tests with real shells: a step that sleeps past its timeout and has
    a `trap` that writes a file proves the file is written, `timedOut`, and
    exit 124. A step that ignores `SIGTERM` is killed after its cleanup time.
    A step that finishes inside its time is untouched;
  - a forecast test for the recommendation;
  - the existing Windows tests keep passing.

#### Considered and rejected

- **Raising the global default:** it hides hung steps for every program to fix
  one, and still has no right value for a 60-minute gate.
- **Keeping `verificationTimeoutMs` as an override beside the step's own:**
  two sources for one value. Every caller already has the step.
- **Cleanup as a fraction of the timeout:** it couples two unrelated durations
  (D-03).
- **The step backgrounding its own teardown so it exits fast:** resources
  would outlive the step with nobody accountable, and verification would pass
  before cleanup was known to have worked.

### S-02 The run raises a step's time, or skips it, and moves on

Afterwards, when keki's `trial` times out on a strand's landing:

- The strand's orchestrator is resumed with the step that timed out, its time,
  and two tools.
- It raises the timeout and says why, and the next landing gives the step the
  new time.
- If that times out too, it skips the step and says why. The strand lands on
  its other gates, the run finishes `succeeded`, and the morning report opens
  with "trial was not run: skipped by decision D-…, because …".

The root does the same for an end gate at `run.finish`, and for a root-level
job's landing.

#### Approach

- **Decisions as the record** (`packages/execution/src/step-adjustments.ts`,
  new):
  - one function per adjustment, writing the decision through the existing
    decision path (`recordWorkerDecision` and the root's equivalent);
  - one pure function, `effectiveSteps(contractSteps, decisions) → steps`,
    with skipped steps marked. The latest adjustment of a step wins. Raises
    are bounded by the maximums.
  - The decision's `context` carries the prefix, the step id and the new
    value. Its `rationale` is the agent's required reason, and its
    `alternatives` name what else was weighed (wait longer, skip, fix).
- **Skip eligibility:** a skip is refused unless the step's most recent run in
  this run, on any node, timed out. That's read from the run's verifications.
  The refusal names what that run was ("unit ran and failed with exit 1; fix
  it, it cannot be skipped").
- **Tools:**
  - **In both servers:** `step.timeout { stepId, timeoutSeconds?,
    cleanupSeconds?, reason }` and `step.skip { stepId, reason }`. These go in
    the root orchestrator's server (`apps/mcp/src/orchestrator.ts`) and the
    strand orchestrator's (`sub-orchestrator.ts`).
  - Workers get neither: a gate is the program's, and a job's agent does not
    loosen it.
  - The harness's tool list (`nightshiftToolNames`) gains both for the two
    orchestrator roles.
- **Engine** (`verify.ts`, end gates):
  - Each verification resolves its steps with `effectiveSteps` from the run's
    decisions at the moment it starts.
  - A skipped step is recorded with `skipped: { decisionId }`.
  - `VerificationCommandResultSchema` gains the field. The outcome refine and
    `outcomeOf` treat a skipped step like neither pass nor fail: `failed` when
    any step that ran failed, else `deferred`, else `passed`.
- **Briefs** (`packages/harness/src/brief.ts`):
  - The strand-fix brief, and the root's handling of a failed landing or end
    gate, say when a step timed out. They give its time and name both tools,
    in that order: raise it if the work is real and slow, skip it if raising
    has not worked, and never skip a step that failed.
  - The planning-free runs' root brief says the same.
- **Report and `run.finish`** (`packages/core/src/report/`, the orchestrator's
  finish answer): a first section, "Not verified", lists each skipped step
  with the commits it was skipped on and the decision's reason. Then each
  raised timeout, with its old and new values and reason. `run.finish` says
  the same in its answer.
- **Risk:** the skip eligibility check and the outcome logic decide whether
  unverified work can land, so the strand's orchestrator marks the jobs that
  touch them **high**. The rest is the program's medium.
- **Tests:**
  - unit tests for `effectiveSteps`, eligibility and the outcome with a
    skipped step;
  - tool refusal tests: a raise past the maximum, and a skip of a step that
    failed or passed;
  - a schema test that a skipped result has no exit code;
  - an end-to-end scenario in `test/src/execution/` on the fake harness: a
    strand's step times out, its resumed orchestrator raises the timeout, it
    times out again, the orchestrator skips it, the strand lands, and the run
    ends succeeded with the report's "Not verified" section naming it. The
    contract's plan hash is the same before and after;
  - a report test for the section.

#### Considered and rejected

- **Writing the new value into the contract:** it changes the plan hash, so a
  later run carries no finished strand over. That's the constraint the backlog
  item found.
- **Letting any step be skipped:** it lets a red test be skipped to make a run
  green (D-06).
- **A worker raising or skipping a gate:** a gate proves the program to its
  owner, and a job's own agent is the wrong party to loosen it.
- **A new record type for adjustments instead of decisions:** decisions are
  already the run's trail, reviewed in the morning, and `STRAND PLAN:` shows
  the pattern works.

## Decisions

All answered by the owner in this session; the answers live in the contract.

- **D-01** Who sets a step's timeout: the plan, and the run's orchestrators
  mid-run. My leaning was the plan alone; the owner overruled it.
- **D-02** The fields: `timeoutSeconds` and `cleanupSeconds`.
- **D-03** Cleanup: its own `cleanupSeconds`, default 30, between `SIGTERM`
  and `SIGKILL`.
- **D-04** The ceiling: a fixed 7200 s timeout and 3600 s cleanup, and within
  the wall clock when one is set. My leaning was the wall clock alone; the
  owner wanted a fixed maximum, with skipping as the way past it.
- **D-05** When waiting longer has not worked: skip the step with a decision,
  and the run carries on and can succeed.
- **D-06** What may be skipped: only a step whose most recent run timed out.

## Verification cost

Nightshift's own gates: build, typecheck, lint, test, synth and sterility, all
at landing. That is about ten minutes on a machine, so two strands, two
landings. The runner tests with real shells add seconds, not minutes: their
timeouts are set in the tests to fractions of a second.

## Risks

- **A skipped step reads as a pass somewhere.** Any reader of
  `Verification.outcome` or `exitCode` that does not know `skipped` could
  count it as green. S-02's tests cover the outcome refine, `outcomeOf`, the
  report and the queue. A grep for every reader of `deferred` finds where
  `skipped` must also be handled.
- **`SIGTERM` ignored by a step's children.** A shell that does not forward it
  leaves its children running until `SIGKILL`. The signal goes to the process
  group, not the shell, which is why it works. A test proves a child process
  of the step's shell receives it.
- **Windows soft kill.** `taskkill` without `/F` asks politely, and console
  programs often ignore it. Cleanup there is best effort, and the force after
  the cleanup time is not.
