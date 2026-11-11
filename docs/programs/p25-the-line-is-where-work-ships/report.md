# Report: A project's line is the branch its work ships from (main, staging, any branch it names) and where Nightshift's responsib

Run `run_01M74E826Z5340G2265FTXGQBG` of plan `e260b495d51b`: **succeeded**. Both strands integrated.

S-01 (the line composes the branch that ships) landed at 0093a651:
- The composer starts each batch from the line's own head and merges only queued ranges; the main merge and the "main does not compose" park are gone.
- Contracts inherit the line as their base branch, and plan check refuses a different one.
- A protected or forbidden line push holds the line with a reason and a remediation instead of looping; `nightshift land`, `line requeue` or a new landing retries it once.
- A line run that parks anything ends failed and names the parked ranges.
- New `nightshift line requeue [<program> | --all]`, and a clearer `nightshift line status`.
- A line run is admitted before it is created.
- The end-to-end test covers a line on the default branch, a direct push to the line between batches, and a protected line.

S-01 took five attempts: a test-file conflict with S-02, then three fix rounds for examiner findings (an absent line branch not being created, refused-push retry paths, the refusal reason on line runs). The last two findings were upheld by an arbiter. The automatic continuation after that ruling stalled, so I retried once (decision dec_01M74KKQDD0A4DW16CYEEJKP96); that attempt passed verification and examination.

S-02 (saying it) landed at 402cb583:
- docs/architecture.md has row A-69 and amendment notes on A-66 and A-67; D-05's pull-request path is retired.
- The skills and AGENTS.md now describe one shape of line, including keeping unfinished user-facing work unreachable.
- A plan run's report says where its work reached the line, including heads the composer folded into one range (an examiner finding, fixed).

All checks passed on the final landings: build, typecheck, lint, test, synth and sterility. The owner's follow-ups are unchanged: move foodfly's line to main and let the Nightshift App past main's branch protection.

2 of 2 strands succeeded; 0 deferred; 0 parked. Wall clock 107 min 5 s.

## Completion histories

none recorded: nightshift completion create ... groups the runs that delivered one outcome. This run's own outcome is not completion.

GitHub has every landing: `program/p25-the-line-is-where-work-ships` is at `0093a651733f`.

## Arbiter rulings — read these first

An arbiter ruled on these disputed findings. Each ruling is yours to reverse with
`nightshift ruling reverse <program> <decisionId> --reason …`. Reversing one records
your decision and replays nothing: an overturn's work stays landed and an uphold's ruling
stays carried out until the decision graph (P9); roll back by hand from the checkpoint named.

- **Upheld** by claude-fable-5-1 F-01 The existing user retry path (`nightshift land`) still cannot retry a refused line-only push. The new publication.retry handler releases it, but land first resolves a planned draft (line programs have none), and even if resolution were supplied it calls republishRun only when dispatch publication has unpublished intents. A line's refused push lives on the line record, so that condition is false; republishRun has the same early return. The added end-to-end test calls the API directly and misses this CLI gap. Wire land to resolve the line program and retry/poll its line push without requiring dispatch intents, and test the actual CLI with no parked entries or new landing. Requeue now offers an alternative, but the existing retry path required by the contract and advertised by line status remains broken. on node_01M74ECFVP71X1TBES89R3FG39: The finding is right on every piece of evidence, and the gap matters as stated. Checked in the checkout: `land` resolves its program through `findProgram` with `use: "ratified"` (apps/cli/src/commands/land.ts:167-173), which requires a draft or committed plan import (program-source.ts:195-208); a plane-created line program has neither, and `land` never branches on `isLineProgram` anywhere. Even past that, `land` calls `republishRun` only when `unpublishedOf(newest)` is non-empty (land.ts:222), and `republishRun` returns "nothing" before sending publication.retry when the run's intents are empty (republish.ts:68-69). A refused line push lives on the line record, not on dispatch intents, so neither condition is ever met. The second fix wired publication.retry on the API (operations/publication.ts) and tested it by calling the route directly (line-e2e.test.ts:1395, handler-line.test.ts), but nothing reaches that route from the CLI for a line.

It matters because the work itself advertises the broken path as the remediation a human reads: `refusalDetail` in packages/core/src/rules/line.ts:587 and the `line status` hint in apps/cli/src/commands/line.ts:147 both tell the person to "run `nightshift land` for the line program". A person who follows that instruction gets a usage error. Acceptance criterion 3 names "the line's existing retry path", and the existing retry path for a refused publication is `nightshift land` (republish through publication.retry); the API half of it is now released but the user-facing half is not connected. `nightshift line requeue --all` does work and is the right primary advice, but a product string that names a command that cannot work for the case it describes should not land, and after two fixes the CLI path still is not exercised by any test.

The fix is narrow: either make `land` resolve the line program (by the project's line branch, not a directory name) and send publication.retry then poll the line's push when the line is held, with a CLI test that has no parked entries and no new landing; or, if the owner accepts requeue as the sole user retry, remove `nightshift land` from both remediation strings so they do not promise a path that does not exist.
  Decision `dec_01M74K74WRCD31FM1F6BGHMEJJ`, made against checkpoint `ckpt_01M74K3W8S7QJ8PY5CKW45Q37G`.
- **Upheld** by claude-fable-5-1 F-02 A single line requeue request can release a refused push twice. postLineRequeue releases the hold and invokes the publisher, then calls startLineRun. If that publication has already returned protected/forbidden (synchronous dispatcher, or an asynchronous publisher finishing during the intervening store reads), startLineRun unconditionally releases the fresh refusal again. The request leaves the push pending for another publisher invocation instead of holding after its one retry. Keep refusal release at the explicit retry/landing boundary; generic startup must not re-release a refusal produced by that retry. Add a test where publishLine records a refusal before postLineRequeue continues, and assert the final status remains protected/forbidden with only one attempt. on node_01M74ECFVP71X1TBES89R3FG39: The finding is correct as stated and the code in this checkout still has the defect.

Mechanism, verified in the code: postLineRequeue (apps/api/src/operations/line.ts:642-652) releases the refused push to pending and awaits askPublisher. It then calls startLineRun (line 668). The first thing startLineRun does (apps/api/src/runner/line-run.ts:52-57) is run releaseRefusedPush on whatever the line record now holds, unconditionally. If the publisher has already settled the retried push as protected or forbidden by then, that second release puts it back to pending.

The window is real, not theoretical. In the local control plane and the e2e wiring (test/src/line/line-e2e.test.ts:384-386) publishLine is awaited synchronously, so the refusal is always recorded before startLineRun runs. In the deployed plane the publisher is invoked with InvocationType "Event" (apps/api/src/lambda/api.ts:111-118), so it is a race against the store reads between askPublisher and startLineRun, but the same write exists on the same path.

A re-pended push is a second attempt, not a harmless status flip: reconcileLinesWithWork asks the publisher for every pending push (apps/api/src/runner/reconcile.ts:121), and lineHasWork counts a pending push as work. So one requeue request can push against the protected branch twice, which breaks acceptance 3 and the contract's "tries the push again once".

Why the existing tests miss it: the handler test's fake publishLine only records the branch name and never settles the push (apps/api/src/handler-line.test.ts:83), so after the first release the push is still pending, lineHeldByRefusal is false, and startLineRun's release is a no-op. No e2e test exercises line.requeue on a refused line.

The startup release in startLineRun is also redundant everywhere else: its callers are postLineRequeue (which already released), publishAll on a landing (where appendQueueEntry already released), and the reconciler (which never sees a refused line because lineHasWork excludes it). Removing the release from startLineRun, keeping it at the landing, publication.retry and requeue boundaries, and adding the test the examiner asked for (publisher settles protected before postLineRequeue continues; assert status stays protected with one attempt) resolves the finding.
  Decision `dec_01M74KAXPNCHRAVX03M4Z49DPV`, made against checkpoint `ckpt_01M74K3W8S7QJ8PY5CKW45Q37G`.

## Stories

### US-01 Programs compose straight onto the branch that ships, whole or in part, as they land; each conflict is resolved once, th: done

- **Who:** The owner running several programs in parallel on one project
- **Today:** The line resolves a conflict between two programs on a preview branch, then the second program's pull request meets the same conflict at main and someone resolves it again, differently; main and the line diverge, main stops merging onto the line, and every later range parks.
- **Afterwards:** Programs compose straight onto the branch that ships, whole or in part, as they land; each conflict is resolved once, there; the line keeps moving.
> "in one instance it required another agent to merge the program branches into main and resolve conflicts. Whereas, I thought the conflicts would be resolved by nightshift"
> "I'd rather the line continually move forward (whole or part program) and merge into main (even if it contains a half-program)"

Criteria: SC-01 met, SC-02 met, SC-03 met, SC-04 met. Strands: S-01, S-02.

### US-02 The team names its line branch in nightshift.config.json, Nightshift composes onto that branch and stops there, and the : done

- **Who:** A team using Nightshift with its own way of shipping
- **Today:** The line can only be a preview beside main, so a team that ships from main, or promotes a staging branch to production, cannot point Nightshift at the branch its pipeline uses.
- **Afterwards:** The team names its line branch in nightshift.config.json, Nightshift composes onto that branch and stops there, and the team's own CI/CD decides what happens next.
> "i also want to give some latitude for other devs/users to organize their CI/CD the way they want. I feel like we should just allow a config for the "line branch""

Criteria: SC-02 met, SC-03 met, SC-04 met. Strands: S-01, S-02.

## Gate health

Audit: **healthy** at `ec4bd064`, 2026-10-09T17:29:07.301Z.

### Verification time

37m 10s across 6 verifications and 0 landings.

Retained rerun time: 0.0s across 0 flaky first run(s) and failed rerun(s), included in the totals.

| Step | Runs | Total | Reruns | Per run | Quiet start | Queue / candidate / end / snapshot | Forecast per run |
|------|------|-------|--------|---------|-------------|------------------------------------|------------------|
| `setup:install` | 6 | 39.6s | none | 6.6s | 0.1s | 6 / 0 / 0 / 0 | — |
| `build` | 6 | 23.2s | none | 3.9s | 0.1s | 6 / 0 / 0 / 0 | — |
| `typecheck` | 6 | 19.6s | none | 3.3s | 0.1s | 6 / 0 / 0 / 0 | — |
| `lint` | 6 | 6.7s | none | 1.1s | 0.1s | 6 / 0 / 0 / 0 | — |
| `test` | 6 | 33m 31s | none | 5m 35s | 0.1s | 6 / 0 / 0 / 0 | — |
| `synth` | 6 | 2m 09s | none | 21.4s | 0.1s | 6 / 0 / 0 / 0 | — |
| `sterility` | 6 | 1.0s | none | 0.2s | 0.1s | 6 / 0 / 0 / 0 | — |

No recommendations: run `nightshift gates <program> --record` before a run to keep what the gates resolve to, and the report prices them here.

## Strands

### S-01 The line composes the branch that ships: succeeded

Acceptance, as planned:
- The composer starts each batch from the line's own head and merges only queued ranges; the default-branch fetch, the main merge and the 'main does not compose onto the line' park are gone; a line branch absent at the remote is created from the default branch's head
- A contract of a project with a line inherits its base branch from line.branch when it states none, and plan check refuses one that names another, with the fix in its message
- A protected or forbidden line push records a waiting reason with the remediation on the line and is not recomposed until a new landing or the line's retry tries it once more
- A line run is created only after admission; a refusal records the line's waiting reason and leaves no run
- nightshift line status names the line program and the branch
- A line run that parked anything it took ends failed, with a reason naming the parked ranges, and its report leads with them
- nightshift line requeue [<program> | --all] moves parked entries back to the queue with their repair count reset, records who asked and starts a line run; engine principals are refused
- The line end-to-end test proves a line on the default branch, a direct push to the line between batches, and a protected line branch
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Composer starts every batch from the line's own head and merges only queued ranges (decision D-03: no default-branch mer | merged | d0b7d05c | 1 |
| A program of a project with a line has the line as its base branch (decision D-02). In packages/contracts/src/v1/config. | merged | 44174939 | 1 |
| A protected or forbidden line push holds the line instead of looping (record and plane side). In packages/core/src/rules | merged | a95a3456 | 1 |
| A line run is created only after it is admitted. In apps/api/src/runner/line-run.ts the plane checks admission (org mont | merged | fa954462 | 1 |
| The line owner honours a refused push and ends honestly. (a) In apps/mcp/src/runner/line-owner.ts (and packages/executio | merged | 05bfc3ca | 1 |
| `nightshift line requeue [<program> / --all]` and a clearer `nightshift line status`. Rebuild (do not cherry-pick) aband | merged | f39759f0 | 1 |
| The line end-to-end test (test/src/line/line-e2e.test.ts) proves the new line: (1) a line on the repository's default br | merged | 76144de5 | 1 |
| In test/src/execution/line-compose.test.ts, move the test `it("takes a commit pushed straight to the line between batche | merged | 86e2b63b | 1 |
| Fix examiner finding F-01: a newly configured line whose branch does not exist at GitHub yet must be admitted and compos | merged | a110aa31 | 1 |
| Fix examiner finding F-02: a refused line push can get permanently stuck. Scenario: a push is refused as protected, so t | merged | 873e70f0 | 1 |
| Fix examiner finding F-01 (acceptance 3: a protected/forbidden line push holds until a new landing OR the line's retry t | merged | af71025c | 1 |
| Fix examiner finding F-02 (acceptance 4: a line run refusal records the line's waiting reason and leaves no run). In app | merged | 57a9a474 | 1 |
| J1 / upheld F-01: Fix the actual nightshift land CLI for a plane-created line program. Resolve line program from the pro | merged | bf33afba | 1 |
| J2 / upheld F-02: Remove releaseRefusedPush from generic apps/api/src/runner/line-run.ts startLineRun. Keep refusal rele | merged | 9dafd300 | 1 |
| J3: Finish J1 --run acceptance. land.ts's new early line path currently ignores options.run. Pass it into landLine and v | merged | 0093a651 | 1 |

- Composer starts every batch from the line's own head and merges only queued ranges (decision D-03: no default-branch mer
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- A program of a project with a line has the line as its base branch (decision D-02). In packages/contracts/src/v1/config.
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- A protected or forbidden line push holds the line instead of looping (record and plane side). In packages/core/src/rules
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- A line run is created only after it is admitted. In apps/api/src/runner/line-run.ts the plane checks admission (org mont
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- The line owner honours a refused push and ends honestly. (a) In apps/mcp/src/runner/line-owner.ts (and packages/executio
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- `nightshift line requeue [<program> / --all]` and a clearer `nightshift line status`. Rebuild (do not cherry-pick) aband
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- The line end-to-end test (test/src/line/line-e2e.test.ts) proves the new line: (1) a line on the repository's default br
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- In test/src/execution/line-compose.test.ts, move the test `it("takes a commit pushed straight to the line between batche
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-01: a newly configured line whose branch does not exist at GitHub yet must be admitted and compos
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-02: a refused line push can get permanently stuck. Scenario: a push is refused as protected, so t
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-01 (acceptance 3: a protected/forbidden line push holds until a new landing OR the line's retry t
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-02 (acceptance 4: a line run refusal records the line's waiting reason and leaves no run). In app
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- J1 / upheld F-01: Fix the actual nightshift land CLI for a plane-created line program. Resolve line program from the pro
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- J2 / upheld F-02: Remove releaseRefusedPush from generic apps/api/src/runner/line-run.ts startLineRun. Keep refusal rele
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- J3: Finish J1 --run acceptance. land.ts's new early line path currently ignores options.run. Pass it into landLine and v
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

### S-02 Saying it: architecture, skills, report: succeeded

Acceptance, as planned:
- docs/architecture.md records the decision as row A-69 amending A-66 and A-67 and retiring D-05's pull-request path
- The run-program, plan-program and nightshift skills say a line is the branch work ships from, programs start from it, work reaches it whole or in part, unfinished user-facing work stays unreachable until its program completes, and promotion beyond the line is the project's
- A run's report for a project with a line says where its work reached the line and asks no one to open a pull request
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Say the decision in the docs and skills. (a) docs/architecture.md: add row A-69 after A-68, in the table's existing styl | merged | e77789b3 | 1 |
| In packages/core/src/report/, a plan program's run report for a project with a line says where THIS RUN's work reached t | merged | a67ee86c | 1 |
| Fix examiner finding F-01 on the plan-run line-reach report. Problem: packages/execution/src/line/compose.ts (the groupi | merged | 402cb583 | 1 |

- Say the decision in the docs and skills. (a) docs/architecture.md: add row A-69 after A-68, in the table's existing styl
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- In packages/core/src/report/, a plan program's run report for a project with a line says where THIS RUN's work reached t
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-01 on the plan-run line-reach report. Problem: packages/execution/src/line/compose.ts (the groupi
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

## Success criteria

| Criterion | State | By |
|---|---|---|
| SC-01 A project whose line is its default branch (main) has every program's ranges composed onto main as they land, with conflicts repaired there, and nothing else merged into the line; the foodfly stall (main does not compose onto the line) cannot occur. | met | S-01 |
| SC-02 A project may name any branch as its line (main, staging, another); a program of a project with a line starts from that branch, and plan check refuses a contract whose base branch is another one, saying how to fix it. | met | S-01 |
| SC-03 A line branch that refuses Nightshift's push holds the line with a reason and remediation the owner can read in nightshift line status, and nothing is recomposed until the refusal is cleared; a line run is only created once it is admitted, so a full org ceiling leaves no interrupted runs behind. A line run that parked work says so by ending failed, and parked work can be sent back to the queue. | met | S-01 |
| SC-04 The architecture record, the skills and a run's report describe the line as the branch work ships from: programs start from it, work reaches it whole or in part, unfinished user-facing work stays unreachable until its program completes, and promotion beyond it is the project's. | met | S-02 |

## Parked

Nothing was parked.

## Deferred

Nothing was deferred.

## Human prerequisites still pending

None.

## Decision graph

Every decision the run recorded: what was weighed, what it produced, and whether you
reversed it. To reverse one: `nightshift decision reverse <program> <decisionId> --choice … --reason …`.

- **Plan:** D-01: Does Nightshift keep a preview line mode (a line nothing promotes from, with programs reaching main through their own pull requests)? (`dec_01M74E82KKQ4M7BEJFEJ61Q1PX`)
  Chose: Retire it: a line is always the branch work ships from (main, or a staging branch the project promotes). The preview mode resolves every cross-program conflict twice and the two resolutions diverge (foodfly, 2026-10-31); a team wanting review before main uses a staging line.
  Weighed: Keep it as an option beside shipping lines
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-02: When a project has a line, do its programs start from the line branch? (`dec_01M74E82P74E921339BK7S50TZ`)
  Chose: Yes, always: the contract inherits its base branch from the line and plan check refuses another. Each program builds on everything already on the line, so conflicts with it surface while the program is built, not at composition.
  Weighed: No: the contract's base branch stays independent
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-03: Does the composer still merge the repository's default branch into the line before composing? (`dec_01M74E82RHFEWVGY1NDP2WY616`)
  Chose: No: the line's inputs are its own head and the queued ranges. Nightshift's responsibility ends at the line; with the line on main nothing else exists, and a staging line's hotfix flow is the project's CI's. It removes the stall class seen on foodfly.
  Weighed: Yes, with a budgeted repair job when it does not merge
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN: round 1 — 2 jobs, 2 starting at once (`dec_01M74EF0C7CZRRK7Y36ECNJ4KJ`)
  Chose: J1: Say the decision in the docs and skills. (a) docs/architecture.md: add row A-69 after A-68, in the table's existing style (bold title, provenance in parentheses naming D-01/D-02 of this program and foodfly 2026-10-31, '(amends A-66, A-67; retires D-05's pull-request path)'), stating: a project's line is the branch its work ships from (main, or a staging/other branch the project promotes); a plan program of a project with a line starts from the line branch (the contract inherits its base branch from the line and plan check refuses another); the composer starts from the line's own head and merges only queued ranges onto it, so each conflict is resolved once on the branch that ships; work reaches the line whole or in part as it lands; for a line that ships, user-facing work of an unfinished program stays unreachable (unrouted or behind a flag) until its program completes; a protected line holds with its reason instead of looping; promotion beyond the line is the project's own CI/CD; programs no longer reach main through their own pull requests and the line no longer takes main in. Rationale column: the preview mode resolved every cross-program conflict twice and the resolutions diverged (foodfly, 2026-10-31); rejected: keeping a preview line mode (a team wanting review before main uses a staging line). (b) On A-66 and A-67 add '(amended by A-69: …)' notes in the same style A-66 already uses for A-67, and make A-66's sentence about pull requests and D-05 read as superseded by A-69 (keep history; do not delete the row). (c) skills/run-program/SKILL.md, skills/plan-program/SKILL.md, skills/nightshift/SKILL.md: wherever they describe the project line or landing, say: name a line and programs start from it; work reaches the line whole or in part as it lands; for a line that ships, user-facing work of an unfinished program stays unreachable (unrouted or behind a flag) until its program completes (plan-program should tell planners to plan for this); promotion beyond the line is the project's. Describe only the one shape of line (no preview mode, no per-program pull request to main). In run-program's report-reading section, tell the reader to relay where the run's work reached the line, not to open a pull request. (d) AGENTS.md: if it describes the line or a program's path to main, align it; otherwise add at most one short bullet where landing is described.
  depends on: nothing (starts at once)
  touches: docs/architecture.md, skills/run-program/SKILL.md, skills/plan-program/SKILL.md, skills/nightshift/SKILL.md, AGENTS.md
  - docs/architecture.md has a row A-69 directly after A-68 amending A-66 and A-67 and retiring D-05's pull-request path, and A-66 and A-67 each carry an '(amended by A-69 …)' note
  - run-program, plan-program and nightshift SKILL.md each say: a line is the branch work ships from, programs start from it, work reaches it whole or in part, unfinished user-facing work stays unreachable (unrouted or behind a flag) until its program completes, promotion beyond the line is the project's
  - No skill or AGENTS.md text tells anyone to open a pull request for a program's work or describes a preview line
  - npm run lint and npm run check:sterility pass

J2: In packages/core/src/report/, a plan program's run report for a project with a line says where its work reached the line, and never asks anyone to open a pull request. Today a plan run's report only renders publication to the program branch (renderPublication/renderLandings in report.ts); for a line-kind program gatherLine reads stores.lines. Add, for a plan (non-line) program whose project has a line (find how the project/contract names its line: program.line, project config, or the dispatch; S-01 may be adding an inherited base branch on the contract — use what exists on your branch head), a section after the publication lines: 'Where this run's work reached the line `<branch>`', computed from the project's line record filtered to ranges/entries of this program: composed onto the line (composition commit, and whether pushed), parked (with its reason), still queued (waiting for the line's owner), or not yet queued (e.g. not published yet). Say plainly that promotion beyond the line is the project's own. Keep the line-run report (renderLineReport) unchanged except where it would say pull request. Add tests next to the existing ones (report.test.ts / line-report.test.ts or a new test file) covering: queued, composed-and-pushed, parked, and a project with no line (no section). Export types via index.ts if added to RunReport.
  depends on: nothing (starts at once)
  touches: packages/core/src/report/report.ts, packages/core/src/report/index.ts, packages/core/src/report/*.test.ts
  - A plan run's rendered report for a project with a line contains a section naming the line branch and, per state, that its work was composed (with commit, pushed or not), parked (with reason), or queued
  - The report for a project without a line has no such section and is otherwise unchanged
  - No report text produced by packages/core/src/report contains 'pull request'
  - New tests cover queued, composed, parked and no-line cases and pass; npm run build, typecheck, lint and test pass. Two independent jobs touching disjoint files, run in parallel: J1 is all prose (architecture row, skills, AGENTS.md); J2 is the report code and its tests. The report today never says 'open a pull request' — the gap is that a plan run's report says nothing about the line at all, so J2 adds where the work reached it from the line record (which names ranges by program). Splitting the docs finer (architecture vs skills) would cost an extra worker for no parallelism gain worth it.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M74EGKZ5FPS2TJ8G168DG9CR`)
  Chose: The two-job split is appropriately sized and can run in parallel: the files are disjoint, and program.line already supplies J2's line identity without waiting for S-01. J1 covers the prose acceptance, but J2's prescribed lookup and state coverage can produce misleading answers about where this run's work reached the line.
- [MATERIAL] Filtering the line record by program alone does not identify this run's work. LineRange has program/from/upTo but no originating run id, and compositions and parked entries retain only the newest 50 entries each (packages/contracts/src/v1/line.ts). An earlier run's composition could therefore be presented under 'this run's work' while this run is unpublished, and an aged-out composition could be presented as not yet queued. J2 needs explicit attribution using this run's publication/range evidence, honest unknown/history-unavailable wording where evidence is insufficient, and tests for successive runs of one program and missing retained history. (J2)
- [MATERIAL] J2's enumerated states omit work already taken into record.batch.entries and work held for repair in record.held. Both exist separately from queue, compositions and parked in LineRecord. During normal composition or repair, the proposed fallback can label published work 'not yet queued' or incorrectly say it is waiting for the owner. Require truthful coverage of batch and held entries, including mixed partial progress, and corresponding tests so the report satisfies acceptance while the line is working. (J2)
- [minor] Neither job's acceptance explicitly owns synth, although strand criterion 4 requires it. nightshift.config.json already configures the synth gate, so this need not add a job or dependency; make the final combined verification responsibility explicit (for example, the existing npm run verify) to close the written acceptance coverage. (J1, J2). An independent examiner reviewed decision dec_01M74EF0C7CZRRK7Y36ECNJ4KJ against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 1 — 7 jobs, 4 starting at once (`dec_01M74EGSAFZ17P9B5FPCZDH91T`)
  Chose: J1: Composer starts every batch from the line's own head and merges only queued ranges. In packages/execution/src/line/compose.ts remove the main merge (mainMessage, the checkout.merge of mainHead, the 'main does not compose onto the line' park and its wording, any repair path for a failed main merge); `heads()` returns only { lineHead }, and mainHead leaves LineComposerPorts/ports.ts. In apps/mcp/src/runner/line-owner.ts fetchHeads stops fetching the default branch except when the line branch is absent at the remote, in which case the line head is the default branch's head (the only time anything but a range enters). Remove the composer's main-merge tests and update the remaining tests (test/src/execution/line-compose.test.ts, test/src/execution/line-attempt-durability.test.ts, apps/mcp/src/runner/line-owner.test.ts). Reference only: abandoned commits 0bbda27/c798bd3 on program/p25-line-feeds-main describe the old composer; do not cherry-pick.
  depends on: nothing (starts at once)
  touches: packages/execution/src/line/compose.ts, packages/execution/src/line/ports.ts, apps/mcp/src/runner/line-owner.ts, apps/mcp/src/runner/line-owner.test.ts, test/src/execution/line-compose.test.ts, test/src/execution/line-attempt-durability.test.ts
  - grep for mainHead and 'main does not compose' in packages/execution/src and apps/mcp/src finds nothing
  - LineComposerPorts.heads yields only the line head; a batch composes from it with only queued ranges merged
  - When the line branch is absent at the remote the owner composes from the repository default branch head; otherwise it does not fetch the default branch
  - A test proves a commit pushed directly to the line between batches is simply in the next batch's base (no merge commit of main)
  - npm run build, typecheck, lint and the touched tests pass

J2: A program of a project with a line has the line as its base branch. In packages/contracts/src/v1/config.ts make inheritFromConfig set repository.baseBranch from config.line.branch when the project has a line and the contract states no baseBranch. Make `nightshift plan check` (apps/cli/src/commands/plan.ts and whichever rule it calls) refuse a contract whose repository.baseBranch differs from the line's branch, with a message naming both and the fix (set repository.baseBranch to <line> or remove it). Verify the CLI program-branch creation (apps/cli/src/program-branch.ts via remote.ts/run-program.ts) and the engine (apps/mcp/src/orchestrator.ts) read the inherited base through the contract with no further special-casing; change only what is needed. Do not change the line's own program contract (packages/core/src/line/program.ts), whose baseBranch remains the repository default branch.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/config.ts, packages/contracts/src/v1/config.test.ts, apps/cli/src/commands/plan.ts, apps/cli/src/commands/plan.test.ts, packages/core/src/rules/**
  - config.test.ts proves a contract with no baseBranch inherits line.branch when the config has a line, and keeps its own baseBranch when stated
  - plan check refuses a contract whose baseBranch differs from line.branch, the message naming the line branch and the fix; a test covers it
  - a contract with no line config is unaffected
  - build, typecheck, lint and the touched tests pass

J3: A protected or forbidden line push holds the line instead of looping. In packages/core/src/rules/line.ts resolvePush: for status protected or forbidden do NOT requeue the unpushed composition's ranges; instead set the line record's `waiting` (add a LineWaitingReason value, e.g. `line_refused`, in packages/contracts/src/v1/line.ts) whose detail names the branch and the remediation: allow the Nightshift GitHub App to bypass the branch's protection (for forbidden, keep the permission wording from forbiddenDetail). lineHasWork must then be false so the owner idles out. The push is tried again exactly once when (a) a new landing appends a queue entry (appendQueueEntry) or (b) the line's existing retry path (find it: reconciler/apps/api/src/runner/reconcile.ts or the line start path) runs: the held composition's push goes back to pending (or its ranges are requeued) once, and the waiting reason is cleared when it publishes. Update apps/api/src/runner/publisher.ts line path as needed. Do not edit apps/mcp/src/runner/line-owner.ts or packages/execution/src/line/compose.ts (another job is changing them); if the owner needs a change, describe it in your handoff.
  depends on: nothing (starts at once)
  touches: packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, packages/contracts/src/v1/line.ts, apps/api/src/runner/publisher.ts, apps/api/src/runner/publisher*.test.ts, apps/api/src/runner/reconcile.ts
  - resolvePush with protected/forbidden leaves the queue unchanged and records waiting with the branch name and the bypass-protection remediation; unit tests in packages/core/src/rules/line.test.ts
  - lineHasWork is false for a line held by a refused push
  - a new queue entry, or the retry path, makes the refused push be attempted once more, and a second refusal holds again without looping; tests cover both
  - a successful publish clears the waiting reason
  - build, typecheck, lint and the touched tests pass

J4: A line run is created only after it is admitted. In apps/api/src/runner/line-run.ts the plane checks admission (org month ceiling, org concurrency, the line's self-started monthly cap, configuration) before it writes the Run and root ExecutionNode; a refusal records the line's waiting reason (as today) and leaves no run record. Factor the ceiling checks out of admitDispatch in apps/api/src/operations/dispatch.ts so they can run without a run, keeping admitDispatch's behaviour for ordinary dispatches unchanged.
  depends on: nothing (starts at once)
  touches: apps/api/src/runner/line-run.ts, apps/api/src/runner/line-run.test.ts, apps/api/src/operations/dispatch.ts, apps/api/src/operations/dispatch*.test.ts
  - line-run.test.ts proves a refused admission (each of monthly_cap, org_month_ceiling, org_concurrency) records waiting and leaves no run and no execution node in the stores
  - an admitted line run is created and dispatched as before
  - ordinary dispatch tests still pass unchanged
  - build, typecheck, lint and the touched tests pass

J5: Honest line runs: a line run that parked anything it took ends `failed`, its failure reason naming each parked range (program, upTo) and its cause, and the line report leads with the parked ranges, saying each waits for `nightshift line requeue`. Rebuild (do not cherry-pick) the idea of commit c798bd3 against the current owner: apps/mcp/src/runner/line-owner.ts reads the parked entries recorded since its run started (a replacement owner's included) and completes the run failed. The report change in packages/core/src/report/ (report.ts / line-report) is minimal: put Parked first; another strand edits report publication wording, keep the diff small.
  depends on: J1
  touches: apps/mcp/src/runner/line-owner.ts, apps/mcp/src/runner/line-owner.test.ts, packages/core/src/report/report.ts, packages/core/src/report/line-report.test.ts
  - line-owner.test.ts proves a run that parked a range completes failed with a reason naming the range, and a run that parked nothing still succeeds
  - line-report test proves Parked leads the report and names nightshift line requeue
  - build, typecheck, lint and the touched tests pass

J6: `nightshift line requeue [<program> | --all]` and a clearer `nightshift line status`. Rebuild (do not cherry-pick) commit 0443cd3: a core rule requeueParked in packages/core/src/rules/line.ts moves parked entries (all, or one program's) back to the queue with their repair count reset, unless already queued/held/batched/composed, recording on the record who asked and when; a user-only API route line.requeue (apps/api/src/operations/line.ts, handler.ts, persistence http routes, authorize.ts) applies it and starts a line run via startLineRun, refusing engine principals with 403; the CLI (apps/cli/src/cli.ts, apps/cli/src/commands/line.ts) adds `line requeue <program>|--all`. `nightshift line status` names the line program and the line branch's role (e.g. 'main, the branch work ships from') and how many parked ranges wait for requeue.
  depends on: J3, J4
  touches: packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, packages/core/src/rules/authorize*.ts, packages/contracts/src/v1/line.ts, apps/api/src/operations/line.ts, apps/api/src/handler.ts, apps/api/src/handler-line.test.ts, packages/persistence/src/http/routes.ts, apps/cli/src/cli.ts, apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts
  - rule tests: requeue of all and of one program, repair counts reset, requester and time recorded, already-queued ranges not duplicated
  - API test: a user requeue moves entries and starts a line run; an engine principal is refused
  - CLI tests for requeue <program>, requeue --all, usage error with neither, and line status naming the line program and branch
  - build, typecheck, lint and the touched tests pass

J7: The line end-to-end test (test/src/line/line-e2e.test.ts) proves the new line: (1) a line on the repository's default branch composes landed ranges onto it; (2) a commit pushed directly to the line between batches is in the next batch's base and survives; (3) a protected line branch holds the line with the waiting reason and remediation, does not loop, and a new landing retries the push once. Remove or adapt any remaining e2e expectations of the main merge. Fix small integration gaps the e2e exposes in the earlier jobs' code.
  depends on: J1, J2, J3, J4, J5, J6
  touches: test/src/line/line-e2e.test.ts, test/src/line/**
  - the three scenarios exist as tests in line-e2e.test.ts and pass
  - no e2e expectation mentions merging main into the line
  - npm run build, typecheck, lint, test pass. J1-J4 are independent and run at once: composer (execution + owner), contract/plan check (contracts config + CLI plan), protected-push hold (core rules + contracts line.ts + publisher), admission-before-run (api line-run + dispatch). J5 also edits line-owner.ts so waits for J1. J6 shares core/rules/line.ts and contracts/v1/line.ts with J3 and calls startLineRun changed by J4, so waits for both. J7 is the e2e over everything. J3 is told not to touch the owner/composer so it can run beside J1; any owner change it needs surfaces in J7. J5 touches packages/core/src/report minimally (acceptance 6 requires the report to lead with parked ranges), a known small overlap with S-02.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN: round 2 — 2 jobs, 2 starting at once (`dec_01M74EH9X1R7JDVWZDNRKA944A`)
  Chose: J1: Say the decision in the docs and skills. (a) docs/architecture.md: add row A-69 after A-68, in the table's existing style (bold title, provenance in parentheses naming D-01/D-02 of this program and foodfly 2026-10-31, '(amends A-66, A-67; retires D-05's pull-request path)'), stating: a project's line is the branch its work ships from (main, or a staging/other branch the project promotes); a plan program of a project with a line starts from the line branch (the contract inherits its base branch from the line and plan check refuses another); the composer starts from the line's own head and merges only queued ranges onto it, so each conflict is resolved once on the branch that ships; work reaches the line whole or in part as it lands; for a line that ships, user-facing work of an unfinished program stays unreachable (unrouted or behind a flag) until its program completes; a protected line holds with its reason instead of looping; promotion beyond the line is the project's own CI/CD; programs no longer reach main through their own pull requests and the line no longer takes main in. Rationale column: the preview mode resolved every cross-program conflict twice and the resolutions diverged (foodfly, 2026-10-31); rejected: keeping a preview line mode (a team wanting review before main uses a staging line). (b) On A-66 and A-67 add '(amended by A-69: …)' notes in the same style A-66 already uses for A-67, and make A-66's sentence about pull requests and D-05 read as superseded by A-69 (keep history; do not delete the row). (c) skills/run-program/SKILL.md, skills/plan-program/SKILL.md, skills/nightshift/SKILL.md: wherever they describe the project line or landing, say: name a line and programs start from it; work reaches the line whole or in part as it lands; for a line that ships, user-facing work of an unfinished program stays unreachable (unrouted or behind a flag) until its program completes (plan-program should tell planners to plan for this); promotion beyond the line is the project's. Describe only the one shape of line (no preview mode, no per-program pull request to main). In run-program's report-reading section, tell the reader to relay where the run's work reached the line, not to open a pull request. (d) AGENTS.md: if it describes the line or a program's path to main, align it; otherwise add at most one short bullet where landing is described.
  depends on: nothing (starts at once)
  touches: docs/architecture.md, skills/run-program/SKILL.md, skills/plan-program/SKILL.md, skills/nightshift/SKILL.md, AGENTS.md
  - docs/architecture.md has a row A-69 directly after A-68 amending A-66 and A-67 and retiring D-05's pull-request path, and A-66 and A-67 each carry an '(amended by A-69 …)' note
  - run-program, plan-program and nightshift SKILL.md each say: a line is the branch work ships from, programs start from it, work reaches it whole or in part, unfinished user-facing work stays unreachable (unrouted or behind a flag) until its program completes, promotion beyond the line is the project's
  - No skill or AGENTS.md text tells anyone to open a pull request for a program's work or describes a preview line
  - npm run lint and npm run check:sterility pass

J2: In packages/core/src/report/, a plan program's run report for a project with a line says where THIS RUN's work reached the line, and never asks anyone to open a pull request. Today a plan run's report only renders publication to the program branch (renderPublication/renderLandings in report.ts); for a line-kind program gatherLine reads stores.lines. For a plan (non-line) program whose project has a line (program.line on the contract, or whatever names the line on your branch head), add a section after the publication lines headed with the line branch. ATTRIBUTION: a LineRange/LineQueueEntry names only program/from/upTo, not a run, so attribute by commit: this run's work is identified by its published program-branch heads (dispatch.publication.head and intent heads, as publicationOf reads them); an entry/range is this run's only when its program is this program AND its upTo is one of this run's published heads. Never present an earlier run's composition as this run's. STATES, covering every place an entry can be in the LineRecord (packages/contracts/src/v1/line.ts): queue (waiting for the line's owner), batch.entries (taken by the owner, being composed), held (held for repair), compositions (composed onto the line at commit X; say whether pushed), parked (with its reason). A run with several published heads can be in several states at once (partial progress): list each. When the run published heads but none is found in the record, say honestly that the line's retained history (compositions/parked keep only the newest entries) no longer shows it or it has not been queued yet — do not claim 'not yet queued' as fact. When the run published nothing, say its work has not reached the line. Say plainly that promotion beyond the line is the project's own. Keep the line-run report (renderLineReport) unchanged except where it would say pull request. Tests (next to report.test.ts / line-report.test.ts or a new file) cover: queued; in batch; held for repair; composed-and-pushed; parked; mixed partial progress across two heads; successive runs of one program (an earlier run's composition is not shown as this run's); published but absent from retained history; project with no line (no section). Export new types via index.ts if added to RunReport.
  depends on: nothing (starts at once)
  touches: packages/core/src/report/report.ts, packages/core/src/report/index.ts, packages/core/src/report/*.test.ts
  - A plan run's rendered report for a project with a line contains a section naming the line branch and, for each of this run's published heads, its state: queued, being composed (batch), held for repair, composed (commit, pushed or not), or parked (reason)
  - Entries are attributed to the run by its published heads, so an earlier run of the same program is never reported as this run's; a head missing from the retained record is reported as not shown rather than asserted unqueued
  - The report for a project without a line has no such section and is otherwise unchanged
  - No report text produced by packages/core/src/report contains 'pull request'
  - Tests cover queued, batch, held, composed, parked, mixed, successive-runs, aged-out and no-line cases; npm run verify (build, typecheck, lint, test) and npm --workspace @nightshift/cdk run synth pass. Revised per review: J2 now attributes line entries to this run by its published heads (ranges carry no run id), covers every LineRecord location (queue, batch, held, compositions, parked) including partial progress, and is honest when retained history no longer shows a head. Gate coverage (synth included) is explicit in J2's acceptance; J1 is prose-only. Still two disjoint parallel jobs.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN REVIEW: round 2 of 2 — sound (`dec_01M74EJ5GQ6Z8C9XZ6G9PJJ2DA`)
  Chose: The two jobs cover the strand's acceptance and can build independently: J1 owns documentation and skills, while J2 owns report gathering, rendering and tests using existing contract and store interfaces. The revised run attribution and retained-history handling fit the current LineRecord model, the file sets do not overlap each other or require S-01's implementation, and the configured verify command covers all required gates, including synth and sterility.. An independent examiner reviewed decision dec_01M74EH9X1R7JDVWZDNRKA944A against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M74EJDDZGQ9XH4AEVS6GRFHC`)
  Chose: The split covers most of the strand and gives the main implementation areas useful parallelism. It needs explicit ownership of the protected-line owner behavior, durable evidence for failed line runs, and the two missing final verification gates before it is ready to build.
- [MATERIAL] J3 cannot deliver its stated owner-idles-out behavior through lineHasWork alone: apps/mcp/src/runner/line-owner.ts has its own hasWork and drain conditions, reading queue, batch, held ranges and repair state directly. After a refusal, leftover queued ranges (including entries beyond MAX_LINE_BATCH_ENTRIES) or held repairs can drive another composition even though core lineHasWork is false. J3 explicitly forbids the needed owner/composer edits and leaves them as unspecified small integration gaps for J7. Assign this known integration work explicitly to a job with the relevant dependency and acceptance tests covering a refusal with queued and held work; coordinate its owner edits with J1/J5. (J1, J3, J5, J7)
- [MATERIAL] J5 specifies determining failure from parked entries on the line record since run start, but that record retains only MAX_LINE_PARKED=50 entries, and J6 moves parked entries back to the queue. A long run or a user requeue before completion can therefore lose the evidence needed to name every range it parked, or even incorrectly succeed. The existing report already reconstructs run-scoped settled line.parked events (including chunks) as well as record entries. Require durable run-scoped evidence for completion and tests for replacement owners, record truncation and requeue before completion. (J5, J6)
- [MATERIAL] Acceptance 9 requires synth and sterility to be green, but no job's acceptance runs either. J7's final checks stop at build, typecheck, lint and test. Assign npm run synth and npm run check:sterility to the final integration verification (the configured npm run verify includes both), with responsibility to fix failures. (J7). An independent examiner reviewed decision dec_01M74EGSAFZ17P9B5FPCZDH91T against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 2 — 7 jobs, 4 starting at once (`dec_01M74EKGD7PM3BXP4JAPP4F43J`)
  Chose: J1: Composer starts every batch from the line's own head and merges only queued ranges. In packages/execution/src/line/compose.ts remove the main merge (mainMessage, the checkout.merge of mainHead, the 'main does not compose onto the line' park and its wording, any repair path for a failed main merge); `heads()` returns only { lineHead }, and mainHead leaves LineComposerPorts/ports.ts. In apps/mcp/src/runner/line-owner.ts fetchHeads stops fetching the default branch except when the line branch is absent at the remote, in which case the line head is the default branch's head (the only time anything but a range enters). Remove the composer's main-merge tests and update the remaining tests (test/src/execution/line-compose.test.ts, test/src/execution/line-attempt-durability.test.ts, apps/mcp/src/runner/line-owner.test.ts). Reference only: abandoned commits 0bbda27/c798bd3 on program/p25-line-feeds-main describe the old composer; do not cherry-pick.
  depends on: nothing (starts at once)
  touches: packages/execution/src/line/compose.ts, packages/execution/src/line/ports.ts, apps/mcp/src/runner/line-owner.ts, apps/mcp/src/runner/line-owner.test.ts, test/src/execution/line-compose.test.ts, test/src/execution/line-attempt-durability.test.ts
  - grep for mainHead and 'main does not compose' in packages/execution/src and apps/mcp/src finds nothing
  - LineComposerPorts.heads yields only the line head; a batch composes from it with only queued ranges merged
  - When the line branch is absent at the remote the owner composes from the repository default branch head; otherwise it does not fetch the default branch
  - A test proves a commit pushed directly to the line between batches is simply in the next batch's base (no merge commit of main)
  - npm run build, typecheck, lint and the touched tests pass

J2: A program of a project with a line has the line as its base branch. In packages/contracts/src/v1/config.ts make inheritFromConfig set repository.baseBranch from config.line.branch when the project has a line and the contract states no baseBranch. Make `nightshift plan check` (apps/cli/src/commands/plan.ts and whichever rule it calls) refuse a contract whose repository.baseBranch differs from the line's branch, with a message naming both and the fix (set repository.baseBranch to <line> or remove it). Verify the CLI program-branch creation (apps/cli/src/program-branch.ts via remote.ts/run-program.ts) and the engine (apps/mcp/src/orchestrator.ts) read the inherited base through the contract with no further special-casing; change only what is needed. Do not change the line's own program contract (packages/core/src/line/program.ts), whose baseBranch remains the repository default branch.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/config.ts, packages/contracts/src/v1/config.test.ts, apps/cli/src/commands/plan.ts, apps/cli/src/commands/plan.test.ts, packages/core/src/rules/** (not line.ts)
  - config.test.ts proves a contract with no baseBranch inherits line.branch when the config has a line, and keeps its own baseBranch when stated
  - plan check refuses a contract whose baseBranch differs from line.branch, the message naming the line branch and the fix; a test covers it
  - a contract with no line config is unaffected
  - build, typecheck, lint and the touched tests pass

J3: A protected or forbidden line push holds the line instead of looping (record and plane side). In packages/core/src/rules/line.ts resolvePush: for status protected or forbidden do NOT requeue the unpushed composition's ranges; instead set the line record's `waiting` (add a LineWaitingReason value, e.g. `line_refused`, in packages/contracts/src/v1/line.ts) whose detail names the branch and the remediation: allow the Nightshift GitHub App to bypass the branch's protection (for forbidden, keep the permission wording from forbiddenDetail). lineHasWork must be false for a line held by a refusal, even with entries still queued or held, until the hold is released. The push is tried again exactly once when (a) a new landing appends a queue entry (appendQueueEntry) or (b) the line's existing retry path (find it: apps/api/src/runner/reconcile.ts or the line start path) runs: the held composition's push goes back to pending (or its ranges are requeued) once, and the waiting reason is cleared when it publishes. Update apps/api/src/runner/publisher.ts line path as needed. Do not edit apps/mcp/src/runner/line-owner.ts or packages/execution/src/line/compose.ts: job J5 makes the owner honour the hold; describe in your handoff exactly what record state signals the hold.
  depends on: nothing (starts at once)
  touches: packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, packages/contracts/src/v1/line.ts, apps/api/src/runner/publisher.ts, apps/api/src/runner/publisher*.test.ts, apps/api/src/runner/reconcile.ts
  - resolvePush with protected/forbidden leaves the queue unchanged and records waiting with the branch name and the bypass-protection remediation; unit tests in packages/core/src/rules/line.test.ts
  - lineHasWork is false for a line held by a refused push, including with queued and held entries present
  - a new queue entry, or the retry path, makes the refused push be attempted once more, and a second refusal holds again without looping; tests cover both
  - a successful publish clears the waiting reason
  - build, typecheck, lint and the touched tests pass

J4: A line run is created only after it is admitted. In apps/api/src/runner/line-run.ts the plane checks admission (org month ceiling, org concurrency, the line's self-started monthly cap, configuration) before it writes the Run and root ExecutionNode; a refusal records the line's waiting reason (as today) and leaves no run record. Factor the ceiling checks out of admitDispatch in apps/api/src/operations/dispatch.ts so they can run without a run, keeping admitDispatch's behaviour for ordinary dispatches unchanged.
  depends on: nothing (starts at once)
  touches: apps/api/src/runner/line-run.ts, apps/api/src/runner/line-run.test.ts, apps/api/src/operations/dispatch.ts, apps/api/src/operations/dispatch*.test.ts
  - line-run.test.ts proves a refused admission (each of monthly_cap, org_month_ceiling, org_concurrency) records waiting and leaves no run and no execution node in the stores
  - an admitted line run is created and dispatched as before
  - ordinary dispatch tests still pass unchanged
  - build, typecheck, lint and the touched tests pass

J5: The line owner honours a refused push and ends honestly. (a) In apps/mcp/src/runner/line-owner.ts (and packages/execution/src/line/compose.ts if needed), when the line record shows the push-refusal hold J3 introduced (read J3's handoff/the record schema), the owner's own hasWork/drain conditions stop composing: no new batch from leftover queued entries (including beyond MAX_LINE_BATCH_ENTRIES) or held repairs, and the owner idles out. (b) A line run that parked anything it took ends `failed`, its failure reason naming each parked range (program, upTo) and its cause; the evidence is run-scoped and durable: the settled line.parked events of this run (including chunked ones and those of a replacement owner of the same run, as the line report already reconstructs them), not the record's parked list, which is truncated at MAX_LINE_PARKED and emptied by requeue. (c) The line report (packages/core/src/report/) leads with the parked ranges, saying each waits for `nightshift line requeue`; keep that diff small, another strand edits report wording. Rebuild the idea of c798bd3, do not cherry-pick.
  depends on: J1, J3
  touches: apps/mcp/src/runner/line-owner.ts, apps/mcp/src/runner/line-owner.test.ts, packages/execution/src/line/compose.ts, packages/core/src/report/report.ts, packages/core/src/report/line-report.test.ts
  - line-owner.test.ts: with a refused push recorded and entries still queued and held, the owner composes nothing more and idles out
  - line-owner.test.ts: a run that parked a range completes failed with a reason naming it; a run that parked nothing succeeds; a replacement owner's parks count; parks beyond MAX_LINE_PARKED and parks requeued before completion still make the run fail and are named
  - line-report test proves Parked leads the report and names nightshift line requeue
  - build, typecheck, lint and the touched tests pass

J6: `nightshift line requeue [<program> | --all]` and a clearer `nightshift line status`. Rebuild (do not cherry-pick) commit 0443cd3: a core rule requeueParked in packages/core/src/rules/line.ts moves parked entries (all, or one program's) back to the queue with their repair count reset, unless already queued/held/batched/composed, recording on the record who asked and when; a user-only API route line.requeue (apps/api/src/operations/line.ts, handler.ts, persistence http routes, authorize.ts) applies it and starts a line run via startLineRun, refusing engine principals with 403; the CLI (apps/cli/src/cli.ts, apps/cli/src/commands/line.ts) adds `line requeue <program>|--all`. `nightshift line status` names the line program and the line branch's role (e.g. 'main, the branch work ships from') and how many parked ranges wait for requeue.
  depends on: J3, J4
  touches: packages/core/src/rules/line.ts, packages/core/src/rules/line.test.ts, packages/core/src/rules/authorize*.ts, packages/contracts/src/v1/line.ts, apps/api/src/operations/line.ts, apps/api/src/handler.ts, apps/api/src/handler-line.test.ts, packages/persistence/src/http/routes.ts, apps/cli/src/cli.ts, apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts
  - rule tests: requeue of all and of one program, repair counts reset, requester and time recorded, already-queued ranges not duplicated
  - API test: a user requeue moves entries and starts a line run; an engine principal is refused
  - CLI tests for requeue <program>, requeue --all, usage error with neither, and line status naming the line program and branch
  - build, typecheck, lint and the touched tests pass

J7: The line end-to-end test (test/src/line/line-e2e.test.ts) proves the new line: (1) a line on the repository's default branch composes landed ranges onto it; (2) a commit pushed directly to the line between batches is in the next batch's base and survives; (3) a protected line branch holds the line with the waiting reason and remediation, does not loop, and a new landing retries the push once. Remove or adapt any remaining e2e expectations of the main merge. Then run every final gate and fix whatever fails, wherever: npm run build, npm run typecheck, npm run lint, npm run test, npm --workspace @nightshift/cdk run synth, npm run check:sterility.
  depends on: J1, J2, J3, J4, J5, J6
  touches: test/src/line/line-e2e.test.ts, test/src/line/**, any file a final gate failure requires
  - the three scenarios exist as tests in line-e2e.test.ts and pass
  - no e2e expectation mentions merging main into the line
  - npm run build, typecheck, lint, test, npm --workspace @nightshift/cdk run synth and npm run check:sterility all pass. Revised per review: J5 now owns the owner's honouring of the refused-push hold (depends on J1 and J3) with tests for leftover queued/held work, and its failed-run evidence is the run's settled line.parked events, not the truncated/requeue-emptied record list. J7 runs all six final gates and fixes failures. Parallel: J1-J4 at once; J5 after J1+J3; J6 after J3+J4 (shared core rules/contracts line files, startLineRun); J5 and J6 touch disjoint files and run together; J7 last.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 2 of 2 — sound (`dec_01M74EN44BTA558H591ZZNPAK1`)
  Chose: The revised split covers all nine acceptance criteria and gives the coupled composer, refusal-hold, and owner changes a workable integration order. The initial jobs have separate implementation surfaces, J5 and J6 can proceed together after their dependencies, and J7 owns the end-to-end scenarios and all six final gates.. An independent examiner reviewed decision dec_01M74EKGD7PM3BXP4JAPP4F43J against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** Fix round 1, F-01: the composer collapses several queued heads of one program into one range ending at their descendant, so a report that matches a published head only against a range's upTo misses heads that were composed inside a coalesced range. (`dec_01M74FYP5VV3K3N1W3KXHFDFWH`)
  Chose: Add an optional `covers` list of queued entry heads to LineRange (and carry it on queue/held entries made from a range). compose.ts records every entry head a grouped range subsumes, and the report treats a published head as reached when it equals upTo or is in covers. Records written before this change keep exact upTo matching. This touches packages/contracts and packages/execution/src/line (S-01's area), additively.. This is durable evidence written where the coalescing happens, so it is exact and never attributes another run's work. The change is small and backwards compatible (the field is optional).
  Weighed: Infer coverage in the report from publish order or timestamps, with no contract change, rejected because The report has no git ancestry, and ordering by time can attribute unrelated runs' work; it is not durable evidence
  Weighed: Run git ancestry checks while gathering the report, rejected because The report gathers from stores only and has no checkout
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Landing fix round 1: the program head (S-02, commit 402cb58 and its parents on program/p25-the-line-is-where-work-ships) inserted two `covers` tests in test/src/execution/line-compose.test.ts right after the 'composes a batch that is clean and green and goes idle' test, exactly where this strand's J1 inserted 'takes a commit pushed straight to the line between batches into the next base'. (`dec_01M74GVXMEZ3CC7Q00RWMJW1FV`)
  Chose: One low-risk job moves J1's direct-push test to the end of the 'the line composer' describe block, unchanged, so the two sides' insertions no longer overlap and git merges them.. This is the only conflicting file. The other overlaps (compose.ts, rules/line.ts, contracts/v1/line.ts) merged cleanly, according to Nightshift's report.
  Weighed: Copy S-02's covers tests into this strand's file as well, rejected because both sides would still add different text at the same insertion point, so the merge would conflict again, and the program head's covers code is not on this branch, so the tests would fail here
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Fix round 2, finding F-01. Under D-02 a naming program's baseBranch is the line, and lineProgramContract copies that base. So a line program whose line branch is absent has baseBranch equal to its programBranch, and the plane's fallback (lineBaseSha, assertGithubInput) asks GitHub for the same missing branch. (`dec_01M74HBZ673G0Q19VDV36RWZ4F`)
  Chose: Add defaultBranch(installationId, repository) to the GitHub port (GET /repos/{repo}, default_branch) with fakes. When the line ref is absent, lineBaseSha and assertGithubInput fall back to the head of the repository's actual default branch rather than the contract's baseBranch. The line program's baseBranch stays a copy of the naming contract's base (now the line), and nothing reads it for the fallback.. Acceptance 1 says an absent line is created from the repository's default branch head, and GitHub is the authority on which branch that is. The owner already reads the default branch from origin on its machine, so the plane and the owner then agree.
  Weighed: Have lineProgramContract keep a separately configured default branch (a new line config field), rejected because it adds configuration the plan never asked for, and it can drift from GitHub's actual default branch
  Weighed: Hard-code 'main' as the fallback, rejected because it is wrong for repositories whose default branch has another name
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Fix round 3, F-01: the plan text says "a new landing or the line's existing retry path tries the push again once". The examiner showed the existing user retry (publication.retry, used by `nightshift land`) never touched the line record. (`dec_01M74JKR5DYEC3E36YRAKRYJ18`)
  Chose: publication.retry on the line program's run releases a refused line push once and asks the publisher to push it. line.requeue on a refusal-held line with nothing parked releases the push and starts the line run instead of refusing nothing_parked. The waiting remediation names both commands. For F-02, a new LineWaitingReason, org_run_ceiling, covers the per-run refusals (tier, hours, run cap), which none of the existing reasons fit.. This uses the retry commands people already have, adds no new command, and covers acceptance 3 and 4 as the examiner read them.
  Weighed: Add a new `nightshift line retry` command, rejected because the plan asks for the existing retry path, and requeue is already the user's line operation
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** The arbiter's ruling on finding F-01 of examination exam_01M74JZNZHQ6DA3X42719HVH72. (`dec_01M74K74WRCD31FM1F6BGHMEJJ`)
  Chose: uphold. The finding is right on every piece of evidence, and the gap matters as stated. Checked in the checkout: `land` resolves its program through `findProgram` with `use: "ratified"` (apps/cli/src/commands/land.ts:167-173), which requires a draft or committed plan import (program-source.ts:195-208); a plane-created line program has neither, and `land` never branches on `isLineProgram` anywhere. Even past that, `land` calls `republishRun` only when `unpublishedOf(newest)` is non-empty (land.ts:222), and `republishRun` returns "nothing" before sending publication.retry when the run's intents are empty (republish.ts:68-69). A refused line push lives on the line record, not on dispatch intents, so neither condition is ever met. The second fix wired publication.retry on the API (operations/publication.ts) and tested it by calling the route directly (line-e2e.test.ts:1395, handler-line.test.ts), but nothing reaches that route from the CLI for a line.

It matters because the work itself advertises the broken path as the remediation a human reads: `refusalDetail` in packages/core/src/rules/line.ts:587 and the `line status` hint in apps/cli/src/commands/line.ts:147 both tell the person to "run `nightshift land` for the line program". A person who follows that instruction gets a usage error. Acceptance criterion 3 names "the line's existing retry path", and the existing retry path for a refused publication is `nightshift land` (republish through publication.retry); the API half of it is now released but the user-facing half is not connected. `nightshift line requeue --all` does work and is the right primary advice, but a product string that names a command that cannot work for the case it describes should not land, and after two fixes the CLI path still is not exercised by any test.

The fix is narrow: either make `land` resolve the line program (by the project's line branch, not a directory name) and send publication.retry then poll the line's push when the line is held, with a CLI test that has no parked entries and no new landing; or, if the owner accepts requeue as the sole user retry, remove `nightshift land` from both remediation strings so they do not promise a path that does not exist.
  Weighed: overturn, rejected because the arbiter chose to uphold
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** The arbiter's ruling on finding F-02 of examination exam_01M74JZNZHQ6DA3X42719HVH72. (`dec_01M74KAXPNCHRAVX03M4Z49DPV`)
  Chose: uphold. The finding is correct as stated and the code in this checkout still has the defect.

Mechanism, verified in the code: postLineRequeue (apps/api/src/operations/line.ts:642-652) releases the refused push to pending and awaits askPublisher. It then calls startLineRun (line 668). The first thing startLineRun does (apps/api/src/runner/line-run.ts:52-57) is run releaseRefusedPush on whatever the line record now holds, unconditionally. If the publisher has already settled the retried push as protected or forbidden by then, that second release puts it back to pending.

The window is real, not theoretical. In the local control plane and the e2e wiring (test/src/line/line-e2e.test.ts:384-386) publishLine is awaited synchronously, so the refusal is always recorded before startLineRun runs. In the deployed plane the publisher is invoked with InvocationType "Event" (apps/api/src/lambda/api.ts:111-118), so it is a race against the store reads between askPublisher and startLineRun, but the same write exists on the same path.

A re-pended push is a second attempt, not a harmless status flip: reconcileLinesWithWork asks the publisher for every pending push (apps/api/src/runner/reconcile.ts:121), and lineHasWork counts a pending push as work. So one requeue request can push against the protected branch twice, which breaks acceptance 3 and the contract's "tries the push again once".

Why the existing tests miss it: the handler test's fake publishLine only records the branch name and never settles the push (apps/api/src/handler-line.test.ts:83), so after the first release the push is still pending, lineHeldByRefusal is false, and startLineRun's release is a no-op. No e2e test exercises line.requeue on a refused line.

The startup release in startLineRun is also redundant everywhere else: its callers are postLineRequeue (which already released), publishAll on a landing (where appendQueueEntry already released), and the reconciler (which never sees a refused line because lineHasWork excludes it). Removing the release from startLineRun, keeping it at the landing, publication.retry and requeue boundaries, and adding the test the examiner asked for (publisher settles protected before postLineRequeue continues; assert status stays protected with one attempt) resolves the finding.
  Weighed: overturn, rejected because the arbiter chose to uphold
  Reversible.
  Produced: nothing that landed.
- **Run:** S-01 failed examination on its fourth attempt: an arbiter upheld two findings. (F-01) `nightshift land` cannot retry a refused line-only push. (F-02) `line requeue` can release a refused push twice. job.wait reported 'continuing' (Nightshift would start the attempt carrying out the ruling), but for ~4 minutes no attempt started, no process ran, and the activity log showed 'S-01 parked (failed)'. (`dec_01M74KKQDD0A4DW16CYEEJKP96`)
  Chose: Retried S-01 with job.retry (retry 1 of the allowed 2).. The failure reason is one a further attempt can fix: two specific findings with clear remedies. The automatic continuation appeared stalled.
  Weighed: Keep waiting on the 'continuing' signal, rejected because No attempt, process or activity appeared for ~4 minutes, and the activity log already called the strand parked; waiting longer risked waiting forever.
  Weighed: Leave S-01 parked and finish the run as failed, rejected because Both findings are concrete, bounded defects with prescribed fixes; a second attempt from the current code can fix them, and the orchestrator never said the objective cannot be met.
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 3 — 2 jobs, 2 starting at once (`dec_01M74KMK8N96NVD83HBE1KV22T`)
  Chose: J1: Carry out F-01: make nightshift land resolve the plane-created line program by the project's line branch, retry and poll its line push without dispatch intents or a planned draft.
  depends on: nothing (starts at once)
  touches: apps/cli/src/commands/land.ts, apps/cli/src/commands/republish.ts, apps/cli/src/program-source.ts, test/src/cli/**, test/src/line/line-e2e.test.ts
  - Actual CLI regression invokes land for a held line program with no draft, no dispatch publication intents, no parked entries and no new landing; it sends publication.retry once and observes the line push settling.
  - Resolve from project line branch rather than a directory name; preserve ordinary program land behavior and --run handling.
  - Cover successful retry, repeated protected/forbidden refusal and pending timeout behavior with honest command output/status; run relevant CLI tests.

J2: Carry out F-02: remove refusal release from generic startLineRun, keeping release only at explicit landing/retry/requeue boundaries, and prove a synchronous requeue retry cannot be released twice.
  depends on: nothing (starts at once)
  touches: apps/api/src/runner/line-run.ts, apps/api/src/handler-line.test.ts, apps/api/src/operations/line.ts
  - Generic startLineRun never releases a fresh protected or forbidden push.
  - A regression publisher settles protected/forbidden before postLineRequeue continues; final line push remains refused, not pending, and only one publication attempt occurs.
  - Exercise naming/startup path so test would fail on the previous unconditional release, retain landing/publication.retry releases, and run relevant API tests.. Both upheld rulings are narrow corrections to earlier merged work. CLI resolution/polling and generic API startup are independent with disjoint test files, so both run immediately. Publisher refusal behavior is high risk. After both merge, run build/typecheck/lint/test/synth/sterility and delegate any necessary repairs; no changes to program contracts or S-02 documentation.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 4 — 1 job, 1 starting at once (`dec_01M74KW1HKGF0FFAP7ZBN1EX6D`)
  Chose: J3: Finish J1's --run acceptance: the line-only land path must not silently ignore an explicit --run. Validate it against the line view's current retry run before any publication.retry and report a usage error for a mismatch; matching run continues normally. Add CLI regressions.
  depends on: nothing (starts at once)
  touches: apps/cli/src/commands/land.ts, apps/cli/src/commands/land-line.ts, apps/cli/src/commands/line.test.ts
  - Explicit matching --run retries the current held line once.
  - Explicit different --run produces a clear error and no publication.retry; ordinary land unaffected.
  - Relevant CLI tests, build/typecheck/lint pass.. Review of merged J1 found its new early line return did not pass options.run. This is a small completion of its stated acceptance; J1 and J2 have merged, so this job has no in-flight dependency.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.

## Usage

Token counts are what each harness reported and are not comparable across harnesses.
A cost marked * is estimated from the price table, not reported by the harness. A cost
that is unknown had neither: give the org's price table a price for that model to estimate it.
Each attempt counts one figure in the cost column (reported when it has one, else estimated). The
Reported and Estimated columns split that by kind; provider-reported dollars are never summed with
an API-equivalent estimate.

| Harness | Model | For | Routes | Input tokens | Output tokens | Cost per attempt (USD) | Reported (n: USD) | Estimated (n: USD) | Basis |
|---|---|---|---|---|---|---|---|---|---|
| claude | claude-opus-5-5 | work | 6 | 12001723 | 64670 | 5.29 | 6: $5.29 | none | provider-reported; 6 of 6 attempts valued |
| codex | gpt-6-astra | examine | 9 | 4209308 | 14057 | unknown | none | none | unknown; 0 of 9 attempts valued |
| claude | claude-fable-5-1 | arbitrate | 2 | 1326261 | 9418 | 4.06 | 2: $4.06 | none | provider-reported; 2 of 2 attempts valued |
| codex | gpt-6-astra | work | 1 | 1239642 | 3671 | unknown | none | none | unknown; 0 of 1 attempts valued |
| claude | claude-opus-5-5 | examine | 1 | 486038 | 1827 | 0.69 | 1: $0.69 | none | provider-reported; 1 of 1 attempts valued |
| claude | claude-sonnet-5-5 | work | 18 | 13473031 | 143913 | 6.76 | 18: $6.76 | none | provider-reported; 18 of 18 attempts valued |
| claude | claude-opus-5-5 | root | 1 | 13143620 | 14104 | 4.46 | 1: $4.46 | none | provider-reported; 1 of 1 attempts valued |

## Where the time went

Elapsed not observed (as of 2026-11-11T06:22:54.355Z); elapsed is the run's window and phase figures below are interval unions. Peak concurrency 6.

- **summed work (overlapping; not elapsed):** 2h 41m, each closed work interval counted in full

- **By phase (union, counted once):** work 1h 00m, wait 19m 52s, queue 3m 53s, integration 50m 05s, examination 14m 09s, setup 2m 33s, startup 2m 53s, verification 37m 19s
- **Wait by blocker kind:** parent_slot 5m 48s, job 19m 26s
- **Unattributed:** not observed. **Ambiguous (open or incomplete, in no union):** 1h 45m
- **Endings:** integrated 2, merged 18, integration conflict 1, verification failed 0, failed 0, deferred 0, examination stopped 4, examination skipped 0, other 0

Observed chain (not a claim about a faster schedule): covers 1h 39m of not observed, coverage not observed, complete; 0 ambiguous step(s).

1. node_01M74ECFVP71X1TBES89R3FG39 integration 2026-11-11T06:15:43.575Z to 2026-11-11T06:22:45.030Z (7m 01s, via end)
1. node_01M74ECFVP71X1TBES89R3FG39 work 2026-11-11T06:09:29.422Z to 2026-11-11T06:15:42.910Z (6m 13s, via work)
1. node_01M74ECFVP71X1TBES89R3FG39 startup 2026-11-11T06:09:28.501Z to 2026-11-11T06:09:29.422Z (0.9s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 wait 2026-11-11T06:09:28.360Z to 2026-11-11T06:09:28.501Z (0.1s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 integration 2026-11-11T05:52:20.283Z to 2026-11-11T06:05:04.003Z (12m 44s, via retry)
1. node_01M74ECFVP71X1TBES89R3FG39 work 2026-11-11T05:42:39.187Z to 2026-11-11T05:52:19.797Z (9m 41s, via work)
1. node_01M74ECFVP71X1TBES89R3FG39 startup 2026-11-11T05:42:38.348Z to 2026-11-11T05:42:39.187Z (0.8s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 wait 2026-11-11T05:42:38.222Z to 2026-11-11T05:42:38.348Z (0.1s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 integration 2026-11-11T05:34:34.687Z to 2026-11-11T05:42:37.495Z (8m 03s, via retry)
1. node_01M74ECFVP71X1TBES89R3FG39 work 2026-11-11T05:29:58.373Z to 2026-11-11T05:34:34.236Z (4m 36s, via work)
1. node_01M74ECFVP71X1TBES89R3FG39 startup 2026-11-11T05:29:57.413Z to 2026-11-11T05:29:58.373Z (1.0s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 wait 2026-11-11T05:29:57.220Z to 2026-11-11T05:29:57.412Z (0.2s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 integration 2026-11-11T05:22:28.212Z to 2026-11-11T05:29:56.461Z (7m 28s, via retry)
1. node_01M74ECFVP71X1TBES89R3FG39 work 2026-11-11T05:21:04.874Z to 2026-11-11T05:22:27.786Z (1m 23s, via work)
1. node_01M74ECFVP71X1TBES89R3FG39 startup 2026-11-11T05:21:04.159Z to 2026-11-11T05:21:04.873Z (0.7s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 wait 2026-11-11T05:21:04.004Z to 2026-11-11T05:21:04.159Z (0.2s, via attempt)
1. node_01M74ECFVP71X1TBES89R3FG39 integration 2026-11-11T05:21:03.159Z to 2026-11-11T05:21:03.303Z (0.1s, via retry)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 integration 2026-11-11T05:13:58.876Z to 2026-11-11T05:21:03.138Z (7m 04s, via queue_order)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 work 2026-11-11T05:05:10.693Z to 2026-11-11T05:13:58.450Z (8m 48s, via work)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 startup 2026-11-11T05:05:09.983Z to 2026-11-11T05:05:10.693Z (0.7s, via attempt)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 wait 2026-11-11T05:05:09.869Z to 2026-11-11T05:05:09.983Z (0.1s, via attempt)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 integration 2026-11-11T04:57:32.725Z to 2026-11-11T05:05:09.164Z (7m 36s, via retry)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 work 2026-11-11T04:38:32.050Z to 2026-11-11T04:57:32.258Z (19m 00s, via work)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 startup 2026-11-11T04:38:24.090Z to 2026-11-11T04:38:32.049Z (8.0s, via attempt)
1. node_01M74ECR91PC05296ZQZ3C9PJ2 wait 2026-11-11T04:38:23.938Z to 2026-11-11T04:38:24.090Z (0.2s, via attempt)

## Delivery

18 work item(s) and 0 repair job(s) in 2 strand(s); 18 attempt(s), 12 helper call(s).

- **First-attempt success:** all jobs: 18/18 (100%), 0 unfinished; coverage complete
- **Excluding repair jobs:** jobs: 18/18 (100%), 0 unfinished
- **Outcomes:** landed 18; failed by none
- **Rework:** 0 attempt(s), each counted once
  - unknown cause: 0 attempt(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
- **First attempts:** input 13473031, output 143913 tokens (complete coverage: complete 18); estimated not observed, reported $6.76 (provider-reported)
- **All rework:** input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed

## Human verdict

A person's one-click verdict on whether the run worked. It is not a verification and says nothing about why.

- Verdict: **not rated**
- This program: 0 of 0 ended run(s) rated; 0 worked, 0 did not; positive share among rated n/a; 0 unrated.

## Review

- **Coverage:** 2 node(s) examined, 18 examined by strand, 0 landed unexamined, 0 skipped; 6 examination(s) (passed 2, findings_raised 4)
- **Dispositions:** 6 unique finding(s); latest fixed 4, upheld 2; rulings upheld 2. fixed means the finding was not raised again; upheld means the arbiter agreed. Neither is independently established truth.
- **Overhead by role (apart from repairs):**
  - examiner: 6 call(s); input 3565305, output 11640 tokens (partial coverage: complete 1, partial 5); estimated not observed, reported $0.69 (provider-reported); 5 unpriced
  - answerer: 0 call(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
  - arbiter: 2 call(s); input 1326261, output 9418 tokens (complete coverage: complete 2); estimated not observed, reported $4.06 (provider-reported)
  - plan review: 4 call(s); input 1130041, output 4244 tokens (partial coverage: partial 4); estimated not observed, reported not observed; 4 unpriced
- **Repairs caused by review:** 4 attempt(s); input 5430352, output 21926 tokens (partial coverage: partial 4); estimated not observed, reported $1.54 (provider-reported); 1 unpriced
- **Linkage:** findings linked 6; 0 helper call(s) unlinked; 0 repair(s) without findings

## Machine

- **Lifetime:** not observed (coverage unknown; 0 observed ending(s), 0 runner-only ending(s); last machine ending not observed, last runner ending not observed; 1 attempt(s) without an observed end; gaps between attempts 0.0s)
  - attempt 1 (dispatch): machine end unobserved, runner not ended
- **Instance:** $0.79 for 6421s (runner-metered 6421s), runner-metered seconds; machine end unobserved (lower bound) (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2; unknown)
- **Volume:** $0.02 for 6423.015s, open (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2)
- **Total:** $0.81 (Instance: 6421 s from runner-metered seconds; machine end unobserved (lower bound) at 0.44352 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2); volume: 6423.015 s from request to asOf (not yet deleted) at 0.010958904109589041 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2).)
- **Recorded spend:** {"estimatedUsd":10.907493698630137,"ceilingSeconds":86400,"meteredUsd":0.8106136231354643,"meteredSeconds":6421}; computed $0.81 against metered $0.81 over 6421s (computedUsd prices instance and volume together over spend.meteredSeconds, as meteredUsd does; the components above use each one's own observed lifetime.)
- **Occupancy:** coverage partial; busy 0.0s at least, idle not claimed (No attempt has an observed machine end (terminatedAt), so idle time is not claimed; busy time is observed busy time, at least.), provisioning 1m 55s, setup not observed; peak 0 concurrent occupant(s)
- **Per-node shares:** none. No attempt has an observed machine end (terminatedAt), so cost cannot be apportioned to nodes. Each observed-closed attempt costs its observed machine lifetime (terminatedAt - startedAt) at the instance rate, split by occupied time within that same window (concurrent occupants share each moment equally). The cost of attempts without an observed machine end (open, or machine end unobserved) is never apportioned and is listed per attempt, together with unoccupied time within closed attempts and the whole volume, as unapportioned.

## Request evidence

Per-request ledgers are stored as artifacts. Fetch one through the authorized download route:
operation `artifact.createDownloadUrl`, `POST .../artifacts/{artifactId}/download-url`.

| Attempt | Artifacts | Ids |
|---|---|---|
| node_01M74ECFVP71X1TBES89R3FG39 work #1 | 30 | art_01M74EENP85E1QC80CM5YNKFGP, art_01M74EGV1KSR5V253KWJ08GN85, art_01M74ENSA0KWPMDTQ1JG0TCDYC, art_01M74EQQJ7SM1TX6FMKS1DEBFA, art_01M74ET9WTDFZEANN7CY1P1QNA, art_01M74EWA1R15MPCJ3NWVTE6770, art_01M74EZ1Y9GSEAA4E4XPVKNQ4P, art_01M74F1MBBM3F5HBJEDQQGBB15, art_01M74F3MDV3WEDCP2RENFS6WJF, art_01M74F6ASCYQN0TAC89MBTC1AT, art_01M74F86XBC8G4NHE1HQVYSA3M, art_01M74FAYSWTQ852N75FKW28S9G, art_01M74FDECKEDM8NGZD9GG7GHEC, art_01M74FFH9FJV5TFWSKAF801140, art_01M74FJ95ZS6QWDQQF3RA1876X, art_01M74FMKYWGHPMTBXGQ9RE2NR4, art_01M74FPFHHQ22SBYMDWDSEBSMA, art_01M74FRP8JV7T2NVKG5GKPRMRA, art_01M74FVE54FE22C2WZG9ZBZKF8, art_01M74FXG6HVY88R04KM0FRA6WK, art_01M74G00MQ3H0288A019VF9PC7, art_01M74G2RH73VS6T08RE0P191NG, art_01M74G4RPDDPW0KECBBACZSWVN, art_01M74G7B0RGBF1TAPWR1TRFYJR, art_01M74G9YRH4Y79EYA8DCPJ7NP3, art_01M74GBXG9NMQ5MFBMVT2WPB76, art_01M74GEND9DQP4M5ZZGGQXM470, art_01M74GGWFT16M47KW8M28QB4X1, art_01M74GK3SPRG3JVMDV3SKESMTT, art_01M74GKRAHEGDM2N6KQAHKTC1Z |
| node_01M74ECFVP71X1TBES89R3FG39 examine #1 | 1 | art_01M74EJD6SMJ2A3K730MY8S88V |
| node_01M74ECFVP71X1TBES89R3FG39 examine #1 | 1 | art_01M74EN3WV4ENZ2GE7HEZPRA0H |
| node_01M74ECFVP71X1TBES89R3FG39 work #2 | 2 | art_01M74GX2PAVJCR50YEGHJYY1FC, art_01M74GXEH64XPVGZDH0D0Y23XC |
| node_01M74ECFVP71X1TBES89R3FG39 examine #1 | 2 | art_01M74HB31EK4W2K2SVQJZP0QBD, art_01M74HB3FYGB79V78TQN25YAZN |
| node_01M74ECFVP71X1TBES89R3FG39 work #3 | 4 | art_01M74HDY0DS0D8RMWV356WQJAV, art_01M74HGNWZDXX6CW63MKMWH7JV, art_01M74HJGSA3Z8R90RG269QNN8Z, art_01M74HKKZESMQK3085X12Z9KRA |
| node_01M74ECFVP71X1TBES89R3FG39 examine #1 | 2 | art_01M74J1Y0BXZJ81A4CMJDTGASV, art_01M74J2AMEQ5SMV67Q378V7NY2 |
| node_01M74ECFVP71X1TBES89R3FG39 work #4 | 5 | art_01M74J552G1ZPEHKRE60WV8V9Z, art_01M74J7T7JMGN4C1P6AYMCNW7B, art_01M74J9QJCD19RPEEQ5WWHPYX0, art_01M74JKY0FAXDEEVZ9610D88N3, art_01M74JM4GV3VE1R97F2TYPN76A |
| node_01M74ECFVP71X1TBES89R3FG39 examine #1 | 2 | art_01M74K2E8KE86YG0VA6XQCYMV1, art_01M74K3VSMT7280H5KA3C1ARBQ |
| node_01M74ECFVP71X1TBES89R3FG39 arbitrate #1 | 2 | art_01M74K6C0E5FTFX0GNQPRBXVFR, art_01M74K7M5CYE2PRDTKBN4YTQA5 |
| node_01M74ECFVP71X1TBES89R3FG39 arbitrate #1 | 2 | art_01M74K9RMBWNJ2FCH0MZY4HK39, art_01M74KBDG2AH5S1ANP5CNHB18S |
| node_01M74ECFVP71X1TBES89R3FG39 work #5 | 2 | art_01M74KP9BCTFDPH1JTAQHDG1RK, art_01M74KYYS86AWR0BKFHE8KAHBH |
| node_01M74ECFVP71X1TBES89R3FG39 examine #1 | 1 | art_01M74MBRGPZE94FDAVSNEK1NSJ |
| node_01M74ECR91PC05296ZQZ3C9PJ2 work #1 | 16 | art_01M74EF1SY0HWTV64ZY3THABK2, art_01M74EHB2AE19RN6EV0PYYJCZC, art_01M74EKD4MJ10T4HKSQAMKR5XB, art_01M74ENTN88QSNCX5VJVRHENJ5, art_01M74EQZKZKSXN8HETGPWH8J7J, art_01M74ETQGFT7H1H42WCWE3G3KK, art_01M74EWSC6FHM8D1P5QQW57H4C, art_01M74EZA023KHFKEKE2G2RMBPM, art_01M74F20E5GE85ZRA6JZKR61AB, art_01M74F3WFN2CAQQK957X8HTE62, art_01M74F6MC4WKZ3HMHW3R5AY0Q8, art_01M74F904RS9W0KW73J9X51PYR, art_01M74FB6VMH14XFWQ17JMGH90K, art_01M74FDYR9KKKN7CD0WE87K2J5, art_01M74FFSV4KYYC2XPJ74TAFPS6, art_01M74FFT1QN1SP2P8Z4T7T4ZGX |
| node_01M74ECR91PC05296ZQZ3C9PJ2 examine #1 | 1 | art_01M74EGKQXQ2NJH705MYPMZ475 |
| node_01M74ECR91PC05296ZQZ3C9PJ2 examine #1 | 1 | art_01M74EJ59WHT6R50WMCYJ0EAEB |
| node_01M74ECR91PC05296ZQZ3C9PJ2 examine #1 | 2 | art_01M74FXPR9R31VWRZRGVDJ3D1A, art_01M74FXQ3B7EDZ2ESKJVNHH25A |
| node_01M74ECR91PC05296ZQZ3C9PJ2 work #2 | 7 | art_01M74G0H8V59VHX81ERBMP9H0E, art_01M74G2YM7QHX0VPHGRYC5VXRG, art_01M74G53REE71DE7P8FR50VZFE, art_01M74G7VMYA6RQKE4C3FEEJJPW, art_01M74G9XBD5REF0JGVQHVB3KB8, art_01M74GCE4FRSRVKES4Y1VDCT32, art_01M74GDX3CJXE2ZRTBHYBNHF77 |
| node_01M74ECR91PC05296ZQZ3C9PJ2 examine #1 | 1 | art_01M74GTSG1R113Z2SA9SCR1H9W |
| node_01M74EJFFTCA3YGP8QY5AM8VGG work #1 | 1 | art_01M74EKPZFD4YFTXPFVCMXK3VR |
| node_01M74EJPDNBRTPQ84WB7HX3EWK work #1 | 4 | art_01M74EMXB6X5YQZ4PW2KBNXKA8, art_01M74EQJ4Z7E1J88RHFPYWCF2E, art_01M74F4CA58HBEB802V9BW5DYK, art_01M74FEXH4RD5537ZGMXJVG38V |
| node_01M74ENB6WAN21Q2GB417Z9K3X work #1 | 2 | art_01M74EQYC2Q9GMX3MAMD0C8PHK, art_01M74ER41XCMEHEPTZYRKG3H82 |
| node_01M74ENF9KW85XQM7WJ9MCR4AK work #1 | 1 | art_01M74ER0C7HQDJYH23DW6XV4W0 |
| node_01M74ENMHBHQNEW6P0FWH2A9GJ work #1 | 2 | art_01M74ET3X69WAW25ZPKGA0MZDQ, art_01M74EVXMWGAZ00M2TDYN1PRW4 |
| node_01M74ENQMRJZZG0QKCAYTWRH6R work #1 | 2 | art_01M74ETF78RBCCHG0QZFGVB1TD, art_01M74ETMGM7JMF58W5FA9J6ZGQ |
| node_01M74ENYX2FSG4QY0YH72XCNQ2 work #1 | 4 | art_01M74EY1VVB7QSR2NHRJWJ6HW9, art_01M74EZXENHM38Y3SE09H5RTQR, art_01M74F21VV2XB2NTHNQXA1DQQ4, art_01M74F2M5NZBH07KSVF986NRJA |
| node_01M74EP412PRHHEPN36FM8AWBN work #1 | 6 | art_01M74EY8XTBB697CTENHCBAVZS, art_01M74F07EQV5GC0BX26N6C7S6D, art_01M74F2V88G2EW4S5PKFPY2QVN, art_01M74FDTTCH28DSC5F7H0SXX81, art_01M74FQFRYVXZXQXXG17MMQPD5, art_01M74FQPJFMYDH2V4A3688AQ12 |
| node_01M74EP9N315HF2X9NZFMVSXXH work #1 | 8 | art_01M74FT6PGF49ES39NMRGTG0S2, art_01M74FWHPF7E4M7QQYEYAT5T5N, art_01M74FZ20VEEJM34HP4QQ2N7FQ, art_01M74G3W2DZC6A0HB2PANTCQQ6, art_01M74G5PZ8JA40V7ZH1P7PSZ9D, art_01M74G8EHX3AQRW01YQ5YE884F, art_01M74GJGTGS3AX3W6EGSMTXM7D, art_01M74GJYRCBDT28A3XE0H05D61 |
| node_01M74FZ1TGPY1CHME6M99YJXJ9 work #1 | 2 | art_01M74G21TKVXWZ21WCBS7RDNHW, art_01M74GCE2SFBBZ6MH2DZ4T0WMK |
| node_01M74GW10YXEWAWTVTH592VH33 work #1 | 1 | art_01M74GWX3CB81FR91ZT4MFV6DP |
| node_01M74HC6Z34718FG1HN483H7Y0 work #1 | 2 | art_01M74HEBS3P5TMG7G1B5H4VP2B, art_01M74HESF6W3DR0D0W08AP507B |
| node_01M74HCMKA4134F5SQTG702R7N work #1 | 2 | art_01M74HH12YHFWFV6AXKWM97VPJ, art_01M74HJ49Q6F4FPGP52ARN9QS8 |
| node_01M74J379V6PP8H3AWZQ0MMAZJ work #1 | 3 | art_01M74J5BM8057JVTMRKBY66P6H, art_01M74J7G0GBFPQK917C8ATTJHZ, art_01M74J8AZ46M4RDPDH1134PB4M |
| node_01M74J3EAPS6FZ6S7KR623MCES work #1 | 2 | art_01M74J5Q1FC4GBF3X750VJ1TC7, art_01M74J5WJHAWPY1EBCMEBDSHSK |
| node_01M74KN89VJBR38Z75N4X4DGG4 work #1 | 3 | art_01M74KQNX16GTW8BPHY6CB9XMK, art_01M74KT2T6GC10RTVZS9D0N4P7, art_01M74KTSSXQ1M0XWN2S3HZ3AQF |
| node_01M74KN8JBHMYN1G7CCYBDTM4N work #1 | 1 | art_01M74KQGPAAPN2TGZRFA8V8AZK |
| node_01M74KW1QW0PQY4ZGNSP26M0GQ work #1 | 1 | art_01M74KXAK37XRQC9BW8ZNA06J5 |
| node_01M74E826Z5340G2265FTXGQBH root #1 | 80 | art_01M74EECY3GTWEXB0H744J38Z7, art_01M74EGTBRV21P98BKGP84F7HG, art_01M74EJZDM7C9HCB0VGGREH2K5, art_01M74ENQAFNRCQJTNYJQY7NS1T, art_01M74EQX58WC1NGG88GCZTT6QE, art_01M74ET9SNSR0NQSWFVY5Z2MT5, art_01M74EX1P6M245Y6H3F68R8KE6, art_01M74EYZY7TJPGZSF9RRF84PE9, art_01M74F1M5S8TEPW1M52DYM56HY, art_01M74F4B16MRBA3Q3J1V1TRY7S, art_01M74F66N9P2RKH5VAR59YTS25, art_01M74F8YHTHV05MKEJZC57EJ8P, art_01M74FBDSQFFC9WPG9PA1CWVBQ, art_01M74FDH1KW50DTTHTG7VH59KS, art_01M74FG8XXDF5TRCER9Q8WB06D, art_01M74FJJHT5Q5FR6GPFDR7GFEP, art_01M74FMVDEEF86X9S2QX0SMX20, art_01M74FQK9Y3V864KMY1QEMB55E, art_01M74FSX48C7WYWZN1X88HQ6PJ, art_01M74FW5SGHPZJDKE0BGQZE6BK, art_01M74FYXP08DF9457KW3VWWYFA, art_01M74G14S3WXDHRP11H21JXKN9, art_01M74G30DQ935CXVQMQ5KD2NGE, art_01M74G5ARFWQN55E4FYCV5SKAS, art_01M74G82N0CYZ3T1ZKYBFGDXDX, art_01M74GA27P9NBE67SSK3XS9MBS, art_01M74GCN4MTWDSMHKS42VJK02F, art_01M74GFABT8XFHSS9X40DS7W16, art_01M74GH7M7B3K813P11GSB3DQK, art_01M74GKZGRW0VFSB2839D063QN, art_01M74GPF2H87EJ182WBQ9FR8J8, art_01M74GRJ0A7812CATSBEQDZ9SC, art_01M74GV0Q2CYYA8FH8C171P9S6, art_01M74GX4FWAPGQHDT2EXR5SQX4, art_01M74GZWCCQ5HZ841FJMT9B01T, art_01M74H23FK7ERTP5XTAX4X2SDD, art_01M74H4EVWPK7Y1CVC7FCKBXXW, art_01M74H76RE9VVK8BW5DEAWCRC7, art_01M74H986NJPPPGTHZMFPRSYYN, art_01M74HBS82Y0G2S69YS470KEH7, art_01M74HEH4MHSVKBFQ6BB5FEAHY, art_01M74HGCYF1MXEMG2CS45WHRJZ, art_01M74HK3M7QAKXZY45FXHH2T3S, art_01M74HNSZCCW8KM392EXTE4Y9D, art_01M74HQP3TPW3RT4TP309ASSRH, art_01M74HTE0BH5G9HPDF6Y2HNFRD, art_01M74HX2KA8TVDS3BNRKN1JJPY, art_01M74HZ0FXFZ5ZWP04MFDX884H, art_01M74J1RCGQJ16S3Y5JHC81NYZ, art_01M74J4A8PR3AXTTNKWNZ4T02Y, art_01M74J6AW1PP23GT7HTDF2Y49Y, art_01M74J92RMFQGFK1YVF1VC81RG, art_01M74JBA49RMJW1DVKX5YSTAT0, art_01M74JDN878682NBZY78E1YKN2, art_01M74JGD4T12DMR7EKBNCRKYS5, art_01M74JJ80608BXPW7JQK2Z1ABA, art_01M74JMZMSPY5W2126FMVC7K5B, art_01M74JQF559MJN2SSK0AXWB1BG, art_01M74JSJ3Z5SHPD2YHB40PC4YX, art_01M74JWA0GP2J6BF8XZJA6WYZJ, art_01M74JYD19RR8VT37P485H2Z7P, art_01M74K0WG3ZWX11CJ9B37HANHG, art_01M74K3K70A8CPW39HAC4Q2FW8, art_01M74K5EZMBNJ72GM83NMAEANG, art_01M74K86W64HCRGVPTB8ZEK1E2, art_01M74KAJ3B38BZ914E9ZFVWTEA, art_01M74KCSBR8E2VXY1RJ2M76GET, art_01M74KFH8DHX1Q4X7A6KBZJRMQ, art_01M74KHJXV5WY1Y1WWA4X45YYB, art_01M74KKJEZS1WW722RXK6C6XTH, art_01M74KNH0QD2HG17FQWM5FR0SH, art_01M74KQRY3TG7D3JH03MF77Q5E, art_01M74KTGTM1GH1YARWEZDPN18A, art_01M74KWEX9DTTT1RSSBSZ7A3AA, art_01M74KZ3AM1XA5VZKDJ0AYBBPT, art_01M74M1SZ295SFT4Z43K8K157Q, art_01M74M3NSR77VB6FHQGP3JN2S7, art_01M74M6DP82BCA04S1X5YY6VD6, art_01M74M90MN3VBFA2DK93VH0XMS, art_01M74MB05S6Z9PA056RAV3KG09 |

## Definitions

- **Active seconds** (`active_seconds`): Seconds during which something was executing for the run, as recorded by the control plane. Idle gaps are excluded. Denominator: Runs with recorded activity intervals.
- **Agent time** (`agent_time`): Harness execution time of an agent, from its start to its end. It excludes verification, queueing and integration. Denominator: Agents with both a recorded start and end.
- **API-equivalent estimate** (`api_equivalent_estimate`): An estimate of what the measured tokens would cost at a price table's list rates. It is an estimate from a price table, not a bill, and subscription or negotiated pricing may differ. Denominator: Attempts with a price-table entry for their model and measured tokens; others are unpriced.
- **Combined estimate** (`combined_estimate`): The model estimate plus the machine estimate. It is a lower bound when either part is incomplete. Denominator: Runs with both parts measured count fully; the rest are listed as incomplete.
- **Completion lead time** (`completion_lead_time`): Time from a story or goal being planned to its work being delivered, as recorded on a completion checkpoint. Denominator: Completion checkpoints whose members all have recorded times.
- **Coverage** (`coverage`): How completely an attempt's resources were observed: complete, partial, unknown, legacy (route figures only) or missing. Missing evidence is never shown as zero. Denominator: All attempts in the selected population, tallied by coverage class.
- **Delivered outcomes** (`delivered_outcomes`): Jobs whose work was verified and integrated, counted once each however many attempts it took. Denominator: All jobs in the selected population, delivered or not.
- **Elapsed completion time** (`elapsed_completion_time`): Wall-clock time from the start of the run or story to its completion, measured on the clock; overlapping work is counted once. Denominator: Completed runs or stories only; unfinished ones are excluded and counted in the sample size.
- **Examination time** (`examination_time`): Time examiners and the helper routes serving them (answering, arbitrating) spent on examinations of the work. Denominator: Examination routes with a recorded start and end.
- **Examiner dispositions** (`examiner_dispositions`): How examiners' findings were resolved: upheld, rejected, fixed or still open. Denominator: Findings raised in the selected population.
- **First-attempt success** (`first_attempt_success`): Delivered jobs whose first attempt (attempt 1) was verified and integrated without a later attempt. Association with rework is not causation. Denominator: Jobs that reached a terminal state in the selected population; jobs still running are not counted.
- **Human verdict** (`human_verdict`): The person's binary verdict on whether a run worked, captured with its attribution. It is separate from deterministic verification and does not change recorded outcomes. Denominator: Runs that received a verdict; unrated runs have none.
- **Infrastructure estimate** (`infrastructure_estimate`): An estimate of the machine expense of runs executed on Nightshift-provisioned machines, from their utilization and a rate table. Denominator: Runs with a machine report; local runs have none and are absent, not zero.
- **Integration time** (`integration_time`): Time spent integrating verified work onto its target branch, after verification passed. Denominator: Integrated jobs with recorded integration intervals.
- **Provider-reported cost** (`provider_reported_estimate`): The dollar figure the provider or harness itself reported, kept apart from the price-table estimate and never summed with it. It is an estimate of spend, not an invoice. Denominator: Attempts whose harness reported a cost; others are unpriced.
- **Queue time** (`queue_time`): Time verification requests waited for the verification queue before they started running. Denominator: Verifications in the selected population that recorded a queue phase.
- **Rating coverage** (`rating_coverage`): The share of completed runs that carry a human verdict. Denominator: Completed runs in the selected population.
- **Review overhead** (`review_overhead`): Resources and time spent by examination and arbitration routes, shown beside the work they reviewed. It is not a measure of review quality. Denominator: Helper routes in the selected population compared with all routes.
- **Rework attempts** (`rework_attempts`): Attempts made after a node's first attempt: escalations and retries of the same node's work. Association with other factors is not proof of causation. Denominator: Attempts of jobs in the selected population; the first attempt of each job is not rework.
- **Rework by cause** (`rework_by_cause`): Rework attempts grouped by the cause recorded when the attempt was made (for example verification failure or examiner finding). An attempt with several causes appears under each. Denominator: Rework attempts with a recorded cause; those without one are counted as unattributed.
- **Run completion time** (`run_completion_time`): Time from a run's start to its completion, measured on the clock. Denominator: Runs that completed.
- **Sample size** (`sample_size`): How many rows matched a filter and how many there were in all, so a figure is read against its population. Denominator: Matched rows out of all rows before filtering.
- **Settlement time** (`settlement_time`): Time from an attempt's start until its node settled, including verification, queue and integration. It is longer than agent time. Denominator: Routing decisions that recorded a wall-clock figure.
- **Summed work time** (`summed_work_time`): The sum of every attempt's working time. It is not elapsed time: work overlaps, so the sum can exceed the clock time of the run. Denominator: Attempts with a recorded start and end; attempts without both add nothing and are counted as missing.
- **Cache-read tokens** (`tokens_cache_read`): Tokens served from the provider's prompt cache, where reported. Denominator: Attempts whose provider reports cache reads; others are not counted as zero.
- **Cache-write tokens** (`tokens_cache_write`): Tokens written to the provider's prompt cache, where reported. Denominator: Attempts whose provider reports cache writes; others are not counted as zero.
- **Input tokens** (`tokens_input`): Input tokens the provider reported, normalized to include cache reads and writes where the convention is known; an unknown convention is flagged and the raw figure kept. Denominator: Attempts with a measured input counter; attempts without one are counted in coverage, never as zero.
- **Output tokens** (`tokens_output`): Output tokens the provider reported for the attempts. Denominator: Attempts with a measured output counter; absent counters are not zero.
- **Reasoning tokens** (`tokens_reasoning`): Reasoning or thinking tokens, where the provider reports them apart from output. Denominator: Attempts whose provider reports reasoning tokens; others are not counted as zero.
- **Wait time** (`wait_time`): Time the run spent waiting rather than working: for a human, for capacity, or for a prerequisite, as recorded on the control plane. Denominator: Runs with recorded waiting intervals; absent intervals are unknown, not zero.
