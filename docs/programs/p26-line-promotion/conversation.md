# Planning conversation: p26-line-promotion

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

After P25 made the line the branch work ships from, the owner asked whether teams who promote by pull request still could: they can, by making a develop or staging branch the line. The owner then proposed that the pull request itself be configurable, so that with a staging line Nightshift opens the promotion pull request to main and teams just review it. Asked to push back, Claude argued it is not a slide back to the abandoned candidate design as long as main moves only through that pull request and Nightshift never resolves conflicts at it; the one design fork was a pinned candidate per head versus one pull request on the moving line branch, and the owner chose moving. The owner then chose that a closed promotion pull request is followed by a fresh one on the next line move, and that a diverged target keeps its pull request with a warning rather than holding it.

## Excerpts

<!-- nightshift:session claude cbbd6508-eba8-481c-8ffe-5bae828890eb 413 -->
### Claude session `cbbd6508`

*Kept 9 of 413 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 404 human 2026-11-12T15:44:17.501Z -->
**Human** · 2026-11-12 15:44 UTC

remind me why we did that? it was complicated keeping the separate line in sync?

<!-- nightshift:message 405 assistant 2026-11-12T15:44:27.018Z -->
**Claude** · 2026-11-12 15:44 UTC

Yes, keeping two branches in sync was the root of it. In three steps:

1. **The original line (P23)** was a preview beside `main`, and programs reached `main` through their own PRs. Every cross-program conflict got resolved twice: once on the line by Nightshift, then again at the PR by hand. On foodfly (30–31 Oct) the two resolutions differed, `main` and the line diverged, and the line parked everything ("main does not compose onto the line"). That happened 15 runs in a row, each reported as succeeded, and nobody noticed for five days.

2. **The 4 Nov fix (the killed P25)** kept the two branches and added machinery to sync them. The line took `main` in and repaired it when that conflicted, and woke up whenever `main` moved. It cut candidates, opened a PR, closed stale ones when `main` moved again, and added draft PRs for unshipped work plus a Deploy button. Every hotfix to `main` became work the line had to reconcile. You had two of those on foodfly on Monday alone.

3. **Your call on 9 Nov:** stop syncing and have one branch. In your words: "I'd rather the line continually move forward (whole or part program) and merge into main (even if it contains a half-program) and then main becomes a staging environment for actual smoke tests and human review before a release tag is created". And for other teams: "we should just allow a config for the 'line branch'". With the line *as* the shipping branch, nothing outside it has to be merged back in, so the whole class of drift goes away. Promotion beyond it is the project's own pipeline.

<!-- nightshift:message 406 human 2026-11-12T15:45:03.083Z -->
**Human** · 2026-11-12 15:45 UTC

yeah, and we have flexibility to make dev branch "the line" right? so people who wanted to continue promoting work via PR can right?

<!-- nightshift:message 407 assistant 2026-11-12T15:45:08.198Z -->
**Claude** · 2026-11-12 15:45 UTC

Yes. Set `"line": { "branch": "develop" }` (or `staging`) and Nightshift composes onto `develop` and stops there. Programs start from `develop`, conflicts between them are resolved once on `develop`, and the team promotes `develop` to `main` by PR however it likes.

Two things that team takes on, both on purpose:

- **Nightshift opens no PR.** The team, or their CI, opens and merges the `develop` → `main` PR.
- **Hotfixes made straight to `main` are theirs to bring back.** The line no longer takes `main` in (D-03), so the team must merge `main` back into `develop` after a hotfix, as git-flow teams already do. If they don't, `develop` drifts and their next promotion PR conflicts. That's the cost of a separate dev branch, and it falls on the team that chose one rather than on Nightshift.

<!-- nightshift:message 408 human 2026-11-12T15:46:56.635Z -->
**Human** · 2026-11-12 15:46 UTC

ohhh, maybe the PR should be configurable too? Because it would be rad if the line were a dev or staging branch, and PR's with candidates were opened to the main branch so teams just reviewed them. what do you think? don't just agree. is that just sliding backward?

<!-- nightshift:message 409 assistant 2026-11-12T15:47:14.965Z -->
**Claude** · 2026-11-12 15:47 UTC

It isn't sliding backward, as long as `main` only ever moves through that PR. If teams also commit straight to `main`, it is.

**What actually caused the trouble** wasn't a PR into `main`; it was `main` moving on its own. Each hotfix created a second place conflicts were resolved. The killed design answered that by having the line take `main` in and repair it, and that was most of its machinery. A promotion PR from `staging` to `main` doesn't bring that back unless `main` also takes direct commits.

**So it's clean with two rules:**
- `main` is protected so only the promotion PR merges into it. Then the PR always merges cleanly, and review is review, never conflict resolution.
- Nightshift never resolves conflicts at that PR. If `main` has commits the line lacks, Nightshift says so ("main has moved: bring it into the line") and doesn't paper over it. A team that wants hotfixes makes them on the line.

**Is it worth building, or is it a 10-line GitHub Action?** Opening a PR is trivial. What a team can't easily produce is the PR body: which programs and part-programs it contains, their reports, the repairs made on the line, and what verification proved the head. That's real value, and it's what you were after on 5 Nov ("i just needed SOME pr to be created so i knew what was finished and could be deployed").

**The one design choice that matters: should the PR's head be the moving line branch, or a pinned commit?**
- **Pinned** (the old candidates) means reviewers approve exactly what ships, at the cost of supersede-and-close churn every time the line moves.
- **Moving** is one long-lived PR that updates itself as the line moves, with no churn. The risk is merging something that landed after review, and GitHub's "dismiss stale approvals on new pushes" already covers that.

I'd go with **moving**, plus a body that names the head commit it describes, so most of the old machinery stays dead.

So: an optional `line.promote: { to: "main" }`, one PR maintained from the line, and a refusal to paper over a diverged `main`. That's a small program on top of P25, not a return to candidates.

<!-- nightshift:message 410 human 2026-11-13T04:20:00.560Z -->
**Human** · 2026-11-13 04:20 UTC

moving

<!-- nightshift:message 411 assistant 2026-11-13T04:20:12.606Z -->
**Claude** · 2026-11-13 04:20 UTC

I'll read the code this touches first: the line config, the GitHub App client, and where the line push is recorded.

Two choices are yours before this goes into the draft:

P26: a person closes the promotion pull request (line → main) without merging it. What should Nightshift do?
- New PR on next change (Recommended): Open a fresh pull request the next time the line moves, so there's always one showing what main lacks. A team that doesn't want it removes `promote` from the config.
- Stay closed until asked: Leave it closed until someone runs a command (e.g. `nightshift line promote`) to open it again; line status says it's closed.

P26: main has commits the line lacks (a hotfix, or a squash-merged promotion). The PR may still merge cleanly. What happens to the promotion pull request?
- Keep it, with a warning (Recommended): Keep updating the PR; its first lines and line status name the commits and the fix (merge main into the line). GitHub itself shows whether it conflicts.
- Hold it until fixed: Stop updating the PR body and mark it stale until the line contains main again.

<!-- nightshift:message 412 human 2026-11-13T04:27:17.677Z -->
**Human** · 2026-11-13 04:27 UTC

Closed PR: New PR on next change (Recommended)

Diverged: Keep it, with a warning (Recommended)
