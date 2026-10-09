# Planning conversation: p16-environment-parity

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

P16 came out of keki-backend's `lightning-ux` remote run on 2026-10-08, which started no worker and called a healthy base red. The owner called it a product destroyer and asked why a plan whose gates were just audited could fail on its gates. The investigation found two kinds of cause. The engine-token bug that stopped every worker was fixed outside any program (D-P10-29, PR #11). The rest became this program: the machine ran the image's Node 24 instead of keki's pinned 22, gave its worker users no Docker, trusted a prerequisite checked on the laptop, counted deferrals as failures, and opened a repair against keki's code.

The owner agreed the machine must adapt to the project, asked that Docker cost nothing for projects that never use it, and wanted the user to WAIT until Nightshift says OK GO, with terminal art. The owner ruled that it deserved a program of its own, split from the urgent fix. The planning gate audit then found Nightshift's own Node pins disagree, and that the owner's laptop runs Node 22 on a repository pinned to 24.

(Summary written by Claude, the planning agent.)

In the decisions, the owner took every recommendation, then widened the program: choosing how the machine picks a Node version, they wrote that Nightshift "should work on any environment" and that "we are super narrow on what we support". Asked how wide P16 should reach, they chose every language runtime through one polyglot version manager over Node alone or the project's dev container.

Before ratifying, the owner asked why their laptop's Node 22 against Nightshift's pin of 24 had never been caught, and said it should be caught by the planning audit. That added rule 8 of the gate standard, declares its runtimes, to S-02, and made the dispatch-time refusal a guard rather than the first line. D-01 flipped to keeping `.node-version`, because CI reads it.

## Excerpts

<!-- nightshift:session claude e33ba3fe-d01d-4325-ac59-b1cc45c7f854 48 -->
### Claude session `e33ba3fe`

*Kept 31 of 48 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 17 human 2026-10-09T04:21:13.485Z -->
**Human** · 2026-10-09 04:21 UTC

this is super frustrating. i mean it simply cannot happen, it is a product destoyer. check the latest keki run

<!-- nightshift:message 18 assistant 2026-10-09T04:21:15.874Z -->
**Claude** · 2026-10-09 04:21 UTC

I'll find the latest keki run and look at what went wrong.

The run stopped six minutes in. Looking for why.

The run never did any work. Every worker died at start because its token wasn't allowed `run.list`. I'll find what calls `run.list` at worker start.

`programRulings` lists every run of the program before each worker launches. Checking which token the remote engine holds and what its table allows.

Pulling the run's verification records from the control plane to see why the base was red on the machine.

Still diagnosing: I'm downloading the gate audit's logs from the machine to see why build and the Docker gates failed there.

HP-01 was checked on your laptop at 22:29 and recorded satisfied, then the gates ran on a machine where it wasn't true. Checking how the machine is supposed to give gates Docker.

The run never got a single worker started. Nightshift has a bug that breaks every remote run right now. On top of that, the machine reported a red base that is mostly Nightshift's own doing. Keki is not at fault for either.

**What stopped the run**

- **Workers can't start on a machine.** Since commit 07a6022 on 7 October, every worker launch first reads the program's upheld rulings. Those are review rulings carried forward from earlier runs, and reading them means listing the program's runs plus their decisions and examinations. On a laptop the engine holds your own session, so the read works. On a machine it holds an engine token scoped to its own run, so the plane refuses with "an execution token may not run.list". The runner image in use, 1.0.32, includes that commit. Every remote run fails at its first job until this is fixed. Granting `run.list` alone wouldn't fix it, because the next reads, of other runs' decisions and examinations, are refused for the same reason.
- **Why nobody saw it.** Every test that launches a worker does it with a user's session, never an engine token. The last remote runs, P15 and the walk-away fixture, happened before that commit landed.
- **The retry hit a second bug.** A launch that fails leaves its git branch behind, so the retry of the same job collided with it.

**Why the base looked red**

- **Build, db-test and e2e deferred rather than failed.** Keki's gate script prints a deferral when `docker info` fails. The machine has no Docker daemon for gate or worker users. The image ships rootless Docker's parts and the per-user ids, but nothing ever starts a daemon. The P10 notes record it as passing, but that check was done by hand on the machine and never automated.
- **The deferral was counted as a failure.** HP-01, the Docker prerequisite, was checked on your laptop at 22:29 and recorded as satisfied. The machine then trusted that record, even though its own environment had no Docker.
- **Unit really failed, because of the Node version.** The machine always runs Node 24.11.1, but keki pins Node 22 in `.nvmrc`. On Node 24, logging a ZodError makes `util.inspect` throw, which fails one reconciliation-worker test. It passes on your laptop's Node 22.

