# P25 The Line Is Where Work Ships

## Overview

A project's line stops being a preview beside main and becomes the branch its
work ships from. The project names it in `nightshift.config.json` (`main`, a
`staging` branch, any branch), and Nightshift's responsibility ends there:
promoting that branch onwards (staging to production, release tags, deploys)
is the project's own CI/CD. Programs start from the line, their work is
composed onto it as it lands, whole or part of a program, and each conflict
between programs is resolved once, on the branch that ships.

Three things change to make that true, and the rest of the line (P23, P24) is
kept: the composer starts from the line's own head and takes in nothing else;
a program's base branch is the line; and a line branch that refuses Nightshift's
push (branch protection) holds the line with a reason instead of recomposing in
a loop. The guidance that assumed the old shape (program pull requests into
main with merge commits, the line as a preview, D-05) is replaced.

Not delivered here: promotion, release tags or a "what is in this commit" view
for whoever cuts a release (a later program can add it on top of the line's
composition records); feature-flag tooling (half programs are kept safe by
convention, in the planning guidance); and any change to a project's own
repository or pipeline.

## Who it is for

US-01 is the owner running programs in parallel. On foodfly (2026-10-30 to
11-01) the line resolved a conflict between two programs, then the second
program's pull request hit the same conflict at main and another agent resolved
it again by hand, differently; main and the line diverged, main stopped
merging onto the line, and every range after that parked. US-02 is any team
with its own way of shipping: today the line can only be a preview, and the
owner wants others to "organize their CI/CD the way they want". US-01 matters
most and drives the shape; US-02 is why the branch is a setting, not `main`.

## Architecture

What the code map (2026-11-09) found:

- **Nothing refuses a line branch named `main`.** `LineConfigSchema` takes any
  branch; the line program's `programBranch` is the line branch
  (`core/src/line/program.ts`). With the line on the default branch, the
  composer's "merge main into the line" is a no-op (`line/git.ts` returns the
  unchanged head for a contained commit).
- **The composer merges the GitHub default branch, not `baseBranch`**, before
  every batch (`apps/mcp/src/runner/line-owner.ts` `fetchHeads`, `compose.ts`
  "Merge main … into the line"); in the one-at-a-time fallback a conflict or a
  red check there parks every unit with "main does not compose onto the line",
  no repair and no cause (`compose.ts` ~640-693). That is the foodfly stall.
- **Programs start from `repository.baseBranch`** (CLI `ensureProgramBranch`,
  remote readiness, the plane's line-base fallback in `operations/dispatch.ts`,
  end gates' `baseSha`). The engine itself works only on `programBranch`.
- **A protected branch loops.** The publisher classifies a protection refusal
  (`publisher.ts` `classify`), `resolvePush` requeues the composition's ranges,
  the owner treats it as rejected and composes again: bounded only by the caps.
- **Nightshift opens no pull requests anywhere.** "Programs reach main by
  their own PRs" lives only in A-66, P23's D-05 and the run report's wording.
- **A line run always ends `succeeded`**, even when it parked every range it
  took (foodfly, 2026-10-31: fifteen such runs, unnoticed for five days), and
  **parked is forever**: nothing sends a parked range back to the queue.
- **A line run is created and then ended every ~20 s while the org's machine
  ceiling is full** (seen twice on 2026-10-29): admission happens after the run
  is made, so each refusal leaves an interrupted run behind.

Afterwards:

```
 nightshift.config.json   "line": { "branch": "main" }        (or "staging", …)
 program                  base = the line branch (inherited; plan check holds it)
 run lands on program/…   ─► queued for the line, as today
 line run (P24)           line head ─► + each range ─► checks ─► CAS push to the line branch
                          conflict / red ─► repair job (P24), on the line, once
 the line branch          promoted onwards by the project's own CI/CD (out of Nightshift)
```

What stays exactly as it is: program runs, strands and landing; the queue, path
reservation, repair budget and parking (P24); the publisher's compare-and-swap;
projects with no line.

## Strands

### S-01 The line composes the branch that ships

**What will exist afterwards.** A project's line may be any branch, including
the default branch. The composer starts every batch from the line's own head
and merges only queued ranges onto it; anything pushed to the line branch by
someone else is simply in that head. A program of a project with a line has
the line as its base branch. A line branch that refuses Nightshift's push holds
the line with its reason and remediation and composes nothing more until the
refusal is cleared. A line run is only made once it is admitted.

#### Approach

- Composer (`packages/execution/src/line/compose.ts`,
  `apps/mcp/src/runner/line-owner.ts`): drop the default-branch fetch and the
  main merge, the "main does not compose" park and its wording; `mainHead`
  leaves `LineComposerPorts`. A line branch absent at the remote is still
  created, from the repository's default branch head (the only time anything
  but a range enters).
