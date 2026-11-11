# Planning conversation: p25-the-line-is-where-work-ships

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

How this plan came about (written by Claude, 2026-11-09).

The owner audited two parallel foodfly programs and found the line had resolved their conflict on nightshift/develop, while another agent resolved it again at main, differently; main then stopped merging onto the line and later ranges parked. The owner had expected Nightshift to resolve conflicts, and learned that P23's D-05 kept the line a preview: programs reached main through their own PRs and conflicts were fixed twice by design.

The owner rejected that shape: the line should move forward continuously, whole or part programs, and merge into main, with main a staging environment and release tags for production in their own pipeline. They then widened it: other teams should organise CI/CD their way, so the line branch is a setting (main, staging, any branch) and Nightshift's responsibility ends there.

The code map showed a line on main nearly works already; what blocks it is programs starting from baseBranch, the composer's merge of the default branch (the source of the foodfly stall), a recompose loop against a protected branch, and guidance describing D-05. The owner retired the preview mode (D-01), had programs start from the line (D-02), and had the composer take in only its own head and the queued ranges (D-03). Releases, tags and a candidate view were left to a later program; half programs are kept safe by convention.

## Excerpts

<!-- nightshift:session claude cbbd6508-eba8-481c-8ffe-5bae828890eb 377 -->
### Claude session `cbbd6508`

*Kept 13 of 377 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 362 human 2026-11-01T17:58:13.864Z -->
**Human** · 2026-11-01 17:58 UTC

i need you to check on the latest foodfly runs. I think i've run a couple in parellel and need to audit if nightshift is behaving the way we anticipate. I know the work was done, but in one instance it required another agent to merge the program branches into main and resolve conflicts. Whereas, I thought the conflicts would be resolved by nightshift

<!-- nightshift:message 363 assistant 2026-11-01T18:00:04.694Z -->
**Claude** · 2026-11-01 18:00 UTC

Clear picture on that conflict. Now checking why the line hasn't moved since: its head is still the 30 October one, although two more programs ran and main took four merges.

Parked went from 14 to 16, so the last two programs did reach the line and were parked. Reading why:

I have the full picture. Nightshift did resolve the conflict, but only on `nightshift/develop`, and that resolution never reaches main. Separately, the composer has a real bug that has now stalled foodfly's line.

**What happened, in order**
1. On Oct 30, platform-dispatch and hood-page ran in parallel. The line composed both, hit their conflict, and a repair job resolved it. The examiner rejected the first attempt, passed the second, and the result was published to `nightshift/develop` (`d794ae0`).
2. On Oct 31, you merged PR #82 (platform-dispatch) into main. PR #83 (hood-page) then conflicted with main in 10 files, and another agent merged main into `program/hood-page` and resolved them by hand (`7c178663`). That redid the line's work, and came out differently: main and the line now differ in 12 files.
3. Since then main can't merge onto the line at all, because the two resolutions conflict with each other. The composer doesn't try to repair main. It parks every incoming range with "main does not compose onto the line", with no conflicting paths and no agent account. scheduled-orders-toggle and driver-pickup-identity were both parked that way.

The line has been dead for foodfly since Oct 31, and will stay so until something changes.

**Two separate problems**
- **A design gap: this is where your expectation and the design part ways.** P23's D-05 has programs reach main through their own PRs while the line takes main in. That means the line proves the combination but never delivers it. Any conflict between parallel programs gets resolved twice: once on the line, verified and examined, and once again by whoever merges the second PR. Then the two resolutions fight each other.
- **A bug.** When main doesn't merge onto the line, the composer parks everything instead of running a repair. P23's resolver used to try a repair here; P24 dropped that path. It also records no cause or paths, so the record doesn't say why.

**The fix for the bug is clear-cut:** a main that doesn't compose gets the same repair as a range, with its cause and words in the parked reason. I'll make that fix regardless.

**The design gap is your call:**

1. **Recommended: main receives the line's resolutions.** When a later program's PR conflicts with main, Nightshift resolves it by merging the line's already-verified resolution into that program's branch before the PR is merged. The PR then merges cleanly, and main and the line converge instead of diverging. That's close to what you expected, and it keeps one resolution per conflict.
2. **PRs come from the line.** You'd open one PR from `nightshift/develop` (or a candidate cut from it) to main, instead of one per program. It's simplest to reason about, but it changes how you review and ship. That's PK-5 (release candidates) in Pipkin's M2.
3. **Keep D-05 and only fix the bug.** The line repairs main after you merge, and conflicts still get resolved twice.

Which way do you want to go?

<!-- nightshift:message 366 human 2026-11-09T17:26:05.597Z -->
**Human** · 2026-11-09 17:26 UTC

huh? doesn't the nightshift/develop line merge into main?

<!-- nightshift:message 367 assistant 2026-11-09T17:26:11.260Z -->
**Claude** · 2026-11-09 17:26 UTC