**Root fixes, as I see them**

1. **Rulings.** Either the control plane serves "this program's rulings" as one read the engine is allowed to make, or the engine table grants those reads scoped to its own program. Either way, a suite should launch a worker under an engine token so this class of bug is caught offline. The engine table was deliberately written to forbid reading other runs, so this one is your call.
2. **Docker.** The machine starts a rootless daemon for each worker user, and gates get its socket.
3. **Prerequisites.** The machine re-runs each prerequisite's verify command itself before the audit, instead of trusting a laptop's result.
4. **Node.** The machine runs the Node version the project pins, rather than whatever the image ships.
5. **Retry.** A failed launch removes the branch and worktree it created.

I can build these. Only the rulings question needs your decision first.

<!-- nightshift:message 19 human 2026-10-09T04:28:58.578Z -->
**Human** · 2026-10-09 04:28 UTC

you're able to read the conversation.md of the lightning-ux program right? It did the gate audit that we just literally shipped. then it fails on the gates not setup right? what the hell?

<!-- nightshift:message 20 assistant 2026-10-09T04:29:00.213Z -->
**Claude** · 2026-10-09 04:29 UTC

I'll read the gate audit in lightning-ux's planning conversation and compare it with what the machine did.

Yes, I read it. The planning audit was green, and it was right. It just certified a different environment from the one the run used.

**What the planning audit checked.** It ran on your laptop with Node 22 and your Docker. Setup, typecheck, lint and unit passed. Build, db-test and e2e were held back only because the draft contract still listed HP-01 as pending. The plan then says `nightshift run` audits all of them again before it starts, and you satisfied HP-01 on the laptop at 22:29.

**What the remote run checked.** With `--remote`, that second audit runs on the machine. The machine is not your laptop:

- It runs Node 24.11.1 whatever the project pins. Keki pins 22, and one unit test fails on 24.
- It has no Docker daemon for gate users, so the three Docker gates deferred. HP-01 said satisfied, because it was checked on the laptop, so the deferrals counted as failures.

**The real defect.** P15's audit has no idea which environment it is certifying. The planning audit certified the laptop, and nothing makes the machine match it. The machine's audit then found the difference and blamed the wrong thing. It called keki's base red when the same commit is green on the laptop, so the cause is the environment, not keki's code. It then opened a "repair" job whose plan was to change keki's `handler.ts` so it tolerates Node 24. That would have been a workaround committed into your product to cover for Nightshift's machine. Only the separate rulings bug, which stops any worker from starting, prevented that commit.

**What fixing the cause means.**

- **Same environment.** The machine runs the Node version the project pins and gives gate and worker users a working Docker. Then "green where you planned" means green where it runs.
- **Prerequisites re-checked on the machine.** Each prerequisite's verify command runs where the run executes, instead of carrying the laptop's result over.
- **Right blame.** A gate that passes at a commit in one environment and fails at the same commit in another is reported as an environment fault, with both results. It never becomes a repair job against the project.
- **The worker-start bug.** Workers on a machine must be able to read the program's rulings, and a test must launch a worker under an engine token.

I can build all of this. Only the rulings fix needs your decision first: the plane can serve a program's rulings as a single read the engine is allowed to make, or the engine's table can grant those reads scoped to its own program. I'd go with the plane serving them, because it keeps the engine from reading other runs, which is how its table was designed.

<!-- nightshift:message 21 human 2026-10-09T04:32:23.687Z -->
**Human** · 2026-10-09 04:32 UTC

why are we keeping the engine from reading other runs? why was that a problem on the latest keki run?

<!-- nightshift:message 22 assistant 2026-10-09T04:32:39.889Z -->
**Claude** · 2026-10-09 04:32 UTC

There's no good reason to keep it, and it protected nothing on the keki run.

**Where it comes from.** D-P10-20 says the engine's token "cannot ratify a plan, reverse a human decision, change org config, or touch another run." The point of that line is authority. An engine bound to one run should not be able to change another run, or act on a plan or decision that belongs to you. When the table was written, "touch" became "forbid every operation on another run", reads included. Nobody weighed reads separately, because nothing needed them yet.

