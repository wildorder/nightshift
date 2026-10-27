# Planning conversation: p23-project-line

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

The owner asked how far through Pipkin they need to get to run many programs at once, which led to M1b: a project-scoped line (already decided on 2026-10-20). Diagrams of the options and a comparison with Scion led the owner to choose an optimistic line with no lease, programs still reaching main through their own pull requests, and a check that dependent strands never ship half a program (nothing ships from the line in M1b; M2 candidates must hold whole programs). Research confirmed git and GitHub remain right, and batch-and-bisect was noted for PK-7. The code map showed a landed strand cannot be reopened and a run's engine has no GitHub access mid-run; the owner's question about a listener led to a single line owner started by the control plane, which composes and repairs. The owner chose natural batching by program-branch range, a resolver that lands its own fix after checks and examination, a separate short-lived machine, and work left on the line branch with no pull requests in M1b.

## Excerpts

<!-- nightshift:session claude cbbd6508-eba8-481c-8ffe-5bae828890eb 259 -->
### Claude session `cbbd6508`

*Kept 29 of 259 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 184 human 2026-10-24T22:33:12.057Z -->
**Human** · 2026-10-24 22:33 UTC

how far through pipkin do i need to get to be able to spin up many programs building at the same time?

<!-- nightshift:message 185 assistant 2026-10-24T22:33:29.769Z -->
**Claude** · 2026-10-24 22:33 UTC

You can do much of it today. What Pipkin adds is that they don't fight each other when they land.

**Today, with no Pipkin:**
- **Remote:** separate programs can already run at once. Each gets its own machine and its own program branch, and nothing in the engine stops two programs running together. The limits are the org's compute ceilings (the `run_cap` and spend caps) and your providers' rate limits.
- **Local:** a laptop checkout runs one program at a time, because the run works on a checked-out branch.

**What breaks at scale.** Each program branches from `main` and lands on its own program branch. You then merge each one to `main` by hand. Five programs touching the same code means five branches that drifted apart overnight, and the conflicts all land on you at merge time. Nightshift's guarantee, that everything is verified on the real head, stops at the program branch.

**Where Pipkin fixes it:**
- **M1, PK-3 (one owner per development line):** the first real step. A project gets one line that every program lands into, with one owner serialising what reaches it, so programs integrate continuously instead of at merge time.
- **M3, PK-7 + PK-10:** this is where "many at once" actually works. Strands land on targeted tests, combinations are proven asynchronously with failures becoming owned repairs, and concurrent strands that touch shared contracts agree on them up front instead of colliding.
- **M4, PK-16:** strands become the unit of intake and runs just compute envelopes. "Programs" stop being the thing you start at all; work flows in and gets scheduled.
- **PK-20 (jobs in slices):** improves cost and throughput, but isn't needed for correctness.

For a handful of independent programs in different areas of the code, you can do it now, remotely. For many programs in the same project landing cleanly, you need M3, and M1's PK-3 is the first step that changes the picture.

<!-- nightshift:message 228 human 2026-10-27T02:14:06.348Z -->
**Human** · 2026-10-27 02:14 UTC

let's plan it together I want details... what are you thinking for M1b/PK-3

<!-- nightshift:message 229 assistant 2026-10-27T02:15:33.943Z -->
**Claude** · 2026-10-27 02:15 UTC

Here's what I'm thinking, starting with what the issue settles and what it leaves open.

**What PK-3 already settles.** You decided on 2026-10-20 that the development line is project-wide, for example `nightshift/develop`, not one per program. Program branches stay each run's working line, and the project line is where all programs' work meets. That was so several features or fixes can run at once and be proven together before a release candidate is cut (M2), and so work arriving one item at a time (PK-16, PK-17) has somewhere to land.

The issue mixes two different problems, though. I'd separate them:
- **A. Two runs of the same program.** Today nothing stops two runs writing the same program branch, say a forgotten local run and a remote one. That's a bug waiting to happen, and fixing it is small.
- **B. Many programs meeting on one project line.** This is the real M1b, and the bigger change.

**How B would work:**
1. A strand lands on its program branch exactly as today: verified, examined, integrated.
2. It's then **composed onto the project line**: merged onto the line's current head.
3. The merged result is **verified on the line**. Landing gates only, the cheap set, since end gates stay at the end per A-57. If the line hasn't moved since the program branch last took it in, the merge is a fast-forward and the existing evidence covers it, so there's nothing to re-run.
4. It's **published to GitHub**, with the publisher's exact-predecessor push.

**What I'd decide differently from the issue: the lease.** The issue proposes a control-plane lease, a lock on the line that one engine holds while it composes. But the publisher already pushes with an exact-predecessor check: it moves the branch only if it's still where the composer saw it. So two composers racing can't overwrite each other. One push is refused, and that composer recomposes on the new head. Correctness already exists. A lease adds only efficiency: no wasted verification when two compose at once. So I'd build composition on that existing check first, and add a lease only if the race actually costs anything in practice. It's less new machinery, and less risk.

