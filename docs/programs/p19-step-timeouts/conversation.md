# Planning conversation: p19-step-timeouts

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

The owner asked to plan the backlog item keki filed after its aws-postgres run: every step is killed at ten minutes, and the kill skipped the step's own cleanup, leaving AWS resources billing. Asked who sets a step's timeout, the owner rejected planner-only: a plan meets reality once the build starts, so a run's agents must be free to change it mid-run, recording why (D-01). They chose integer seconds for the fields (D-02), a per-step cleanup grace with a small default (D-03), and a fixed maximum rather than the wall clock alone (D-04). They added a fallback: when waiting longer does not work, an agent skips the step, records the decision and the run carries on without failing (D-05). They then limited skipping to steps that timed out, so a failing test is fixed, never skipped (D-06), and set the maximum at two hours.

## Excerpts

<!-- nightshift:session claude a8c79c41-870f-4d3f-8712-744577a60dfa 117 -->
### Claude session `a8c79c41`

*Kept 6 of 117 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 112 human 2026-10-19T23:09:39.346Z -->
**Human** · 2026-10-19 23:09 UTC

keki just added something to our backlog on nightshift. basically we timeout all tests at 10 min no matter what. keki had a long running test it wanted the agents to be able to set their own timeout time.. can you find the backlog item? because it had more context and evidence

<!-- nightshift:message 113 assistant 2026-10-19T23:10:22.214Z -->
**Claude** · 2026-10-19 23:10 UTC

Found it: `docs/backlog/verification-steps-declare-their-own-timeout-and-get-a-grace-period-to-clean-up.md`, captured today. It's committed on your local `main` (`ffe4cc1`) but not pushed yet.

**What happened:** keki's `aws-postgres` run (`run_01M5ANBX8TKYWXR6M3H51DCFM4`) had an end gate called `trial`. It deploys a throwaway SST stage (VPC, NAT instances, RDS, every Lambda), proves the program against it, then removes the stage with `sst remove` from a shell `trap`. A real pass takes 30 to 60 minutes, and the removal alone takes 15 to 40, because AWS holds a VPC Lambda's network interfaces for up to about 40 minutes after the function is deleted. Nightshift killed the step at 10 minutes with exit 124.

The item records two separate defects:

1. **The 10-minute cap is fixed.** Every step gets `verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS`, which is 10 minutes, and a step has no field to change it. So gates that legitimately run long, like deploying and proving an infra change or a long end-to-end suite, can never pass.
2. **The kill skips the step's own cleanup.** On timeout, `killProcessTree` sends `SIGKILL` to the whole process group at once. The 2-second `KILL_GRACE_MS` only bounds how long Nightshift waits afterwards. The script's `trap … EXIT` never ran, so the AWS stage was left running and billing, with RDS up and both NAT instances on. SST's state lock was also left held. The root had to `sst unlock` and remove the stage by hand, and keki ended the run `failed`.

**Constraints it found:**
- **Carry-over needs an identical plan hash,** so retuning a gate after ratification forces every finished strand to be rebuilt. The timeout has to be right in the plan from the start, and `plan check` or `gates` should warn before ratification when a step's duration exceeds its cap.
- **A timeout must stay a timeout:** exit 124 is forced on purpose, even if the step exits 0 after cleanup.
- **The fix it points at for cleanup is `SIGTERM`, then a bounded grace, then `SIGKILL`,** so the step's own `trap` can release cloud stacks and locks. Real teardown can take minutes, so the grace probably needs to be per step too, or a fraction of the step's timeout.
- **Deferral is unchanged:** exit 75 within the timeout still defers.
- **`gates` (P17) already measures step durations,** so it's the natural place for the warning.

**Rejected:** raising the global default, telling planners to keep gates under 10 minutes, having steps background their own teardown, and a separate cleanup-command field per step.

**Code pointers:** `packages/verification/src/run.ts` and `spawn.ts`, `packages/execution/src/environment.ts`, and `carry-over.ts`. On the keki side: `docs/programs/aws-postgres/report.md`, `contract.json`, and `scripts/rds-trial.sh`.