No, nothing flows from `nightshift/develop` into main. That was a deliberate choice in P23 (decision D-05), and it's the root of what you saw on Nov 1.

How it works today:
- Each program lands on its own branch, and you merge each program's PR into main, as before.
- The line only receives. It takes main in, then merges each program's new commits on top, and runs the checks to prove they work together.
- So the line is a preview of "everything together". It's where conflicts between parallel programs are found and repaired, but none of that repair reaches main. When the second program's PR meets main, the same conflict shows up again, and someone resolves it a second time.

That's why I asked how you want main to receive the line's work. The two real options:
1. **Recommended:** before the later program's PR merges, Nightshift merges the line's verified resolution into that program's branch, so the PR merges cleanly and carries the line's fix.
2. **PRs from the line:** merge the line, or a candidate cut from it, into main instead of the program PRs. That's PK-5 (release candidates) in Pipkin.

<!-- nightshift:message 368 human 2026-11-09T17:26:31.084Z -->
**Human** · 2026-11-09 17:26 UTC

oh that's seems weird, why did i do that?

<!-- nightshift:message 369 assistant 2026-11-09T17:26:32.678Z -->
**Claude** · 2026-11-09 17:26 UTC

Let me check what was actually decided and why, rather than reconstruct it.

You chose it on purpose, on Oct 27, and the reason is still sound. It just had a cost we accepted that turned out worse than expected.

**Why:** the line composes work as it lands, so at any moment it holds programs that are still in progress, with some strands landed and others not. A PR from the line into main would ship half-finished programs. So D-05 kept main receiving only **whole programs** through their own PRs, and left feeding main from the line to M2, where candidates cut from proven line snapshots would contain only whole programs (PK-5/PK-6).

**The cost we accepted:** the decision says it in so many words: "a conflict the resolver fixed on the line is fixed again at the pull request, with the line's fix as reference."

**What the foodfly audit showed is that the cost is worse than that:** the second fix wasn't a copy of the line's, it was a different resolution. Once that landed in main, main and the line disagreed, and the line could no longer take main in at all. A composer bug made that a permanent stall instead of a repair.

So the reasoning ("main only gets whole programs") still holds; the "fix it again at the PR" part doesn't. That's what option 1 addresses without breaking the reasoning. The program's PR stays the unit (whole programs only), but the line's verified resolution is merged into the later program's branch first. The PR carries the same fix the line proved, and main and the line converge.

<!-- nightshift:message 370 human 2026-11-09T17:30:18.330Z -->
**Human** · 2026-11-09 17:30 UTC

yeah we gotta fix that. i'm seeing how it meshes very closely with how your project deploys. I'd rather the line continually move forward (whole or part program) and merge into main (even if it contains a half-program) and then main becomes a staging environment for actual smoke tests and human review before a release tag is created and pushed... or something like that. obviously in foodfly, we shouldn't be merging into main and auto-deploying to prod anymore if we're gonna merge our line directly into main. i don't know.. thoughts?

<!-- nightshift:message 371 assistant 2026-11-09T17:30:39.955Z -->
**Claude** · 2026-11-09 17:30 UTC

I think that's the right direction. It's essentially trunk-based development with gated releases, the same shape as Scion's "land first, prove after, gate at deploy", and it removes the double-resolution problem at its root instead of patching around it.

Taking your idea one step further: if the line merges into main continuously, **the line and main stop being two things.** The composer can compose directly onto main, with program branches as its inputs and main as the only shared branch. Then:
- There's one resolution per conflict, on the branch that matters, so the double-fix and the divergence go away entirely.
- A hand merge or hotfix into main is just another input the composer takes in, as it already takes main in today.
- `nightshift/develop` disappears as a concept.

**What has to come with it:**
1. **Main stops deploying to prod.** Main deploys to staging; prod deploys from a release tag. For foodfly that's a change to its own deploy pipeline, so it's yours, not mine.
2. **Half programs must be safe on main.** Even staging shouldn't be broken by an in-progress program. Most of that is already true, because every landing passes the checks. The rest is a convention: user-facing work stays behind a flag or unrouted until its program completes. That belongs in the planning skill and the briefs.
3. **The release becomes the human's review point, and Nightshift should feed it.** Nightshift knows exactly which ranges of which programs are in any main commit. So for a candidate commit it can say: programs complete, programs partially in, their reports and decisions, and the evidence (checks, end gates, examinations). You smoke-test staging, read that, and tag. This is a simpler form of what Pipkin's M2 "candidates" was going to be.
4. **Writing to main needs the right permission.** The publisher would push to main by compare-and-swap. If main has branch protection, the Nightshift App needs a bypass. Program PRs either go away, or stay as review records only, not as the merge path.
5. **Main can occasionally go red** on things the landing checks don't catch. End gates and the staging smoke tests catch those, and a revert or repair is a normal line operation.

**What I'd keep from today:** program branches, runs and strands are unchanged. The repair-job machinery from P24, the path reservation and the budget carry over as they are. The composer just targets main instead of a separate line.

This is a program-sized change: the composer's target, the publisher's write to main, a release/candidate view, and a skill convention for half programs. If it's the direction you want, I'd plan it with you as P25. The composer bug from the foodfly audit (main can't compose, so everything parks) would fold into it, since a composer that owns main can't hit that state.

<!-- nightshift:message 372 human 2026-11-09T17:35:46.637Z -->
**Human** · 2026-11-09 17:35 UTC

that's fine with me, but i also want to give some latitude for other devs/users to organize their CI/CD the way they want. I feel like we should just allow a config for the "line branch"... I would prefer to have it be main, and organize my deployment workflows around that. but maybe someone else does want a staging branch -> main prod branch?

<!-- nightshift:message 373 assistant 2026-11-09T17:36:05.315Z -->
**Claude** · 2026-11-09 17:36 UTC

Agreed. The config is already there: `"line": { "branch": … }`. The change is to make the line's branch whatever a project names, including main, and to make Nightshift's responsibility end at that branch. Everything past it (staging→prod promotion, tags, deploys) is the project's own CI/CD.

**What that means:**
- **Your setup:** `"line": { "branch": "main" }`. The composer composes onto main; main deploys to staging in your pipeline; release tags deploy to prod.
- **Someone else's:** `"line": { "branch": "staging" }`. Nightshift composes onto staging, and their pipeline promotes staging→main however they like: a PR, a fast-forward, a scheduled cut.
- **Today's behaviour stays available:** `"line": { "branch": "nightshift/develop" }` is still a preview line that nothing promotes from, and programs reach main by their own PRs (the current D-05 shape).

**What has to change so that works cleanly:**
1. **Programs start from the line branch, not `baseBranch`.** Otherwise, with `staging` as the line, programs would be built on an older main and conflict with what's already on staging. When the line is main, nothing changes.
2. **"Take main in" becomes "start from the line's current head".** Whatever anyone else pushed to that branch (a hand hotfix, a promotion merge) is already in the head the composer starts from, by compare-and-swap. That's also what removes the stall from the foodfly audit: there's no separate main to fail to merge.
3. **The publisher may write to whichever branch is the line.** On a protected branch the App needs a bypass. That's a GitHub setting the owner makes, and Nightshift can check for it before the first push.
4. **A program PR becomes optional.** When the line is the branch you ship from, the PR isn't the merge path any more. It can still be opened as a review record if a project wants one. Default: no PR, with the line run's composition record and the program's report as the review.
5. **Releases stay outside Nightshift for now.** What Nightshift can add is a "what's in this commit" view (programs complete and partial, with evidence) to help whoever cuts the tag. That's a nice-to-have, not required for this.

Want me to plan it as P25 with you?

<!-- nightshift:message 374 human 2026-11-09T17:37:28.724Z -->
**Human** · 2026-11-09 17:37 UTC

yep

<!-- nightshift:message 375 assistant 2026-11-09T17:37:35.402Z -->
**Claude** · 2026-11-09 17:37 UTC

I'll map the code first, since the seams depend on where `baseBranch` and the line's "take main in" are wired.

Should Nightshift keep today's 'preview line' mode (a line nothing promotes from, with programs reaching main through their own PRs)?
- Retire it (Recommended): A line is always where work ships from: main, or a staging branch the project's CI promotes. The preview mode's flaw is built in: every conflict is resolved twice, and the two resolutions can diverge and stall the line. A team that wants review before main uses a staging line. Projects with no line are unchanged.
- Keep it as an option: Preview lines stay supported beside main and staging lines. The double resolution and divergence remain possible in that mode, so the main-merge repair has to be built for it too.

When a project has a line, do its programs start from the line branch?
- Yes, always (Recommended): A program's base branch is the line branch: the contract inherits it from the config, and `plan check` refuses a contract naming a different base. Each program builds on everything already shipped to the line, so conflicts with the line are found while the program is built, not afterwards.
- No, keep baseBranch independent: The contract's baseBranch stays whatever the plan says (usually main). With a staging line, programs would build on older code than the line they land on, and conflicts surface only at composition.

Should the composer still merge the repository's default branch into the line before composing?
- No: line head only (Recommended): The line's inputs are program ranges plus anything pushed to the line branch itself. If the line is main, that's already everything. If it's staging, bringing a hotfix from main back into staging is the project's CI's job. This removes the class of failure that stalled foodfly's line.
- Yes, with a repair: Keep taking main in when the line isn't main. When it doesn't merge, run a budgeted repair job instead of parking every range. Hotfixes on main reach staging automatically, but main's divergence can still trouble the line.

<!-- nightshift:message 376 human 2026-11-09T17:43:48.525Z -->
**Human** · 2026-11-09 17:43 UTC

Preview mode: Retire it (Recommended)

Program base: Yes, always (Recommended)

Upstream: No: line head only (Recommended)
