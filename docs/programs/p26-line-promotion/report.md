# Report: A project whose line is a development or staging branch can name the branch it promotes to, and Nightshift keeps one pul

Run `run_01M79JR6Q9A5M7D9413P2MMQ5H` of plan `8a859ff44779`: **succeeded**. Both strands integrated. S-01 (the promotion pull request): line.promote config with refusal of a target equal to the line branch, a GitHub compare and pull-request client, a pure body/divergence function in core, publisher and reconciler upkeep of the one moving pull request, a divergence warning, and line status, with an end-to-end promoting-line test. It landed on attempt 3 after two rounds of examiner findings were fixed by its own orchestrator (report links by publication name, repair decisions, merge-commit divergence evidence). S-02 (docs): architecture row A-70 amending A-69, plus AGENTS.md and the run-program, plan-program and nightshift skills describing line.promote. Verification passed for both.

2 of 2 strands succeeded; 0 deferred; 0 parked. Wall clock 79 min 51 s.

## Completion histories

none recorded: nightshift completion create ... groups the runs that delivered one outcome. This run's own outcome is not completion.

GitHub has every landing: `program/p26-line-promotion` is at `b64c218660cb`.

## Stories

### US-01 One pull request from the line to main is always open while the line is ahead, saying which programs it promotes, whethe: done

- **Who:** A team whose line is a develop or staging branch and who promote to main by reviewed pull request
- **Today:** Nothing tells them what the line holds that main lacks or what proved it, so they open the promotion pull request by hand and describe it from memory.
- **Afterwards:** One pull request from the line to main is always open while the line is ahead, saying which programs it promotes, whether each is whole or part, the repairs made on the line and the verification of the head it describes; they review it and merge it.
> "it would be rad if the line were a dev or staging branch, and PR's with candidates were opened to the main branch so teams just reviewed them"

Criteria: SC-01 met, SC-02 met, SC-03 met, SC-04 met, SC-05 met. Strands: S-01, S-02.

## Departures from the plan

**S-01 The promotion pull request**

- **the plan said divergence (and implicitly a missing grant) is reported "as a line waiting reason". The record has a single `waiting` slot that admission writes and clears (monthly cap, concurrency, line_refused). I keep divergence and a missing pull-request grant in record.promotion and add waiting reasons promotion_diverged / promotion_forbidden that core's lineWaitingReasons(record) derives and line status prints, rather than writing them into record.waiting.**
  Chose: Store on record.promotion; surface as derived waiting reasons in line status
  Why: Same reason and words shown to the person, without two writers fighting over one field.
- **the plan did not say how a merge-commit merge of an earlier promotion is treated. That merge commit is on the target and not on the line, so a plain "target ahead of the line" test would call every merged promotion divergence. The divergence rule excludes a target merge commit whose non-first parents are all on the line; squash/rebase merges and direct commits still count.**
  Chose: Exclude promotion merge commits from divergence
  Why: The plan asks people to merge with a merge commit; doing so must not be reported as divergence.

## Gate health

Audit: **healthy** at `ec4bd064`, 2026-10-09T17:29:07.301Z.

### Verification time

24m 53s across 4 verifications and 0 landings.

Retained rerun time: 0.0s across 0 flaky first run(s) and failed rerun(s), included in the totals.

| Step | Runs | Total | Reruns | Per run | Quiet start | Queue / candidate / end | Forecast per run |
|------|------|-------|--------|---------|-------------|-------------------------|------------------|
| `setup:install` | 4 | 26.4s | none | 6.6s | 0.1s | 4 / 0 / 0 | — |
| `build` | 4 | 15.5s | none | 3.9s | 0.1s | 4 / 0 / 0 | — |
| `typecheck` | 4 | 12.5s | none | 3.1s | 0.1s | 4 / 0 / 0 | — |
| `lint` | 4 | 4.5s | none | 1.1s | 0.1s | 4 / 0 / 0 | — |
| `test` | 4 | 22m 26s | none | 5m 37s | 0.1s | 4 / 0 / 0 | — |
| `synth` | 4 | 1m 27s | none | 21.8s | 0.1s | 4 / 0 / 0 | — |
| `sterility` | 4 | 0.8s | none | 0.2s | 0.1s | 4 / 0 / 0 | — |

No recommendations: run `nightshift gates <program> --record` before a run to keep what the gates resolve to, and the report prices them here.

## Strands

### S-01 The promotion pull request: succeeded

**Departed from the plan's approach:**

- **the plan said divergence (and implicitly a missing grant) is reported "as a line waiting reason". The record has a single `waiting` slot that admission writes and clears (monthly cap, concurrency, line_refused). I keep divergence and a missing pull-request grant in record.promotion and add waiting reasons promotion_diverged / promotion_forbidden that core's lineWaitingReasons(record) derives and line status prints, rather than writing them into record.waiting.**
  Chose: Store on record.promotion; surface as derived waiting reasons in line status
  Why: Same reason and words shown to the person, without two writers fighting over one field.
- **the plan did not say how a merge-commit merge of an earlier promotion is treated. That merge commit is on the target and not on the line, so a plain "target ahead of the line" test would call every merged promotion divergence. The divergence rule excludes a target merge commit whose non-first parents are all on the line; squash/rebase merges and direct commits still count.**
  Chose: Exclude promotion merge commits from divergence
  Why: The plan asks people to merge with a merge commit; doing so must not be reported as divergence.

