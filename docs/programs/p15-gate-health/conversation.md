# Planning conversation: p15-gate-health

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

The owner's keki-backend run failed overnight and landed nothing. Investigation showed every failure was a build that broke only in reused worker worktrees, so verification was fixed to clean ignored files (A-52's companion fix). The owner then asked for an audit of a project's gates before Nightshift runs. A mechanical audit was built, then cut to one pass with no override at the owner's direction. The owner asked whether the run could fix flaky gates, and rejected re-planning as an answer: a run gets the job done and records what happened for review. They want the audit to be intelligent, judging compliance with what Nightshift needs, and completed before ratification, with the human deciding the fixes up front. They ruled that a repair job may change anything, a flaky gate opens a non-blocking repair, every repair logs a decision, and Nightshift ships a gate standard. They ratified the proposed record, check and surface decisions and asked for P15 to be built by Nightshift itself on a remote run.

## Excerpts

<!-- nightshift:session claude 0df16c00-142e-4afa-8a49-fb460d9be187 34 -->
### Claude session `0df16c00`

*Kept 18 of 34 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 1 human 2026-10-06T13:36:55.875Z -->
**Human** · 2026-10-06 13:36 UTC

Here's a recap from the agent session watching our attended nightshift run on keki-backend project. what went wrong and what options do we have in nightshift to make sure that doesn't happen again?


The playspace-time-reservations run failed and landed nothing
Both strands failed. S-01, the booking engine, is parked, and S-02 never started because it depends on S-01. The full report is in docs/programs/playspace-time-reservations/report.md.
Why nothing landed. Two finished pieces of S-01 passed all six gates and the examiner, then failed when Nightshift re-checked them before landing. That re-check runs the gates in parallel in a fresh checkout with no dependencies installed. Each gate’s npm pre-hook then runs an unlocked pnpm install, and the installs collide. S-01’s orchestrator reproduced the collision on a fresh copy.
That was my mistake at the start. Your run skill says dependencies must come from a declared setup, never from an install folded into the gates. I accepted the pre-hooks instead of sending the plan back for a setup. Nightshift runs setup once, before the parallel gates, so declaring it is the root fix. A lock in the repo’s dependency-install script can sit beside it as a guard. Both are changes to the plan’s inputs, so I didn’t make them.
The work is saved. Both pieces exist as commits in the repo:
Database foundation, 84e0179: migration 0012, the window columns, a truly nullable occurrence column, the window capacity trigger, and tests.
Contracts, 7b9be0c: playspace rules, the playspace cart line, pricing, start-time and DST rules, and availability types.
Not started: the hold logic in reservation-core, the availability read model, the staff queries, ordering and the webhook.
Arbiter rulings
All three upheld the examiner. I’d keep all three:
Database: the stopgap type that called the occurrence column non-null was rejected, and the type must be honestly nullable. To reverse: nightshift ruling reverse playspace-time-reservations dec_01M47VEXW71357FWPFKNQHDKSK --reason "…"
Contracts, opening time: on the autumn clock-change day, starts before opening were being offered. To reverse: … dec_01M484T1YKSMYB1HVQ3GV6ZGG4 …
Contracts, closing time: valid starts were missing when closing falls in the repeated hour. To reverse: … dec_01M48DHBBPR6DVTTGWRZ2HVQT6 …
Reversing a ruling only records your decision. It changes no code.
What else you should know
Departure, test suites. The new integration tests sit under suite names that are already registered. The plan wanted a new registered suite, but that list lives in scripts/, outside S-01’s scope.
Departure, error messages. Error-to-message mapping is left to S-02, because that table lives in the web app.
Close call, cart line. The playspace cart line is a parallel type beside the existing cart line, not a member of it. That is debt until S-02 folds it in. The re-plan should make the fold an explicit S-02 task.
Engine bug. The engine retried the scope-blocked database job 27 times without the strand’s orchestrator ever seeing it fail.
My cancel didn’t happen. You approved cancelling that job, but Nightshift refused: only the strand’s own orchestrator can cancel its jobs. A decision recorded before the cancel wrongly says it happened. A second decision record corrects it.
Control plane errors. The control plane refused the strand orchestrator’s calls from about 06:10 PDT.
Memory. I added both gotchas to the run-gotchas memory.
Cost
Amount
Claude work and examination
about $63
GPT-6 routes
not priced
Wall clock
8 h 24 min
Your choices:
Re-plan with a setup. Run /plan-program playspace-time-reservations to add a setup that installs dependencies once, plus the script lock as a guard. The re-plan can start S-01 from the two saved commits, and the database job should include reservation-core. This is the path I’d take.
Reverse a ruling if you disagree with one, using the commands above.