**Questions that are yours:**
1. **When does work reach the line: each strand as it lands, or each program when it finishes?**
   - Per strand finds cross-program breakage within minutes, and is the M3 direction.
   - Per program is closer to today, with fewer compositions, but conflicts surface late.
   - I lean per strand.
2. **When a composition fails on the line (conflict or red gates), who fixes it?**
   - The composing strand's own orchestrator: it's that strand's change meeting someone else's.
   - Or a repair job owned by the line.
   - I lean the strand's orchestrator, which matches how a failed landing is fixed today.
3. **How does `main` relate to the line?** Today each program becomes a PR to `main`.
   - In M1b, does a PR from the line to `main` replace program PRs?
   - Or do program PRs stay, with the line only for proving combinations, until M2's candidates take over?
   - I lean that program PRs stay in M1b. The line proves combinations, and M2 changes what you merge. Fewer moving parts per milestone.
4. **Is the line on by default for every project, or does a project opt in?** I lean opt-in per project (`nightshift.config.json`), so keki and foodfly can trial it without touching your other repos. That's your "don't break other projects" rule.
5. **Should M1b split again?** A (one run per program) is tiny and pure safety, and could ship first. B is the real program.

Which of these do you want to dig into first?

<!-- nightshift:message 230 human 2026-10-27T02:25:38.709Z -->
**Human** · 2026-10-27 02:25 UTC

can you diagram it. tell me what version control mechanisms are being used at each step... provide multiple diagrams if there are multiple options worth considering. and remind me what scion found was the bottleneck, and are we addressing that bottleneck

<!-- nightshift:message 231 assistant 2026-10-27T02:26:45.769Z -->
**Claude** · 2026-10-27 02:26 UTC

Checking what we said about Scion earlier, so I don't misremember it.

Four diagrams follow: today, two ways to build the project line, and how M3 removes the bottleneck. Each step names the version-control mechanism it uses. Then Scion's bottleneck, and the honest answer on whether PK-3 addresses it.

### 0. Today: one program, one line

```
 job worktree            strand branch                program branch         GitHub
 (git worktree add,      nightshift/<run>/<strand>    program/<id>
  detached at strand     
  head)                                                                          
                                                                                 
 worker edits files ──►  Nightshift commits the  ──►  (nothing yet)
 (never commits)         worker's diff, then
                         `git merge` it onto the
                         strand branch ("Merge job …")
                                │ every move: pack-objects → bundle in S3 →
                                │ publisher pushes the strand branch (A-60)
                                ▼
                         strand complete:
                         1. `git merge` program head INTO strand
                            ("Merge the program head … into strand")
                         2. verify in a fresh detached worktree
                         3. examine the diff
                         4. seal (ref: refs/nightshift/sealed/<node>)
                         5. program branch `merge --ff-only` to strand head ──► publisher pushes
                                                                                with expected
                                                                                predecessor
                                                                                (compare-and-swap)
 merge queue: in-process mutex, one landing at a time per run
```

The program branch only ever moves by fast-forward. Every check ran on exactly the commit that becomes the head.

### A. Project line with a lease (what PIP-9 proposes)

```
 program/A ──(lands as today)──►┐
                                │      ┌──────────── control plane ─────────────┐
 program/B ──(lands as today)──►┤      │ LINE-LOCK per (project, line):          │
                                │      │ holder run + generation, expiry,        │
                                ▼      │ heartbeat; fenced like the dispatch     │
                    composer (the run that landed):                              │
                    1. TAKE LEASE ─────►│ (wait here if another run holds it)    │
                    2. `git fetch` line head (nightshift/develop)                │
                    3. `git merge` strand INTO a candidate from line head        │
                       (fast-forward when the line has not moved)               │
                    4. landing gates in a fresh worktree                         │
                    5. publisher pushes line, expected predecessor = head seen   │
                    6. RELEASE LEASE ──►│                                         │
                                       └────────────────────────────────────────┘
 nightshift/develop: moves one composition at a time, every one verified
```

### B. Project line, optimistic: no lease

```
 program/A lands ─► composer A: fetch line @X, merge, verify ─► push "X→A'" ── accepted
 program/B lands ─► composer B: fetch line @X, merge, verify ─► push "X→B'" ── REFUSED
                                                                (head is A', not X)
                    composer B: fetch line @A', merge again, verify again ─► push "A'→B''" ── accepted
```

Correctness comes from the publisher's existing compare-and-swap push, so nothing new is needed for it. When composers collide, the loser re-merges and re-verifies.

### C. M3, PK-7: land on targeted checks, prove afterwards

```
 strand ─► merge onto line head ─► targeted tests only (seconds) ─► push (compare-and-swap) ─► line moves
                                                                          │
                                       snapshot of line head N ◄──────────┘ (any time, in the background)
                                       full suite on N → evidence bound to N
                                       red? → find the culprit landing → owned repair
 candidates for main are cut only from proven snapshots (M2)
```

### What Scion found, and whether PK-3 addresses it

From our earlier comparison: Scion couldn't keep a **global merge-queue lock** at agent scale. Every change waited its turn to be tested before landing, so they moved to post-merge, pre-deploy testing. (Their other bottleneck, clone and checkout on a 100 GB repo, isn't yours.)

**PK-3 does not remove that bottleneck. It creates the place where it would show up.** A shared project line is exactly where many programs' landings would queue.
- **A** builds Scion's lock literally: one composer at a time, waiting on a lease.
- **B** has no lock, but each landing still re-verifies when it collides. Under real load, the retries become the same queue.
- **C** is how Scion actually fixed it, and that's PK-7 in M3: the line moves on cheap targeted checks, and the full suite proves snapshots afterwards.

That changes my lean. For M1b, choose the design that M3 will extend, not the one it has to tear out.
- **B fits that.** No lock to remove later. Its re-verification is exactly the part PK-7 shrinks to targeted checks. And at your current concurrency, a handful of programs, collisions will be rare.
- **A** means building a lease in M1b and dismantling it in M3.

Scale is the qualifier. With two or three concurrent programs, A and B behave the same. The difference only shows at the concurrency Pipkin is aiming for.

Do you want B as the M1b design? If so, the earlier questions remain: per strand or per program, who repairs a failed composition, and how `main` relates to the line.

<!-- nightshift:message 232 human 2026-10-27T02:36:01.337Z -->
**Human** · 2026-10-27 02:36 UTC

yes I want B. Orchestrator can repair the failed composition... that's fine I think. FOr strand vs program... the only question i have about strand is.. what if multiple strands are dependent on each other and one shouldn't get pushed out without the others? if strands land and then we push out a deploy before the others do... isn't that a problem? how will that work? finally... explain the main relates to the line again

<!-- nightshift:message 233 assistant 2026-10-27T02:36:37.769Z -->
**Claude** · 2026-10-27 02:36 UTC

Both questions come down to one distinction: **the line is where work is put together and proven, not where releases come from.** Deploys come from `main`, today through PRs and in M2 from release candidates.

### 1. Dependent strands, and "half a program got deployed"

Within a program, nothing changes about order. S-02 `dependsOn` S-01 still can't land on the line before S-01, because each strand reaches the line when it lands, and it lands in plan order. The plan rules already require every strand to be **independently green**, with a shared shape changed as expand → migrate → contract. So the line is never broken by half a program. It can, though, contain an unfinished feature: S-01's new storage without S-02's UI.

**Why that's safe in M1b:**

```
 line:  …─A:S-01─B:S-01─A:S-02─B:S-02─A:S-03…   (programs interleave, each strand green)
 main:  only ever receives WHOLE programs (step 2 below); nothing deploys from the line
```

**Where it matters later:** in M2, release candidates are cut from the line. That's when "never ship half a program" must be a rule:

```
 candidate = a proven line snapshot, restricted to complete programs
             (or strands the plan marked shippable alone, e.g. behind a flag)
```

I'd record that now as a constraint on M2 (PK-5), so M1b's per-strand line doesn't paint M2 into a corner.

### 2. How `main` relates to the line

```
             outside work, hotfixes
                     │
 main ───────────────●──────────────●───────────────●──────  (what deploys)
          ▲ PR (whole program,      ▲ PR (program B)│
          │  merge commit)          │               │ main merged INTO line
          │                         │               ▼ (so line ⊇ main)
 program/A ─S1─S2─S3┘    program/B ─S1─S2┘
     │  │  │                  │  │
     ▼  ▼  ▼ each strand, on landing, composed onto the line (option B)
 nightshift/develop ──A:S1──B:S1──A:S2──B:S2──A:S3──…──(takes main in)──
                       proven combination; nothing ships from here in M1b
```

- **Programs reach `main` as today:** one PR per finished program, so `main` only gets whole programs.
- **The line gets every strand as it lands**, and proves they work together. That's where cross-program breakage shows up, and where the composing orchestrator repairs it, as you agreed.
- **The line takes `main` in regularly,** for example before each composition. That keeps outside work and hotfixes in the combination too, so the line never drifts from what's deployed.
- **One requirement:** program PRs must be merged with a merge commit, not squashed. Then the line already holds those exact commits, and merging `main` back in is a no-op. A squash merge would rewrite them, and the line would see the same change twice and conflict. I've been merging Nightshift's PRs that way all along. Foodfly's need it too, whether you merge them yourself or via an agent.
- **In M2**, candidates cut from proven line snapshots replace program PRs (PK-6). Then `main` is fed from the line, not around it.

So the plan would be: option B, per-strand composition, the composing orchestrator repairs, program PRs stay, and the line takes `main` in. Does that all hold for you? The merge-commit requirement is worth checking against how you merge PRs today.

<!-- nightshift:message 238 human 2026-10-27T03:40:39.946Z -->
**Human** · 2026-10-27 03:40 UTC

great. note the batch-and-bisect on pk-7 and then... i guess we're ready to run?

<!-- nightshift:message 239 assistant 2026-10-27T03:41:18.183Z -->
**Claude** · 2026-10-27 03:41 UTC

Not quite ready to run: we've agreed the design, but M1b isn't written up as a plan yet. Recording batch-and-bisect on PK-7 first.

Noted on PK-7 (PIP-13). Before I can write M1b's plan I need the code under it: how a strand lands, what the publisher is allowed to push, and how a run starts. An agent is mapping that now.

Batch-and-bisect is recorded on PK-7 (PIP-13), with a note that M1b builds the line without a lock so PK-7 can extend it.

We're not ready to run M1b yet. We've agreed the design, but it isn't a plan: no draft, no strands, no check. The plan has to be written from the code, since composing onto a second branch touches the publisher's rules about which branches it may push and how a refused push gets back to the engine. The code map for that is running now. When it's back I'll draft the plan and bring you the decisions it surfaces before anything runs.

One assumption to confirm: I'm folding the small safety fix (at most one live run per program, and stale "pending" runs that never started can't block it) into M1b as its own first strand, rather than splitting it off. Is that OK?

The code map is back, and M1b is bigger than our design talk suggested. Three of our assumptions don't hold as stated, and each becomes a decision for you.

**What the code says:**
1. **Once a strand has landed, it can't be reopened.** "Landed" is a final state, and the strand's worktree and branch are deleted right after landing. So "the strand's orchestrator repairs a failed composition" has nothing to repair in. Its session and branch are gone by the time the line refuses.
2. **The engine can't reach GitHub mid-run.** On a machine, the checkout's `origin` is a local mirror, deliberately, so nothing on the machine can push. Only the runner holds a GitHub read token, and it uses it only at boot. Fetching the line and `main` mid-run needs a new channel.
3. **The engine never hears whether a push was accepted.** Publication is fire-and-forget: a refusal is recorded on the plane and the engine never sees it. Recomposing on refusal needs the engine to wait for and read the result.

**What fits as-is:**
- The publisher's push really is a compare-and-swap: a git push with the expected old value. Its write token can already push any branch.
- There's a precedent for repairs that aren't a strand's own: the gate-repair jobs a run already delegates when its baseline is red.

**Decisions:**
1. **Who repairs a failed composition**, given the strand can't be reopened:
   - **(leaning)** The run's root orchestrator gets a repair job, the way gate repairs work today: "your strand S-02 conflicts with program B's work on the line; resolve it from the line head." The cause is recorded, and the job lands onto the line.
   - Rebuild the strand's branch from its sealed ref and hand it back to the strand's orchestrator. That's possible, but it reverses "landed is final", and that change reaches far.
2. **Local runs:**
   - **(leaning)** The line is remote-only at first. Local runs keep landing on their program branch and don't compose. A laptop pushing the line would be a new path that trusts your own credentials.
   - Local runs compose too, pushing with your git credentials.
3. **How a machine reads the line and `main` mid-run:**
   - **(leaning)** The engine asks the runner to refresh its mirror. The runner already holds the token, so no new credential reaches the engine.
   - Give the engine a short-lived read-token file. Simpler, but it widens what the engine holds.
4. **Stale `pending` runs**, needed so "one live run per program" can't be blocked by a run that never started:
   - **(leaning)** A run still `pending` with no dispatch and no attach after a short grace period is ended as `interrupted`, "never started", by the next `nightshift run` of that program.
   - A periodic sweep on the plane.
5. **Config:**
   - **(leaning)** An opt-in `"line": { "branch": "nightshift/develop" }` in `nightshift.config.json`, absent meaning off.
   - The word "line" already names the provisional line in the code, so the docs will say "project line" to keep the two apart.

**Strands, as I'd cut them:**
- **S-01, one live run per program:** an atomic marker on the plane, and stale pending runs ended. This answers my earlier question; tell me if you'd rather ship it separately.
- **S-02, the publisher's line path:** a compare-and-swap push of the project line, plus a result the engine can read.
- **S-03, the machine's fetch channel:** the runner refreshes its mirror on request.
- **S-04, composition:** merge `main` and then the strand onto the line head, run the landing checks, push, recompose on refusal, and repair on conflict or red checks. It's built after S-02 and S-03.
- S-01 to S-03 can run in parallel.

**Risk:** this is a real medium-to-high-risk program. It touches the publisher, the machine's security boundary and the landing path. Every strand should be examined, and S-03 and S-04 should be marked high risk.

How do these leanings sit with you? Once you've decided, I'll write the draft.

<!-- nightshift:message 240 human 2026-10-27T04:22:23.267Z -->
**Human** · 2026-10-27 04:22 UTC

why can't the line have a listener that spins up a resolver when necessary?

<!-- nightshift:message 241 assistant 2026-10-27T04:23:41.103Z -->
**Claude** · 2026-10-27 04:23 UTC

It can, and pushing your idea one step further gives a better design than the one I proposed.

**Your version: the run composes, and the line resolves failures.**
- A listener on the line notices a failed composition (conflict or red checks) and starts a resolver.
- The repair then belongs to the line, not to whichever run happened to compose. That also fixes a hole in my leaning: if a run's last strand composes as the run finishes, there's no root orchestrator left to hand a repair job to. A listener doesn't care whether the run is still alive.

**One step further: the line also does the composing.**

```
 run A ─► lands strand on program/A (as today) ─► publisher pushes program/A ─┐
 run B ─► lands strand on program/B (as today) ─► publisher pushes program/B ─┤ plane sees
                                                                              │ the move
                                      ┌───────────────────────────────────────┘
                                      ▼
                         LINE OWNER (one per project line, started by the plane)
                         1. fetch line, main, and the new strand work (it holds the read token)
                         2. merge main, then the strand, onto the line head
                         3. landing checks on the result
                         4. green → push the line (compare-and-swap; it is the only writer)
                         5. conflict or red → start a RESOLVER agent: fix from the line head,
                            then back through steps 3–4
```

**What that buys:**
- **All three problems the code map found disappear.**
  - The engine never needs GitHub access mid-run; the line owner fetches.
  - Nobody has to react to a refused push mid-run.
  - Nothing has to reopen a strand that already landed.
  - Runs stay exactly as they are today.
- **It's literally PK-3's title, "one owner per development line"**: an owner that does the work, not a lock that runs take turns holding.
- **It's where batch-and-bisect has to live.** Batching several landings into one proof needs one place that sees them all. So this is a better foundation for PK-7 than the "every run composes for itself" design I recommended. I'm revising that recommendation.
- **The "uber-orchestrator" you described** is the line owner's eventual form.

**What it costs:**
- **A new kind of work the plane starts by itself.** A machine is started for composition, not for a run. That reuses the dispatch machinery, but it's the first time Nightshift spends money without you starting anything. So it's opt-in per project, with a spend cap.
- **The line owner works through landings one at a time.** It's a queue, but one that does cheap work. At your scale that's fine, and batch-and-bisect is its scaling answer. The difference from Scion's lock is that runs never wait on it: they finish on their program branches regardless.
- **The resolver is an agent the plane starts, with no run around it.** Its contract is generated from the failure ("make these two changes work together"), not from a plan you wrote. That's new, and it should be examined.

**What I'd decide with you:**
1. Does the line owner start on every program-branch push, or are pushes collected for a short window first? The window is the first step towards batching.
2. Is the resolver allowed to land its fix onto the line by itself, or does it stop for you after making it?
3. What's the spend cap on work Nightshift starts on its own?

Do you want the line-owner design? If so, I'll rework the strands around it. Runs barely change; the new work is in the plane and the line owner.

<!-- nightshift:message 242 human 2026-10-27T04:29:08.571Z -->
**Human** · 2026-10-27 04:29 UTC

I think i want this design? evaluate against scion

<!-- nightshift:message 243 assistant 2026-10-27T04:29:45.785Z -->
**Claude** · 2026-10-27 04:29 UTC

Measured against Scion, the line-owner design takes its principles and departs from it deliberately in two places. One departure is a bottleneck we accept for now, with a planned exit.

I'm going on what's public about Scion: server-side changesets, commits and merges made by the server, and the move away from a global merge lock towards testing after merge and before deploy. I don't know its internals beyond that.

| | Scion | Line owner (M1b) | Verdict |
|---|---|---|---|
| **Who merges** | The server; agents never do | The line owner, which agents never touch | Same principle |
| **How the shared ref moves** | Server-side, one authority | One writer, with a compare-and-swap push | Same principle |
| **Do producers wait on the shared line?** | No; agents keep working | No; runs finish on their program branches whether or not the line has caught up | Same |
| **Testing before or after merging to the shared line** | After, then before deploy, because a pre-merge lock couldn't keep up | **Before**: landing checks run before the line moves | **Deliberately different, for now** |
| **Failure handling** | Fix or revert after the merge | A resolver agent owns the repair; batch-and-bisect comes with PK-7 | Similar intent; ours is more automated |
| **Version control** | Replaced git (a changeset log, working copies optional) | Git as protocol, GitHub as where work is published | Deliberately different: Anthropic says its approach only pays off for enormous monorepos |
| **Cost per operation** | Scales with the size of the change | Fetch and worktree on a prepared machine: repo-sized, but your repos are small | Fine at your scale; PK-12's prepared workspaces keep it fast |
| **What ships** | Changes that passed pre-deploy testing | Release candidates cut from proven line snapshots (M2) | Same idea |

**The one real gap: testing before the line moves.** That's the shape Scion abandoned. Our version is softer, because runs never wait on the line; only the line owner's own queue does. But the line's throughput is capped at about one composition per landing-check run. That's roughly 1.5 minutes on foodfly and 6 minutes on Nightshift, so about 10 to 40 compositions an hour. That's plenty for a handful of concurrent programs, and far short of Scion's scale.

**The exit is PK-7, and this design makes it a policy change in one place.** The line owner switches from "check, then move the line" to "move the line on targeted checks, prove snapshots in the background, batch and bisect, repair the culprit". That's Scion's model. Batching needs one place that sees every landing, and the line owner is that place. In the design where every run composes for itself, that switch would mean a redesign.

**A risk Scion handles with infrastructure we have to build: the line owner is a single point.** If its machine dies mid-composition, the queue of landings to compose must survive, and two line owners must never run at once. Both have precedents:
- the queue lives on the plane, like publication intents;
- the line owner is fenced by a generation number, like a run's dispatch.

That's the riskiest new piece, and it gets the most examination.

**Verdict:** it follows Scion where Scion's lessons apply at any scale: server-side merging, one authority moving the shared ref, producers never blocked. It differs where Scion's answers are about scale you don't have: replacing git, and dropping pre-merge checks. And the path to Scion's testing model is one change in one place.

If that's a yes, the remaining decisions for the plan are the three from before:
1. compose on every push or in short windows;
2. whether the resolver lands its own fix;
3. the spend cap.

<!-- nightshift:message 244 human 2026-10-27T04:36:11.128Z -->
**Human** · 2026-10-27 04:36 UTC

what are your thoughts on #1? in my volume it doesn't matter.. but long term?

<!-- nightshift:message 245 assistant 2026-10-27T04:36:32.891Z -->
**Claude** · 2026-10-27 04:36 UTC

Long term, I wouldn't use a time window. I'd use natural batching: the line owner composes the moment it's idle, and whatever lands while it's busy becomes the next batch.

**Why not a time window:** a window adds its full length to every landing, all the time, to catch traffic that may not come. At low volume it's pure delay; at high volume a fixed window is never the right size.

**How natural batching behaves:**
- **Quiet, which is your case now:** one landing arrives, the owner is idle, it composes straight away. It's the same as composing on every push, with no added delay.
- **Busy:** while one composition is being checked, five more landings arrive. When the owner is free it takes all five as one batch: merge all five, check once, move the line once. One check run instead of five.
- **It adjusts itself.** The busier the line, the bigger the batches, and the cost per landing drops exactly when volume rises. That's the property Scion's lock lacked, and it's how the better merge queues work (bors-style batching).

**What batching needs:** a failed batch has to find its culprit.
- **Long term:** bisect it. Split the batch, check the halves, narrow to the change that broke it, compose the rest, and give the culprit its resolver.
- **Simple version for M1b:** if a batch fails, compose its members one at a time. It's the slow fallback, and it's always correct.

**For M1b I'd build:**
- the queue on the plane, where the owner takes everything waiting, up to a cap;
- the one-at-a-time fallback when a batch fails;
- no timers.

At your volume batches will almost always be size one, so it behaves like composing every push. The batching path is still built and tested from day one. PK-7 then replaces the fallback with bisection and the full checks with targeted ones. Neither change touches the queue.

One thing to weigh: a batch blurs what proved what. "The line at X was checked with landings 3 to 7 together." P22's records can already say exactly which commit and inputs a check covered. The line owner should record the batch's members on the verification, so a later reader knows what each result vouched for.

If that suits you, I'll fold it into the plan. The other two decisions remain: whether the resolver lands its own fix, and the spend cap.

<!-- nightshift:message 246 human 2026-10-27T04:45:49.131Z -->
**Human** · 2026-10-27 04:45 UTC

but it's landing strands right? so oen program could pile up strands that are finishing? (by pile up, i mean like 2 or 3 might land near each other... ha)

<!-- nightshift:message 247 assistant 2026-10-27T04:46:04.888Z -->
**Claude** · 2026-10-27 04:46 UTC

Yes, it's per strand, and that's the common case: two or three strands of one program finishing close together. They batch together naturally, and they're the cheapest batch there is.

**Why a program's own strands are a safe batch.** On the program branch they already landed one after another, each verified on top of the others. So they're known to work together. The only open question is whether they work with what's on the line from other programs.

**Which suggests composing by program-branch range, not by strand.** The line owner doesn't take strands individually. For each program, it takes everything that has landed on that program branch since the program was last composed. That's one `git merge` of `program/A`'s new head onto the line.

```
 program/A:  …─●(composed last time)─S-02─S-03─S-04   ← three strands landed close together
 line:       …─────────────────────────────────── + merge program/A head  (one merge, one check)
```

- **Order is preserved for free.** The program branch only ever moves by fast-forward, so its history is already in plan order, and `dependsOn` is respected by construction.
- **A failed batch has a ready-made way to find the culprit.** The program branch's landing points are a straight line of commits, so the fallback, and later bisection, walks back through them: compose up to S-03; if that's green, S-04 is the culprit.
- **Mixed batches work the same way.** A's three strands plus B's one is two range merges, then one check.

It also tidies the record. "The line at X includes `program/A` up to S-04 and `program/B` up to S-01." That's exactly what M2 needs to cut a candidate containing only whole programs.

So: natural batching, by program-branch range, with the one-at-a-time fallback in M1b. Shall I fold it in? That leaves the resolver question and the spend cap.

<!-- nightshift:message 248 human 2026-10-27T04:47:25.273Z -->
**Human** · 2026-10-27 04:47 UTC

yeah i think i like that... whats the resolver question?

<!-- nightshift:message 249 assistant 2026-10-27T04:47:58.759Z -->
**Claude** · 2026-10-27 04:47 UTC

It's about what the resolver may do on its own.

**When it's needed.** The line owner merges `program/B`'s new strands onto the line and either the merge conflicts with `program/A`'s work, or it merges cleanly but the checks go red. Neither program's plan covered "make A and B work together", so a resolver agent is started with the failure as its brief.

**The question.** When the resolver has a fix, may it land the fix onto the line by itself, or does it stop for you?

- **(a) It lands it by itself**, after the same landing checks plus an examination by a different model. The fix is recorded as a decision you can review and reverse later. This matches your standing rule that runs fix problems and record them rather than stopping. It's also cheap to be wrong here: in M1b nothing ships from the line, so a bad fix costs a later repair, not a broken release.
- **(b) It stops and asks you.** That's safer for code you haven't seen, but it parks the line: every later composition queues behind the fix waiting for you.
- **(c) A split:** mechanical conflicts (both changes touched the same lines, with obvious intent) land by themselves; red checks wait for you.

I lean (a). The examination is the safeguard, and the decision record means nothing is silent.

**One gap you should know about, separate from the question.** In M1b, programs still reach `main` through their own PRs. So the resolver's fix exists only on the line. When both programs' PRs merge into `main`, the same conflict comes back there, and gets resolved at PR time, by you or an agent, as today.
- **For M1b, I'd accept it.** The line has still proven the two programs can work together. The PR links to the resolver's fix as the reference, so resolving it on `main` is a copy, not a puzzle.
- **M2 closes it properly.** Once `main` is fed from release candidates cut from the line, the resolution comes with them.
- **The alternative,** pushing the fix back into one program's branch, drags the other program's work into that program's PR. That breaks the "whole programs only on `main`" rule.

So: (a), (b) or (c), and is the gap acceptable for M1b?

<!-- nightshift:message 250 human 2026-10-27T04:52:22.472Z -->
**Human** · 2026-10-27 04:52 UTC

yeah (a) is fine.

<!-- nightshift:message 251 assistant 2026-10-27T04:52:33.693Z -->
**Claude** · 2026-10-27 04:52 UTC

(a) it is: the resolver lands its own fix after checks and an examination, and the fix is recorded for your review. I'll take the `main` gap as accepted for M1b, with M2 closing it. Say if you'd rather not.

**The last decision: the spend cap.** The line owner's machine and its resolvers are the first work Nightshift starts without you. A busy day, or a resolver that keeps failing, shouldn't be able to run up a bill unnoticed.

My leaning:
- **A monthly cap on self-started work, per project**, separate from your runs, with a default of about $25 a month. At foodfly's prices that's roughly 50 hours of the "good" machine. When it's reached, the line stops composing and says why, as `routes_limited` does. Programs keep landing on their branches, so nothing is lost; the line just stops catching up until you raise the cap or the month turns.
- **A limit per composition:** one hour, and at most three resolver attempts. A composition that still can't be fixed after that is parked and reported. It doesn't keep retrying.
- **The org's existing compute ceilings still apply on top.**

Does $25 a month, one hour per composition and three resolver attempts sound right, or do you want different numbers? Once you've said, I'll write the draft and show you the strands.

<!-- nightshift:message 252 human 2026-10-27T04:54:23.933Z -->
**Human** · 2026-10-27 04:54 UTC

so we'll still use the org's claude and codex subscriptions, the cost is on the compute?

<!-- nightshift:message 253 assistant 2026-10-27T04:54:36.075Z -->
**Claude** · 2026-10-27 04:54 UTC

Yes. The resolver and the examiner run on the org's provider logins, the same Claude and Codex subscriptions your runs use, delivered to the machine the same way. The cap I proposed is on compute: the machine hours Nightshift meters and bills, which is what its compute ledger already tracks.

On the model side:
- **On subscriptions** (Claude Code login, ChatGPT login for Codex), a resolver costs no extra dollars, but it uses your plan's quota. That quota is shared with everything else you do. A line owner resolving conflicts overnight eats into the same weekly or monthly limits your own sessions and runs use. We saw what a limit looks like earlier: a route refused with a "monthly spend limit" 429.
- **On API keys**, model usage would cost real money. Nightshift records token counts but mostly can't price them, so a dollar cap couldn't track it reliably.

So the guard on model usage isn't a dollar figure. It's the limit of three resolver attempts per composition and one hour per composition, which bounds how much quota a bad conflict can burn. The monthly cap covers the machine.

With that clarified, does $25 a month of machine time, one hour per composition and three resolver attempts work?

<!-- nightshift:message 254 human 2026-10-27T04:55:33.441Z -->
**Human** · 2026-10-27 04:55 UTC

how is the machine triggered? does it re-use the machine running the program? or spin up a new one? what are the mechanics here

<!-- nightshift:message 255 assistant 2026-10-27T04:56:02.371Z -->
**Claude** · 2026-10-27 04:56 UTC

I'd use a separate, short-lived machine that the plane starts when there's work for the line and stops when the line catches up. Here's the flow, then the alternative I considered.

```
 1. run A's machine lands a strand on program/A
 2. publisher (in the plane) pushes program/A to GitHub, compare-and-swap   ← exists today
 3. on success, the publisher writes a LINE QUEUE entry on the plane:
        { line: nightshift/develop, program: A, upTo: <program/A head> }
 4. no line owner live? → the plane starts one
        - a new kind of dispatch ("line") through the existing dispatcher
        - same runner image, the project's warm snapshot, so ~2 min to ready
        - at most ONE live line dispatch per line (conditional write),
          fenced by a generation number like a run's dispatch
 5. the line owner works the queue:
        fetch line + main + program branch heads (it holds the read token, like any machine)
        take everything waiting (natural batching) → merge ranges → landing checks
        green → hand the push to the publisher (compare-and-swap)
        red / conflict → resolver agent on the same machine → checks → examination → push
 6. queue empty for ~10 min → the owner exits; the machine stops, its volume snapshotted
```

**Why not reuse the program's own machine:**
- **It doesn't outlive its run.** The last strand often lands as the run finishes, and the machine goes with it. Composition, and especially a resolver, needs to outlive any one run.
- **Two runs means two composers.** That's back to every run composing for itself: no single place for batching, compare-and-swap races between machines, and the engine needing GitHub access mid-run. Those are the three problems the code map found.
- **It mixes duties.** The run's machine is sized and prepared for its program. The line owner works on the combination of all programs.

**What the separate machine costs:** about two minutes of startup each time the line wakes from idle, plus machine time while it composes. At your volume that's a few short wake-ups a day. The idle timeout means a burst of landings is composed in one session instead of starting a machine for each.

**What's new in the plane:**
- the line queue record;
- the publisher writing to it after a successful program-branch push;
- a "line" dispatch kind, with its at-most-one-per-line guard;
- the runner knowing how to be a line owner, not a run's engine.

The dispatcher, image, snapshots, heartbeat and fencing are all reused.

Does that match what you pictured? If so, I'll write the draft with these strands:
- **S-01:** one live run per program.
- **S-02:** the line queue and the publisher's line push.
- **S-03:** the line dispatch, and the runner as line owner.
- **S-04:** composition and the resolver, built on S-02 and S-03.

<!-- nightshift:message 256 human 2026-10-27T04:58:03.319Z -->
**Human** · 2026-10-27 04:58 UTC

yep ok all good. and where does the composer leave the work? on a branch? on a PR?

<!-- nightshift:message 257 assistant 2026-10-27T04:58:18.478Z -->
**Claude** · 2026-10-27 04:58 UTC

On a branch: the project line itself (`nightshift/develop`) on GitHub, pushed by the publisher with a compare-and-swap. In M1b the composer opens no PRs.

**Where everything ends up:**
- **The combined code:** on `nightshift/develop`. Each composition is a merge commit naming what it took in, for example "Compose program/A up to S-04 and program/B up to S-01". It's an ordinary branch you can check out, diff and test.
- **A resolver's fix:** a commit on the line right after the composition it repaired. Its message names the conflict and the decision recording it.
- **What the line contains:** a line record on the plane. For each composed commit it holds which program ranges went in, the verification that checked it (with P22's fields plus the batch's members), and any resolver decision. That's what M2 will cut candidates from.
- **What you see:** a `nightshift line status` command showing the line's head, what's queued, what's composed, and any open or parked repair. The report and Studio pick it up later; I'd keep the Studio out of M1b.

**Why no PRs in M1b:** programs still reach `main` through their own PRs, which you open as today. A PR from the line to `main` would carry half-finished programs. PRs from the line arrive in M2, as release-candidate PRs carrying their evidence (PK-6).

**One setup consequence.** If you protect branches on GitHub with a rule that matches `nightshift/develop`, the publisher's push is refused. So the plan gets a prerequisite: the Nightshift App must be allowed to push the line branch, checked by a command that confirms the line isn't protected against the App. With no matching rule there's nothing to do.

Unless you want something different here, I'll write the draft now.

<!-- nightshift:message 258 human 2026-10-27T04:59:46.800Z -->
**Human** · 2026-10-27 04:59 UTC

nope sounds good