Acceptance, as planned:
- line.promote { to } is accepted in nightshift.config.json and the contract; a target equal to the line branch is refused with the fix in the message
- After each successful line push, and when the target's head moves, the publisher opens or updates exactly one pull request from the line branch to the target while the line is ahead, and opens none when it is not
- The body names the head commit, each program the target lacks with its report link and whole-or-part, the repairs made on the line, the head's verification, and 'merge with a merge commit', within GitHub's size limit
- A target ahead of the line is reported in the body's first lines and as a line waiting reason with the commits and the remedy; nothing is merged into the line and the line keeps composing
- An installation without pull request access gets no pull request and a line status naming the grant; a project without promote makes no GitHub pull request calls
- A promotion pull request a person closed without merging is followed by a fresh one the next time the line moves (D-02)
- nightshift line status shows the promotion pull request, its state, the head it describes and any divergence
- Tests cover the body, the publisher and reconciler against a fake GitHub (open, update, nothing to promote, diverged, merged, closed by a person, no permission), and a promoting line in the line end-to-end test
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Shared shapes for the promotion pull request (strand S-01, job J1). (1) packages/contracts/src/v1/line-config.ts: LineCo | merged | 639868d5 | 1 |
| Pure promotion rules (strand S-01, job J2) in packages/core/src/line/promotion.ts, exported from @nightshift/core, tests | merged | 7c972b42 | 1 |
| Implement GitHubPromotionClient (from J1, @nightshift/core ports/github.ts) in apps/api/src/github/app.ts (strand S-01,  | merged | 7b4ed7c6 | 1 |
| Keep the promotion pull request (strand S-01, job J4). Uses J1 (record.promotion, GitHubPromotionClient, GitHubAccessMis | merged | 163a9419 | 1 |
| `nightshift line status` shows the promotion (strand S-01, job J5) in apps/cli/src/commands/line.ts. When record.promoti | merged | 594b26ed | 1 |
| Add a promoting line to the line end-to-end test and run the whole gate (strand S-01, job J6). In test/src/line/line-e2e | merged | 0f8dff46 | 1 |
| Fix two examiner findings in the promotion pull request body (strand S-01, fix round 1). Both are in packages/core/src/l | merged | bab63ee7 | 1 |
| Fix two examiner findings in the promotion pull request (strand S-01, fix round 2). One job, because both touch apps/api | merged | b64c2186 | 1 |

- Shared shapes for the promotion pull request (strand S-01, job J1). (1) packages/contracts/src/v1/line-config.ts: LineCo
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Pure promotion rules (strand S-01, job J2) in packages/core/src/line/promotion.ts, exported from @nightshift/core, tests
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Implement GitHubPromotionClient (from J1, @nightshift/core ports/github.ts) in apps/api/src/github/app.ts (strand S-01, 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Keep the promotion pull request (strand S-01, job J4). Uses J1 (record.promotion, GitHubPromotionClient, GitHubAccessMis
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- `nightshift line status` shows the promotion (strand S-01, job J5) in apps/cli/src/commands/line.ts. When record.promoti
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Add a promoting line to the line end-to-end test and run the whole gate (strand S-01, job J6). In test/src/line/line-e2e
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix two examiner findings in the promotion pull request body (strand S-01, fix round 1). Both are in packages/core/src/l
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix two examiner findings in the promotion pull request (strand S-01, fix round 2). One job, because both touch apps/api
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

### S-02 Saying it: architecture, skills, status: succeeded

Acceptance, as planned:
- docs/architecture.md records the promotion pull request as row A-70, amending A-69
- The run-program, plan-program and nightshift skills and AGENTS.md say how a staging line promotes: line.promote, one moving pull request, merge with a merge commit, protect the target so only the promotion merges into it, and that Nightshift never merges it
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Document the staging line's promotion pull request. (1) docs/architecture.md: add row A-70 after A-69, in the table's st | merged | fa787d19 | 1 |

- Document the staging line's promotion pull request. (1) docs/architecture.md: add row A-70 after A-69, in the table's st
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

## Success criteria

| Criterion | State | By |
|---|---|---|
| SC-01 With line.promote set, whenever the line is ahead of the target there is exactly one open pull request from the line branch to the target, updated after every line push and whenever the target moves; when the line is not ahead there is none. | met | S-01 |
| SC-02 The pull request's body names the head commit it describes, every program on the line that the target lacks with a link to its report and whether it is whole or part, the repairs made on the line, the verification of that head, and to merge with a merge commit. | met | S-01 |
| SC-03 When the target has commits the line lacks, the pull request's first lines and nightshift line status say so, naming the commits and the remedy; Nightshift merges nothing into the line and resolves nothing at the pull request, and the line keeps composing. | met | S-01 |
| SC-04 A project without line.promote is unchanged; an installation that has not granted the App pull request access gets no pull request and a line status naming what to grant, and its line keeps composing. | met | S-01 |
| SC-05 The architecture record, the skills and AGENTS.md describe how a staging line promotes by pull request and that Nightshift never merges it. | met | S-02 |

## Parked

Nothing was parked.

## Deferred

Nothing was deferred.

## Human prerequisites still pending

None.

## Decision graph

Every decision the run recorded: what was weighed, what it produced, and whether you
reversed it. To reverse one: `nightshift decision reverse <program> <decisionId> --choice … --reason …`.

- **Plan:** D-01: Is the promotion pull request's head the moving line branch, or a pinned commit per qualified head? (`dec_01M79JR73A067V30YY3H56JV5W`)
  Chose: Moving: one long-lived pull request whose head is the line branch, its body naming the head it describes. No supersede-and-close churn and one place to review; GitHub's dismiss-stale-approvals covers a push after review. The owner's choice, 2026-11-12.
  Weighed: Pinned: a candidate branch per qualified head, superseding and closing the previous pull request
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-02: A person closes the promotion pull request without merging it: what does Nightshift do? (`dec_01M79JR76CAPMY7WPTT43WSCK8`)
  Chose: Open a fresh pull request the next time the line moves. There is always one pull request showing what the target lacks; a team that does not want it removes promote from the config.
  Weighed: Leave it closed until someone asks for it again
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-03: When the target has commits the line lacks, what happens to the promotion pull request? (`dec_01M79JR78TPTN0WTBWXGTYGQ6R`)
  Chose: Keep updating it, with a warning in its first lines and in line status. It may still merge cleanly and GitHub shows whether it conflicts; the warning names the commits and the remedy.
  Weighed: Hold it, stale, until the line contains the target again
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN: round 1 — 1 job, 1 starting at once (`dec_01M79K0FQ3DV55KCKYVZ4PNY3V`)
  Chose: J1: Document the staging line's promotion pull request. (1) docs/architecture.md: add row A-70 after A-69, in the table's style (bold headline, sources in parentheses, 'amends A-69', then a rationale column with Rejected alternatives). It records: a project whose line is a staging/development branch can set `line.promote` to the branch it promotes to (e.g. `line: { branch: "staging", promote: "main" }`); Nightshift (the publisher/reconciler) keeps exactly ONE long-lived pull request open from the line to that target, its head the moving line branch (D-01, owner 2026-11-12; rejected: a pinned commit per qualified head, for supersede-and-close churn; GitHub's dismiss-stale-approvals covers a push after review), its body naming the head it describes, what the line holds that the target lacks (programs and part-programs, their reports, repairs made on the line) and what verification proved that head; if a person closes it unmerged, Nightshift opens a fresh one the next time the line moves (D-02; a team that does not want it removes promote from the config); the team reviews it and merges it with a merge commit (not squash/rebase, so the line and target share history and the next diff stays honest); the team should protect the target so only the promotion merges into it; Nightshift never merges it and never resolves a conflict at it, and says so in the body/status when the target has commits the line lacks. Also amend A-69's text with '(amended by A-70: ...)' the way earlier rows note amendments, since A-69 says promotion beyond the line is the project's own CI/CD. (2) AGENTS.md line ~690 bullet, skills/nightshift/SKILL.md (~line 56-61, which currently says 'do not open a pull request' — keep that true for the agent itself but say Nightshift keeps the promotion PR when line.promote is set), skills/run-program/SKILL.md (~line 112-133 line section; mention `nightshift line status` shows the promotion pull request), skills/plan-program/SKILL.md (~line 192-197): each says how a staging line promotes: `line.promote`, one moving pull request, merge with a merge commit, protect the target so only the promotion merges into it, Nightshift never merges it; plus the trade-off for a team choosing a `main` line (work ships as it lands) vs a staging line with promote (a reviewed promotion PR). Check packages/contracts/src/v1/line.ts for whether `promote` already exists (another strand S-01 adds it in parallel) and match its real shape if present; otherwise use `promote: "<target branch>"`. Do not change code.
  depends on: nothing (starts at once)
  touches: docs/architecture.md, AGENTS.md, skills/nightshift/SKILL.md, skills/run-program/SKILL.md, skills/plan-program/SKILL.md
  - docs/architecture.md has a row A-70 immediately after A-69 recording the promotion pull request, stating it amends A-69, and A-69 notes it is amended by A-70
  - AGENTS.md and skills/nightshift, run-program and plan-program SKILL.md each mention `line.promote`, one moving pull request whose head is the line branch, merging with a merge commit, protecting the target so only the promotion merges into it, and that Nightshift never merges it
  - npx vitest run test/src/skills test/src/cli/init.test.ts passes (skill phrase tests) and npm run lint passes (prettier on markdown, if checked). The strand is a few paragraphs of prose across five files with no code; one docs job is cheaper than splitting into parallel workers that each pay a start. S-01 works in code paths only, so no file overlap is expected; the job checks contracts for the real `promote` shape in case S-01 has landed it.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M79K26GQ53BQ2645NDHYQN1K`)
  Chose: One documentation job is the right size for these five closely related files, and its planned edits cover the promotion behavior without an unnecessary dependency on S-01. However, its acceptance omits most of the strand's required verification, so the split does not yet cover every acceptance criterion.
- [MATERIAL] Strand acceptance criterion 3 requires build, typecheck, lint, test, synth and sterility to be green, but J1 requires only a targeted Vitest subset and lint; no other job owns the remaining checks. Include the full configured verification in J1's acceptance (the root package.json already provides npm run verify for all six), so completing the only job also establishes the strand's required gates. (J1). An independent examiner reviewed decision dec_01M79K0FQ3DV55KCKYVZ4PNY3V against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN: round 2 — 1 job, 1 starting at once (`dec_01M79K2N5SA45CT5PHYBB3AAM0`)
  Chose: J1: Document the staging line's promotion pull request. (1) docs/architecture.md: add row A-70 after A-69, in the table's style (bold headline, sources in parentheses, 'amends A-69', then a rationale column with Rejected alternatives). It records: a project whose line is a staging/development branch can set `line.promote` to the branch it promotes to (e.g. `line: { branch: "staging", promote: "main" }`); Nightshift (the publisher/reconciler) keeps exactly ONE long-lived pull request open from the line to that target, its head the moving line branch (D-01, owner 2026-11-12; rejected: a pinned commit per qualified head, for supersede-and-close churn; GitHub's dismiss-stale-approvals covers a push after review), its body naming the head it describes, what the line holds that the target lacks (programs and part-programs, their reports, repairs made on the line) and what verification proved that head; if a person closes it unmerged, Nightshift opens a fresh one the next time the line moves (D-02; a team that does not want it removes promote from the config); the team reviews it and merges it with a merge commit (not squash/rebase, so the line and target share history and the next diff stays honest); the team should protect the target so only the promotion merges into it; Nightshift never merges it and never resolves a conflict at it, and says so in the body/status when the target has commits the line lacks. Also amend A-69's text with '(amended by A-70: ...)' the way earlier rows note amendments, since A-69 says promotion beyond the line is the project's own CI/CD. (2) AGENTS.md line ~690 bullet, skills/nightshift/SKILL.md (~line 56-61, which currently says 'do not open a pull request' — keep that true for the agent itself but say Nightshift keeps the promotion PR when line.promote is set), skills/run-program/SKILL.md (~line 112-133 line section; mention `nightshift line status` shows the promotion pull request), skills/plan-program/SKILL.md (~line 192-197): each says how a staging line promotes: `line.promote`, one moving pull request, merge with a merge commit, protect the target so only the promotion merges into it, Nightshift never merges it; plus the trade-off for a team choosing a `main` line (work ships as it lands) vs a staging line with promote (a reviewed promotion PR). Check packages/contracts/src/v1/line.ts for whether `promote` already exists (another strand S-01 adds it in parallel) and match its real shape if present; otherwise use `promote: "<target branch>"`. Do not change code.
  depends on: nothing (starts at once)
  touches: docs/architecture.md, AGENTS.md, skills/nightshift/SKILL.md, skills/run-program/SKILL.md, skills/plan-program/SKILL.md
  - docs/architecture.md has a row A-70 immediately after A-69 recording the promotion pull request, stating it amends A-69, and A-69 notes it is amended by A-70
  - AGENTS.md and skills/nightshift, run-program and plan-program SKILL.md each mention `line.promote`, one moving pull request whose head is the line branch, merging with a merge commit, protecting the target so only the promotion merges into it, and that Nightshift never merges it
  - npm run verify (build, typecheck, lint, test, synth, sterility) passes, including the skill phrase tests in test/src/skills. One docs job across five closely related prose files; splitting would only add worker starts. S-01 works in code paths, so no file overlap expected. Revised per review: J1's acceptance now includes the full npm run verify.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-02:** STRAND PLAN REVIEW: round 2 of 2 — sound (`dec_01M79K3BJS23XQJ9HWBE6TRQGX`)
  Chose: J1 covers all three acceptance criteria, including the complete configured npm run verify chain. Keeping the five closely related prose files in one job avoids extra worker starts and internal conflicts; the inspected documentation and skill tests reveal no prerequisite on S-01's code changes or expected file overlap with that strand.. An independent examiner reviewed decision dec_01M79K2N5SA45CT5PHYBB3AAM0 against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 1 — 6 jobs, 1 starting at once (`dec_01M79K51P9YHRQX1YFGQM97FA7`)
  Chose: J1: Shared shapes for the promotion pull request. (1) packages/contracts/src/v1/line-config.ts: LineConfigSchema gains optional `promote: z.strictObject({ to: z.string().min(1) })`; the schema refuses `promote.to === branch` with a message naming the fix ("line.promote.to is the line's own branch `X`; name the branch the line promotes to, e.g. `main`, or remove promote"). (2) packages/core/src/rules/plan.ts: plan check gives a reason kind `promote_to_line` with the same fix when a contract's line.promote.to equals line.branch (next to baseBranchReasons), for contracts that reach it unparsed by the schema refinement or as a belt-and-braces. (3) packages/contracts/src/v1/line.ts: LineRecord gains optional `promotion`: { to: string; number?: int; url?: string; state?: 'open'|'closed'|'merged'; head?: sha (the line head the body describes); targetHead?: sha (the target head last seen); aheadBy?: int>=0; behindBy?: int>=0; diverged?: { commits: [{ sha, subject }] (max 20), since: iso }; blocked?: { reason: 'pull_requests_permission'|'error', detail: string, since: iso }; updatedAt: iso }. LineWaitingReasonSchema gains 'promotion_diverged' and 'promotion_forbidden'. Export the new schemas/types. (4) packages/core/src/ports/github.ts: a new interface GitHubPromotionClient { compare(installationId, repository, base, head): Promise<{ aheadBy, behindBy, commits: readonly { sha, subject, parents: readonly string[] }[] }> (commits = those in head not in base, oldest first, as GitHub lists them); findOpenPullRequest(installationId, repository, { head, base }): Promise<PullRequestFacts|undefined>; pullRequest(installationId, repository, number): Promise<PullRequestFacts|undefined>; openPullRequest(installationId, repository, { head, base, title, body }): Promise<PullRequestFacts>; updatePullRequest(installationId, repository, number, { title, body }): Promise<PullRequestFacts> } with PullRequestFacts { number, url, state: 'open'|'closed'|'merged', head: sha }, and an exported error class GitHubAccessMissing(permission: string, detail: string). Leave GitHubAppClient unchanged. (5) LineStore (packages/core/src/ports/stores.ts) gains listPromoting(): every line whose record has `promotion`; memory store implements by filter; http store throws like listWithWork; AWS store: the single sparse GSI1 LINEWORK entry is now carried when `lineHasWork(record) || record.promotion !== undefined`, listWithWork filters the index read by lineHasWork, listPromoting filters by promotion !== undefined (update the keys.ts comment). Tests for the schema refusal, plan check reason, record round-trip with promotion, and memory listPromoting/listWithWork.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line-config.ts, packages/contracts/src/v1/line.ts, packages/contracts/src/v1/line.test.ts, packages/contracts/src/v1/config.ts, packages/core/src/rules/plan.ts, packages/core/src/rules/plan.test.ts, packages/core/src/ports/github.ts, packages/core/src/ports/stores.ts, packages/core/src/index.ts, packages/persistence/src/memory/index.ts, packages/persistence/src/memory/line.test.ts, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/keys.ts, packages/persistence/src/http/stores.ts
  - nightshift.config.json and a program contract with line.promote { to: 'main' } parse; one with promote.to equal to line.branch is refused with a message that names the fix
  - plan check reports promote_to_line with the fix for such a contract
  - LineRecordSchema accepts a record with and without promotion; old records parse unchanged
  - GitHubPromotionClient, PullRequestFacts and GitHubAccessMissing are exported from @nightshift/core; GitHubAppClient is unchanged
  - LineStore.listPromoting exists in memory, http and AWS stores; AWS listWithWork still returns only lines with work although promoting lines share the index
  - npm run build, typecheck, lint and the touched packages' tests pass

J2: Pure promotion rules in packages/core/src/line/promotion.ts (exported from core's index), with tests in promotion.test.ts. (1) divergedCommits(behind: compare commits of base=line, head=target): the target's commits the line lacks, EXCLUDING a merge commit whose every non-first parent is absent from the behind list (i.e. on the line: the merge-commit merge of an earlier promotion); a squash or rebase merge or a direct commit counts. (2) promotionTitle(record, to) e.g. `Promote <line branch> to <to> (<n> programs)`. (3) promotionBody(input): input = { record: LineRecord; to: string; repository: 'owner/name'; ahead: compare commits of base=target, head=line; aheadBy: number; diverged: readonly {sha,subject}[]; programs: ReadonlyMap<programId, { title?: string; whole: boolean }>; programsDirectory: string per program or a resolver }. The body: when diverged is non-empty its FIRST lines are a warning naming the commits (short sha + subject, capped) and the remedy (merge `<to>` into `<line>`, or protect `<to>` so only the promotion merges into it; Nightshift does not merge the target into the line); then the head commit it describes (record.head); the programs on the line the target lacks — every range program of each kept composition whose commit is in `ahead` — each with a link to its report on the line branch `https://github.com/<repo>/blob/<line branch>/<programsDirectory>/<id>/report.md` and 'whole' or 'part' (part when its run has not ended succeeded, as given by programs map); programs only named by ahead commits whose subject matches /^Merge program (.+?) into the line/ that no kept composition accounts for (older than the 50 kept) listed by that subject; the repairs made on the line (compositions with resolver decision 'resolved' or a repair ref, with the resolver decision/detail and repair run/job); the head composition's verification (outcome, each command and its exit); and the line 'Merge with a merge commit' (not squash or rebase, which would make the target diverge). Bounded to MAX_PROMOTION_BODY_CHARS = 60000 (GitHub's limit is 65536), truncating lists with a 'and N more' line rather than cutting mid-line; aheadBy > ahead.length is said. (4) lineWaitingReasons(record): record.waiting (if any) plus, from record.promotion, a 'promotion_diverged' waiting with the commits and remedy when diverged is set, and a 'promotion_forbidden' waiting with the grant ("Give the Nightshift GitHub App 'Pull requests: Read and write' and have the installation accept it") when blocked.reason is 'pull_requests_permission'. Tests cover: diverged first lines, merge-commit promotion not counted as divergence, squash merge counted, whole/part, report links, repairs, verification, older-than-50 by subject, size bound with a huge record, lineWaitingReasons.
  depends on: J1
  touches: packages/core/src/line/promotion.ts, packages/core/src/line/promotion.test.ts, packages/core/src/line/index.ts
  - promotionBody, promotionTitle, divergedCommits, lineWaitingReasons and MAX_PROMOTION_BODY_CHARS are exported from @nightshift/core and are pure
  - A diverged target puts the warning, commits and remedy in the body's first lines
  - The body names the head, each lacking program with its report link and whole/part, repairs, the head's verification and 'merge with a merge commit'
  - A merge commit of an earlier promotion is not divergence; a squash merge commit is
  - The body never exceeds MAX_PROMOTION_BODY_CHARS even for 50 compositions with long verification output
  - Unit tests in packages/core/src/line/promotion.test.ts pass with build, typecheck, lint

J3: Implement GitHubPromotionClient in apps/api/src/github/app.ts: createGitHubAppClient returns GitHubAppClient & GitHubPromotionClient. Every pull-request call uses an installation token minted for the one repository with { pull_requests: 'write', contents: 'read', metadata: 'read' }; a 422 at minting (permission not granted) or a 403 'Resource not accessible by integration' from a pull-request route throws GitHubAccessMissing('pull_requests', …) and is not retried. compare → GET /repos/{repo}/compare/{base}...{head} mapping ahead_by, behind_by, commits[].sha, first line of commit.message, parents[].sha. findOpenPullRequest → GET /repos/{repo}/pulls?state=open&head={owner}:{head}&base={base}. pullRequest → GET /repos/{repo}/pulls/{n} (404 → undefined). openPullRequest → POST /repos/{repo}/pulls. updatePullRequest → PATCH /repos/{repo}/pulls/{n} (extend `call` to allow PATCH). state 'merged' when merged_at is set. Other non-2xx throw GitHubError. Tests in app.test.ts with a fake fetch for each call, the permission missing case at mint and at the route, and merged state mapping.
  depends on: J1
  touches: apps/api/src/github/app.ts, apps/api/src/github/app.test.ts
  - createGitHubAppClient's result satisfies GitHubPromotionClient
  - Pull-request calls request pull_requests: write on a single-repository token
  - A missing grant throws GitHubAccessMissing, not GitHubError, and the mint is not retried
  - apps/api/src/github/app.test.ts covers compare, find, read, open, update, merged state and missing permission; build/typecheck/lint/test pass

J4: Keep the promotion pull request. New apps/api/src/runner/promotion.ts: maintainPromotion(deps, { projectId, branch }). It finds promote.to from the project's program contracts naming this line branch (non-line contracts; helper beside lineCapUsd in line-support.ts); with no promote, or no `promotions` client in deps, it makes NO GitHub pull-request or compare calls and returns 'not_configured'. Otherwise, with the installation and repository resolved as pushLine does: compare(base=to, head=line head) for ahead; when behindBy > 0 compare(base=line head, head=to) and divergedCommits(); find the open PR by head=line branch, base=to. If aheadBy === 0: open none; record state (an open PR is left alone). If ahead: update the open PR's title/body (promotionTitle/promotionBody); else open one — except when the record's last PR is 'closed' (by a person, not merged) and the line head still equals promotion.head, in which case open nothing until the line moves (D-02: a fresh one the next time the line moves); a 422 'already exists' on open → find and update. Programs map: for each program in the body, whole = its run that fed the range has ended 'succeeded' (from the runs store), title from plan drafts or contract; programsDirectory from the contract. Writes record.promotion (number, url, state, head described, targetHead, aheadBy, behindBy, diverged {commits, since kept while diverged} or removed, blocked removed) through stores.lines.update without touching queue, push, batch or waiting. GitHubAccessMissing → promotion.blocked { reason: 'pull_requests_permission', detail naming the grant } and nothing retried; any other error → blocked { reason: 'error' } and logged; never throws to the caller and never affects the line's composing. Wire: publishLine calls maintainPromotion after 'published' or 'already_published', under the same line lock; PublisherDeps gains optional `promotions: GitHubPromotionClient`; PublishEvent / PublisherRequest gain { kind: 'promotion', projectId, branch } handled in lambda/runner-publisher.ts under the line lock; the lambdas pass the App client as `promotions`. Reconciler: reconcileLinePromotions over stores.lines.listPromoting(): read the target head via plane.github.branchHead; ask the publisher { kind: 'promotion' } when it differs from promotion.targetHead or when promotion.head differs from record.head; count and catch per line; called from reconcile(). The local plane / testing control plane wiring (apps/api/src/local, apps/api/src/testing) passes promotions through where it passes github. Tests: apps/api/src/runner/promotion.test.ts with a fake GitHubPromotionClient and memory stores: opens after a push; updates the same PR after the next push (exactly one PR); nothing to promote opens none; diverged target sets diverged and the body's first lines and keeps the push/queue untouched; merged then a new push opens a fresh one; closed by a person: none reopened until the line moves, then a fresh one; GitHubAccessMissing records blocked and makes no further calls; no promote config makes zero calls. Reconciler test: target head moved → publisher asked; unchanged → not asked.
  depends on: J2, J3
  touches: apps/api/src/runner/promotion.ts, apps/api/src/runner/promotion.test.ts, apps/api/src/runner/publisher.ts, apps/api/src/runner/line-support.ts, apps/api/src/runner/reconcile.ts, apps/api/src/runner/reconcile.test.ts, apps/api/src/lambda/runner-publisher.ts, apps/api/src/lambda/runner-reconciler.ts, apps/api/src/lambda/api.ts, apps/api/src/http.ts, apps/api/src/local/server.ts, apps/api/src/testing/local-control-plane.ts
  - After each successful line push the publisher opens or updates exactly one PR from the line branch to promote.to while ahead, and opens none when not ahead
  - The reconciler asks for a refresh when the target head moved since promotion.targetHead
  - A PR closed by a person is followed by a fresh one only once the line moves (D-02); a merged one by a fresh one on the next push
  - Divergence is recorded on record.promotion and in the body; nothing is merged into the line and queue/push/batch/waiting are untouched
  - A missing pull_requests grant records blocked with the grant and is not retried; a project without promote makes no pull-request or compare calls
  - Tests for publisher and reconciler with a fake GitHub cover open, update, nothing to promote, diverged, merged, closed by a person, no permission; build/typecheck/lint/test pass

J5: `nightshift line status` shows the promotion (apps/cli/src/commands/line.ts): when record.promotion is set, a line `promotion → <to>: #<n> <state> <url>, describes <short head>` (or `nothing to promote` when aheadBy is 0 / no PR, and `line at <short head>, PR describes <short>` when they differ), ahead/behind counts; waiting lines come from core's lineWaitingReasons(record) so divergence prints as `waiting (promotion_diverged): …` with the commits and remedy and a missing grant as `waiting (promotion_forbidden): …` naming the grant. Keep the existing line_refused hint. Tests in apps/cli/src/commands/line.test.ts for: open PR, nothing to promote, diverged, permission missing, no promote (no promotion lines).
  depends on: J2
  touches: apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts
  - line status prints the PR number, state, URL and described head
  - Divergence and a missing grant print as waiting reasons with the commits/remedy and the grant
  - A record without promotion prints exactly as before
  - CLI tests pass with build/typecheck/lint

J6: Add a promoting line to test/src/line/line-e2e.test.ts: a suite (or case) whose config has line { branch, promote: { to: 'main' } }, publisher deps given an in-memory fake GitHubPromotionClient backed by the local git server's refs (compare computed with git rev-list/log against the bare repo), driving landings through publishLine as the existing suite does. Assert: after the first line push exactly one PR from the line to main is open whose body names the head, each program with its report link and whole/part, the verification and 'merge with a merge commit'; after the next push the same PR is updated (no second PR); a commit pushed directly to main makes the next refresh (reconcileLinePromotions or maintainPromotion) record divergence and put it in the body's first lines while the line keeps composing.
  depends on: J4
  touches: test/src/line/line-e2e.test.ts, test/src/line/promotion-fake.ts
  - The line e2e test has a promoting line covering open, update-in-place and divergence
  - npm run test passes for test/src/line. Order: J1 lays the shared shapes (config, record, ports, store listing). J2 (pure body + divergence rule in core) and J3 (GitHub App client REST calls) both need only J1 and touch disjoint files, so they run in parallel. J4 (publisher + reconciler + lambda wiring) needs J2's functions and J3's client; it is the high-risk job (GitHub writes, divergence handling). J5 (CLI line status) needs only J1's record shape and J2's lineWaitingReasons, so it runs beside J4. J6 (e2e) needs J4. Design choices fixed here so jobs agree: (a) the pull-request calls are a separate port interface GitHubPromotionClient, not new methods on GitHubAppClient, so the many existing GitHubAppClient fakes need no change; createGitHubAppClient returns both. (b) A missing permission is a typed error GitHubAccessMissing exported from core. (c) DynamoDB has a single sparse GSI1 a record can sit in once, so the LINEWORK index predicate widens to `lineHasWork(record) || record.promotion !== undefined`, and listWithWork filters by lineHasWork after reading; listPromoting filters by promotion. (d) Divergence and a missing grant are kept in record.promotion, not in the single record.waiting slot (which admission overwrites); they surface as waiting reasons through core's lineWaitingReasons(record), which line status prints. (e) The divergence rule ignores a merge commit on the target whose non-first parents are all on the line (the merge-commit merge of an earlier promotion), otherwise every merged promotion would read as divergence forever; a squash/rebase merge or direct commit counts.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** DEPARTURE: the plan said divergence (and implicitly a missing grant) is reported "as a line waiting reason". The record has a single `waiting` slot that admission writes and clears (monthly cap, concurrency, line_refused). I keep divergence and a missing pull-request grant in record.promotion and add waiting reasons promotion_diverged / promotion_forbidden that core's lineWaitingReasons(record) derives and line status prints, rather than writing them into record.waiting. (`dec_01M79K57XSSR52NP6RV62236PC`)
  Chose: Store on record.promotion; surface as derived waiting reasons in line status. Same reason and words shown to the person, without two writers fighting over one field.
  Weighed: Write divergence into record.waiting, rejected because admission overwrites it (recordLineWaiting) and resolvePush clears refusals; the warning would flicker or hide a cap reason
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** DEPARTURE: the plan did not say how a merge-commit merge of an earlier promotion is treated. That merge commit is on the target and not on the line, so a plain "target ahead of the line" test would call every merged promotion divergence. The divergence rule excludes a target merge commit whose non-first parents are all on the line; squash/rebase merges and direct commits still count. (`dec_01M79K5AHZCV5CNRHEVAPNKBDC`)
  Chose: Exclude promotion merge commits from divergence. The plan asks people to merge with a merge commit; doing so must not be reported as divergence.
  Weighed: Divergence = behindBy > 0, rejected because every correctly merged promotion would warn forever
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M79K7G438F2T5KNG5F6M3R3M`)
  Chose: The split has useful parallel boundaries: J2/J3 and J4/J5 can proceed independently, and the existing code supports the separate promotion port. However, the specified lifecycle and reconciliation leave acceptance gaps, J1 leaves an existing test failing, and the final verification requirements are not assigned.
- [MATERIAL] J4 never specifies reading the previously recorded PR with pullRequest(number). findOpenPullRequest cannot distinguish a human closure from a merge, and the stored state will still be 'open'. A target-only movement after a human closes the PR therefore opens a replacement before the line moves, violating D-02; a closure with neither ref moving remains invisible to status indefinitely. Refresh the recorded PR's actual state and test closure starting from a persisted open record, rather than pre-seeding 'closed', including a target-only refresh. (J4)
- [MATERIAL] Promotion discovery is not durable across the first successful push: listPromoting sees only records already carrying promotion, while promotion is first written by maintainPromotion after pushLine has settled the push. If the process stops between those operations, the now-idle line has neither work for listWithWork nor promotion for listPromoting and never gets its PR, even when the target moves. Establish durable promotion work/discovery before that gap and test recovery. Also distinguish pending retryable refreshes from a missing-permission block: the proposed head-mismatch trigger otherwise repeatedly schedules a blocked first publication whose described head is absent. (J1, J4)
- [MATERIAL] The proposed configuration lookup scans historical program contracts for this branch without defining which configuration is current or how removal wins. Unlike lineCapUsd's explicit minimum aggregation, promote.to cannot be aggregated: older contracts can retain promote after a newer program removes it, or name a different target. J4 must specify authoritative selection and removal/target-change behavior, including stale promotion record handling, so removing promote actually stops PR calls as D-02 and criterion 5 require. (J4)
- [MATERIAL] J3 specifies one unpaginated compare response, but J2 treats absence from its commits as proof of ancestry and relies on those commits to recover programs outside the 50 retained compositions. GitHub limits an unpaginated comparison to 250 commits (https://docs.github.com/en/rest/commits/commits#compare-two-commits). Merely saying aheadBy exceeds the returned length does not recover omitted programs, and an incomplete reverse comparison can incorrectly suppress divergence. Define complete paginated comparisons (or equivalent verified ancestry evidence) and test comparisons exceeding that limit before applying body-size truncation. (J1, J2, J3)
- [MATERIAL] Adding http.lines.listPromoting makes apps/api/src/http-adapter.test.ts fail: PORT_METHODS.lines at line 150 lists exactly get/update/listWithWork, and the test at lines 960-964 compares that list with Object.keys of the implementation. J1 does not include this file or its test in its acceptance. Update and exercise the new method in that suite as part of J1 so its merge remains green. (J1)
- [MATERIAL] Criterion 9 requires build, typecheck, lint, test, synth and sterility, but no job acceptance owns the complete integrated gate. J1-J5 specify partial checks and J6 only the line tests; synth and check:sterility are never assigned. Give the final integration job explicit responsibility for the configured root npm run verify (which runs all six) and resolving failures. (J6). An independent examiner reviewed decision dec_01M79K51P9YHRQX1YFGQM97FA7 against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 2 — 6 jobs, 1 starting at once (`dec_01M79K9QA0QAG567VCDAHZ1S9P`)
  Chose: J1: Shared shapes for the promotion pull request. (1) packages/contracts/src/v1/line-config.ts: LineConfigSchema gains optional `promote: z.strictObject({ to: z.string().min(1) })`; the schema refuses `promote.to === branch` with a message naming the fix ("line.promote.to is the line's own branch `X`; name the branch the line promotes to, e.g. `main`, or remove promote"). (2) packages/core/src/rules/plan.ts: plan check gives a reason kind `promote_to_line` with the same fix when a contract's line.promote.to equals line.branch (next to baseBranchReasons). (3) packages/contracts/src/v1/line.ts: LineRecord gains optional `promotion`: { to: string; number?: int; url?: string; state?: 'open'|'closed'|'merged'; head?: sha (the line head the PR body last described); closedAtHead?: sha (the line head when a person's close was first seen); targetHead?: sha (target head last seen); aheadBy?: int>=0; behindBy?: int>=0; diverged?: { commits: [{ sha, subject }] (max 20), count: int, since: iso }; blocked?: { reason: 'pull_requests_permission'|'error', detail: string, since: iso, at: iso (last tried), head?: sha, targetHead?: sha }; updatedAt: iso }. LineWaitingReasonSchema gains 'promotion_diverged' and 'promotion_forbidden'. Export the new schemas/types. (4) packages/core/src/ports/github.ts: a new interface GitHubPromotionClient { compare(installationId, repository, base, head): Promise<{ aheadBy, behindBy, commits: readonly { sha, subject, parents: readonly string[] }[], complete: boolean }> (commits = those in head not in base, oldest first; complete = every one of aheadBy listed); findOpenPullRequest(installationId, repository, { head, base }): Promise<PullRequestFacts|undefined>; pullRequest(installationId, repository, number): Promise<PullRequestFacts|undefined>; openPullRequest(installationId, repository, { head, base, title, body }): Promise<PullRequestFacts>; updatePullRequest(installationId, repository, number, { title, body }): Promise<PullRequestFacts> } with PullRequestFacts { number, url, state: 'open'|'closed'|'merged', head: sha, base: string }, and an exported error class GitHubAccessMissing(permission: string, detail: string). GitHubAppClient unchanged. (5) LineStore (packages/core/src/ports/stores.ts) gains listPromoting(): every line whose record has `promotion`; memory store filters; http store throws like listWithWork; AWS: the single sparse GSI1 LINEWORK entry is carried when `lineHasWork(record) || record.promotion !== undefined`, listWithWork filters the index read by lineHasWork, listPromoting by promotion !== undefined (update keys.ts comment). Update apps/api/src/http-adapter.test.ts PORT_METHODS.lines (and any similar port-method list) to include listPromoting and exercise it. Tests for the schema refusal, plan check reason, record round-trip with promotion, memory listPromoting/listWithWork.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/line-config.ts, packages/contracts/src/v1/line.ts, packages/contracts/src/v1/line.test.ts, packages/contracts/src/v1/config.ts, packages/core/src/rules/plan.ts, packages/core/src/rules/plan.test.ts, packages/core/src/ports/github.ts, packages/core/src/ports/stores.ts, packages/core/src/index.ts, packages/persistence/src/memory/index.ts, packages/persistence/src/memory/line.test.ts, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/keys.ts, packages/persistence/src/http/stores.ts, apps/api/src/http-adapter.test.ts
  - nightshift.config.json and a program contract with line.promote { to: 'main' } parse; promote.to equal to line.branch is refused with a message naming the fix
  - plan check reports promote_to_line with the fix
  - LineRecordSchema accepts records with and without promotion; old records parse unchanged
  - GitHubPromotionClient, PullRequestFacts and GitHubAccessMissing are exported from @nightshift/core; GitHubAppClient is unchanged
  - LineStore.listPromoting exists in memory, http and AWS stores; AWS listWithWork still returns only lines with work although promoting lines share the index
  - apps/api/src/http-adapter.test.ts passes with the new port method
  - npm run build, typecheck, lint and npm run test pass

J2: Pure promotion rules in packages/core/src/line/promotion.ts (exported from core), tests in promotion.test.ts. (1) divergedCommits(behind: compare result of base=line, head=target) → { commits, count, complete }: the target's commits the line lacks, EXCLUDING a merge commit whose every non-first parent is absent from behind.commits (on the line: the merge-commit merge of an earlier promotion); squash/rebase merges and direct commits count. When behind.complete is false the exclusion cannot be trusted: return every listed non-excluded commit and count = behindBy, treating the target as diverged. (2) promotionTitle(record, to). (3) promotionBody(input): input = { record: LineRecord; to; repository: 'owner/name'; ahead: compare result of base=target, head=line; diverged: result of (1); programs: ReadonlyMap<programId, { title?: string; whole: boolean; programsDirectory: string }> }. When diverged is non-empty the FIRST lines are a warning naming the commits (short sha + subject, capped, 'and N more') and the remedy (merge `<to>` into `<line>`, or protect `<to>` so only the promotion merges into it; Nightshift does not merge the target into the line). Then: the head commit it describes (record.head); the programs on the line the target lacks — every range program of each kept composition whose commit is in ahead.commits — each with its report link `https://github.com/<repo>/blob/<line branch>/<programsDirectory>/<id>/report.md` and 'whole' or 'part' (from programs map); programs named only by ahead commits whose subject matches /^Merge program (.+?) into the line/ and no kept composition accounts for (older than the 50 kept), listed by that subject; when ahead.complete is false, a line saying how many commits were not listed; the repairs made on the line (compositions with resolver decision 'resolved' or a repair ref: decision, detail, repair run/job); the head composition's verification (outcome, each command and exit); and 'Merge with a merge commit' (not squash or rebase, which makes the target diverge). Bounded to MAX_PROMOTION_BODY_CHARS = 60000, truncating lists with 'and N more' lines, never mid-line. (4) lineWaitingReasons(record): record.waiting plus, from record.promotion, 'promotion_diverged' (commits and remedy) when diverged is set, and 'promotion_forbidden' with the grant ("Give the Nightshift GitHub App 'Pull requests: Read and write' and have the installation accept it") when blocked.reason is 'pull_requests_permission'. Tests: diverged first lines; promotion merge commit not divergence; squash merge counted; incomplete behind compare treated as diverged; whole/part; report links; repairs; verification; older-than-50 by subject; incomplete ahead compare stated; size bound with 50 large compositions and >250 ahead commits; lineWaitingReasons.
  depends on: J1
  touches: packages/core/src/line/promotion.ts, packages/core/src/line/promotion.test.ts, packages/core/src/line/index.ts
  - promotionBody, promotionTitle, divergedCommits, lineWaitingReasons and MAX_PROMOTION_BODY_CHARS are exported from @nightshift/core and pure
  - A diverged target puts the warning, commits and remedy in the body's first lines
  - The body names the head, each lacking program with report link and whole/part, repairs, the head's verification and 'merge with a merge commit'
  - A promotion merge commit is not divergence; a squash merge is; an incomplete reverse compare is reported as divergence
  - The body never exceeds MAX_PROMOTION_BODY_CHARS
  - packages/core tests pass with build, typecheck, lint

J3: Implement GitHubPromotionClient in apps/api/src/github/app.ts: createGitHubAppClient returns GitHubAppClient & GitHubPromotionClient. Every pull-request and compare call uses an installation token minted for the one repository with { pull_requests: 'write', contents: 'read', metadata: 'read' }; a 422 at minting (permission not granted) or a 403 'Resource not accessible by integration' from a pull-request route throws GitHubAccessMissing('pull_requests', …) and is not retried. compare → GET /repos/{repo}/compare/{base}...{head}?per_page=100&page=N, paginated until every one of total_commits/ahead_by is listed or a cap of 2500 commits (complete=false beyond it), mapping ahead_by, behind_by, sha, first line of commit.message, parents[].sha. findOpenPullRequest → GET /repos/{repo}/pulls?state=open&head={owner}:{head}&base={base}. pullRequest → GET /repos/{repo}/pulls/{n} (404 → undefined). openPullRequest → POST /repos/{repo}/pulls. updatePullRequest → PATCH /repos/{repo}/pulls/{n} (extend `call` to allow PATCH). state 'merged' when merged_at is set. Other non-2xx throw GitHubError. Tests in app.test.ts with a fake fetch: compare over several pages and beyond the cap, find, read, open, update, merged state, and the missing permission at mint and at the route.
  depends on: J1
  touches: apps/api/src/github/app.ts, apps/api/src/github/app.test.ts
  - createGitHubAppClient's result satisfies GitHubPromotionClient
  - Calls use a single-repository token with pull_requests: write
  - compare paginates and reports complete correctly past 250 commits
  - A missing grant throws GitHubAccessMissing, not GitHubError, without retrying the mint
  - app.test.ts covers each call; build/typecheck/lint/test pass

J4: Keep the promotion pull request. New apps/api/src/runner/promotion.ts. CONFIG: promotionConfigOf(stores, projectId, branch) in line-support.ts returns the `line.promote` of the NEWEST (createdAt) non-line program contract of the project whose line.branch is this branch; that contract is authoritative (older contracts' promote is ignored). SEEDING (durability): settleLineObligation (when it queues a range) and pushLine (before it pushes) set record.promotion = { to } (keeping prior fields when `to` is unchanged; resetting to { to } when `to` changed; removing promotion when the config has no promote) in the same lines.update path, so a line that is pushed is already discoverable by listPromoting. maintainPromotion(deps, { projectId, branch }): with no promote config, it removes record.promotion and makes NO compare or pull-request calls ('not_configured'); with no `promotions` client in deps likewise makes no calls. Otherwise, installation/repository as pushLine: (a) if promotion.number is set, read it with pullRequest(number); merged → state merged; closed → state closed and closedAtHead = the line head at first sight of the close (keep it if already set). (b) compare(base=to, head=line head); when behindBy>0, compare(base=line head, head=to) and divergedCommits(). (c) aheadBy===0: open none. Ahead: if the recorded PR is open (or findOpenPullRequest by head=line branch, base=to finds one, adopting its number), update title/body; else if state is closed and record.head === closedAtHead, open nothing (D-02: only once the line moves); else open one (a 422 'already exists' → find and update) and clear closedAtHead. Programs map: whole = the program's latest run has ended 'succeeded' (runs store), title from plan drafts or contract, programsDirectory from the contract. Write record.promotion (number, url, state, head described, targetHead, aheadBy, behindBy, diverged {kept `since` while diverged} or removed, blocked removed) via stores.lines.update touching nothing else (queue, push, batch, waiting untouched). GitHubAccessMissing → blocked { reason: 'pull_requests_permission', detail naming the grant, since, at, head, targetHead }; other errors → blocked { reason: 'error', … } and logged; never throws, never affects composing. WIRING: publishLine calls maintainPromotion after 'published'/'already_published' under the same line lock; PublisherDeps gains optional `promotions: GitHubPromotionClient`; PublishEvent/PublisherRequest gain { kind: 'promotion', projectId, branch } handled in lambda/runner-publisher.ts under the line lock; lambdas pass the App client as `promotions`; local/testing control-plane wiring passes it where it passes github. RECONCILER: reconcileLinePromotions over stores.lines.listPromoting(), called from reconcile(): read the target head via plane.github.branchHead; ask the publisher { kind: 'promotion' } when (i) not blocked and (target head ≠ promotion.targetHead or promotion.head ≠ record.head or the recorded PR state is open — so a person's close is seen within a tick); (ii) blocked 'error' → every tick; (iii) blocked 'pull_requests_permission' → only when line or target head moved since blocked.head/targetHead or blocked.at is over an hour old. Count and catch per line. TESTS apps/api/src/runner/promotion.test.ts with a fake GitHubPromotionClient over memory stores: opens after a push; updates the same PR after the next push (exactly one PR); nothing to promote opens none; diverged target sets diverged and body first lines, queue/push untouched; merged then a new push opens a fresh one; starting from a persisted OPEN record, a person closes it: a target-only refresh opens none and records closed, then a line push opens a fresh one; GitHubAccessMissing records blocked, no further calls that refresh; no promote config makes zero calls and removes a stale promotion; newest contract without promote wins over an older one with it; a crash after push before maintenance (record seeded, promotion.head stale) is recovered by the reconciler. Reconciler tests: target moved → asked; unchanged and closed → not asked; permission-blocked not re-asked each tick.
  depends on: J2, J3
  touches: apps/api/src/runner/promotion.ts, apps/api/src/runner/promotion.test.ts, apps/api/src/runner/publisher.ts, apps/api/src/runner/line-support.ts, apps/api/src/runner/reconcile.ts, apps/api/src/runner/reconcile.test.ts, apps/api/src/lambda/runner-publisher.ts, apps/api/src/lambda/runner-reconciler.ts, apps/api/src/lambda/api.ts, apps/api/src/http.ts, apps/api/src/local/server.ts, apps/api/src/testing/local-control-plane.ts
  - After each successful line push the publisher opens or updates exactly one PR from the line branch to promote.to while ahead, and opens none when not ahead
  - The reconciler asks for a refresh when the target head moved, the described head is stale, or an open PR may have been closed; not every tick for a permission block
  - A PR a person closed is followed by a fresh one only once the line moves (D-02), tested from a persisted open record including a target-only refresh
  - Divergence is recorded and in the body; nothing is merged into the line and queue/push/batch/waiting are untouched
  - A missing grant records blocked with the grant; a project without promote (per the newest contract) makes no compare or pull-request calls
  - Tests for publisher and reconciler with a fake GitHub cover open, update, nothing to promote, diverged, merged, closed by a person, no permission; build/typecheck/lint/test pass

J5: `nightshift line status` shows the promotion (apps/cli/src/commands/line.ts): when record.promotion is set, `promotion → <to>: #<n> <state> <url>, describes <short head>` (or `nothing to promote` when aheadBy is 0 / no PR, and the line head when it differs from the described head), ahead/behind counts; waiting lines come from core's lineWaitingReasons(record), so divergence prints as `waiting (promotion_diverged): …` with commits and remedy and a missing grant as `waiting (promotion_forbidden): …` naming the grant. Keep the existing line_refused hint. Tests in apps/cli/src/commands/line.test.ts: open PR, nothing to promote, diverged, permission missing, no promotion (output unchanged).
  depends on: J2
  touches: apps/cli/src/commands/line.ts, apps/cli/src/commands/line.test.ts
  - line status prints the PR number, state, URL and described head
  - Divergence and a missing grant print as waiting reasons with commits/remedy and the grant
  - A record without promotion prints exactly as before
  - CLI tests pass with build/typecheck/lint

J6: Add a promoting line to test/src/line/line-e2e.test.ts: a suite or case whose config has line { branch, promote: { to: 'main' } }, publisher deps given a fake GitHubPromotionClient (test/src/line/promotion-fake.ts) backed by the local git server's bare repo (compare via git rev-list/log, PRs in memory), driving landings as the existing suite does. Assert: after the first line push exactly one PR from the line to main is open whose body names the head, each program with its report link and whole/part, the verification and 'merge with a merge commit'; after the next push the same PR is updated (no second PR); a commit pushed directly to main makes the next refresh record divergence and put it in the body's first lines while the line keeps composing. Then run the whole gate `npm run verify` (build, typecheck, lint, test, synth, check:sterility) on the strand's integrated branch and fix whatever it reports, in any file.
  depends on: J4, J5
  touches: test/src/line/line-e2e.test.ts, test/src/line/promotion-fake.ts
  - The line e2e test has a promoting line covering open, update-in-place and divergence
  - npm run verify (build, typecheck, lint, test, synth, check:sterility) passes on the integrated branch. Revised for the review. Order unchanged: J1 shapes; J2 (core rules) and J3 (App client) in parallel; J4 (publisher/reconciler, high risk) beside J5 (CLI); J6 e2e and the whole verify gate last. Fixed design points so jobs agree: (a) pull-request calls are a separate GitHubPromotionClient port, so existing GitHubAppClient fakes do not change; (b) GitHubAccessMissing is the typed no-grant error; (c) DynamoDB has one sparse GSI1, so the LINEWORK index entry is carried when `lineHasWork || promotion !== undefined`, and listWithWork/listPromoting filter after reading; (d) divergence and a missing grant live on record.promotion and surface as derived waiting reasons (lineWaitingReasons), not in the single record.waiting slot admission overwrites (recorded as a departure); (e) a target merge commit whose non-first parents are on the line is the merge-commit merge of an earlier promotion and is not divergence (recorded as a departure); (f) compares are paginated and say whether they are complete; an incomplete reverse compare is treated as diverged rather than silently suppressing; (g) the authoritative promote config is the newest (createdAt) non-line contract naming the line branch; its absence removes record.promotion and stops all PR calls; (h) promotion is seeded on the record before the push it follows (when the range is queued and before pushLine pushes), so a crash between push and PR maintenance is recovered by the reconciler's `promotion.head !== record.head` trigger; (i) the recorded PR is read by number each refresh, so a person's close is seen (D-02) and a target-only refresh never reopens it.
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 2 of 2 — revise (`dec_01M79KBQ0B48Y0AZXZ5H1DTENJ`)
  Chose: The dependency graph and file boundaries support useful parallel work, and the final integration job covers the configured gates. However, the specified closure handling misses D-02 in a normal timing case, and the body rules leave two acceptance gaps that should be corrected before implementation.
- [MATERIAL] D-02 fails when a person's close is first observed after the next line push. For example, the persisted PR is open at H1, a person closes it, then publishLine pushes H2 before the next reconciler tick. Maintenance sets closedAtHead to the current record.head (H2), immediately suppresses opening because they match, and waits for H3. The existing publisher updates the line record before post-push maintenance, so this is a real ordering case. Define closure tracking that recognizes the first subsequent line movement and add this test; the planned target-only-refresh-before-push test does not cover it. (J4)
- [MATERIAL] Programs older than the 50 retained compositions are only listed by merge subject in J2, without the required report link or whole/part status. Acceptance 3 requires those fields for each lacking program. The existing composer emits subjects using a range label (packages/execution/src/line/compose.ts), so specify how programs identified from those subjects are resolved into the programs metadata map and rendered with the same required fields, and test an evicted composition's program. (J2, J4)
- [MATERIAL] The incomplete reverse-compare rule uses the wrong count: for compare(base=line, head=target), target-only commits are aheadBy, while behindBy counts line-only commits. Setting divergence count = behindBy can report zero or an unrelated count for thousands of target-only commits, contradicting the required conservative divergence warning and its 'and N more' summary. Correct the direction explicitly and test incomplete reverse comparisons with unequal aheadBy/behindBy, including behindBy=0. (J2). An independent examiner reviewed decision dec_01M79K9QA0QAG567VCDAHZ1S9P against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Second plan review found three material gaps; I take all three into the delegated jobs instead of a third review round. (`dec_01M79KC3B8R7A4W3VYG4YZKTWT`)
  Chose: (1) J4: closedAtHead is the head the closed PR described (promotion.head), not the line head at first sight, so a push that lands before the close is seen opens a fresh PR; tested. (2) J2 exports promotionPrograms(record, ahead), which yields the program ids from kept compositions and from `Merge program <id> <from>..<upTo> into the line` subjects (first token after 'Merge program'). J4 fills the metadata map for all of them, and the body renders report link and whole/part for evicted programs too; tested. (3) J2: in compare(base=line, head=target), the target-only commits are aheadBy. An incomplete reverse compare counts aheadBy as the divergence; tested with unequal counts and behindBy=0.. The fixes are fully specified, so another review round adds nothing.
  Weighed: Keep the round-2 plan as written, rejected because each finding is a real acceptance gap
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** Fix round 2, examiner F-02. Excluding a target merge commit from divergence only because its non-first parents are on the line misses a merge that also carried edits. The examiner asks to report such commits. Reporting every target merge commit, though, would make every correctly merged promotion warn forever, which is departure 2. (`dec_01M79PEHV3QFWMWGJPAWF0YDSK`)
  Chose: A target-only merge commit is excluded only with evidence that it introduced nothing: every non-first parent is on the line AND its tree equals the tree of one of those parents (read through GitHub). Without that evidence (a lookup failed, or the lookup cap was reached) it counts as divergence.. A clean merge-commit promotion has its line parent's tree. Any extra edit changes the tree, so it is reported.
  Weighed: Count every target-only commit, merge commits included, rejected because every merge-commit promotion (the merge style we tell people to use) would be reported as divergence forever
  Weighed: Keep the parent-only exclusion, rejected because the examiner is right: a merge with extra edits hides the target's own changes
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
| claude | claude-opus-5-5 | work | 4 | 11194950 | 59279 | 4.85 | 4: $4.85 | none | provider-reported; 4 of 4 attempts valued |
| codex | gpt-6-astra | examine | 8 | 2674487 | 10169 | unknown | none | none | unknown; 0 of 8 attempts valued |
| claude | claude-sonnet-5-5 | work | 9 | 6365013 | 103378 | 3.83 | 9: $3.83 | none | provider-reported; 9 of 9 attempts valued |
| claude | claude-opus-5-5 | root | 1 | 6149340 | 8584 | 2.35 | 1: $2.35 | none | provider-reported; 1 of 1 attempts valued |

## Where the time went

Elapsed not observed (as of 2026-11-13T05:50:36.408Z); elapsed is the run's window and phase figures below are interval unions. Peak concurrency 5.

- **summed work (overlapping; not elapsed):** 1h 56m, each closed work interval counted in full

- **By phase (union, counted once):** work 53m 42s, wait 20m 34s, queue 0.1s, integration 29m 36s, examination 7m 31s, setup 1m 23s, startup 1m 34s, verification 24m 59s
- **Wait by blocker kind:** job 20m 33s, parent_slot 2m 47s
- **Unattributed:** not observed. **Ambiguous (open or incomplete, in no union):** 1h 17m
- **Endings:** integrated 2, merged 9, integration conflict 0, verification failed 0, failed 0, deferred 0, examination stopped 2, examination skipped 0, other 0

Observed chain (not a claim about a faster schedule): covers 1h 16m of not observed, coverage not observed, complete; 0 ambiguous step(s).

1. node_01M79JXZNPA3VN4NJP7KDZPJVE integration 2026-11-13T05:43:17.400Z to 2026-11-13T05:50:33.123Z (7m 16s, via end)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE work 2026-11-13T05:34:59.166Z to 2026-11-13T05:43:16.959Z (8m 18s, via work)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE startup 2026-11-13T05:34:58.410Z to 2026-11-13T05:34:59.166Z (0.8s, via attempt)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE wait 2026-11-13T05:34:58.165Z to 2026-11-13T05:34:58.409Z (0.2s, via attempt)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE integration 2026-11-13T05:27:20.787Z to 2026-11-13T05:34:57.272Z (7m 36s, via retry)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE work 2026-11-13T05:18:35.547Z to 2026-11-13T05:27:20.348Z (8m 45s, via work)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE startup 2026-11-13T05:18:34.841Z to 2026-11-13T05:18:35.547Z (0.7s, via attempt)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE wait 2026-11-13T05:18:34.711Z to 2026-11-13T05:18:34.841Z (0.1s, via attempt)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE integration 2026-11-13T05:10:50.850Z to 2026-11-13T05:18:34.023Z (7m 43s, via retry)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE work 2026-11-13T04:34:10.709Z to 2026-11-13T05:10:50.417Z (36m 40s, via work)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE startup 2026-11-13T04:33:55.271Z to 2026-11-13T04:34:10.708Z (15.4s, via attempt)
1. node_01M79JXZNPA3VN4NJP7KDZPJVE wait 2026-11-13T04:33:55.117Z to 2026-11-13T04:33:55.271Z (0.2s, via attempt)

## Delivery

9 work item(s) and 0 repair job(s) in 2 strand(s); 9 attempt(s), 8 helper call(s).

- **First-attempt success:** all jobs: 9/9 (100%), 0 unfinished; coverage complete
- **Excluding repair jobs:** jobs: 9/9 (100%), 0 unfinished
- **Outcomes:** landed 9; failed by none
- **Rework:** 0 attempt(s), each counted once
  - unknown cause: 0 attempt(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
- **First attempts:** input 6365013, output 103378 tokens (complete coverage: complete 9); estimated not observed, reported $3.83 (provider-reported)
- **All rework:** input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed

## Human verdict

A person's one-click verdict on whether the run worked. It is not a verification and says nothing about why.

- Verdict: **not rated**
- This program: 0 of 0 ended run(s) rated; 0 worked, 0 did not; positive share among rated n/a; 0 unrated.

## Review

- **Coverage:** 2 node(s) examined, 9 examined by strand, 0 landed unexamined, 0 skipped; 4 examination(s) (passed 1, findings_raised 3)
- **Dispositions:** 5 unique finding(s); latest unresolved 1, fixed 4; rulings none. fixed means the finding was not raised again; upheld means the arbiter agreed. Neither is independently established truth.
- **Overhead by role (apart from repairs):**
  - examiner: 4 call(s); input 1703309, output 5629 tokens (partial coverage: partial 4); estimated not observed, reported not observed; 4 unpriced
  - answerer: 0 call(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
  - arbiter: 0 call(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
  - plan review: 4 call(s); input 971178, output 4540 tokens (partial coverage: partial 4); estimated not observed, reported not observed; 4 unpriced
- **Repairs caused by review:** 2 attempt(s); input 4038631, output 9447 tokens (partial coverage: complete 1, partial 1); estimated not observed, reported $1.20 (provider-reported)
- **Linkage:** findings linked 4, unresolved 1; 0 helper call(s) unlinked; 0 repair(s) without findings

## Machine

- **Lifetime:** not observed (coverage unknown; 0 observed ending(s), 0 runner-only ending(s); last machine ending not observed, last runner ending not observed; 1 attempt(s) without an observed end; gaps between attempts 0.0s)
  - attempt 1 (dispatch): machine end unobserved, runner not ended
- **Instance:** $0.59 for 4783s (runner-metered 4783s), runner-metered seconds; machine end unobserved (lower bound) (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2; unknown)
- **Volume:** $0.01 for 4789.839s, open (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2)
- **Total:** $0.60 (Instance: 4783 s from runner-metered seconds; machine end unobserved (lower bound) at 0.44352 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2); volume: 4789.839 s from request to asOf (not yet deleted) at 0.010958904109589041 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2).)
- **Recorded spend:** {"estimatedUsd":10.907493698630137,"ceilingSeconds":86400,"meteredUsd":0.6038257217656013,"meteredSeconds":4783}; computed $0.60 against metered $0.60 over 4783s (computedUsd prices instance and volume together over spend.meteredSeconds, as meteredUsd does; the components above use each one's own observed lifetime.)
- **Occupancy:** coverage partial; busy 0.0s at least, idle not claimed (No attempt has an observed machine end (terminatedAt), so idle time is not claimed; busy time is observed busy time, at least.), provisioning 2m 19s, setup not observed; peak 0 concurrent occupant(s)
- **Per-node shares:** none. No attempt has an observed machine end (terminatedAt), so cost cannot be apportioned to nodes. Each observed-closed attempt costs its observed machine lifetime (terminatedAt - startedAt) at the instance rate, split by occupied time within that same window (concurrent occupants share each moment equally). The cost of attempts without an observed machine end (open, or machine end unobserved) is never apportioned and is listed per attempt, together with unoccupied time within closed attempts and the whole volume, as unapportioned.

## Request evidence

Per-request ledgers are stored as artifacts. Fetch one through the authorized download route:
operation `artifact.createDownloadUrl`, `POST .../artifacts/{artifactId}/download-url`.

| Attempt | Artifacts | Ids |
|---|---|---|
| node_01M79JXZNPA3VN4NJP7KDZPJVE work #1 | 30 | art_01M79K09RBD4BHHNM9Y2JJ84B1, art_01M79K2SVDSPJZRB39VB12D2Q5, art_01M79K4W239PSWP59AXWSS1MA5, art_01M79K73K9SY4JDXBSSKWBMAG9, art_01M79K9EHDN5RSGF7V6RCX2J30, art_01M79KBH7CP1GNMA536VJEHJHA, art_01M79KDSG67GE46566KPAZ269P, art_01M79KFVM0WXRZBQBVVM9GGPF9, art_01M79KHQGWJTK3H1VP6M3B8Q4S, art_01M79KME3HMGBF48KGG7Q6FBQY, art_01M79KQ2ENSYP7NEV9BTNGK300, art_01M79KS0K1WFWVFN8P18KS2DEX, art_01M79KVRFGMTPNRBM5JDQP8HRC, art_01M79KXSBJTM7GFKE3MS7CQNY8, art_01M79M0AZ169SQRWXBP0FJG1BZ, art_01M79M270FQHJPGYGXE76Z78SN, art_01M79M4XEKV7VGBEXGCVS8G3V9, art_01M79M7G0NFR35RGYJJPS5EZ2S, art_01M79M9FY41Z7PB4WA4RT6PQ65, art_01M79MC7TM7ZX74BNJ491VTEN0, art_01M79MEKKJT250QAJCEC54SXDT, art_01M79MGTA4ZNNVKEMBY3384ZR5, art_01M79MJNGRJQP198Y5MTG567JV, art_01M79MMN0HG23H4D6PY2WCX515, art_01M79MPJJS6YZZG997CYWR6KVS, art_01M79MS1ZQ7DTQFYBK25TVF0XQ, art_01M79MVSW805YZYY3773MKDR91, art_01M79MXQ4FKXWE0HNP5JP93RV8, art_01M79N0CBSNWY3BCSKWY4C3ZPD, art_01M79N1KFYEPFQMZD4NQX1TWM6 |
| node_01M79JXZNPA3VN4NJP7KDZPJVE examine #1 | 2 | art_01M79K7FKH0M74BVMJXARTS5XB, art_01M79K7FY00AMB8R515SF3253W |
| node_01M79JXZNPA3VN4NJP7KDZPJVE examine #1 | 2 | art_01M79KBPEVC23BQKC6A5HJ7B00, art_01M79KBPSY33162QTR8BZHA8FF |
| node_01M79JXZNPA3VN4NJP7KDZPJVE examine #1 | 2 | art_01M79NFPR7GCWA394FAJNBHZN6, art_01M79NFQ4JRPS91XTSKEHM0397 |
| node_01M79JXZNPA3VN4NJP7KDZPJVE work #2 | 7 | art_01M79NJDH5FBFK2T0WQH895EPM, art_01M79NMBVYBCQAYV6A8461C2S1, art_01M79NQ3RDPW6KND5F9V6FSEEQ, art_01M79NSP10YFF8SBHJ6GAR257S, art_01M79NVP80293NWA8PM4FHX6D3, art_01M79NYE4FWQGZM6EC5TPV193R, art_01M79NZT786J0W7ZDGN8277PAH |
| node_01M79JXZNPA3VN4NJP7KDZPJVE examine #1 | 2 | art_01M79PDPTJDMAQRE38NHQBXKG3, art_01M79PDQ6AVW7V17KRGDFEXKJT |
| node_01M79JXZNPA3VN4NJP7KDZPJVE work #3 | 7 | art_01M79PGHTCTVJ9CTBQTQFM6EJZ, art_01M79PJHFT5NBD99QD6ZZZ5SA6, art_01M79PN49VAQE5D6H1G6BWC4EE, art_01M79PQVE1NTPKYE48X0Q1PXHM, art_01M79PSPSFVCF1GKB9GHDJYNQP, art_01M79PWENYEBVQJ45VN5EYJ682, art_01M79PX0D8NF7JDSVS4G9S5GYE |
| node_01M79JXZNPA3VN4NJP7KDZPJVE examine #1 | 1 | art_01M79QA83C5PC1H647F87ZEJP2 |
| node_01M79JYF7WXYSESGFKTP0BG2Z8 work #1 | 9 | art_01M79K0HFFRWFQHJQ8QYTMBYHT, art_01M79K2PTTMNYCBXPSBMX25H59, art_01M79K53SH20XWD94DN2YC3BAF, art_01M79K7C9PTF77GXWGKB70V399, art_01M79K9P91PZT4NMPS3053Y5H5, art_01M79KCE5JNQ73RWSDJTV36KSF, art_01M79KEBZNM53TJX929A3GZRBX, art_01M79KGGC1D9W8HVZNNE44SY9M, art_01M79KH2XY9NEX9DG895F49S2E |
| node_01M79JYF7WXYSESGFKTP0BG2Z8 examine #1 | 1 | art_01M79K2682M4WDCZVH1WK754HG |
| node_01M79JYF7WXYSESGFKTP0BG2Z8 examine #1 | 1 | art_01M79K3BBRSWKEZKZTB60PR8PT |
| node_01M79JYF7WXYSESGFKTP0BG2Z8 examine #1 | 1 | art_01M79KXS3V163MKS3SZ88YX452 |
| node_01M79K3Q6EQVM6Y48C2R2MAQ1H work #1 | 2 | art_01M79K6PZB0A235SFD6NPS892G, art_01M79KG8K4E611CPWJKHV3RDSH |
| node_01M79KCDW9B32SP4TP535XMDFQ work #1 | 2 | art_01M79KFDN3Q0PWRXRWBBJ1PZZH, art_01M79KTA8MV47Z6YD3D6QXY2JW |
| node_01M79KCW1ABD45G7WT36NQ6ZWE work #1 | 3 | art_01M79KX7CX3S529GHCAF3Q904D, art_01M79KZ53Y5EGN294ERAWH48CT, art_01M79KZ7K09Q6V8SRWMFSH752W |
| node_01M79KD1VKTCNKP57G7DK0HYHX work #1 | 2 | art_01M79KWNTEGC753BYBBKGB33VK, art_01M79KXJA3312F25Q1NBMB2XA6 |
| node_01M79KDMQ8MWHK79HABCRF6VTD work #1 | 6 | art_01M79M28E89WKFNA2QEMY1P4QX, art_01M79M4A89SJ1HFRG06PQWJFYR, art_01M79M6TXS4N1TR6AGDP8C1KD5, art_01M79M9JTA74VCEH67YD8V26NT, art_01M79MHR196TZYZR7JY602C5S3, art_01M79MJFPEPPGFA1T3TVF6SC3W |
| node_01M79KDRC5Z56RMS7HEVJB4KRG work #1 | 2 | art_01M79M1K1041MXGM2AFJV5GH4F, art_01M79M219T18NB0EHBEK6EJSYX |
| node_01M79KE087J2CTGVRMJ8FG0JYK work #1 | 3 | art_01M79MN7M116P78XE1JWX17PAV, art_01M79MQAVC40FC5SR7BN4NDD1M, art_01M79N0X0FC3W7R3TVSD5EY12J |
| node_01M79NGG07H7E0FJJK673Y8KFR work #1 | 3 | art_01M79NJQP68GGVN8XYYJ0FNKDD, art_01M79NNAFCGG14DH6BMT6AY77T, art_01M79NZ8JWVH0MK10SQX9HGF7Z |
| node_01M79PEYP1R8EJP3Y5Q2MNBC39 work #1 | 2 | art_01M79PH6FAXWDGPHC3X3Q0514V, art_01M79PW9BG05GR3XNYNRG0N58X |
| node_01M79JR6Q9A5M7D9413P2MMQ5J root #1 | 58 | art_01M79JYWTGZ84PQ1DETA1P23R9, art_01M79K14FWP9P30NEJZBW19J50, art_01M79K3WCEP9CG1W1MZJ5CZJJ8, art_01M79K64G48TR7CR2WGJAHHBP9, art_01M79K8EVYJ5NW86ZHYQEQYC9B, art_01M79KB6RE24X5ECKC7N3RJEM1, art_01M79KD68Q7W3QK1DPP6377G26, art_01M79KFS81P44S81TVJKGN7RXC, art_01M79KJGBC7EJGSSTEYQDSE3SA, art_01M79KMBQPV1FATF5J70QD4931, art_01M79KQ3M8ARG8RWSK464RR86D, art_01M79KSJ3YB5WEZVK9GMQM8ATJ, art_01M79KVP3ST4PS22E2ZZTS0TCW, art_01M79KXZVD7TJM7PK591KG2XVB, art_01M79M08KC0TZXAF83B9XZNA9P, art_01M79M30FXFEYQ4ZYGW59ZBMXJ, art_01M79M57GENG0G3W6J657TRP49, art_01M79M7JZH9QS6EG038CM9VJ96, art_01M79MAAW1GD8TM59DFRA9DP8X, art_01M79MC9A5Y7E91M8DAYCJHE78, art_01M79MEXBKRXS0RQ63ZG01M1B4, art_01M79MHMBB5PFR30XM71HCMZJW, art_01M79MKFV54DTYYPMFRZQXDDK9, art_01M79MP7QS5N8NNADNC1S5ECPV, art_01M79MRV1GABKPAKDZFS6E8ZC6, art_01M79MTT7D3F1VYFQRNPKQH3YC, art_01M79MXJ3XPCNN6RGT6F6GP0RY, art_01M79MZXST7KMK8VX4D0NXXMTH, art_01M79N24KFR7VFEBY6RZ3T1SQT, art_01M79N4WG1VBJ6JP7CJHHW72VD, art_01M79N6XMCV2N8D703NR1Y5Y1R, art_01M79N9EZKBAP40QB0ANA8XKTC, art_01M79NC6QQ5A95EM6H670T76P8, art_01M79NEYRPHMMNRRRGJKFKK9SS, art_01M79NHHT1A2QY21E5N0B4FWNG, art_01M79NKH89JQCFEM0VGSWRYSZ9, art_01M79NP94TV0DVVQ0G5MGPYSVZ, art_01M79NRSF6A1JVQTCCD37D6MNJ, art_01M79NTVMCDE0CCYM31EH8ZRKJ, art_01M79NXKGYKQBFDPMVNWNACYD3, art_01M79P005813EE7BWSKXHDC1EY, art_01M79P260QZ7E6R8FSZNX3DFMW, art_01M79P4XX89J9A9B11ZG9WGZBV, art_01M79P70Z88HJQRV813DNJ08NR, art_01M79P9GCS6VE07P2HT2F5WXCW, art_01M79PC74K98V4PB3B6VQFZAS6, art_01M79PE2WC4RC18Q3DJ9F1WR8Q, art_01M79PGTRXD0JDVS0C9P7NV2PM, art_01M79PK60YDNPB4HPHWRQSWNZX, art_01M79PND8H18W0YCNV349Z058D, art_01M79PR55445Q8JPT96TBV65EX, art_01M79PT9R93ZQ9YRMHRV8G5QMK, art_01M79PWQMQHT84HP1YQY3M9N1M, art_01M79PZFHA02GCDX32HTSSF5TS, art_01M79Q1FF2FTD48QXSSYWQ270X, art_01M79Q420Y4EJBKPGBD0FF8H0K, art_01M79Q6PKG97266WKWDWSHMPCF, art_01M79Q8MGHKCQXPKM6D954XQTD |

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