<!-- nightshift:message 17 human 2026-10-06T16:43:06.586Z -->
**Human** · 2026-10-06 16:43 UTC

do we need some audit of the project gates before they run nightshift? seems like keki needs one

<!-- nightshift:message 18 assistant 2026-10-06T16:43:12.698Z -->
**Claude** · 2026-10-06 16:43 UTC

I'll check what Nightshift's existing preflight already checks before answering.

Nightshift never runs a project's gates before a run starts. Preflight only checks the human prerequisites, and plan check only reads the plan documents. So the first time the gates run under Nightshift's conditions is on the first job, often hours in, with nobody around. An audit would move that moment to before the run, while you're there.

**What an audit could establish.** It would run every gate on the program's base commit, in a fresh checkout, with the declared setup:
- **The gates pass at all.** This catches a missing setup, gates that depend on undeclared local state, and a base that was already failing.
- **The gates pass when run twice.** That exposes flaky gates before they cost a worker a retry.
- **What one verification costs in time.** Every job pays that cost, often several times.

None of this has to refuse anything. It can be evidence that you read and decide on, which suits your reluctance to block things up front.

**Keki-backend's case.** The failure that sank this run was Nightshift's leftover-files bug, which is now fixed. Under the fixed code, keki-backend's gates would probably pass an audit, because the pre-hooks install correctly when gates run one at a time. An audit would still surface two real problems:
- **No declared setup.** Every verification does a full install inside the build gate, because Nightshift only copies dependencies cheaply from the program's checkout when setup is declared. That shows up as a slow first gate.
- **The likely shared build folder.** The build and e2e gates appear to write different builds to the same output folder. An audit run in Nightshift's conditions wouldn't catch this, because each verification now starts clean. A developer running e2e and then build locally probably would hit it. That defect belongs to keki-backend, and it is still unconfirmed.

So keki-backend needs a declared setup and probably a separate output folder for its e2e build. Nightshift needs the audit so the next project's gate problems show up before the run instead of during it.

<!-- nightshift:message 19 human 2026-10-06T17:49:35.912Z -->
**Human** · 2026-10-06 17:49 UTC

ok. cna we fix this for nightshift please. I feel like the benefits of an audit are clear..

<!-- nightshift:message 20 assistant 2026-10-06T17:49:49.711Z -->
**Claude** · 2026-10-06 17:49 UTC

I'll start by mapping how preflight and run start are wired across the CLI, the MCP server and the run skill, so the audit fits the existing flow.

Dark local runs and remote runs both end up in the headless orchestrator. I'll check how a headless run records a failure, so a remote run whose gates fail at the start can end with a clear reason.

A remote run's options travel to the machine in its dispatch input, so an override can go there. Checking that schema.

Writing the audit module.

Tidying the module: a static import, no unused helper, and a simpler failing rule.

Biome flags the main function as too complex, so I'll split it into the passes and the summary.

Now tests for the audit, against a real git repository like the existing git tests.

The audit's tests pass. Before wiring the CLI I need to know where a run's setup and gates come from, since `nightshift.config.json` and `contract.json` can each declare them.

The run uses the merged contract recorded on the control plane, which includes the prerequisite statuses preflight just updated. Now the CLI wiring: how commands and flags are registered.