**Why reads carry no risk.** The engine can already read its program, its project and its whole run. Earlier runs of the same program hold the same kind of records: decisions, examinations and verifications on the same repository, in the same org. Project code can't get at the token either. Since D-P10-25, workers run as separate users and cannot read the engine's token. Seeing a sibling run's records gives the engine nothing it couldn't already infer, and changes nothing.

**What happened on the keki run.** The restriction did nothing useful. On 7 October the rulings feature made every worker launch read the program's earlier runs, so the program remembers what reviews upheld. The table refused that read, and every launch failed. The cause was a rule written broader than its intent, colliding with a feature that legitimately needs the reads.

**So I'm withdrawing my recommendation.** Having the plane serve a special rulings read would route around a rule that shouldn't exist. The root fix is to make the engine's table say what D-P10-20 meant:

- **Reads.** Listing and reading runs, decisions and examinations becomes allowed across the engine's own program.
- **Writes.** Every write stays limited to its own run and held to the dispatch's generation, exactly as now.
- **Tests.** The table's tests pin both rules, and a suite launches a worker under an engine token so a feature that needs a forbidden operation fails offline, not on your machine at 3 a.m.

<!-- nightshift:message 23 human 2026-10-09T04:34:49.694Z -->
**Human** · 2026-10-09 04:34 UTC

agreed. list the tasks we're going to undertake here

<!-- nightshift:message 24 assistant 2026-10-09T04:35:09.106Z -->
**Claude** · 2026-10-09 04:35 UTC

These are the tasks. Each removes a cause found on the keki run.

1. **The engine reads its own program.** Its table allows listing and reading runs, decisions and examinations across its own program. Every write stays limited to its own run and held to the dispatch's generation. This is recorded as D-P10-29, narrowing D-P10-20's "touch another run" to writes. The table's tests pin both halves.
2. **A suite launches a worker under an engine token.** Today every launch test uses a user's session, which is why the rulings bug reached a machine. After this task, a feature that needs a forbidden read fails offline.
3. **A failed launch cleans up after itself.** It removes the branch and worktree it created, so a retry of the same job starts clean.
4. **The machine runs the project's pinned Node.** Setup reads the pin, from `.nvmrc` or its equivalents, and gates, workers and the engine's checkout all run that version. The image's Node 24 serves only the runner itself.
5. **Each worker user gets a working Docker.** The machine starts a rootless daemon per worker user and points gates and agents at it. The boot proof checks automatically, as a worker user, that `docker info` succeeds and that a Postgres container accepts a connection. Today that check was done once, by hand.
6. **Prerequisites are re-verified where the run runs.** Before its audit, the machine runs each prerequisite's verify command and records the result as the machine's. A laptop's "satisfied" no longer carries over.
7. **An environment fault is not a red base.** When a gate fails on the machine but passed in the recorded audit for the same tree, the run reports an environment fault with both results. It never opens a repair job against the project's code.
8. **Ship it.** A new runner image built from the merged commit, a deploy to dev, and the boot proof passing on it.
9. **Rerun keki's lightning-ux remotely,** the proof that the run gets past its gates and its first worker starts.
10. **Record it.** The P10 as-built notes, plus the lesson in AGENTS.md: an audit certifies the environment it ran in, and a remote run must run in that environment.

<!-- nightshift:message 25 human 2026-10-09T04:39:01.020Z -->
**Human** · 2026-10-09 04:39 UTC

does it get docker even if docker is not in any of the tests? explain 6 and 7 more in terms of user impact

<!-- nightshift:message 26 assistant 2026-10-09T04:39:22.510Z -->
**Claude** · 2026-10-09 04:39 UTC

**Docker when nothing uses it.** As I wrote task 5, yes: every worker user would get a daemon whether or not anything uses it. That is wasteful, so I'd change it. Each daemon should start only when something first connects to it, through socket activation. A project like Nightshift itself, which never touches Docker, would then pay nothing in memory or boot time. A project like keki would get its daemon the moment `docker info` or Testcontainers asks for one. I haven't yet confirmed that rootless Docker supports socket activation under a worker's user manager, so I'd prove it on the machine first. If it doesn't, the fallback is to start the daemons only for projects whose probe found Docker use. The probe already exists, as the tier recommendation from P10.

**Task 6, prerequisites re-checked where the run runs.**

