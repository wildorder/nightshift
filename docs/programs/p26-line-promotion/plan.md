# P26 The Line Opens Its Promotion

## Overview

A project whose line is a development or staging branch can ask Nightshift to
keep **one pull request open from the line to the branch it promotes to**
(`"line": { "branch": "develop", "promote": { "to": "main" } }`). The pull
request's head is the line branch itself, so it moves as the line moves; its
body says what the line holds that the target lacks: the programs and
part-programs, their reports, the repairs Nightshift made on the line, and the
verification that proved the head commit it describes. The team reviews it and
merges it when they choose. Nightshift never merges it and never resolves a
conflict at it: when the target holds commits the line lacks, it says so, with
the fix, instead.

It builds on P25 (A-69): the line is the branch work ships from, and promotion
beyond it is the project's. This program gives the projects that promote by
pull request a pull request worth reviewing; a project whose line is `main`
names no `promote` and is unchanged.

Not delivered here: pinned, immutable candidates (the owner chose a moving
head, D-01); merging the pull request, a Deploy button, or any deployment;
changing a repository's branch protection or merge settings.

## Who it is for

US-01 is a team whose line is a `develop` or `staging` branch and who promote
to `main` by reviewed pull request. Since P25 nothing tells them what the line
holds that `main` lacks, or what proved it; they would open the promotion pull
request by hand and write its description from memory.

## Architecture

What the code map (2026-11-12) found:

- **The line config** is `LineConfigSchema` (`packages/contracts/src/v1/line-config.ts`):
  `branch` and `monthlyUsd`. It is inherited into the contract (`line`), so the
  plane reads it from the line program's contract as it reads the branch.
- **The publisher Lambda is the only GitHub writer** (D-P10-22). It pushes the
  line by compare-and-swap (`apps/api/src/runner/publisher.ts`, `publishLine` /
  `pushLine`), and the line record keeps `push` (head, status) and the newest
  50 `compositions`, each with its ranges, repair and verification
  (`packages/contracts/src/v1/line.ts`).
- **The GitHub port** (`packages/core/src/ports/github.ts`) has `branchHead`,
  `defaultBranch` and the read/write tokens; nothing opens a pull request. The
  App's write token asks for `contents` and `workflows`, falling back without
  `workflows` when an installation has not granted it (`apps/api/src/github/app.ts`).
  The App holds "Pull requests: Read and write" on the `wildorder` installation
  (granted 2026-11-04).
- **The abandoned `program/p25-line-feeds-main`** opened, read and closed pull
  requests (`4a00401`: `pullRequestToken` with `pull_requests: write`, `open`,
  `get`, `close`). Read it as a reference for the GitHub calls; do not
  cherry-pick it: its candidate model is dead.

Afterwards:

```
 nightshift.config.json   "line": { "branch": "develop", "promote": { "to": "main" } }
 line push published       ─► publisher: compare main...develop at GitHub
                              ├─ develop ahead, main not ahead ─► open or update THE pull request
                              │                                    (head develop, base main, body from the records)
                              ├─ develop not ahead             ─► nothing to promote (no pull request)
                              └─ main ahead of develop         ─► say so: body banner + line status, with the fix
 reconciler tick           ─► main moved (a merge, a hotfix) ─► ask the publisher to refresh
 a person                  ─► reviews and merges (merge commit) — never Nightshift
```

## Strands

### S-01 The promotion pull request

**What will exist afterwards.** A project with `line.promote` has, whenever its
line is ahead of the target, exactly one open pull request from the line branch
to the target, kept current by Nightshift after every line push and whenever
the target moves. Its body says what it promotes and what proved it. When the
target has commits the line lacks, the body leads with that and the remedy, and
`nightshift line status` says it too. When the App cannot open pull requests on
the installation, the line keeps composing and `line status` says what to grant.

#### Approach

- Config: `LineConfigSchema` gains `promote: { to: string }` (optional); a
  `to` equal to the line branch is refused by `plan check` and by the config
  parser, with the fix in the message.
- GitHub port and App client: `compare(installationId, repository, base, head)
  → { aheadBy, behindBy }`, and pull requests (find the open one by head and
  base, open, update title and body, read state), on a token minted with
  `pull_requests: write`; an installation that has not granted it is reported
  as such, not retried.
- The pull request's body is a pure function in `packages/core` over the line
  record, the target's state and the plan drafts: the head commit it describes;
  the programs on the line the target lacks, each with a link to its report on
  the line branch and whether the program is whole or part (its run has not
  ended `succeeded`); the repairs made on the line with their decisions; the
  head's composition verification; "merge with a merge commit". Bounded in
  size, for GitHub's limit. Records older than the 50 kept compositions are
  named by GitHub's compare (commit subjects `Merge program … into the line`),
  not lost.
- The publisher maintains the pull request after each successful line push;
  the reconciler, each tick, compares the target's head with the one the line
  record last saw and asks the publisher to refresh when it moved. The line
  record keeps the pull request's number, state and the target head it last
  saw.
- Divergence (the target ahead of the line, including a squash or rebase merge
  of an earlier promotion) is reported in the body's first lines and as a line
  waiting reason, naming the commits and the remedy (merge the target into the
  line, or protect the target so only the promotion merges into it). The line
  keeps composing; nothing merges the target into the line (P25, D-03).
- `nightshift line status` shows the promotion: the pull request, its state,
  the head it describes, and any divergence.
- Tests: the body function in `core`; the publisher and reconciler with a fake
  GitHub (open, update, nothing to promote, diverged, merged, closed by a
  person, permission missing); the line end-to-end test gains a promoting line.

The publisher's GitHub writes and the divergence rule are the risky parts; their
jobs are high risk.

#### Considered and rejected

- **A pinned candidate per qualified head** (the abandoned design): every line
  push supersedes and closes a pull request, and reviewers chase numbers. The
  owner chose a moving head (D-01); GitHub's "dismiss stale approvals on new
  pushes" covers a push after review.
- **Merging the target into the line when it diverges**: P25 D-03; the line's
  inputs are its own head and its queued ranges.
- **A GitHub Action in the project**: it can open a pull request, but not say
  which programs, repairs and verification it holds; that is Nightshift's record.

### S-02 Saying it: architecture, skills, status

**What will exist afterwards.** `docs/architecture.md` has row A-70 recording
the promotion pull request. The run-program, plan-program and nightshift skills,
and AGENTS.md where it speaks of the line, say how a staging line promotes:
`line.promote`, one moving pull request, merge with a merge commit, protect the
target so only the promotion merges into it, and that Nightshift never merges it.

#### Approach

- `docs/architecture.md`: row A-70 in the file's style, noting it amends A-69.
- `skills/*/SKILL.md` and `AGENTS.md` where they describe the line.

#### Considered and rejected

- Leaving it to the config reference alone: a team choosing between a `main`
  line and a staging line needs the trade-off where it reads about lines.

## Decisions

D-01 to D-03 are in the contract, all answered by the owner on 2026-11-12.

## Risks

- **Writing pull requests in a customer's repository.** Only with `promote`
  set, only on the one pull request the line owns; nothing merges or closes
  anything else.
- **A squash-merge habit.** A team that squashes the promotion leaves `main`
  with a commit the line lacks every time; the divergence report says so, and
  the skills say to merge with a merge commit.
- **The trial needs a staging line.** foodfly's line is `main` (P25); the trial
  is `wildorder/nightshift-line-sandbox` with a `develop` line promoting to
  `main`, after this ships.