The audit belongs to planned programs, which all go through `runProgram`. Writing the CLI side: a shared audit-and-print module and the `nightshift gates` command.

Wiring `nightshift gates` and the `--allow-red-gates` flag into the CLI.

Now the run itself: the audit for local runs, and the override carried to remote runs. Checking how a remote dispatch builds its input.

Verbatim copy, so the new field only needs adding to the schema. Editing the contract, the dispatch and `runProgram`.

The CLI compiles. Now the remote runner. I'll read how a run is moved to running and what the runtime offers for recording artifacts.

Remote recovery runs must skip the audit, since those runs are already underway. Adding the `as` and `env` options to the audit, plus a function that ends a run as failed before anything starts.

The execution package compiles. Now the runner module that audits on the machine and ends the run if a gate is red.

Biome warns about complexity in two functions I touched: the audit summary and `runProgram`. I'll split both so I add no new warnings.

Both are clean now. Running the full test suite to see which existing tests the audit affects.

The planning tests pass again. Now new tests: `run` stops on a red gate, `--allow-red-gates` overrides, and `nightshift gates` reports. Checking the fixture's helpers first.

The CLI tests pass. Now a test for the runner's audit, which ends a remote run when a gate is red. I'll look for an existing test that builds a run in memory stores to copy from.

Fixing the test to list artifacts by run, which is what the store offers.

The runner's audit works against the real control plane, and the transitions are accepted. Now the skills and docs. Reading the relevant skill passages and how the architecture doc records decisions.

I'll add a settled-decision entry to the architecture doc and update both skills.

Docs and skills are updated. Running the full verify gate.

A formatting error to fix. I'll also check whether the complexity warning on `run` is new.

No new warnings. Running the full verify again.

Synth and the sterility check pass, and the keki-backend audit is running. While it runs, I'll review the whole diff.

One risk in the runner: the audit borrows a worker user under a synthetic agent id. If the user pool holds that user for good, it would cost the run a worker slot. Checking the pool.

The pool hands users out round-robin and the audit finishes before the root starts, so no worker slot is lost. Checking on the keki-backend audit.

The audit is running against keki-backend's real gates. I'll wait for its results before committing.

The audit finishes on its own and will notify me. I'll wait for that result before committing.

The build gate passed its first run in 55 seconds. The audit is still going.

Typecheck passed its first run. The audit is still going.

Lint passed its first run. The audit is still going.

The unit gate passed its first run. The audit is still going.

The database tests passed their first run in about two and a half minutes. Only the e2e gate is left in the first run.

All six gates passed the first run, in about seven and a half minutes. The second run starts from a pristine clean of the same checkout, which is the condition that failed keki-backend's run.

The build passed on the second run as well. That's the gate that failed twelve times out of twelve in the reused worktrees. With the pristine clean, it now behaves like a fresh checkout.

Typecheck passed the second run too.

Lint passed the second run. Three gates are left: unit, the database tests and e2e.

The unit gate passed the second run. The database tests and e2e are left.

The database tests passed the second run. Only e2e is left.

The audit passed end to end on keki-backend and flagged the missing setup. I'll confirm it left no worktree behind in keki-backend.

Clean. Committing and pushing to main.

Nightshift now audits a program's gates before a run starts, and it's pushed to main as commit e4b5587. I ran it against keki-backend's real gates, and all six passed both times.

**What the audit does.** It runs the program's setup and every gate twice, in a fresh checkout of the program branch, exactly as verification runs them. The second run comes after the same full clean a re-verification gets.
- **Red:** a gate failed both runs. No job could pass verification on that base.
- **Flaky:** a gate passed once and failed once. The audit reports it but doesn't stop anything.
- **No setup:** lockfiles are committed but the program declares no setup, and the audit says so.
- **Waiting:** a gate that needs an unmet prerequisite is skipped and named.