- Base branch: `inheritFromConfig` (`packages/contracts/src/v1/config.ts`)
  makes a contract of a project with a line take `repository.baseBranch` from
  `line.branch` when it states none; `plan check` refuses a contract whose base
  differs from the line, with the fix in its message. The CLI's program-branch
  creation and the plane's line-base fallback then read the line through the
  contract as they read `baseBranch` today.
- Protection: a `protected` or `forbidden` line push is not requeued for
  recomposition. The line record gains a waiting reason (the existing `waiting`
  field) naming the branch and the remediation (allow the Nightshift App to
  bypass the branch's protection); the owner idles out; a new landing or the
  line's existing retry path tries the push again once.
- Honest line runs: a line run that parked anything it took ends `failed`, its
  failure reason naming the parked ranges, and its report leads with them.
- Requeue: `nightshift line requeue [<program> | --all]`, a user operation,
  moves parked entries back to the queue with their repair count reset, records
  who asked, and starts a line run. Refused for engine principals.
- Admission before the run: the plane admits a line run (org ceiling,
  self-started cap) before it creates the run; a refusal records the line's
  waiting reason and makes no run.
- `nightshift line status` names the line program and the branch's role.
- Both were built once on the abandoned `program/p25-line-feeds-main`
  (c798bd3, 0443cd3) against the old composer; read them, do not cherry-pick
  them: they are rebuilt here against this composer.
- Tests: the e2e (`test/src/line/line-e2e.test.ts`) gains a line on the
  repository's default branch, a direct push to the line between batches, and a
  protected line branch; the composer's main-merge tests are removed with it.

The composer, the publisher's refusal path and the plan-check rule are the
risky parts; their jobs are high risk.

#### Considered and rejected

- Keeping the default-branch merge with a repair job when it fails: the owner
  ruled that the line's inputs are its ranges and its own head (D-03); a
  staging line's hotfix flow is the project's CI's.
- A preview line mode beside the shipping line: retired (D-01); its double
  resolution is built in.
- Forcing the push past protection, or Nightshift editing branch protection:
  a security posture only the owner sets.

### S-02 Saying it: architecture, skills, report

**What will exist afterwards.** `docs/architecture.md` has a row recording the
line as the branch work ships from, amending A-66 and A-67 and retiring D-05's
pull-request path. The run-program and plan-program skills, and the nightshift
skill where it speaks of landing, say: name a line and programs start from it;
work reaches the line whole or in part as it lands; promotion beyond the line is
the project's; and, for a line that ships, user-facing work of an unfinished
program stays unreachable (unrouted or behind a flag) until its program
completes. A run's report says where its work reached the line instead of
telling anyone to open a pull request.

#### Approach

- `docs/architecture.md`: row A-69 (A-68 is pause/cancel/land); A-66 and A-67 note the amendment in the
  file's existing style.
- `skills/*/SKILL.md` and `AGENTS.md` where they describe the line or landing.
- `packages/core/src/report/`: the publication and next-step wording for a
  program of a project with a line.

#### Considered and rejected

- Leaving the skills to describe both shapes: a line is one thing now.

## Decisions

D-01 to D-03 are in the contract, all answered by the owner on 2026-11-09. How a protected line holds (S-01) is a defect fix the acceptance pins, not a decision.

## Risks

- **Writing to a shipping branch.** A bad composition now lands on what the
  project deploys from (staging, or main feeding staging). The landing checks
  and repair examination are unchanged and high risk; the project's own
  pipeline is the next gate. Worth saying in the guidance.
- **Half programs on the line.** Safe only by convention (S-02); a planning
  skill that does not say it loudly enough lets an unfinished screen reach
  staging.
- **The trial needs the owner.** Moving foodfly's line to `main` and allowing
  the App past main's protection are the owner's changes, after this ships.
