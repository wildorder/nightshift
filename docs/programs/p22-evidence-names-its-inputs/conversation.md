# Planning conversation: p22-evidence-names-its-inputs

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

The owner proposed splitting Pipkin M1 so the low-risk PK-1 and PK-2 are built and tried before PK-3. Planning both as one program surfaced that a verification made outside a run has no honest home before PK-4 (filing it under the latest run would mix a check into a run that did not do it), and that PK-2's lasting consumers are candidate qualification (PK-5) and background proving (PK-7). The owner questioned the value of PK-2 now; the claimed benefit of learning suite timings was weak, and the owner chose to build PK-1 alone now and PK-2 with M2. A separate setup hash was dropped because the gate fingerprint already covers setup.

## Excerpts

<!-- nightshift:session claude cbbd6508-eba8-481c-8ffe-5bae828890eb 219 -->
### Claude session `cbbd6508`

*Kept 12 of 219 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 206 human 2026-10-26T20:06:34.333Z -->
**Human** · 2026-10-26 20:06 UTC

looking ahead, what would be the next bit of pipkin work

<!-- nightshift:message 207 assistant 2026-10-26T20:06:46.166Z -->
**Claude** · 2026-10-26 20:06 UTC

Next is **M1, "verify anything, any time."** M0 now meets its own bar: you've planned and run two foodfly programs entirely through the control plane, and both worked.

M1 is three issues:
- **PK-1: verification records name their inputs.** Each check result records what it ran against: base, fingerprint, environment. A landing can then accept evidence that already covers its change.
- **PK-2: `nightshift verify`.** Run a program's checks, end-to-end suite included, on any head at any time, separate from `run.finish`. This is also the tool for the work done outside Nightshift that we discussed, e.g. "verify this program on `main`" for something you finished in your own session.
- **PK-3: one owner per development line.** The first step towards several programs landing into one project line without the conflicts all arriving at merge time. It's the most design-heavy of the three.

PK-1 comes first, since PK-2 builds on it. PK-3 can run alongside. Landing behaviour doesn't change in M1. What you get is learning how long keki's and foodfly's real suites take, and how often they flake, before anything later depends on that.

PK-18 (project memory) could also run alongside: it only needed M0, and it improves every agent run.

Want me to plan M1 as P22? I'd also mark PIP-23 (PK-15) Done in Linear, since it's finished.

<!-- nightshift:message 208 human 2026-10-26T20:10:11.810Z -->
**Human** · 2026-10-26 20:10 UTC

could we split this milestone? seems like PK-1 and PK-2 are lightweight and low risk. I could execute those, run a couple tests, before doing PK-3 which seems higher risk? just a thought

<!-- nightshift:message 209 assistant 2026-10-26T20:10:33.103Z -->
**Claude** · 2026-10-26 20:10 UTC

Yes, splitting makes sense, and the issues support it.

**PK-1 and PK-2 as one small program** (M1a):
- **PK-1:** verification records gain optional fields for what they ran against. The check that decides which records count as landing evidence becomes an explicit list instead of an exclusion. Verification writes become create-only.
- **PK-2:** generalises the end-gate runner you already use at `run.finish` to any commit, adds `nightshift verify`, and is opt-in: nothing changes unless you call it.
- **Risk:** both are mostly additive, and old records read unchanged. The one thing to watch is create-only writes. If any current path rewrites an existing verification record, that path would start being refused. The program should look for such paths first and treat each as a decision, not something to quietly work around.
- **Trial:** each issue already names one. Run a keki or foodfly job and see the new fields on its verifications. Then, during a live run, verify head N while a job lands N+1, and check that the record names only N.

**PK-3 on its own afterwards** (M1b). It's a different kind of change:
- a control-plane lease on a development line, fenced on every landing and publication;
- your decision that the line is project-wide, so programs meet on one line instead of each having its own;
- every landing path touched.

It deserves its own plan, its own decisions and its own trial period.

M1a also gives you `nightshift verify` early. That covers "verify on `main` a program finished outside Nightshift", which you wanted anyway.

Want me to plan M1a as P22?

<!-- nightshift:message 210 human 2026-10-26T22:04:10.814Z -->
**Human** · 2026-10-26 22:04 UTC

yes please

<!-- nightshift:message 212 human 2026-10-26T22:22:46.943Z -->
**Human** · 2026-10-26 22:22 UTC

1. under the programs latest run? isn't that possibly inaccurate? I don't like that you can't tease out what was a simple verify job from an actual run. how does this impact our larger pipkin vision of work being continuously merged and verified? 
2. I'm fine with laptop for now, but honestly I imagine some uber-orchestrator running it remote eventually
3. every step? didn't we move away from running the full suite after after job landed? how does this affect it? how does this decision lean into our future-pipkin world?
4. idk, explain

<!-- nightshift:message 213 assistant 2026-10-26T22:23:05.832Z -->
**Claude** · 2026-10-26 22:23 UTC

On D-04 I need to check one fact before answering: whether the gate fingerprint already covers the setup steps.

Taking them in order.

**1. Filing under the latest run: you're right, it's inaccurate.** It would mix "I checked this commit" into a run that didn't do it.
- **In the Pipkin direction,** evidence belongs to a commit, not to a run. PK-4 makes snapshots (commits on a line) first-class records, and PK-7 has those snapshots proven in the background while work keeps landing. A run is just one producer of evidence; PK-16 even describes runs as "compute envelopes".
- **What I'd do now:** a verification made outside a run gets its own small envelope, a run record marked as a verification run. It has no orchestrator and no strands, and runs just the checks.
  - The Studio and reports show it as a verification, not a run, so you can always tell the two apart.
  - It's honest about who produced the result.
  - It doesn't jump ahead of PK-4 by inventing snapshot records now.
- **When PK-4 lands,** verifications become findable by commit whichever envelope produced them.
- **Rejected alternative:** filing verifications under the program with no run at all. That's the deeper version, but it means new storage keys, routes and permissions, and it's exactly what PK-4 will design properly.

**2. Laptop now, remote later: agreed.** I'll keep the runner code the same wherever it runs. Then your later "uber-orchestrator", which is really PK-7 proving snapshots in the background on a machine, can dispatch it remotely without a second implementation.

**3. Every step, and why it doesn't undo A-57.**
- **What A-57 changed:** the expensive suite stopped running on every job's landing.
- **A snapshot isn't a landing.** It runs only when someone asks, so its cost is paid once, on purpose.
- **This is the Pipkin model.** In M3, landings run only targeted, cheap tests and the full suite proves a snapshot in the background. A snapshot verification is exactly that proof, so it should be the whole suite.
- **Outside work needs it too.** For a program finished outside Nightshift, no landing ever ran the landing gates. "End gates only" would leave them unchecked.
- **The reuse is just A-57 applied:** if a snapshot of the unchanged head already passed everything, `run.finish` doesn't run the end gates again.

**4. The setup hash: I'd drop it.** It was meant to say what the environment was set up from, so two results could be told apart. But the gate fingerprint already covers it: it hashes the setup steps, the verification steps, the gate machinery files and every lockfile. A separate setup hash would record the same fact twice. A verification would carry base, commit, gate fingerprint, and where it ran (laptop, or machine with dispatch generation and image version).

Should I revise to: D-01 a marked verification run, D-02 laptop for now, D-03 every step with reuse at finish, D-04 no separate setup hash?

<!-- nightshift:message 214 human 2026-10-26T22:33:06.485Z -->
**Human** · 2026-10-26 22:33 UTC

1. why don't we just wait for PK-4? what else is dependent on nightshift verify that indicates we should still put this ahead of everything else now. 
good with the rest

<!-- nightshift:message 215 assistant 2026-10-26T22:33:27.822Z -->
**Claude** · 2026-10-26 22:33 UTC

Good question. Most of PK-2 doesn't need an answer to where to file outside work at all. Only one use case does.

**What PK-2 is for, beyond the "outside work" case:**
- **Verifying mid-run.** Run the full suite on the current head while the run keeps going, when you decide to. That's M1's point: learning how long keki's and foodfly's real suites take and how often they flake, before M3 depends on them. That result belongs to the live run, so there's no filing question.
- **Being the foundation for M2 and M3.** PK-5 "qualifies" a release candidate by verifying a chosen commit. PK-7 proves snapshots in the background while landings continue. Both need what PK-2 builds: one runner that verifies any commit and records a result bound to that commit. PK-4 itself only needs PK-1's evidence identity, not PK-2.

**The only part that needs PK-4** is verifying a commit outside any run, as for a program you finished in your own session. Commits have no record to hang evidence on until PK-4 gives them one, which is why every option I offered was a compromise.

So I'd split PK-2 at that line:
- **Now:** the generalised runner, the `snapshot` phase, the MCP tool, and `nightshift verify <program> [--commit]` for a program with a live run, filed under that run. With no live run it refuses, and says verifying outside a run comes with PK-4.
- **With PK-4:** verification outside a run, filed against the commit's own snapshot record. You get the outside-work story then, properly, instead of a stand-in now.

D-01 then goes away. Shall I revise the plan to that, with D-02 to D-04 as agreed?

<!-- nightshift:message 216 human 2026-10-26T22:35:44.301Z -->
**Human** · 2026-10-26 22:35 UTC

i still don't understand the value of "learning how long keki and foodfly real suites take and how often the flake" ... what are we going to do with that info? also, you mentioned 2 specific projects but i assume there is value beyond just me and my projects

<!-- nightshift:message 217 assistant 2026-10-26T22:36:07.046Z -->
**Claude** · 2026-10-26 22:36 UTC

You're right to push on that. "Learn how long the suites take" was a weak reason and I overstated it. The data does have a use later: PK-7 has to decide how often to prove snapshots in the background, trading cost against how quickly a break is noticed. But that alone doesn't justify building PK-2 now. And yes, nothing here is specific to your projects.

The value that does hold, for anyone whose project has an expensive end-to-end suite:

- **A break shows up near where it happened.** Today the end suite runs once, at finish. If it fails after an eight-hour run, the cause could be any of the landings since the start, and the fix job has to dig through all of them. Verifying the head after a risky strand lands, or every few landings, narrows that to the last few. The suite costs the same; what you gain is a short list of suspects instead of the whole night.
- **It's the foundation for M2 and M3.** Candidate qualification (PK-5) and background proving (PK-7) both are "verify this exact commit and bind the result to it". That's the one piece that has to exist before either.

That raises an honest alternative to what I proposed:

- **Option A: PK-2 now, limited to live runs.** The early-break value is real, but only if the orchestrator is told when to use it, for example "after a strand lands, if end gates exist". That's a small change to its instructions, and it adds cost to runs.
- **Option B: PK-1 alone now, PK-2 with M2.** Build PK-2 together with PK-4 and PK-5, where verifying any commit has a home (the snapshot record) and a clear consumer (qualifying a candidate). M1a becomes very small: records that name their inputs, one landing-evidence rule, create-only writes. It's still worth doing first, because PK-4 depends on it.

I lean B. It builds `nightshift verify` once, in the place it's actually used, instead of a live-run-only version now and the general one later. It also means outside work waits for M2. Which would you rather?

<!-- nightshift:message 218 human 2026-10-26T22:40:10.655Z -->
**Human** · 2026-10-26 22:40 UTC

B