- **Today.** You confirm Docker on your laptop and HP-01 is recorded as satisfied. The remote machine trusts that record without looking. On keki it had no Docker, so the Docker gates deferred, and because HP-01 said satisfied, the deferrals counted as failures. You came back to a failed run that blamed your base.
- **After.** The machine checks each prerequisite for itself before anything runs. If it's met there, the gates run normally. If it isn't, the report says plainly that HP-01 isn't met on the run's machine, and that's the machine's lack, not your repository's. The gates that need it defer honestly, and work continues on a provisional line, as it would on a laptop without Docker. Once task 5 lands, this shouldn't trigger for Docker at all. It's there so that when a machine lacks something, you hear the truth.

**Task 7, an environment fault is not a red base.**

- **Today.** A gate passes on your laptop and fails on the machine at the same code, and the run decides your code is broken. Its first job is a "repair" that changes your product to suit Nightshift's machine. On keki, that would have been rewriting the reconciliation worker's error logging to cope with a Node version you don't use. You'd have found an unasked-for commit in your product, fixing a problem you don't have.
- **After.** The run compares the machine's result with the audit recorded for the same tree. If that audit passed, the machine is the suspect. Your code is never touched to work around it. The report shows both results side by side, for example "unit passes in your audit, fails on the machine," with each output, so the cause is obvious in seconds.
- **What the run then does is your call.** I'd stop the run at the audit, before any strand starts. Building for hours on a gate the run can't trust wastes money and gives you nothing you could land. The cost is a few minutes of machine time and a report that names the environment as the cause. The alternative is to carry on and treat that gate as deferred for this run.

<!-- nightshift:message 27 human 2026-10-09T04:43:29.789Z -->
**Human** · 2026-10-09 04:43 UTC

love it. and i don't think it's unreasonable to ask the user to WAIT until nightshift says OK YOU CAN GO NOW. it could even be funny in some terminal art showing wait vs ok go. does this deserve it's own program?

<!-- nightshift:message 28 assistant 2026-10-09T04:43:46.255Z -->
**Claude** · 2026-10-09 04:43 UTC

Yes, though the fix should be split in two, because one half is blocking every remote run today.

**Ship now, outside any program: tasks 1 to 3.** These are the engine reading its own program, a suite that launches a worker under an engine token, and a failed launch cleaning up after itself. All three are complete root fixes. Each is small, and none depends on the rest. Until they land, no remote run can start a single worker, for keki or anyone. D-P10-29 goes into the P10 contract beside D-P10-28, the way the installation fix did.

**Its own program: everything else.** It has the marks of one:

- **Real decisions to ratify.** How the machine honours a project's Node pin. Whether Docker starts by socket activation or from the probe. What counts as "the same tree" when comparing audits. What the run does on an environment fault. These are expensive to get wrong and belong in a plan you rule on, not in my judgment mid-build.
- **A user-facing promise.** "Green where you planned means green where it runs" is a product guarantee, with stories in your words. That is what a plan's stories and success criteria are for.
- **A live proof that only a machine can give.** A new image, a boot proof that checks Docker and the Node pin as a worker user, and keki's lightning-ux run as the exit gate.

**The wait-then-go moment fits it well.** Today `run --remote` hands back a run id at dispatch and you're free to leave, which is exactly when the keki run was already doomed. Instead, the CLI would stay with you through boot, setup, the machine's prerequisite checks and its gate audit. The terminal shows WAIT until the machine agrees with your planning audit, then OK GO, and only then is closing the laptop safe. If the machine disagrees, you're still at the keyboard. You see the side-by-side within minutes, not after a night. That makes task 7's stop-at-the-audit cheap. Keki's audit took a few minutes on the machine, so the wait is short. That moment is also the program's natural headline, so the terminal art can be part of it.

Nightshift could build it on a local run. Once tasks 1 to 3 ship it could build it remotely too, which would make a fitting first proof. Say the word and I'll start tasks 1 to 3 now and open the program's plan with you after.

<!-- nightshift:message 29 human 2026-10-09T04:44:55.284Z -->
**Human** · 2026-10-09 04:44 UTC

sure, sounds good

<!-- nightshift:message 30 assistant 2026-10-09T04:44:59.260Z -->
**Claude** · 2026-10-09 04:44 UTC

Starting tasks 1 to 3. First, how the access levels are evaluated, so the engine's reads can be widened to its program while writes stay on its run.

Changing the engine table: every read of a run-scoped record widens from its run to its program, writes stay as they are.

Now the engine table's tests: reads reach any run of its program, writes stay on its run, nothing reaches another program.

Table done. Task 2: finding an existing offline suite where the engine runs against a control plane, to launch a worker there under an engine token.

Task 1 is done and its tests pass. Now building task 2, a world where the engine holds an engine token, so a worker launch is tested the way a machine does it.

Writing the engine mode into the execution world: a dispatch on record, an earlier run of the same program, and the environment's stores, tokens and outbox all carrying an engine token.

Now the suite itself: an engine-token world launches a worker that implements, verifies and integrates, with an earlier run of the program on record.

The new suite reproduces the keki failure word for word. It still fails because the plane runs the compiled core, so I'm rebuilding and fixing a type error.

The launch passes under the engine token now. The write refusal works, but it's refused by the generation fence before the run check, so I'm asserting the refusal itself rather than its wording.

Task 2 done, and it demonstrably fails without task 1. Now task 3: a failed launch must remove the branch and worktree it created.

Tasks 1 and 2 are done and tested. I'm on task 3: tracing why a failed launch's worktree can't be removed on a machine, where it's been handed to a worker user.

Still on task 3. I'm checking whether the engine's process on the machine runs with a group-writable umask, which decides whether it can remove a worker's worktree.

The engine runs with a group-writable umask, so permissions alone don't explain it. Reading the orchestrator's transcript from the run to see what the first cleanup actually hit.

The transcript confirms the sequence but not why the first cleanup failed. I'll reproduce it offline: a launch that fails at start, then a retry of the same job.

Adding the reproduction: a launch that fails at start, then an engine retry of the same job.

The engine may `chown` as root, so it can take a worktree back before removing it. Looking at how the execution environment exposes run-as, so reclaiming lives in one place.

Still on task 3. Removal now frees the branch or reports why it couldn't. Next is the reclaim hook, so the engine takes a worker's worktree back before removing it.

Wiring the reclaim hook through integration's environment type, then building.

Both helpers are exported. Adding unit tests for removal's two outcomes and for the machine's reclaim command.

All three suites pass. Recording D-P10-29 in the P10 contract and checking AGENTS.md for the old engine rule, then the full gate.

Full suite green: 219 files, 4423 tests. Committing, opening the PR, and once CI passes, merging and shipping a new runner image, since this code runs on the machine.

Merged as afd578e. The runner on a machine comes from the image, so this needs a new image built from that commit. Checking how a new image version gets built after deploy.

While the deploy and image build run, I'll update memory with where this stands.

The deploy is running. I'll check on it once the API stacks are through, and again when the image finishes.

Tasks 1 to 3 are built, merged as PR #11 into main at afd578e, and deploying now. The runner code ships inside the machine image, so a new image, 1.0.33, is being built from that commit. Remote runs stay broken until that image is live. I'll report when the deploy and image build finish.

What shipped:

- **The engine reads its whole program.** Every read of a run's records is allowed across its own program, and every write stays in its own run. Recorded as D-P10-29 in the P10 contract, with the lesson in AGENTS.md.
- **A suite launches workers under an engine token.** Before the fix it reproduced the keki error word for word, so the next gap of this kind fails offline.
- **A failed launch cleans up.** It removes the worktree and branch it made. The engine takes back a worktree it handed to a worker user before removing it. A removal that can't finish now fails with git's reason instead of being silently swallowed.

One cause is inferred rather than observed. Offline, the retry works. On the machine, the first attempt's worktree had already been handed to a worker user, and the engine's removal of it failed silently. The machine is gone, so I couldn't see that failure directly. Taking the worktree back before removing it removes the one difference between the machine and the passing offline test.

Verification:

| Check | Result |
|---|---|
| Full suite | 219 files, 4423 tests passing |
| CI on the PR | passed |

The environment-parity program comes next, once the image is live.

The fix is live. Remote runs can start workers again. Dispatch launches machines from image 1.0.33, built from merge commit afd578e, which contains D-P10-29 and the worktree cleanup.

| Item | State |
|---|---|
| Dev deploy | all six stacks succeeded |
| Runner image 1.0.33 | Arm and x86 images both available |
| Image the dispatcher uses | 1.0.33 |

**What this fixes for keki.** A worker now starts on the machine, and a retry after a failed launch starts clean.

**What it doesn't fix yet.** Keki's base will still come up red on the machine. The Docker gates will defer, there's no Docker for worker users, and unit fails on Node 24. Re-running `lightning-ux` remotely before the environment-parity program lands would hit those same gates. Under today's behaviour, the run would then open a repair job against keki's code. A local run of lightning-ux, or another project's remote run, is unaffected.

The environment-parity program is the next step. Say when you want to plan it and I'll start with the plan-program skill.

I'll start the plan. First, checking that the CLI is v1 and loading the repository's context and the last program's layout.

The CLI is v1. Nightshift's own programs pair a human-owned document with plan-program files, as P15 does, so I'll read P15's layout, the plan template and the gate standard next.

While the explorers read, I'm drafting the contract and plan so the gate audit has something to run from. The stories come from your messages in this conversation.

The contract needs at least one success criterion, so I'm drafting the criteria now. They'll be revised once the seams are settled.

The gate audit and the three code explorers are still running. Two gate findings so far, both of which will become decisions for you:

- **Two Node pins that disagree.** `.nvmrc` says 22, while `.node-version` and `package.json` engines say 24. CI and the image use 24. Once a machine honours a project's pin, Nightshift's own runs would depend on which file it reads.
- **The test gate reads the build gate's output.** Workspace packages resolve to their compiled `dist`, so `npm test` only sees a change after `npm run build` has run. Verification runs the gates in order, so this passes. But an agent that edits a package and runs only the tests gets stale results. That's what happened to me earlier today.

I'll bring the full audit, the seams and the decisions once they're back.

The first explorer is back, the machine-environment one. The other two and the gate audit are still running. One finding changes a fallback I offered you. The tier probe that would flag Docker-using projects exists only as a rule table, and nothing scans a repository today. So "start Docker only for projects the probe flags" would mean building the probe too. That makes socket activation the stronger option, provided it works for rootless Docker.

The second explorer is back. Nothing today waits on the machine or records a green audit. A setup failure on the machine even leaves the dispatch stuck in "provisioning" with no recorded cause. The last explorer and the gate audit are still running.

All three explorers are back. Two findings reshape the design.

- **The machine's audit doesn't recognise a declared deferral.** Job verification does, so on keki the Docker gates' deferrals counted as failures.
- **The gate-health record keeps no per-gate results.** It holds one commit, a fingerprint and an overall verdict. Gates that need a pending prerequisite usually never ran in the planning audit at all. So "green in the recorded audit" has nothing to compare against today.

Checking the gate audit.

Setup, build, typecheck and lint are green. The test suite is running now. While it finishes, I'm drafting the seams and decisions from what the explorers found.

The design is taking shape. I'll write it into the files once the test gate finishes. Checking on it.

The gate audit is green, with two findings. Before writing the decisions up, I'm checking your saved preference for how decisions get reviewed.

Writing the full plan and contract now. Under your standing review style, four low-risk decisions take my leaning, which I'll list so you can object. The other five go to you one at a time.

Now `plan.md`, at medium fidelity, with each strand's approach written from the code.

Mostly expected. I'm widening the program's scope to cover the root files, then recording the gate audit with its two findings.

Recorded as repairing, with both findings tied to their decisions. Now keeping the planning conversation, so the stories' quotes have a source.

Two fixes. The checker wants S-00 named directly in every strand's dependencies, not only through the chain. And my summary used gendered pronouns for you; I'm rewriting it neutrally.

Only your five decisions remain. Checking the plan for gendered pronouns, then putting the first decision to you.

D-06, the highest-risk decision: what does the machine compare its gate audit against, to tell "the machine is different" from "your code is broken"? On a real night, this decides whether keki's Node 24 unit failure is caught as the machine's fault in minutes or treated as keki's bug.
- Laptop audit at dispatch (Recommended): `run --remote` audits on your laptop at the exact commit first, then the machine must agree gate by gate. Adds your laptop's audit time to the WAIT (about 4 min here, more for keki with e2e), but also catches a red base before you pay for a machine.
- Planning audit's record: Keep per-gate results from the planning audit and compare against those. No extra wait, but the planning audit runs at a draft commit, usually with prerequisites pending, so the Docker gates that matter never ran and prove nothing.
- No comparison: The machine trusts only its own prerequisite checks. Cheapest, but it would still have blamed keki for the Node 24 unit failure, since no prerequisite explains that.

<!-- nightshift:message 31 human 2026-10-09T06:09:22.026Z -->
**Human** · 2026-10-09 06:09 UTC

Laptop audit at dispatch (Recommended)

<!-- nightshift:message 32 assistant 2026-10-09T06:09:27.871Z -->
**Claude** · 2026-10-09 06:09 UTC

D-03: which Node does the machine run? Your laptop is on Node 22.22.0 while this repository pins 24, so under the recommended option your own next `run --remote` of Nightshift would be refused until you switch to 24. That is the point: the mismatch is named before a machine is paid for.
- Pin decides, laptop's patch (Recommended): The project's pin decides the version; your audit's exact version is used when it satisfies the pin; an audit run on a Node that violates the pin is refused at dispatch, naming both versions.
- Pin files alone: The machine runs what the pin says, resolving a partial pin like `22` to the latest 22.x. Your laptop's version is never checked, so a laptop on the wrong Node passes its audit and the machine may disagree.
- Laptop's version alone: The machine copies exactly the Node your audit ran on, whatever the project pins. Matches the audit perfectly, but would have run Nightshift on 22 against its own pin of 24.

<!-- nightshift:message 33 human 2026-10-09T06:10:44.426Z -->
**Human** · 2026-10-09 06:10 UTC

Pin decides, laptop's patch (Recommended)

this is going to be a major issue moving forward. nightshift should work on any environment, and we are super narrow on what we support

<!-- nightshift:message 34 assistant 2026-10-09T06:11:01.633Z -->
**Claude** · 2026-10-09 06:11 UTC

You said Nightshift should work in any environment and today supports a very narrow one. As drafted, P16 fixes Node only. How wide should it reach?
- Every language runtime (Recommended): Replace the Node-only download with one polyglot version manager on the image (mise), which honours every standard pin: .tool-versions, .nvmrc, .node-version, .python-version, rust-toolchain.toml, go.mod, .java-version, .ruby-version and so on. Python, Rust, Go, Java and Ruby projects get their versions too, cached on the warm volume. OS packages are still not reproduced; the environment-fault guard catches and names what parity misses.
- The project's dev container: When a repository has a devcontainer or Dockerfile for development, run its gates and agents inside it. Closest to "any environment", but every job then runs in a container under rootless Docker, which is a much larger program with its own decisions. Runtime pins would cover projects without one.
- Node now, the rest next: Keep P16 to Node, Docker and the guard, and plan general toolchain parity as the next program. Smallest step, but the next Python or Rust project hits the same wall until then.

<!-- nightshift:message 35 human 2026-10-09T06:11:28.491Z -->
**Human** · 2026-10-09 06:11 UTC

Every language runtime (Recommended)

<!-- nightshift:message 36 assistant 2026-10-09T06:12:01.635Z -->
**Claude** · 2026-10-09 06:12 UTC

Now the plan's prose, to match: the overview, the S-01 approach and the rejected alternatives.

D-07: when the machine disagrees with your laptop's audit (an environment fault), what does the run do? On a real night: stopping costs a few minutes of machine time and you see why at the keyboard; carrying on spends the night building work whose gates can't be trusted on that machine.
- Stop at the audit (Recommended): Before any strand starts: the run and the dispatch end with the environment fault as the cause, and the report and your terminal show both outputs side by side. Nothing is built, nothing in your code is touched.
- Carry on, gates deferred: The disagreeing gates are treated as deferred and the work carries on a provisional line until you're back. More gets built, but none of it is verified by those gates on that machine.

<!-- nightshift:message 37 human 2026-10-09T06:17:35.613Z -->
**Human** · 2026-10-09 06:17 UTC

Stop at the audit (Recommended)

<!-- nightshift:message 38 assistant 2026-10-09T06:17:40.799Z -->
**Claude** · 2026-10-09 06:17 UTC

D-05: when does a worker user's Docker run on the machine? You asked whether a project with no Docker in its tests would get Docker anyway; this decides it.
- On first connection (Recommended): Each worker's socket listens from boot, and the daemon starts the moment anything connects (docker CLI, Testcontainers). A project that never touches Docker pays nothing. Unproven on the image until your boot proof; a small proxy in front of the daemon is the fallback inside this choice.
- All started at boot: Every worker's daemon runs from boot. Simplest and certain to work, but up to sixteen idle daemons on every machine, for every project, Docker or not.
- Only if a prerequisite says so: Start Docker only for projects that declare a Docker prerequisite. Cheap, but Testcontainers projects often declare nothing and would silently get no Docker.

<!-- nightshift:message 39 human 2026-10-09T06:21:00.663Z -->
**Human** · 2026-10-09 06:21 UTC

On first connection (Recommended)

<!-- nightshift:message 40 assistant 2026-10-09T06:21:04.358Z -->
**Claude** · 2026-10-09 06:21 UTC

D-08: where does a prerequisite check count? On keki, HP-01 (Docker) was checked on your laptop and the machine trusted it, so its Docker gates' deferrals counted as failures.
- Where it ran (Recommended): Each check records whether it ran on your laptop or on a run's machine, and a run trusts only checks made where it runs. Your laptop's preflight and the machine's checks never overwrite each other's meaning.
- Latest check anywhere: As today: the most recent check sets the program's status. The machine's check would overwrite your laptop's "satisfied", so a later local run could see the program as unmet because a machine lacked something.

<!-- nightshift:message 41 human 2026-10-09T06:21:53.567Z -->
**Human** · 2026-10-09 06:21 UTC

Where it ran (Recommended)

<!-- nightshift:message 43 human 2026-10-09T06:27:05.788Z -->
**Human** · 2026-10-09 06:27 UTC

i need to understand this environment issue better. my machine has node 22.22.0, but nightshift pins 24, which means when we build on it, we aren't running any gates locally? because they'd fail?

<!-- nightshift:message 44 assistant 2026-10-09T06:27:15.092Z -->
**Claude** · 2026-10-09 06:27 UTC

No. The gates do run on your laptop, and they pass on Node 22. The audit I ran today used your Node 22.22.0, and every gate was green.

Nothing enforces the pin. The `engines` field asking for Node 24 is advice to npm, which only warns unless strict engine checking is turned on, and it isn't here. `.node-version` and `.nvmrc` mean something only to a version manager that reads them, and your shell isn't using one. So your laptop runs Nightshift on 22, and the code happens to work there.

Where 24 actually runs:

- **CI.** It runs on 24, and that's what checks your pull requests.
- **The runner image.** It runs on 24, so P15 was built by Nightshift on 24.

So the same code is verified on two Node versions, and nobody chose that. It hasn't hurt because nothing in the code depends on a difference between 22 and 24. The keki run shows what happens when something does. The same commit was green on one version and red on the other, and nothing named the version as the cause.

That's why P16 refuses the mismatch instead of copying it. If your laptop audit runs on 22 and the project says 24, the audit isn't evidence for the machine. Either the pin is wrong, or your laptop is.

<!-- nightshift:message 45 human 2026-10-09T06:30:07.314Z -->
**Human** · 2026-10-09 06:30 UTC

shouldn't this just be another thing caught during the audit? i ran an audit on keki, and didn't mention this at all, but it could have been fixed during that audit

<!-- nightshift:message 46 assistant 2026-10-09T06:30:21.970Z -->
**Claude** · 2026-10-09 06:30 UTC

Partly, yes. Your laptop running a different Node from the one the project pins should be a finding in the planning audit. Today the audit never looks at runtimes at all. I found Nightshift's mismatch by accident, because I happened to read `.nvmrc` while reviewing the gates. The audit should catch two things:

- **Pins that disagree with each other,** like Nightshift's `.nvmrc` at 22 against `.node-version` at 24.
- **A laptop whose runtime doesn't match the pin,** like your Node 22 on a repository pinned to 24.

Each would become a decision during planning, and the fix would happen then, with you there.

On keki, though, the audit had nothing to catch. Keki pins Node 22 and your laptop runs 22, so the audit was right. The machine was wrong: it ignored keki's pin and ran 24. No audit on your laptop can see that, because the laptop isn't where the run happens. That half still needs the machine to honour the pin, which is S-01.

So the audit check makes a mismatch at dispatch rare, because drift gets fixed at planning. The refusal at dispatch stays as the guard for drift that arrives after planning, such as a Node upgrade between ratifying and dispatching.

I can fold the runtime check into the plan. It would be a new rule in the gate standard plus a check in the mechanical audit, most naturally in S-02, which already owns the audit.

<!-- nightshift:message 47 human 2026-10-09T06:32:19.634Z -->
**Human** · 2026-10-09 06:32 UTC

yeah i think do that too.. wouldn't that be best practice for devs to pin the same version they actually have installed so tests are accurate?

<!-- nightshift:message 48 assistant 2026-10-09T06:32:27.408Z -->
**Claude** · 2026-10-09 06:32 UTC

Yes. The practice is to pin the version you actually test on, and to have every environment read that one pin:

- **Your laptop** switches to it automatically, through a version manager that reads the pin file.
- **CI** reads the same file.
- **The machine** reads it too, after P16.

Then "the tests passed" means the same thing everywhere. That also means a project with no pin at all deserves a finding, not only a mismatched one. I'll fold all of it into the plan, starting with where the gate standard and CI read from.