**Where it runs:**
- **On its own.** `nightshift gates <program>` exits 1 only when a gate is red. It works during planning too, before ratification.
- **Before a run on this machine.** `nightshift run` audits before it creates anything, attended or dark, and stops on a red gate. The run id stays the first line of output, because the audit writes to stderr. Expect it to take about twice as long as one full verification.
- **On a remote machine.** The runner audits with the machine's own toolchain and worker user, before the orchestrator starts. A red gate ends the run as failed, with each red gate's output attached to the run. A replacement machine doesn't audit again.

`--allow-red-gates` starts a run anyway. It exists for a program whose own work is to make that gate pass.

**On keki-backend.** The audit took about 15 minutes. Its one note was that `pnpm-lock.yaml` is committed but no setup is declared, so every verification installs from nothing.

**Tests.** I added unit tests for the audit and CLI tests for `run`, `--allow-red-gates` and `gates`. A test against a real control plane confirms that a red remote run ends as failed through the normal state transitions. The full suite passes except the three tests that were already failing on main. Build, typecheck, lint, synth and the sterility check pass.

**Decisions for you.** I recorded the design in the architecture doc as A-52. These build choices are marked as awaiting your ratification:
1. **Stop on red, with an override.** You said you'd rather not refuse things up front. I made red the one stop because every job would otherwise fail, and `--allow-red-gates` leaves the call with you.
2. **Two runs, not one.** Running everything twice catches flaky gates and leftover state, at the cost of doubling the wait.
3. **Remote runs audit on their own machine.** That is the machine whose gates matter.

**Not deployed.**
- **Remote runs.** The runner-side audit needs a new runner image.
- **The override for remote runs.** It also needs the API deployed with the new dispatch field. Until then, `--remote --allow-red-gates` would be refused, while plain remote runs are unaffected.
- **Local runs.** These pick the audit up from the build in this repo, which `/opt/homebrew/bin/nightshift` points at.

<!-- nightshift:message 21 human 2026-10-06T18:31:25.835Z -->
**Human** · 2026-10-06 18:31 UTC

can't the nightshift run catch and remedy flaky gates? i'd prefer not to run it twice up front. no allow-red-gates is necessary. fine to run audit on their own machine. does the audit require intelligence? like you can't run the audit from the cli can you?

<!-- nightshift:message 22 assistant 2026-10-06T18:31:44.310Z -->
**Claude** · 2026-10-06 18:31 UTC

On your questions first. The audit needs no intelligence. It only runs the gate commands and reads their exit codes, and `nightshift gates <program>` runs it from the CLI with no agent involved.

Now I'll make the two changes you asked for: one pass instead of two, and `--allow-red-gates` removed everywhere.

I'll rewrite the audit as a single pass, with one result per gate and no flaky verdict.

The audit compiles. Checking for leftovers, then updating its tests.

Now the CLI: one pass, no flaky output, no `--allow-red-gates`.

Remaining references are in the runner, two tests, both skills and the architecture entry. Updating those.

Now the skills and the architecture entry.

All references are gone. Running the full verify.

Only the three tests that were already failing remain. I'll make sure the formatter touched nothing outside this change, then run synth and the sterility check.

Both changes are pushed to main as commit ba8b4a0. The audit now runs each gate once, and `--allow-red-gates` is gone. A red gate now always stops a local run before it is created, and fails a remote run before its orchestrator starts. That includes a program whose own work is to fix that gate. The full suite passes apart from the same three tests that were already failing on main.

**Does the audit need intelligence?** No. It runs the setup and gate commands and reads their exit codes. `nightshift gates <program>` runs it from the CLI with no agent involved. `nightshift run` does the same thing before creating a run.

**Can the run catch flaky gates?** It could, and it doesn't today.

When a gate fails, the job ends with a verification failure. The orchestrator may retry it, and Nightshift then treats the failure as the model's fault. The retry climbs a rung, so a flaky gate pays for a more expensive model to redo work that was fine.

Catching flakiness during a run needs no intelligence. When a gate fails, Nightshift could rerun just that gate on the same commit. If it passes the second time, the gate is flaky, and that goes on the verification record.