Who sets a step's timeout, and when? The backlog item notes that changing a contract after ratification changes its plan hash, which forces every finished strand to be rebuilt.
- Planner, in the plan (Recommended): Each step's timeout is a field in the contract. The planning agent sets it from `nightshift gates`' measured durations and you ratify it. Run agents can't change it mid-run.
- Also run agents, mid-run: An agent in the run may raise a step's timeout when it hits the cap. Faster to recover, but a gate agents can loosen during the run proves less, and the record moves under the ratified plan.

What should the field look like?
- timeoutSeconds (Recommended): An integer on each setup and verification step, e.g. "timeoutSeconds": 5400. Matches the contract's existing costPolicy.maxWallClockSeconds.
- timeoutMinutes: Easier to read for long gates ("timeoutMinutes": 90), but the only minutes field in the contract.
- Duration string: "timeout": "90m". The most readable, but a new parsing convention in a strict schema.

When a step times out, how long should it get to clean up before it's force-killed? keki's teardown took 15 to 40 minutes.
- Per-step field, small default (Recommended): On timeout Nightshift sends SIGTERM, waits the step's cleanup grace (its own field, default 30 seconds), then SIGKILLs. keki's trial would declare ~45 minutes. It still counts as a timeout (exit 124).
- A fraction of the timeout: The grace is, say, half the step's timeout, so there's no second field. Simpler, but it couples two unrelated durations: a long gate with fast cleanup waits needlessly.
- One fixed grace for all: SIGTERM, then a fixed wait (e.g. 60 seconds) for every step. Simplest, but too short for cloud teardown, which was keki's actual problem.

Should there be a ceiling on what a step may declare?
- Within the run's wall clock (Recommended): No fixed maximum. `plan check` refuses a timeout plus grace longer than the contract's maxWallClockSeconds when one is set, and `gates` warns when a measured step comes within 80% of its cap.
- A fixed maximum: For example 4 hours per step, refused above that, to stop one gate eating a night.
- No ceiling at all: Any positive value is accepted.

<!-- nightshift:message 114 human 2026-10-19T23:43:58.770Z -->
**Human** · 2026-10-19 23:43 UTC

Who sets it: Also run agents, mid-run

you are still fixated on rules rules rules. make it follow the plan. big plans go to shit once you start building. the agents MUST have the independence to fix what is blocking them from delivering results.

Field shape: timeoutSeconds (Recommended)

Cleanup grace: Per-step field, small default (Recommended)

Ceiling: Within the run's wall clock (Recommended)

i think we do a fixed maximum - we also need a fallback if simplyi waiting longer doesn't work, the agents should have the ability to skip the test, record what happened, and move on with the rest of the build. once again this should not FAIL a run, it should finish with decisions recorded... in this case a decision to skip a long running test

<!-- nightshift:message 115 assistant 2026-10-19T23:44:33.444Z -->
**Claude** · 2026-10-19 23:44 UTC

Which steps may an agent skip mid-run?
- Only a step that timed out (Recommended): Skip is allowed only for a step whose last run on that commit hit its timeout, even after raising it. A step that ran and failed must be fixed, not skipped, so agents can't skip red tests to get a green run.
- Any step, with a decision: An agent may skip any gate for the run if it records why. Never blocks, but a run can then end 'succeeded' with failing tests skipped.

What fixed maximum may a step's timeout reach, whoever sets it?
- 2 hours (Recommended): Covers keki's 30–60 minute trial with room to spare, and stops one gate eating a night. Cleanup grace is capped separately at 1 hour.
- 1 hour: Tighter, but keki's trial plus a slow removal already brushes against it.
- 4 hours: Room for very long suites, at the cost of a stuck step burning half a night before it's skipped.

<!-- nightshift:message 116 human 2026-10-19T23:49:32.018Z -->
**Human** · 2026-10-19 23:49 UTC

Skippable: Only a step that timed out (Recommended)

Maximum: 2 hours (Recommended)

<!-- nightshift:message 117 assistant 2026-10-19T23:50:05.484Z -->
**Claude** · 2026-10-19 23:50 UTC

The plan is taking shape. Checking where the planning skill's guidance and the gates forecast live in this repo, since both need to learn about timeouts:

I have what I need. Writing the plan and contract now as `p19-step-timeouts`:

Your answers were kept as messages, so your own notes can be quoted in the stories. Keeping the exchanges that shaped the plan (112–117), with a short summary:
