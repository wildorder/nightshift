# Planning conversation: p24-line-owner-is-a-run

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

How this plan came about (written by Claude, 2026-10-28).

The owner ran two foodfly programs onto the new project line (P23). The owner machine's first call 404ed, it looped unreplaced for 50 minutes, and once fixed its first repair parked with only "the resolver failed (exit 127)": the line's agents had no sink, no transcript and no kept log, and the machine was gone before anyone could read it. The owner asked whether such failures could be investigated afterwards without watching live, then: "should't the mechanics of a line owner be the exact same as a run?" and "plasse tell me we aren't rebuilding everything all over again".

Four designs were weighed. A line session as a run was first proposed and the owner asked for downsides; "the shared thing becomes an agent session" (a second parent on every agent record) was welcomed, then rejected by the owner because it added shape rather than removing code; repairs as separate plane-started runs were proposed as the Scion-shaped answer and rejected by the owner once it was clear they cost minutes of start-up where the warm line machine repairs in seconds. The owner's brief throughout: "i want what scales. what moves us toward the futue scion vision. but i want it done elegantly not clumsily."

Research into Scion, Gas Town's Refinery, Uber's SubmitQueue and fleet operators' write-ups settled the concurrency shape: a mechanical authority that never blocks, agents only for repairs under a budget with a human escalation, and the observation that most repeated conflicts come from a few files every change appends to. The owner raised the endless-repair risk and proposed prioritising a bounced range; the answer became reserving only the failing range's paths rather than halting the line.

The final shape: the line owner machine is the right place; it was lacking the engine, not the machine. A line owner session is a run of a per-line program with the composer (code) in the root seat, repairs are P15 repair jobs executed by the engine on the same machine, LineDispatch and the line's agent path are deleted, and every machine keeps its runner log as an artifact. Open at version 2: when paths are reserved (D-04), the repair budget (D-05), where the line program comes from (D-06), and whether a line run takes a machine slot (D-07).

## Excerpts

<!-- nightshift:session claude cbbd6508-eba8-481c-8ffe-5bae828890eb 337 -->
### Claude session `cbbd6508`

*Kept 53 of 337 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 276 human 2026-10-28T07:15:20.511Z -->
**Human** · 2026-10-28 07:15 UTC

ok - i started two more concurrently... on foodfly again.. can you check them?

<!-- nightshift:message 277 assistant 2026-10-28T07:15:43.232Z -->
**Claude** · 2026-10-28 07:15 UTC

The line is live this time: there's a line record and a line dispatch. Reading both, plus the runs:

Both programs queued onto the line (06:23 and 06:41 UTC), but the line owner is still "provisioning" with no batch taken. Checking how long that's been and the machine itself:

The machine has been running for 50 minutes, but the plane still says "provisioning", so the owner has never reported in. Reading the runner's journal over SSM:

The client does encode the branch, so the slash is being decoded somewhere between client and router. Testing the deployed route directly with the CLI, which uses the same encoded path:

Runs and lines both set the lease only on a heartbeat, so a run machine that never reports in would hang the same way. Checking for any boot deadline elsewhere:

Now the edits: the boot lease in core, set at both launches, and the branch moved to a query parameter.

Now the routes:

Some clients go through local servers rather than the gateway. Checking that each one splits the query off the path:

The local server splits the query off properly. Now the two tests that build line paths by hand:

My edit removed `url`, which the `call()` uses still need. Restoring it beside the new path and query:

Line handler tests pass. Next, tests for the boot lease. Finding the provisioning and reconciler tests to extend:

Adding tests for the boot lease: a machine launched gets one, and a line machine that never heartbeats is replaced once it passes.

While verify runs: the stuck machine (i-0bb67d16821c72551) is still restarting every 5 seconds. The boot lease only applies to machines launched after the deploy, so it won't free this one. After deploying, I'll stop it through the line's cancel route, the designed way for a human to stop a line owner. The reconciler then sees the queue still holds both programs and starts a fresh owner on the fixed code.

<!-- nightshift:message 278 human 2026-10-28T07:30:05.456Z -->
**Human** · 2026-10-28 07:30 UTC

so there was a bug? did the work land or not?

<!-- nightshift:message 279 assistant 2026-10-28T07:30:31.594Z -->
**Claude** · 2026-10-28 07:30 UTC

Yes, the bug is in the line. The programs' own work did land:

- **stock-list-simple** succeeded (05:32 to 06:22 UTC), and its work is on `program/stock-list-simple` at GitHub.
- **yaku-menu-editor** is still running. Its landings are going to `program/yaku-menu-editor` as usual.

What hasn't happened is the meeting of the two on `nightshift/develop`. Both programs' commits are queued for the line, but the line owner machine never started working: it couldn't reach the API, and has been restarting every few seconds since 06:25. So nothing has composed or checked the two programs together yet. That can't harm the programs: runs never wait on the line, and both still reach main through their own PRs as before.

Two bugs:

1. **The line's API calls 404.** The branch name `nightshift/develop` was sent as one encoded path segment, and AWS's API gateway decodes the slash before our API sees it. The tests never went through the gateway, so they missed it. The fix sends the branch as a query parameter, and a new smoke test now goes through the real gateway.
2. **A machine that never reports in was never replaced or stopped.** Its lease only started with its first heartbeat, so this one had none to lose. Machines now get a 10-minute lease at launch. This also applied to run machines.

The fix is in verify now. After deploying, I'll stop the stuck machine, and the reconciler will start a fresh line owner. It will then compose both programs' queued work, including yaku-menu-editor's later landings once its run publishes them.

Verify is green (7,776 passed). Committing and shipping. Then I'll stop the stuck owner and smoke-test.

While CI runs, I'm working out how to stop the stuck owner. Checking whether the CLI already wraps the cancel route:

The route takes a user's call. Once the deploy lands I'll call it with my session. Waiting for CI and the deploy.

Deployed. `nightshift line status` now reaches the plane through the gateway. It shows 6 queued ranges and the owner still stuck in provisioning. Cancelling that owner with my session:

The stuck owner is now "stopping". Next I'm watching the reconciler terminate it and start a fresh owner on 1.0.72, then running smoke.

The old machine is terminated and a new owner is provisioning. Watching it boot and compose:

The new owner is running and has taken the whole queue as one batch. It's composing and running foodfly's checks now. I'll report when it settles.

Run mode and line mode both pass the machine's environment, so the difference is further in. I need the line machine's own log. Checking whether the stopped machine still exists:

The machine is already shutting down and its console log has no runner lines, so the agent's own error is gone. I'll work it out from the code. Reading how the line owner launches its agents:

Both modes resolve the agent binary the same way, so the difference must be in how the line resolver is launched: as the project user, through a wrapper. Reading that:

`startLine` passes `parentEnv: {}`. Checking how `launch` builds the agent's environment from that, and what a worker launch passes instead:

Exit 127 is also the adapter's own code for "the launch failed before or during spawn", so the agent may never have started. Listing every path that reports it:

Here's where it stands. The fixes for both bugs are deployed (1.0.72), and the line now runs: a new owner started, took the queue, and ran for 14 minutes. **But it put nothing on `nightshift/develop`**:

- **yaku-menu-editor** was parked. Combining it with the line failed, so the owner called its resolver agent to repair it. The resolver failed 3 times in 3 seconds, each with exit 127.
- **stock-list-simple** isn't in the composed list or the parked list. I still need to find out what happened to it.

Your programs' own work is unaffected and is on GitHub: stock-list-simple's branch is complete, and yaku-menu-editor is still running and landing normally.

I can't tell you yet why the resolver failed. Exit 127 is also the code the adapter uses for "couldn't start the agent at all", and the adapter's explanation is thrown away for line agents. They launch with a null event sink, which is the only place that text goes. The machine's own log was gone when the owner stopped. This needs to be fixed first, otherwise every line failure stays blind. Line agent failures will carry the adapter's own explanation into the parked reason, and the parked record will also say why the composition failed in the first place. Then I'll reproduce it and fix the real cause.

<!-- nightshift:message 282 human 2026-10-28T15:59:58.714Z -->
**Human** · 2026-10-28 15:59 UTC

is the "compute slots" in the nightshift config? why only 2?

<!-- nightshift:message 283 assistant 2026-10-28T16:01:16.094Z -->
**Claude** · 2026-10-28 16:01 UTC

No. The compute slots aren't in `nightshift.config.json`; it's an org-level setting held in the control plane. A project or program config can only lower it, never raise it.

The 2 is the shipped default from P10's decision D-P10-19, agreed on 2026-10-01: at most 2 concurrent remote runs, along with $300 a month and $50 per run. The P10 doc says those numbers were provisional, "chosen without data", and meant to be revisited after the first few live runs. Your org has never set its own, so it's on that default. Since P23, a running line owner also takes one of those slots.

To raise it, write the org config with a `compute` block, for example `"compute": { "maxTier": "best", "maxConcurrentRuns": 4, "maxRunHours": 24, "maxUsdPerMonth": 300, "maxUsdPerRun": 50 }`, and apply it with `nightshift org config set <file>`. Get the current config first with `nightshift org config get`, because `set` replaces the whole thing. I can do that for you if you tell me the number.

<!-- nightshift:message 290 human 2026-10-28T17:00:43.882Z -->
**Human** · 2026-10-28 17:00 UTC

how do we find this bug? what do you need?

<!-- nightshift:message 291 assistant 2026-10-28T17:01:01.180Z -->
**Claude** · 2026-10-28 17:01 UTC

To find it, I need to watch a resolver actually launch on a real line owner on 1.0.74, which now records the adapter's error. That only happens when the line hits a conflict or a failing check. There are two ways to get one on purpose:

1. **A probe on foodfly (quick, about an hour).** I push a throwaway branch, `program/line-probe`, with a commit that conflicts with main, and queue it on foodfly's line the way I did today. The owner composes, hits the conflict and launches the resolver, and I read its journal live while it runs. The catch: if the resolver works this time, it pushes the probe's change to foodfly's `nightshift/develop`. I'd delete that branch and the probe branch afterwards, but they'd be on your GitHub for a while.
2. **A sandbox project (cleaner, a bit more setup).** A small throwaway repo in wildorder, set up as its own Nightshift project with the line on, and two tiny programs that conflict. Nothing touches foodfly. It needs the GitHub App to cover the new repo, and it costs a few runs of compute (cents to a few dollars).

Either way, what I need from you is a choice between them and the go-ahead to push to that GitHub repo. I'd go with option 2: it also gives us a standing test bed for the line that we can rerun after future changes.

<!-- nightshift:message 292 human 2026-10-28T17:02:18.802Z -->
**Human** · 2026-10-28 17:02 UTC

don't i have a foodfly program running now? will you get the logs from it when it finishes?

<!-- nightshift:message 293 assistant 2026-10-28T17:03:16.532Z -->
**Claude** · 2026-10-28 17:03 UTC

SSM returns only about 24 KB of output, so I'm capping each copy at the journal's last 400 lines and starting the watcher:

On second thought, the `sudo` lines are the most useful part for this bug, because they show the exact command run for the agent. Removing that filter and restarting the watcher:

The watcher is running. (The "failed" notice above is just the first copy, which I stopped on purpose.) Once a minute it records order-refunds' state and the line owner's. Whenever an owner machine is up, it also saves that machine's journal to `/tmp/line-watch/journal-gen<N>.log`, sudo lines included, so the exact agent command survives the machine. It stops once order-refunds has ended and the last owner has stopped.

When it finishes, I'll check whether a resolver ran. If it did, the journal and the parked reason should show what's behind the 127. If order-refunds merges cleanly with main and passes the checks, no resolver runs and we learn nothing about the bug. In that case the sandbox project is the reliable way to force the resolver to run.

<!-- nightshift:message 294 human 2026-10-28T17:06:08.432Z -->
**Human** · 2026-10-28 17:06 UTC

my question is... do you have to monitor the error live, or can you troubleshoot after, will you have the right logging in place to look at a failure afterwards? because if that's the case, i'm just going to keep operating as-is and wait for this to appear again

<!-- nightshift:message 295 assistant 2026-10-28T17:06:23.035Z -->
**Claude** · 2026-10-28 17:06 UTC

You can keep operating as-is. You don't need me watching live, though it's worth knowing what survives afterwards.

**What survives a failure:** the parked reason in the line record, which is permanent and shows in `nightshift line status`. Since 1.0.74 it carries the adapter's own explanation: the agent's error output, or the exact reason the launch failed, such as "could not start claude: spawn … ENOENT" or "could not write the Claude configuration: EACCES …". For a failure like this one, that is very likely enough to name the cause.

**What doesn't survive:** the owner machine's journal. It's gone when the machine stops, which is why I had to read it live today. Runs don't have this problem, because they save their orchestrator transcripts as artifacts; the line owner saves nothing.

If you want this fully covered after the fact, the fix is to make the line owner save its journal to the plane when it stops, the same way runs do. That's a small change. Then any line failure can be investigated afterwards from the plane alone, with no live watching. Want me to do that?

<!-- nightshift:message 296 human 2026-10-28T17:07:25.861Z -->
**Human** · 2026-10-28 17:07 UTC

omg, hell yes. should't the mechanics of a line owner be the exact same as a run?

<!-- nightshift:message 297 assistant 2026-10-28T17:07:39.543Z -->
**Claude** · 2026-10-28 17:07 UTC

Before answering, checking what a run actually keeps from its machine, so the comparison is accurate:

<!-- nightshift:message 298 human 2026-10-28T17:07:45.390Z -->
**Human** · 2026-10-28 17:07 UTC

like, plasse tell me we aren't rebuilding everything all over again

<!-- nightshift:message 299 assistant 2026-10-28T17:08:03.371Z -->
**Claude** · 2026-10-28 17:08 UTC

Mostly not. The line owner reuses most of the run machinery, but one layer was built separately, and that's where today's gaps come from.

**Shared with runs:**
- the machine itself: image, boot, identity, heartbeat, lease and generation fencing, tokens, the volume and warm snapshot;
- project setup and the project environment;
- the check runner;
- the Claude and Codex adapters, and running agents as the project user;
- the publisher's compare-and-swap push;
- the reconciler's replace-and-stop rules.

The boot-lease bug sat in this shared part, and its fix applies to runs and lines alike.

**Built separately for the line:**
- **Its plane records and routes:** a line dispatch beside the run dispatch, and the line record. The 404 was here: only the line's routes carry a branch name with a slash.
- **How it launches and records agents.** A run's agents go through the engine's full bookkeeping: an Agent record, lifecycle events, a transcript kept as an artifact. The line's resolver and examiner go through a thin parallel path. The agent is announced on the dispatch and launched, and nothing else is kept. That's why the resolver's error vanished (no event sink), and why there's nothing to read afterwards.

So the copy you're worried about is real, but it's limited to that agent-and-recording layer. The root fix isn't adding logging to the line's path. It's having line agents go through the same agent machinery runs use, so they get Agent records, events and kept transcripts, and the machine's journal is kept the same way for both. The thin parallel path then goes away instead of growing.

That's a medium-sized change, closer to a small program than a quick fix, because the run's agent bookkeeping assumes a run, an execution node and a job. Want me to scope it properly before deciding?

<!-- nightshift:message 300 human 2026-10-28T17:52:57.220Z -->
**Human** · 2026-10-28 17:52 UTC

yeah - i think it makes sense to refactor. /plan-program

<!-- nightshift:message 301 assistant 2026-10-28T17:53:25.757Z -->
**Claude** · 2026-10-28 17:53 UTC

I'll plan this with you. First I'm checking the tool and mapping the code, because the seams depend on how tightly run agents are tied to a run.

How should the line's work be recorded so it uses the same machinery as runs?
- Line session is a run (Recommended): Each project line gets its own program (no strands). Each line owner session is a Run of it, and each composition and each resolver or examiner launch is an execution node. Agents, events, routing decisions, usage, transcripts, check logs and the machine's journal then go through the run's existing stores, routes and Studio views unchanged. The line also appears in the Studio as a program with runs.
- Add a line scope everywhere: Teach every run-keyed record (Agent, Event, Artifact, RoutingDecision, Measurement) a second, line-keyed shape. Every store, route and Studio view then exists twice. This is the parallel-path problem again.

Should the line owner's machine also become the run's machine record, retiring LineDispatch?
- Yes, in this program (Recommended): The line run is dispatched like any run, and the duplicated heartbeat, token, credential and cancel handlers go away (about 250 lines that exist twice today). 'One owner per line' becomes the existing one-live-run-per-program guard. What stays line-specific is the line's actual job: the queue, batches, compositions, the push and the $25 self-started cap. Bigger and riskier, built after the recording change.
- Later: Keep LineDispatch as the machine record for now, pointing at the line's run. Smaller, but the duplicated machine handlers stay, and they're where today's route and lease bugs lived.

<!-- nightshift:message 302 human 2026-10-28T19:29:22.986Z -->
**Human** · 2026-10-28 19:29 UTC

Line records: Line session is a run (Recommended)

ehhhh... i'm not convinced on that. tell downsides, this is not decided yet.

Machine: Yes, in this program (Recommended)

<!-- nightshift:message 303 assistant 2026-10-28T19:30:17.682Z -->
**Claude** · 2026-10-28 19:30 UTC

The line watcher finished as well; checking what it caught before I answer:

Here are the downsides of making a line session a run:

1. **A line isn't a plan, but a run assumes one.** A program contract requires success criteria (at least one), an objective, a scope and so on. A line program would need placeholders for all of them, or the schema would need a special case. Placeholders are a smell; a special case is a "kind" of program everything has to know about.
2. **Everything that reads runs would see line runs.** That includes the report generator (a report with no strands), the Studio's program and run lists, compute recommendations from past runs, and the per-run caps and wall clock. Each would either show line sessions as odd runs or need a filter. That's a scatter of `if line` checks: the parallel path again, just spread out.
3. **The lifecycles differ.** A run is one attempt at a plan with an outcome. A line owner wakes on a landing, works for minutes and idles out, many times a day. That's dozens of tiny "runs" a week per project, each "succeeded", which says nothing.
4. **The line becomes coupled to run evolution.** Changes made for runs (ending rules like A-63, report rules, resume) would start applying to the line, intended or not.
5. **Authorization gets riskier.** The line's token would need run-engine access to its own run. The access tables are where a mistake becomes a security hole.

What it buys is real, though: Agent records, events, routing, usage, transcripts, the journal, the Studio views and the one-owner guard, all with no new record types.

**A middle option** that avoids most of those downsides: unify one level down. The shared thing becomes an **agent session**, not a run. The engine's agent bookkeeping (Agent record, events, routing decision, usage, transcript, journal as an artifact) is made to work for either owner: a run's execution node, or a line's composition. That keeps runs meaning runs, and the line stays a first-class thing with its own Studio view, but it shares every agent-recording path, store and adapter call. Its cost is that those records gain a second kind of parent. That's a deliberate generalisation in one place, not copies.

My leaning has moved to the middle option. Either way, it's your call, and I'll draft the plan around it.

Separately, unless you object I'll fix the EACCES bug now. It's small, its cause is confirmed, and right now it blocks every line composition that runs checks.

<!-- nightshift:message 304 human 2026-10-28T19:36:27.903Z -->
**Human** · 2026-10-28 19:36 UTC

"The shared thing becomes an agent session, not a run." EXACTLY!!! share the plumbing. ok produce some downsides to that option

<!-- nightshift:message 305 assistant 2026-10-28T19:36:56.808Z -->
**Claude** · 2026-10-28 19:36 UTC

Here are its downsides:

1. **It changes the shape of the most-used records.** Agent, Event, RoutingDecision, Measurement and Artifact are all keyed by run, and most also by execution node, right down to the DynamoDB partition keys. Giving them a second kind of parent changes persisted data in the busiest part of the table. It has to go expand → migrate → contract, with old run records still readable throughout, and it's the highest-risk part of the program.
2. **Every reader that assumes "agent means run" must decide.** That covers the report, the Studio's node views, the run-bound event outbox, the artifact upload signer and the measurement recorder. A typed parent makes the compiler find them all, but the change is wide, and anything under `packages/execution` is likely to conflict with any program running at the same time.
3. **Line events need their own numbering.** The run event log gets dense sequence numbers per run from the stream consumer, and that's what we tuned after the $105 read bill. Line-owned events need their own partition in that machinery. Get it wrong, and the cost or ordering problems come back.
4. **The line token gets real write access.** It would write agents, events and artifacts, which means new rows in the access tables, fenced to its own line and generation. That's security-relevant, so it needs high-risk review.
5. **New agent roles ripple out.** `line_resolver` and `line_examiner` are outside the agent role list today. Either they join it, and every switch over roles (routing, Studio, the report) must handle them, or they map onto the existing examiner and worker roles and lose their names.
6. **It reopens your machine answer.** "Retire LineDispatch" was natural when the line was a run, because its machine would simply have been the run's Dispatch. Under agent sessions, the same move means generalising the machine record the same way: one dispatch record whose parent is a run or a line. That's consistent, but it's a second shape change, so it needs your confirmation again under this option.
7. **Line records need housekeeping.** With no run to hang off, they need their own listing, paging and retention rules, or the line's history grows without bound.
8. **The two-parent idea could decay into a `kind` everyone checks.** That's exactly the smell we're avoiding. The guard against it: the parent is visible only where records are keyed and authorised, and all session logic (bookkeeping, sink, transcripts, journal) never looks at what owns it. That's a design rule worth stating in the plan.

None of these is a reason to drop it, in my view. Points 1, 3 and 4 are why the program's default risk should be high, and point 6 is the one decision this option needs from you again.

<!-- nightshift:message 306 human 2026-10-28T19:39:31.295Z -->
**Human** · 2026-10-28 19:39 UTC

i don't like how it seems to be making things more complex when the goal was to make things less complicated by sharing

<!-- nightshift:message 307 assistant 2026-10-28T19:40:10.496Z -->
**Claude** · 2026-10-28 19:40 UTC

You're right, and that's a fair test: both options add shape to make the line fit. Here's a simpler way to share, which removes code instead of generalising records.

**Stop having line agents at all.** The line owner's own job is mechanical: take the queue, merge, run the checks, push. Only a repair needs an agent, and a repair is exactly what Nightshift already does for a living: an agent fixes something, the checks pass, an examiner reviews it, it lands. So when the line hits a conflict or a red check, the owner starts an **ordinary run** for that repair, with the conflict as the job. When it lands, the owner takes the result, re-checks it and pushes. A repair is a real, rare, meaningful run ("repair: order-refunds onto the line"), so it gets every record, transcript, report and Studio view for free.

What goes away: the line's resolver and examiner launcher (`line-agents.ts`), the `startLine` methods in both adapters, the line agent announcements, and the resolver loop's own verify and examine logic. That's the thin parallel path, deleted rather than mirrored.

**For the duplicated machine code** (your "yes" to retiring LineDispatch): the same principle applies, sharing code rather than shapes. Both dispatch records already share their status machine. The duplicated handlers (heartbeat, tokens, credentials, cancel) become one implementation over that shared core. The line keeps its own small record for what's really line-only: queue, cap, generation fencing. No persisted shape changes.

**The machine journal** is then one shared mechanism: the runner saves its journal at stop, and periodically, to whatever it served, a run or a line.

The downsides, briefly:
- **Repairs are slower.** A repair run pays a run's start-up (its own worktree and setup) instead of an in-process launch: minutes rather than seconds. Repairs are rare, so I think that's acceptable.
- **Each repair needs a small program contract** (an unplanned one, written by the owner). It's honest content, but it means repairs appear in the program list. They're rare and meaningful, so I'd call that a feature.
- **The owner waits on a run.** The one-hour composition limit becomes "the repair run's time limit", and a failed repair run parks the range, as today.

Is that closer to what you meant?

<!-- nightshift:message 308 human 2026-10-28T22:11:52.980Z -->
**Human** · 2026-10-28 22:11 UTC

i want what scales. what moves us toward the futue scion vision. but i want it done elegantly not clumsily. what do you recommend

<!-- nightshift:message 309 assistant 2026-10-28T22:12:26.832Z -->
**Claude** · 2026-10-28 22:12 UTC

My recommendation, measured against the Scion shape: producers are never blocked, one mechanical authority moves the shared ref, and proving is batched, with bisect coming in PK-7.

**1. The line owner becomes a pure mechanical authority, with no agents in it.** It takes the queue, merges, proves, pushes and, later, batches and bisects. Today it holds a batch for up to an hour while a resolver agent works, so one conflict stalls every program behind it. That's the part that doesn't scale.

**2. A repair is just another producer.** When a range fails, the line parks it and keeps moving, and the plane starts an ordinary run to repair it. That run lands on its own branch, and its result arrives on the line's queue like any other program's landing. The line never waits on an agent, the repair gets all of a run's machinery (records, transcripts, review, report, Studio), and there's no second agent path anywhere. This is the cleanest version of "share the plumbing": there's one way work gets done, and the line just consumes its output.

**3. The plane can start runs itself.** That's the one genuinely new capability. Today only the CLI starts a run. It's also the building block for the "uber-orchestrator running it remotely" you described earlier: the same mechanism later lets the plane start runs for candidates, proving or scheduled work. A repair run counts against the self-started cap and the compute slots.

**4. Code is shared, not shapes.** One machine implementation, for heartbeat, tokens, credentials, cancel and the journal, serves both dispatch records over the core they already share. The line keeps its small record for what's genuinely line-only: queue, cap and generation. No persisted record changes shape.

**5. Every machine saves its journal** to the plane, periodically and at stop, through that same shared code, for runs and lines alike.

This removes code: the line's resolver and examiner launcher, `startLine` in both adapters, line agent announcements, and the resolver loop's own verify and examine. What it adds is small and reusable: plane-started runs, and one machine implementation.

**The cost to accept:** a repair takes minutes to start rather than seconds. The line doesn't wait for it, though, so nothing behind it slows down.

If that's the direction, I'll draft it as P24 with the stories and the decisions it leaves open. The main one is what a repair run's contract and branch look like. Meanwhile I'm fixing the EACCES worktree bug separately now, so the line works in the meantime.

<!-- nightshift:message 310 human 2026-10-28T22:19:35.090Z -->
**Human** · 2026-10-28 22:19 UTC

couldn't this produce an endless cycle of repairs if you have hundreds of things moving into the line?

<!-- nightshift:message 311 assistant 2026-10-28T22:19:59.816Z -->
**Claude** · 2026-10-28 22:19 UTC

It could. Here's the mechanism and how I'd bound it.

**Why it can loop:** a repair is made against the line as it was when the range failed. While the repair runs, the line keeps moving. When the repair lands, it may conflict with something that landed in the meantime, which triggers another repair, and so on. With hundreds of things moving, a range touching busy files could chase the line forever (a livelock). Today's design avoids this only by holding the line while the resolver works, which is exactly what stalls everyone else.

**How I'd bound it:**
1. **A repair budget per range, counted across its whole lineage.** A repair of a repair draws on the same budget (say 3). When it's spent, the range is parked for its program's PR to settle, as happens today. That guarantees termination.
2. **A repaired range goes to the front of the queue.** It's composed in the very next batch, so the window for new conflicts is the repair's own duration, not the queue's length.
3. **A line that has moved isn't a failure.** If the repaired range merges cleanly onto the newer head and passes the checks, it lands. Most moves touch other files. A second repair only happens on a *new* conflict with work that genuinely landed since, so each round is real progress, not churn.
4. **Only the colliding ranges are affected.** When batch-and-bisect arrives (PK-7), independent ranges in a batch still land, and only the culprit is parked. One hot file doesn't hold up the hundreds that don't touch it.
5. **It's measured.** Repairs per range and budgets spent show on the line, so a file that keeps colliding is visible and someone can act on it, rather than hidden in a retry loop.

Two of these change the behaviour and belong in the plan as decisions: the size of the budget, and whether a repaired range jumps the queue. Everything else is mechanics the run can settle.

<!-- nightshift:message 312 human 2026-10-29T04:14:49.106Z -->
**Human** · 2026-10-29 04:14 UTC

how does scion do it again? you've probably explained this multiple times

<!-- nightshift:message 313 assistant 2026-10-29T04:15:11.955Z -->
**Claude** · 2026-10-29 04:15 UTC

I'll take it from what we recorded earlier rather than from memory.

Here's what we recorded about Scion earlier this session. It's from Anthropic's announcement on 2026-10-13 and the analyses I found then:

- **No global merge lock.** They couldn't keep one merge queue serialising everything at agent scale. The queue kept losing ground to rebase races.
- **The server does the version control.** Commits, merges and rebases happen server-side, on changesets logged by the server. Working copies are optional, and the shared ref only moves by compare-and-swap, so producers never hold or wait on a lock.
- **They land first and prove after.** Testing moved to post-merge and pre-deploy: changes reach trunk optimistically, and the expensive proving happens afterwards on what landed. The Mergify essay describes the same fix: batch several changes into one validation, and when a batch fails, bisect to the culprit instead of re-testing everything.

What I don't have recorded is how Scion treats a change that **conflicts** at landing: whether the server resolves it, or sends it back to its author to rebase. That's exactly the part that matters for your repair-loop question, and I'd rather not guess. I can look it up properly now, a quick search of Anthropic's post and the write-ups, and then show how it should shape the line's repair design. Should I?

<!-- nightshift:message 314 human 2026-10-29T04:16:25.158Z -->
**Human** · 2026-10-29 04:16 UTC

yes please, start the search there, but go ahead and search what other people are doing too

<!-- nightshift:message 315 assistant 2026-10-29T04:16:51.134Z -->
**Claude** · 2026-10-29 04:16 UTC

Next, the primary source: Anthropic's own post. Fetching it to see what it says about conflicts and post-merge testing:

Two more sources: Gas Town, which practitioners cite as prior art for agent merge queues, and the established large-scale queues (Uber's SubmitQueue, Google's TAP).

Here's what I found. Anthropic is light on the exact mechanics, but practitioners and the established queues fill most of the gap.

**Scion (Anthropic's own post):**
- **No merge queue at all.** "A proper merge queue, for example, doesn't make much sense at agent scale," and they deliberately did not replicate "a global repository lock on the merge queue". Every commit, rebase and merge happens on the server, and the ref moves by compare-and-swap.
- **Land first, prove after.** They rely on "post-merge and pre-deploy automated testing" and "automated bisect and revert pipelines" to catch and back out a culprit.
- **Conflicts:** they acknowledge concurrent changes conflict, and say "Claude can typically fix these conflicts faster than humans can even identify them." The post does not say who triggers the fix, whether a conflicting change is rejected or rebased, or how repeated races are bounded. That part isn't public.

**What others do:**
- **Gas Town's Refinery:** a batch-then-bisect queue, Bors-style. It rebases the waiting changes as a stack on main, tests the tip, and fast-forwards them all if green; on red it bisects. Its design doc is silent on conflicts, and the third-party tools built on it disagree (some escalate, never auto-resolve; some auto-resolve).
- **Uber's SubmitQueue:** a conflict analyzer works out which changes can't affect each other, so independent ones build in parallel speculatively and only overlapping ones queue behind each other. They report 53% less CI and 37% shorter waits while keeping the mainline green.
- **Practitioners running agent fleets:**
  - The common pattern: the clean case uses no model (rebase, check, push). A model runs only on a real conflict, with a narrow "resolve conflicts, do no new work" brief, under a per-change budget, escalating to a human when spent.
  - One team measured 72 open agent PRs. **0 of 36** conflicting ones rebased cleanly, and **five shared files caused 29 of the conflicts**. Most were files every lane appends to: a `MEMORY.md` and a README. Their conclusion: a resolving bot can't drain that backlog, because the next merge re-creates it. The structural fix was removing the hotspots.

**What this means for our design:**
1. **The line stays mechanical and never blocks.** That matches Scion and the Refinery. Repairs happen outside the queue, by an agent, under a budget with escalation. That's the repair-run design, and the budget is what stops the endless cycle.
2. **The clean path uses no agent.** Most ranges just merge and pass, and only a real conflict or a red check starts a repair.
3. **Batch-and-bisect** (PK-7) is standard practice, confirmed again.
4. **Separating independent ranges, as Uber does,** is the scaling step after that: only ranges that touch the same things need ordering.
5. **The biggest lesson is hotspots, and Nightshift creates one itself.** foodfly's first line conflict was in `docs/as-built.md`, a file every Nightshift program is told to update. With hundreds of programs, Nightshift's own shared docs would cause most of the repairs. The fix is structural: each program records its as-built entry in a file of its own, and the shared view is built from those files. Then nobody appends to the same file. That alone would remove most of the endless-cycle risk before any repair budget is reached.

I'd fold all of this into P24's plan: the line as a mechanical authority, repairs as budgeted plane-started runs, and the as-built hotspot removed. PK-7 batching and the conflict analysis stay where they belong, later. Should I draft it that way?

Sources:
- [Anthropic: Redesigning source control at Anthropic](https://www.anthropic.com/research/redesigning-source-control)
- [The Register: Anthropic reinvents source control](https://www.theregister.com/devops/2026/10/13/anthropic-reinvents-source-control-as-claude-floods-the-world-with-code/5302943)
- [Matthew Wong: Anthropic Scion](https://www.matthewswong.com/en/blog/anthropic-scion-replaced-git-monorepo/)
- [Gas Town architecture (Refinery)](https://raw.githubusercontent.com/gastownhall/gastown/main/docs/design/architecture.md)
- [Uber: Slashing CI costs at Uber (SubmitQueue)](https://www.uber.com/us/en/blog/slashing-ci-costs-at-uber/)
- [agent-infra #2698: the conflicting queue cannot be automated](https://github.com/daniel-ospina/agent-infra/issues/2698)
- [agent-forge #25: automatic resolution of merge conflicts](https://github.com/lbacik/agent-forge/issues/25)
- [Merge Debt: parallel AI agents (2026)](https://heyvaldemar.com/merge-debt-2026-parallel-ai-agents/)
- [AgenticFlict dataset (arXiv 2604.03551)](https://arxiv.org/pdf/2604.03551)

<!-- nightshift:message 316 human 2026-10-29T04:23:43.060Z -->
**Human** · 2026-10-29 04:23 UTC

so let me get this right... if merging onto the line has a conflict, it will spin up a new run to fix it and merge back in? meanwhile other programs could move main forward, so when the fix comes back it might not land again?

<!-- nightshift:message 317 assistant 2026-10-29T04:23:57.353Z -->
**Claude** · 2026-10-29 04:23 UTC

Yes, that's right, with one nuance: it's the line that moves on, not only main. Other programs' ranges keep landing on the line while the repair run works. So when the fix comes back, it's composed onto a newer line head than the one it was made against.

What happens then:

1. **Most of the time it just lands.** The repaired range is merged onto the new head with no agent. The newer work usually touches other files, so the merge is clean and the checks pass.
2. **If it conflicts again, that's a new conflict,** with something that landed during the repair. Another repair run starts, against the newer head, and it counts against the same budget.
3. **When the budget is spent, the range is parked.** It reaches main the ordinary way, through its program's PR, and the line picks it up from main afterwards. Nothing loops forever.
4. **The repaired range is composed next,** ahead of the queue, so the window for a new conflict is only as long as the repair itself.

The alternative is to freeze the line while the repair runs, so the fix always lands. That's what we have today, and it stalls every program behind one conflict. Scion, Gas Town's Refinery and the fleet operators all chose not to block, and to bound the retries instead.

The repeat-conflict case is rare unless programs keep editing the same file. That's why removing Nightshift's own hotspot (`docs/as-built.md`) matters more than the budget does.

<!-- nightshift:message 318 human 2026-10-29T04:24:51.066Z -->
**Human** · 2026-10-29 04:24 UTC

but a fix never stops the line from moving ahead

<!-- nightshift:message 319 assistant 2026-10-29T04:24:56.415Z -->
**Claude** · 2026-10-29 04:24 UTC

Correct. A fix never stops the line. The line keeps taking every other range while a repair runs, and the repaired range simply rejoins the queue when it's ready. The only work that waits is the one range being repaired.

<!-- nightshift:message 320 human 2026-10-29T04:26:00.842Z -->
**Human** · 2026-10-29 04:26 UTC

so in practice, some user story keeps trying to merge onto the line but getting bounced... it theoretically could be prioritized, the line halts the repair happens, re-merges, then waiting programs can merge in?

<!-- nightshift:message 321 assistant 2026-10-29T04:26:19.806Z -->
**Claude** · 2026-10-29 04:26 UTC

Yes, that works, and it's a known remedy for starvation: optimistic by default, with a short exclusive window only for a range that keeps losing the race. It guarantees the bounced range lands, and it costs a pause only in that rare case.

I'd refine it in one way, so it scales: **reserve the files, not the whole line.**
- After a range has bounced (say on its second failed repair), the line **reserves the paths that range touches**, which is cheap to know (the list of files the range changes).
- The repair runs against the current head, and while it does, the line **holds back only ranges that touch those reserved paths**. Everything else keeps landing as normal.
- The repair re-merges onto a head that can't have changed under it in the places that matter, so it lands.
- The reservation is released, and the held ranges go next.

With a hundred programs, a full halt would stop all hundred because of one bouncing story. A path reservation stops only the handful that would collide with it anyway. It's the same "only overlapping changes need ordering" idea as Uber's conflict analysis, applied just where it's needed.

That makes the escalation ladder:
1. A clean merge needs no agent.
2. A conflict starts a repair, and the line keeps moving.
3. A repeat bounce reserves the range's paths and repairs it against a stable base.
4. If that fails too, the range is parked for its PR.

The thresholds, and reserve-paths versus halt-the-line, are decisions for the plan, and I'd lean to reserving paths. Should I draft P24 with this ladder in it?

<!-- nightshift:message 322 human 2026-10-29T04:29:57.190Z -->
**Human** · 2026-10-29 04:29 UTC

yeah i think - in theory - it sounds great. what is the liklihood you cna pull this off? i'm gonna burn some Fable tokens on this one... seems tricky

<!-- nightshift:message 323 assistant 2026-10-29T04:30:28.835Z -->
**Claude** · 2026-10-29 04:30 UTC

Good odds overall, but not uniform. Here's the piece-by-piece assessment:

**High confidence (mechanics Nightshift already has):**
- **The line as a mechanical authority.** Mostly deletion: the resolver loop, `line-agents.ts`, `startLine` in both adapters. The compose-verify-push core stays as it is and already works end to end.
- **Shared machine code and the journal.** One heartbeat/token/credential/cancel implementation over the core both dispatches already share, and the journal uploaded through the existing artifact path. Both are well-tested areas.
- **The repair budget and the park-when-spent rule.** Bookkeeping on the line record, where the parked and resolver counts already live.

**Medium confidence (new, but built from existing parts):**
- **Plane-started repair runs.** The plane already creates runs in `RunStore.put` and dispatches them; what's new is composing the repair's contract and brief without a human. The risk is in getting the brief right so a repair agent does only the repair ("resolve conflicts, do no new work"), which the practitioners' experience says is the hard part. We can test it against real foodfly conflicts before trusting it.
- **Path reservation.** The file list per range is cheap, and "hold back ranges that touch reserved paths" is a queue rule, but it interacts with batching and with generation handover. This is where a subtle bug would hide.

**The honest risks:**
1. **It's a long program on the parts of the code that move the most** (`packages/execution`, the API's dispatch and line operations). Running it beside other programs invites conflicts, and I'd run it alone.
2. **A second plane bug like today's 404 or EACCES is likely.** The line's integration tests run against fakes, which is exactly how today's bugs slipped through. The program needs a real end-to-end trial on a sandbox repo before you rely on it, and I'd make that trial part of the exit gate, not an afterthought.
3. **The repair-agent brief** will need a round or two of tuning against real conflicts. That's product work, not plumbing, and it won't be perfect on the first run.

**My estimate:** the plumbing (points 1 through 4 of the ladder, shared machine code, the journal) lands in one program with high probability. The repair runs working well on real conflicts is more like a strong start that needs a follow-up pass after you've watched a few. I'd scope P24 that way and say so in the plan, rather than promising repairs are polished on day one.

If that's acceptable, I'll draft it. Two things I'd do first, both small and separate from P24: fix the EACCES worktree bug so the line works tonight, and remove the `docs/as-built.md` hotspot from the run-program skill so programs stop colliding there.

<!-- nightshift:message 324 human 2026-10-29T04:36:36.305Z -->
**Human** · 2026-10-29 04:36 UTC

ok, now compare this against today's mechanism... where we stop the whole line to fix each conflict?

<!-- nightshift:message 325 assistant 2026-10-29T04:36:56.203Z -->
**Claude** · 2026-10-29 04:36 UTC

Here's the comparison, with where today's design is actually better as well.

| | Today: hold the line and repair in place | Proposed: never block, repair as a run |
|---|---|---|
| **A conflict's cost to others** | Everything queued behind it waits, up to an hour | Nothing waits, except ranges touching the same files once a reservation is active |
| **A conflict's cost to itself** | Repaired in seconds by an in-process agent, against a head that can't move | Repaired in minutes: a run's start-up, then a re-merge onto a newer head |
| **Chance the fix lands** | Certain, if the repair succeeds: the line is frozen under it | Very likely the first time, certain under a reservation, and parked after the budget |
| **Repeated conflicts** | Can't happen; the line doesn't move | Bounded by the budget, then the reservation |
| **What you can see afterwards** | Almost nothing: no transcript, no events, a one-line parked reason | Everything a run has: transcript, events, review, report, Studio |
| **Code** | A second agent path and a second machine path, each with its own bugs (today's 404, EACCES, exit 127) | One agent path (runs), one machine implementation, less code overall |
| **Compute** | One machine, already running | One extra machine per repair, counted against the slots and the self-started cap |
| **At your current scale** (two or three programs at once) | Fine; a one-hour hold rarely hurts anyone | Slightly slower per repair, no faster for anyone else |
| **At a hundred programs** | A conflict stalls a hundred; conflicts become the throughput limit | Conflicts cost only their own files' neighbours |

**Where today is genuinely better:** repairs are faster and simpler, and they're guaranteed to land. If you only ever run a handful of programs, today's design is the pragmatic one, and its real problems are the recording gap and the duplicated code, not the hold.

**Where it breaks:** the hold is a global lock, exactly the thing Scion, the Refinery and the fleet operators all removed. Its cost grows with the number of programs, and you asked for what scales.

**The middle ground is also available:** keep repairs in place but make them runs anyway, holding only the range's paths rather than the whole line. That buys the recording and the shared code without changing when the line moves. The path reservation in the proposal is this same idea, applied only after a range has bounced.

So the question for the plan is where the reservation kicks in: on the first conflict (closest to today, simplest to reason about) or only after a bounce (closest to Scion, highest throughput). I'd lean to first-conflict reservation now, because it's safer and still scales, and move it later only if measurements show the reservations themselves becoming the bottleneck.

<!-- nightshift:message 326 human 2026-10-29T04:38:50.432Z -->
**Human** · 2026-10-29 04:38 UTC

why is today's faster?

<!-- nightshift:message 327 assistant 2026-10-29T04:39:05.829Z -->
**Claude** · 2026-10-29 04:39 UTC

Because of where the repair starts from, not how fast the agent works. The agent's actual work is the same either way.

**Today:** the line owner machine is already up, warm, with the repository cloned, the project set up (`npm ci` done) and the conflicted merge sitting in a worktree. The resolver is launched directly into that worktree. Launch to first edit is a few seconds, and the checks run in the same place.

**A repair run:** the plane records a run, provisions a machine, boots it, mounts or restores the volume, prepares the project, starts an orchestrator, which plans a job, which launches a worker into a fresh worktree. After the fix, it goes through the merge queue, verification, publication, and only then does the line pick it up and compose it again. Each step is fast on its own, but together it's typically 5 to 15 minutes of overhead before and after the same agent work. That's the price of using the full run machinery, which is also what gives you the transcript, review and report.

Some of that overhead can be cut: a repair run could be dispatched onto a warm snapshot rather than cold, and skip the orchestrator by starting the worker job directly. Even so, it's minutes, not seconds, because a run is a separate machine and a separate lifecycle. For a rare repair that's fine; it's only a bad trade if conflicts are frequent, and frequent conflicts mean a hotspot to remove.

<!-- nightshift:message 328 human 2026-10-29T04:40:19.691Z -->
**Human** · 2026-10-29 04:40 UTC

yeah no... something tells me the line owner machine is the right way to do it.. but we said it's lacking a bunch of machinery that exists in runs?

<!-- nightshift:message 329 assistant 2026-10-29T04:41:06.542Z -->
**Claude** · 2026-10-29 04:41 UTC

Yes. The line owner machine is the right place; what it's missing is the engine. Today the machine runs the line's own small launcher instead of the code that runs jobs. The way to give it the run machinery, without a second path, is:

**A repair is a job, executed by the engine, on the line owner machine.** The engine's job path (`packages/execution`: attempt, hook sink, transcript, examination, verification, merge queue) runs in-process on whatever machine hosts it. It's the same code a run machine uses, so a repair gets a worker and an examiner with Agent records, events, routing, usage, transcripts and review, launched into the warm worktree in seconds. The line's own resolver loop and `startLine` go away.

**The one thing the engine needs is a run to key its records by.** That is the "line session is a run" option from before. Looking at it again from this angle, most of the downsides I listed soften:

- **Contract placeholders**: a line program's contract can be honest content. Objective: keep `nightshift/develop` composed. Criterion: every published range is composed or parked with a reason. Scope: the line's paths.
- **Line runs in the Studio**: a feature, not noise. You'd see the line's sessions as runs of the line program, with their jobs, transcripts and reports.
- **One owner per line** becomes the existing one-live-run-per-program guard, and **LineDispatch retires**, which you already said yes to.
- **The line's token** becomes an engine token for its own run: the existing access tables, no new rows.

**What remains:**
- **Many short runs.** Each wake of the owner is a run, dozens a week per busy project. They'd need to be cheap to list and easy to tell apart from program runs, so I'd mark the line program as a `line` kind and have the Studio and report treat it accordingly. That's a kind check in two or three readers, not everywhere.
- **Run-wide rules apply.** Caps, wall clock and ending rules now cover line sessions. Mostly that's correct; it needs a look at each.

That's now my recommendation. The repair stays fast, the line gets every record a run has, and the program deletes the parallel agent and machine paths rather than generalising around them. Want me to draft P24 on this basis?

<!-- nightshift:message 330 human 2026-10-29T04:42:02.688Z -->
**Human** · 2026-10-29 04:42 UTC

so the line owner is like the root orchestrator of a program run?

<!-- nightshift:message 331 assistant 2026-10-29T04:42:18.361Z -->
**Claude** · 2026-10-29 04:42 UTC

Close. It sits in the root orchestrator's position, but it's code, not an agent.

On a run machine: the runner boots, starts a root orchestrator (a Claude or Codex session), and that agent drives the engine through tools (`delegate`, `job.wait`, `run.finish`). The agent decides what work to cut and when the run is done.

On the line machine: the runner boots and starts the line composer, which is deterministic code. It takes the queue, merges, verifies and pushes, and the one time it needs intelligence, a conflict or a red check, it asks the engine for a job the same way the orchestrator's `delegate` tool does, with a fixed brief ("resolve this merge, do no new work") and the usual examination. When the queue is idle, it ends its run the way `run.finish` does.

So it's a mechanical orchestrator: the same seat, the same engine underneath, no model in the seat. That's deliberate, and it's where Scion's "mechanical authority, agents only for repairs" lands in Nightshift's structure.

One consequence worth naming: the line's repair is a job, so it gets a job's whole treatment, including the examiner review and the merge-queue landing onto the line's candidate. Nothing about repairs is special-cased any more.

<!-- nightshift:message 332 human 2026-10-29T04:44:57.700Z -->
**Human** · 2026-10-29 04:44 UTC

but don't you need some intelligence at the root? what if a second merge lands while one repair job is running? does it just spin up another one? with both having no context into the other?

<!-- nightshift:message 333 assistant 2026-10-29T04:45:42.977Z -->
**Claude** · 2026-10-29 04:45 UTC

You don't, and the reason is that the line's decisions are determined by data the composer already has, where a run's root decisions aren't. Take your scenario:

**A conflicts, its repair job starts. B lands in the queue.**
1. The composer reserves A's paths (the files its range changes; cheap to know).
2. B arrives. If B touches none of A's paths, it's composed now, onto the current head. If it does, it waits until A's repair lands. That's a set intersection, not a judgement.
3. A's repair finishes against the head it started from. Re-merging it onto the newer head is mechanical, because by construction nothing landed in A's files meanwhile.

So two repairs are concurrent only on disjoint files, exactly like two jobs in different strands, and they need no knowledge of each other. When they'd overlap, the second one waits, so it's repaired against a tree that already contains the first.

**Where context does matter, it's in the brief, not in a model at the root.** A repair job's brief is assembled by code from facts: the line head, which ranges it contains, the conflicting paths or the failing check's output, what landed since the range was published, and the line's recent repair decisions. The agent sees the tree, which contains everything that landed before it, and the examiner reviews against that same tree. That's more context than a human resolving the same conflict usually has.

**The one case that needs judgement** is a semantic clash: A and B touch different files, each is green alone, together the checks fail. No root intelligence prevents that; you find it by proving the combination. The composer already handles it mechanically: a red batch falls back to one at a time, so B becomes the failing unit and its repair brief says "onto a head that includes A, these checks fail". That's the batch-and-bisect pattern, and PK-7 formalises it.

**What a model at the root would add** is policy: repair or park, who goes first, noticing a hotspot. Everyone who has run this at scale made those explicit rules with a human escalation, because a model quietly making content decisions about other people's work is the failure mode they all hit. The composer parks after the budget and shows the hotspot; the judgement stays with you.

If a run's root were as determined by data as this, it wouldn't need a model either. It needs one because cutting a plan into jobs is open-ended. Composing a queue isn't.

<!-- nightshift:message 334 human 2026-10-29T04:46:49.995Z -->
**Human** · 2026-10-29 04:46 UTC

ok, yeah I htink i like this. how difficult is it to spin up a job inside the line owner machine? previously you said that machinery didn't exist in the line owner

<!-- nightshift:message 335 assistant 2026-10-29T04:47:01.401Z -->
**Claude** · 2026-10-29 04:47 UTC

Let me check the actual entry points before I answer, so this is grounded in the code rather than memory.

Less difficult than I made it sound, and for a reason I'd forgotten: **repair jobs already exist.** P15 added them (D-P15-04): a job a run may add outside its strands, carrying a recorded decision, examined at high risk, allowed to change anything including the gates. A line repair is one of those with a new cause (`line_conflict`, `line_red`). Nothing about the job kind is new.

**What launching one takes.** The engine's job path is two plain functions, `delegateJob` and `startJob` in `packages/execution/src/runner.ts`. The MCP `delegate` tool is a thin wrapper around them. They need an `ExecutionEnvironment` (stores, harness, git, paths, event outbox, project environment, run-as) and a `RunSession` (the run's scope, its program contract, root node, an orchestrator agent id, the checkout path). The line owner already holds most of the environment: harnesses, git, paths, run-as, the project environment, the checkout. And the code is already on the machine, because the runner image ships the whole engine.

**What it's missing, honestly:**
1. **A run to be.** The `RunSession` wants a Run, a program contract and a root node, and every record the job writes is keyed by them. That's the "line session is a run" piece: a line program per project line, a run per owner session, dispatched like any run. This is the bulk of the work, and it's what also retires LineDispatch and the duplicated machine handlers.
2. **An engine token instead of a line token.** Falls out of 1: a run machine gets its engine token at dispatch, and the standard HTTP stores work with it. The line's own plane client and most of the `line.*` routes shrink to the queue, settle and push.
3. **Where the job lands.** A job integrates onto a branch in the local checkout through the merge queue. For a repair, that target is the line's candidate rather than a strand branch. There's a pleasing simplification available: the line program's `programBranch` is the line branch itself, so the engine's own integration lands the repair where the composer wants it. That's the one adaptation that needs care.
4. **The composer calling the engine.** Replace the resolver loop with: record the decision, delegate the repair job, wait for it to land, take the commit as the candidate. The job's own verification and examination replace the loop's.

**Difficulty:** moderate. The job launch is a few calls; the real work is the run identity and the landing target, plus the deletions. It's one program, and it's in the engine and dispatch code, so I'd run it on its own, not beside other programs.

Want me to draft P24 now on this basis?

<!-- nightshift:message 336 human 2026-10-29T04:50:01.334Z -->
**Human** · 2026-10-29 04:50 UTC

yes