What happens next is a policy choice:
- **Count the rerun's pass and land the work.** This is the cheapest option. It risks landing a job that introduced an intermittent failure itself.
- **Don't land, but don't blame the model.** No retry, no climb. The job waits on the gate instead.
- **Treat the flaky gate as its own finding.** Fixing a flaky test is real work for an agent or for you, so the orchestrator or report would surface it to whoever fixes it.

Only the rerun-and-detect part is mechanical. Choosing among those three is yours to make, and fixing the flaky test itself needs an agent or you.

The runner image and API are still not deployed, so remote runs don't audit yet.

That notice only means the progress watch on the keki-backend audit has closed. The audit itself finished earlier, with every gate passing.

Two things are still open:
- **Deploying for remote runs.** Remote runs won't audit until the runner image and the API are deployed.
- **Catching flaky gates during a run.** You'd need to choose among the three policy options in my last message: land the work when the rerun passes, hold the job without blaming the model, or report the flaky gate as its own finding.

<!-- nightshift:message 23 human 2026-10-06T18:44:39.222Z -->
**Human** · 2026-10-06 18:44 UTC

shouldn't the orchestrator create a new job to fix the gating issue? mark it as a 'decision', and then have the rest of the run continue with a more stable gating mechanism?

<!-- nightshift:message 24 assistant 2026-10-06T18:44:49.493Z -->
**Claude** · 2026-10-06 18:44 UTC

I'll check two things before answering: whether the root orchestrator can create a job outside the plan's strands, and how a job's scope is bounded.

Mostly yes, as long as the fix is a change to the repository's code and not to the gates themselves. Nightshift's current model doesn't let the run do this yet.

**What fits well:**
- **The fix lands like any other job.** If the flakiness is in a test or a script, a job fixes that code. The job goes through verification and examination and lands on the program branch. Every later job is verified on top of it, so the rest of the run gets the steadier gate without anyone changing the gate's definition.
- **Recording it as a decision is right.** The decision graph exists for exactly this: what was done, what else was considered, and how to reverse it. You'd see it in the report and could reverse it.

**What blocks it today:**
- **The root orchestrator can only start the plan's strands.** On a planned run it refuses any other job. The plan's strands are the only jobs it can create, and adding work needs a new ratification. A strand's own orchestrator can create jobs, but only inside its strand's scope. A flaky test usually sits outside that scope, like the test-suite registry under `scripts/` that keki-backend's S-01 couldn't touch. So someone would have to own unplanned gate repair, with a scope that covers it.
- **The gate commands themselves can't change mid-run.** They're part of the contract you ratified, like setup, and a worker that could edit them could change what its own work is checked against. A "more stable gating mechanism" is fine as a fix inside a test or script. A new or altered gate command means re-planning.

**The real risk is an agent weakening the test.** The cheapest "fix" for a flaky test is a retry wrapper, a looser assertion, or deleting it. That can also hide a real intermittent bug. The examiner would need to treat a weakened gate as a blocking finding, and the decision would need to say plainly what changed in the test.

**In the meantime.** Spotting the flake stays mechanical: rerun the failed gate on the same commit. Other jobs would still hit the flaky gate until the fix lands. They need the interim rule from my last message, so they neither climb a model rung nor land on the second run's pass.

So your design comes down to three additions:
- **A deterministic flake check.** Rerun a failed gate on the same commit.
- **A repair job with an owner and scope.** It would be recorded as a decision, and is the one kind of job a planned run may add.
- **Examiner rules against weakening a gate.**

<!-- nightshift:message 25 human 2026-10-06T18:49:38.995Z -->
**Human** · 2026-10-06 18:49 UTC

NOOOOOO to "replanning" the fucking thing is designed to get the job done and record what happened so it can be REVIEWED. NOT replanned. this is what i meant by "does the audit need intelligence" - I'd argue that it DOES, because only then can it be audited for compliance with nightshift. suppose a super unhealthy piece of shit build starts using nightshift. nightshift should be able to say, umm, we need to get this cleaned up before i can reliably run

<!-- nightshift:message 26 assistant 2026-10-06T18:50:12.763Z -->
**Claude** · 2026-10-06 18:50 UTC

You're right, and "re-plan" was the wrong answer. A run should fix what blocks it, record the fix as a decision, and leave it for you to review. I've saved that as a working rule.

On the audit, I misread your question. What I built only runs the gates and checks the exit codes. It's the floor, not the audit you mean. It would have passed keki-backend while missing everything actually wrong with that build.

**An intelligent audit would judge whether a repo is fit for Nightshift to run.** Keki-backend shows what that means:
- **Installs folded into gates.** keki-backend installs dependencies through gate pre-hooks instead of a declared setup. That works, but it's slow and fragile.
- **Gates that interfere with each other.** The e2e gate and the build gate likely write different builds to the same output folder.
- **Gates that depend on outside state.** Docker, ports or the home directory, without a declared prerequisite.
- **Flakiness found in the code.** Retries, sleeps and timing in tests, before any run trips over them.
- **Gates that jobs can't keep healthy.** keki-backend's S-01 couldn't register its new test suite because the registry sits outside every strand's scope.
- **Cost.** How long one verification takes, multiplied by how many run at once.

The output would be a verdict like "this has to be cleaned up before I can run reliably", backed by findings. The cleanup itself is work Nightshift can do with jobs, recorded as decisions.

**During a run, the rule that blocks your design is in Nightshift's code.** On a planned run, the root orchestrator refuses any job that isn't one of the plan's strands. So it can't create the gate-repair job you describe. That rule needs to give way for repair work, which would be recorded as a decision and reviewed afterwards.

Building both is program-sized. It means a new auditing agent with a compliance checklist, and a new kind of job a planned run may add. The check I built now becomes one input the audit agent uses.

I'll start by checking how Nightshift's own programs are planned and numbered, and what the latest program document looks like.

The intelligence belongs where an agent is already present and cheap, which is planning. The run keeps only a mechanical check, and calls an agent when something actually breaks.

## The shape I'd propose

**1. Gate health is a fact about the repository, not about one program.** Nightshift keeps one gate-health record per project on the control plane, and the Studio can show it.

The record carries a fingerprint of what the gates depend on:
- the setup and gate commands;
- the lockfiles;
- the files the auditor identifies as gate machinery. In keki-backend those would be the Docker test script, the Playwright and Vitest configs, the install script and the suite registry.

If none of that has changed since the last healthy audit, nobody reviews it again. That is what makes it fast.

**2. Planning does the deep audit, only when the record is missing or stale.** The planning session is already an intelligent agent, and you're there. It reviews the gates against a written Nightshift gate standard and runs the mechanical check. The standard covers:
- setup is declared;
- no installs are folded into gates;
- gates don't depend on leftover files or shared output folders;
- outside services are declared as prerequisites;
- there are no obvious sources of flakiness;
- one verification takes a reasonable time.

If the gates are healthy, planning records that and moves on. If not, it adds a gate-health strand that every other strand depends on. It is built, verified and recorded like any other work, and the record is written when it lands.

A new project's first program gets this automatically, so there's no separate onboarding program to remember. A later program that changes the gate machinery gets a fresh review for the same reason.

**3. The run never stops for gates. It fixes them and records what it did.**
- **At start:** the run does one mechanical pass on the base, which takes minutes. If a gate is red, the run's first job repairs it, and the strands wait for that job alone.
- **During the run:** when a gate fails, Nightshift reruns that gate on the same commit. A pass the second time means the gate is flaky, which a machine can tell.
- **Repair jobs:** a broken or flaky gate becomes a gate-repair job. This is a new kind of job the root orchestrator may add on a planned run. It is examined at high risk, with "the gate was weakened" as a blocking finding, and recorded as a decision for your review. Everything else carries on.

## Why not the other two options

- **One audit per project, once.** It goes stale silently as the repository changes, and nothing would notice until a run hit it.
- **A deep audit at the start of every run.** That means an agent and a full review every night, repeating work on gates that haven't changed. The fingerprint gives you the same reliability without the cost.

**Speed.** A run pays for one gate pass at the start, for keki-backend about seven and a half minutes. It pays for an agent only when a gate actually breaks. Planning pays for a review only when the gate machinery changed.

## What I need from you

1. **This split overall.** The deep audit at planning, gated by the fingerprint, and a mechanical check plus repair jobs in the run. Or something else?
2. **What a repair job may change.** My leaning is that it may also change the setup and gate commands themselves, not only tests and scripts. That's how keki-backend's missing setup gets fixed without re-planning. Each such change would be examined at high risk and recorded as a decision, and other jobs would use the new definition only after it lands.
3. **A job whose gate passes on the rerun.** My leaning is to let it land, record the flake as a decision, and open a repair job. That favours speed. The alternative holds the job until the gate is repaired, which favours reliability.
4. **Who writes the gate standard.** My leaning is a Nightshift-owned document shipped with the skills, which you review once.

Nightshift's own programs are single documents, not `plan.md` and `contract.json` files. Once we've settled these, I'll write the program up as P15 in that format, with the stories in your words from this conversation.

<!-- nightshift:message 27 human 2026-10-06T19:37:20.299Z -->
**Human** · 2026-10-06 19:37 UTC

this all seems good. but does it add a full gate check during plan-program? those can sometimes be quite long. answer then please repeat what you need from me

<!-- nightshift:message 28 assistant 2026-10-06T19:37:40.327Z -->
**Claude** · 2026-10-06 19:37 UTC

It does, but only when the gate-health record is missing or stale. A plan on a repository whose gate machinery hasn't changed skips both the review and the gate run.

When the gates do run during planning, nobody waits for them. The planning session starts the gate pass in the background and carries on the conversation, which usually takes longer than the gates do. The result is folded in before ratification. If the gates are still running when you're ready to ratify, you can ratify anyway. The mechanical pass at the start of the run is the backstop, and a red gate there becomes a repair job. So a long gate run costs you no waiting in planning, and at most one gate pass at the start of a run.

What I need from you:

1. **Confirm the overall split.** The deep audit runs at planning, only when the fingerprint says something changed, with its gate run in the background. The run does one mechanical pass at start, and repair jobs fix anything that breaks.
2. **What a repair job may change.** My leaning is that it may also change the setup and gate commands, not only tests and scripts. That's how keki-backend's missing setup gets fixed without re-planning. Each such change would be examined at high risk and recorded as a decision, and other jobs would use the new definition only after it lands.
3. **A job whose gate passes on the rerun.** My leaning is to let it land, record the flake as a decision, and open a repair job. That favours speed. The alternative holds the job until the gate is repaired, which favours reliability.
4. **Who writes the gate standard.** My leaning is a Nightshift-owned document shipped with the skills, which you review once.

<!-- nightshift:message 29 human 2026-10-06T19:40:51.030Z -->
**Human** · 2026-10-06 19:40 UTC

i think we ought to have the audit completed before the user ratifies the plan. they can wait. it's better than sending it to nightshift as a total turd which then has to make a bunch of decisions. force the user to make the decisions up front... they are basically initializing nightshift. we can only do as good as their testing is setup

<!-- nightshift:message 30 assistant 2026-10-06T19:41:03.639Z -->
**Claude** · 2026-10-06 19:41 UTC

Agreed. The audit has to finish before you ratify, and its findings become decisions you answer during planning. Here is how I'd build that in:

- **Plan check enforces it.** A plan is not ready until the project has a gate-health record that matches the current gate fingerprint. Either the gates passed the audit as they are, or the plan includes the gate-health strand that carries out your decisions.
- **The audit runs in the foreground.** You wait for the gate run, because the results shape the decisions.
- **Each finding is a decision for you.** Examples are "declare `pnpm install --frozen-lockfile` as setup and drop the pre-hooks", or "give the e2e build its own output folder". The gate-health strand then builds what you chose, and every other strand depends on it.
- **The run's start check stays as a backstop.** It catches anything that changed between ratification and the run. Repair jobs only handle what breaks during the run.

That settles the first question. Three are left:

1. **What a repair job may change during a run.** My leaning is that it may also change the setup and gate commands, not only tests and scripts. Each such change would be examined at high risk and recorded as a decision, and other jobs would use the new definition only after it lands. With the audit up front this becomes rare, but it still decides what the run can fix on its own.
2. **A job whose gate passes on the rerun.** My leaning is to let it land, record the flake as a decision, and open a repair job. That favours speed. The alternative holds the job until the gate is repaired, which favours reliability.
3. **Who writes the gate standard.** My leaning is a Nightshift-owned document shipped with the skills, which you review once.

<!-- nightshift:message 31 human 2026-10-06T19:50:36.791Z -->
**Human** · 2026-10-06 19:50 UTC

1. yes, let it do whatever the hell it needs to do... 2. i agree with opening a repair job but not on a blocking path (and obviously a decision gets logged during all repair jobs). 3. yeah nightshift should have some opinion on gate standards

<!-- nightshift:message 32 assistant 2026-10-06T19:50:43.056Z -->
**Claude** · 2026-10-06 19:50 UTC

All decisions are settled. I'll write the program up as P15 in the format Nightshift's own programs use, so I'm reading P14's structure first.

I have what I need from P14's format. Writing P15 now.

I've drafted P15 Gate Health as a contract document, in the format Nightshift's own programs use. It's written up in `docs/programs/p15-gate-health.md` and listed in the staging table. Neither is committed, so you can read them first.

**Stories, with your words quoted exactly:**
- **US-01.** A developer bringing a repository to Nightshift is told what to clean up before Nightshift can run reliably, decides each fix once, and the first strand builds it.
- **US-02.** The owner reviewing a run in the morning finds that the run repaired broken gates itself and recorded each repair as a decision, with nothing re-planned.

**Already settled by you, recorded as D-P15-01 to D-P15-06:**
- The intelligent audit finishes before ratification. Its findings become your decisions, and a gate-health strand that every other strand depends on builds them.
- A fingerprinted record per project lets an unchanged repository skip the audit.
- A red gate at the start of a run becomes the run's first job, not a stop. That replaces the stop-on-red I built earlier today.
- A repair job may change anything, including setup and the gate commands. It always records a decision and is examined at high risk against weakening a gate.
- Nightshift ships a gate standard. The draft has seven rules: declared setup, passes fresh, hermetic, outside dependencies declared, deterministic, kept healthy by the work, and its cost said out loud.
- A flaky gate lands the work and opens a repair job that nothing waits on.

**What I need you to ratify, D-P15-07 to D-P15-11:**
1. **The gate-health record lives on the control plane,** written only by `nightshift gates --record`, so a hand edit in the repository can't fake it.
2. **`plan check` enforces the audit.** It answers READY only when there's a healthy record for the current gates, or every finding is answered by a decision and the gate-health strand exists.
3. **The report and the Studio show gate health:** the audit's verdict, each repair with its decision, and each flake.
4. **A repair job's scope is the whole program,** not one strand's. Conflicts it causes are resolved through the merge queue as usual.
5. **The program checkout becomes the setup reference after a repair lands.** Every later worktree is then copied from it cheaply. Today a laptop's checkout almost never gets that speed-up.

The build is split into six tasks. The last is deploying the API, the runner image and the Studio, followed by your trial on keki-backend.

<!-- nightshift:message 33 human 2026-10-06T23:21:09.591Z -->
**Human** · 2026-10-06 23:21 UTC

yes. love it let's go. actually. are you able to run this using existing nightshift on remote? that would be super helpful
