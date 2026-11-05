# Program P25 — The Line Feeds Main (Pipkin M2)

| Field | Value |
|-------|-------|
| Program ID | `p25-line-feeds-main` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p25-line-feeds-main` |
| Source stage | Pipkin M2 (PK-2, PK-4, PK-5, PK-6), reshaped by the owner on 2026-11-04 (§3.1) |
| Status | **Ratified 2026-11-04** (all of §3.2); building |
| Built by | An agent **in a coding session**, not a Nightshift run (the owner, 2026-10-15; reaffirmed 2026-11-04) |
| Depends on | P22 (evidence names its inputs, A-65), P23 (the project line, A-66), P24 (the line owner is a run, A-67), P10 (the publisher and the GitHub App) |
| Blocking decisions | D-P25-01 … D-P25-18 (16 to 18 amended in on 2026-11-05) |

This contract is the stable authority for P25. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Make the project line **the only road to main**, so that a conflict is resolved
once, by Nightshift, on the line, and never again at a pull request. Anything
on the line is deployable; a qualified snapshot of the line becomes a
**candidate**; Nightshift opens one pull request from the candidate to main;
and a person, engineer or not, ships it from the Studio with one button, never
meeting a conflict.

**What P25 is not.** No deployment machinery: projects keep deploying from
main as they do today. No strand-level feeding of the line (that is M3, behind
"safe to ship alone" strands). No laptop `nightshift verify` (PK-2's CLI form
waits until it has a consumer). No change to how a program's own run builds,
verifies, examines or lands on its program branch.

### What exists today

- **Two roads to main, two resolutions.** Programs reach main through their own
  pull requests (A-66, D-05 of P23), which a human opens and merges. The line
  composes the same work separately. On 2026-10-30 foodfly's line resolved
  platform-dispatch against hood-page (`cd61257`); hours later the hood-page
  pull request was resolved again, by hand and differently (`7c17866`). From
  2026-10-31 every line run parked every range with "main does not compose onto
  the line", fifteen runs in a row, and each ended **succeeded**. Nobody knew
  for five days. The line was reset to main's tree by hand on 2026-11-04
  (`3125882`).
- **P23 promised the pull request would point at the line's resolution.** It
  was never built (P23 conversation, line 473).
- **A main conflict is never repaired.** The composer parks every unit when
  main will not merge (`packages/execution/src/line/compose.ts:662-693`); the
  repair path only knows a program range (`ports.ts:165-170`). An unused
  `LineUnitSchema` `{kind:"main"}` exists (`line.ts:195-199`).
- **A line run always succeeds.** The owner completes with the default
  `{status:"succeeded"}` (`line-session.ts:118`, `line-owner.ts:551-554`);
  the report never ties status to what was parked.
- **Parked is forever.** No rule, route or command requeues a parked range.
- **The line takes strands as they land.** Each published intent queues a
  range (`publisher.ts:479-531`), so the line can hold half a program, and
  nothing marks a program as whole.
- **No home for a commit's own verification.** Verifications are run-scoped;
  the line's checks live only inside its composition records, without
  fingerprint or environment (`line.ts:83-98`). P22 left PK-2 for "where it is
  used".
- **Nightshift has never opened a pull request.** The App token asks for
  `contents`, `workflows` and `metadata` only (`apps/api/src/github/app.ts:89-120`).

## 2. Environment and human prerequisites

| # | Prerequisite | Needed by | Status |
|---|--------------|-----------|--------|
| H-P25-01 | Ratify D-P25-01 … D-P25-15 | T1 | done 2026-11-04 |
| H-P25-02 | **The GitHub App granted "Pull requests: Read and write"**, accepted on the `wildorder` installation | T6 | done 2026-11-04 (owner) |
| H-P25-03 | `aws sso login --profile nightshift` before each deploy | T9 | at deploy time |
| H-P25-04 | **The live proof's last step is a real merge to foodfly's main, which deploys.** The owner chooses when to press Deploy | T9 | at proof time |

**Explicitly not required.** No new AWS service and no new kind of machine:
everything new runs in the line run (A-67) or the existing Lambdas. A new
machine image is needed because the line owner changes.

## 3. Decisions

### 3.1 The owner's direction, 2026-11-04

| # | Question | Answer |
|---|----------|--------|
| Q1 | Should the line feed main? | "for this to work, line HAS to go to main right? souldn't we be opening PR's from line -> main" |
| Q2 | Build M2 now? | "maybe i'm inclined to build M2 now? isn't that the next step of our 'scion-esque' migration? we still need to fix the issues you mentioned before"; then "M2 should go ahead" of P17 |
| Q3 | Who merges a candidate? | The owner: "You merge" (a human gate before deploy; auto-merge may come later) |
| Q4 | When is a candidate cut? | "Automatically" |
| Q5 | What may be on the line? | "only publishable work should land on the line so that anything reaching it is ok to deploy"; chose **A**: a program joins the line only when its run succeeds. Strands that are safe to ship alone are M3 |
| Q6 | Partial runs | Never feed the line on their own; the owner says "ship what landed" explicitly (agreed with A) |
| Q7 | Who resolves conflicts? | "a non-engineer looking at a completed feature in the studio and being able to deploy it (merge PR) and who is going to resolve conflicts if main moved ahead?" Answered: Nightshift, on the line, always; the Studio offers only a current candidate. "yes please" to building the Studio Deploy button in P25 |

### 3.2 Proposed decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P25-01 | **A program joins the line when its run succeeds, as one range.** The publisher stops queueing a range per published intent. When a run of a program that names a line ends `succeeded` (every strand succeeded, end gates passed, publication settled: orchestrator.ts:474-540), the plane queues one entry `{program, upTo: the run's final published head, runId, whole: true}`. A deferred run joins when it is resumed to `succeeded`. Amends A-66 by a new A-68. | Q5. Every line head is then deployable by construction, so a candidate is just a qualified line head: no "all programs whole" bookkeeping and no waiting for a quiet moment that grows rarer with concurrency. The early warning lost was never acted on: nothing the line does can affect a run (A-66). |
| D-P25-02 | **Partial work joins only by the owner's word.** `nightshift line ship <program> [--run <id>]` queues the published head of a run that ended `failed`, `cancelled` or `interrupted`, after showing which strands landed and which did not, and records a decision with the owner's principal and words. | Q6. Shipping half a program is a product decision, never a default. |
| D-P25-03 | **Main is a unit of the line, with its own repair.** When main does not merge onto the line head, or merges red, the composer asks for a repair job (P24's path) with a new cause `line_main_conflict` / `line_main_red`, on a lineage keyed by main's head. Program ranges in the batch are **held** behind it, not parked. Three repairs (P24's budget); a spent budget parks main with the cause and the agent's last words, and the line stops taking work until the owner acts. | The 2026-10-31 jam. Under D-P25-01 main moves outside the line only by hotfix or hand commit, and that conflict is the line's to resolve, once. |
| D-P25-04 | **A line run says what it did.** It ends `succeeded` only if nothing it took was parked and any candidate it cut qualified; otherwise `failed`, with a failure reason that names the parked ranges or the failed candidate. The report leads with parked ranges and candidate state, before compositions. | The fifteen silent "succeeded" runs; the same failure class as 2026-10-14's publication break. |
| D-P25-05 | **Parked is not forever.** `nightshift line requeue [<program> \| --main \| --all]` moves parked entries back to the queue with their repair count reset, records who asked, and starts a line run. A user operation, refused for engine principals. | No way back today. |
| D-P25-06 | **Main moving wakes the line.** The reconciler, each tick, asks GitHub (the App's `branchHead`) for each line project's main head; when it differs from the `mainTakenIn` the line record keeps (the main head last merged onto the line), it queues the main unit and starts a line run. Merging a candidate moves main too; the line takes that in as a no-op. | Q7. A hotfix with no program after it would otherwise leave the open candidate stale indefinitely. |
| D-P25-07 | **A snapshot is a record, keyed by the line commit (PK-4).** `Snapshot { projectId, branch, commit, parent, programs[{program, runId, upTo}], compositionIds[], repairs[], verificationIds[], createdAt }`, written by the line run when a composition is pushed. The programs list is cumulative since main (what this commit holds that main does not). | The candidate needs "what is in it" and "what proved it" without reading a 50-entry rolling record. |
| D-P25-08 | **A commit's full verification has an honest home: the line run (PK-2).** It is a run-scoped `Verification` under the line run (the line's program and run, A-67), new phase `snapshot`: no job (`VERIFICATION_PHASE_HAS_JOB.snapshot = false`), never landing evidence (`LANDING_EVIDENCE.snapshot = false`), with `baseSha`, `gateFingerprint` and `environment` like any other. It runs **every** gate step, the program end gates' pipeline generalised to a scope and a commit (`end-gates.ts:106-185`), with flake reruns and kept logs. The snapshot names it. | P22's "no honest home before PK-4" is answered by A-67: the line owner is a run, so the record has a run, a node and an agent. One pipeline, not a second runner. |
| D-P25-09 | **A candidate is a qualified line head (PK-5).** `Candidate { candidateId: cand_<ulid>, projectId, branch, commit, snapshot, programs[], state, verificationId?, pr?, supersededBy?, createdAt, updatedAt }`, states `qualifying → qualified \| failed`, then `superseded`, `deployed` or `closed`. The line run cuts one when its queue is empty, the line head is not in main, and the head is not already a candidate. It verifies (D-P25-08) and settles. Immutable: a failed candidate is never edited into its replacement. | Q4, and the backlog's immutability rule. `candidate` the verification phase keeps its meaning; this record is "Candidate" in prose and `cand_` in ids. |
| D-P25-10 | **A red candidate is repaired on the line.** A failed qualification asks for a repair job, cause `candidate_red`, against the line head, under the same budget. Its fix lands on the line, and the next idle point cuts a new candidate. A spent budget leaves the candidate failed and the line run failed (D-P25-04). | Conflicts and red results are the line's, always on the line. |
| D-P25-11 | **A qualified candidate becomes one pull request (PK-6).** The GitHub writer (the publisher Lambda, sole holder of the App key) pushes the candidate commit to `nightshift/candidates/<candidateId>` and opens a pull request to main. Its body: the programs it ships (names and links to their plan and report), the resolutions made on the line (repair decisions), the qualification's commands and outcome, and "merge with a merge commit". At most one open candidate PR per line: opening a new one closes the previous with a comment linking it, and marks it `superseded`. | Q1. A pinned branch keeps the PR's content equal to what was verified; the moving line branch would not. |
| D-P25-12 | **Deploying is merging, by a person.** A user operation `candidate.deploy` merges the candidate PR with a merge commit, and only when: the candidate is `qualified` and not superseded, the PR's head is the candidate commit, and main's current head is an ancestor of it. Otherwise it refuses with the state in words. A merge made in GitHub's own UI is found by the reconciler and marks the candidate `deployed` too. | Q3, Q7. The person never meets a conflict; a stale candidate is never mergeable from Nightshift. |
| D-P25-13 | **The Studio line page.** The project's line shows the current candidate: what it ships ("This deploy includes: …"), its state in words ("Ready", "Checking", "Updating: main changed, Nightshift is re-checking", "Needs an engineer: …" with the reason), the **Deploy** button when ready, and the history of candidates and deploys. | Q7. The deploy unit is the line, not one feature, so the page must say everything it ships. |
| D-P25-14 | **Program pull requests stop for line projects.** Nothing opens them today, so the change is in words: the run report's "for the morning", the run-program skill and the README say the program "joins the line and ships in the next candidate", and the CLI's `line status` shows the candidate. Projects without a line are unchanged. | Q1. Two roads to main is the defect. |
| D-P25-15 | **Built in a coding session, verified by the repository's gates, proven live on foodfly.** The live proof: two real programs with a deliberate conflict succeed; both join the line; the conflict is repaired once; a candidate qualifies and opens one PR; a hand commit to main makes it stale; the line repairs, supersedes and re-qualifies; the owner presses Deploy in the Studio (H-P25-04). | P24's own exit trial (two programs, a conflict) was never run; this one covers it. |
| D-P25-16 | **Reversed the same day (the owner, 2026-11-05).** A pull request per program was built and taken back out before it was deployed: "i just needed SOME pr to be created so i knew what was finished and could be deployed". The line keeps one candidate, and one pull request, for everything main lacks; that pull request lists each program with a link to its branch. A merge marks every candidate cut at or before the merged one deployed, which is kept. | One queue means one pull request matches what a merge actually deploys; per-program pull requests would each ship the ones before them. |
| D-P25-17 | **Work that did not ship gets a draft pull request** (the owner, 2026-11-05). A run of a line program that ends `failed`, `cancelled` or `interrupted` with work on GitHub, and a program whose range the line parked, each get a draft pull request from the program's branch to main, titled "Not shipped: <program>", saying what landed, what did not and why, and pointing at `nightshift line ship`, `nightshift resume` and `nightshift line requeue`. It is closed with a link when that work later reaches a candidate. Never merged by Nightshift. | Today that work sits silently on a branch: "i think work is getting lost". A draft is visible where the owner already looks, and cannot be mistaken for something ready. |
| D-P25-18 | **The Studio is the status board, GitHub is where review happens.** The line panel lists each undeployed program with its pull request and state, and the not-shipped drafts, linking to GitHub. | "how else will i see what has landed on the line?" |

### Non-guarantees

- **A qualified candidate passed the project's gates, nothing more.** A gate
  that does not test a thing does not prove it.
- **Holding one finished feature back is not possible in P25.** A program that
  succeeded joins the line and ships with the next deploy. If that becomes a
  need, "joins when accepted in the Studio" is a small later change, not a
  redesign.
- **Repairs can fail.** Then the Studio says "Needs an engineer" and why; it
  does not hide it.
- **Main can still be pushed to directly.** That is a hotfix's road; the line
  repairs it in, once, and the candidate after it carries the result.

## 4. Design

### 4.1 The flow

```text
program run succeeds ─► plane queues {program, upTo, whole}        (D-01)
main moved?  ───────── reconciler queues the main unit              (D-06)
line run:  take main in ──conflict/red──► repair job (main lineage)  (D-03)
           compose each program ──conflict/red──► repair job         (P24)
           push, write Snapshot                                     (D-07)
           queue empty, head not in main ─► Candidate: qualifying   (D-09)
             full verification, phase `snapshot`                   (D-08)
             red ─► repair job, cause candidate_red                 (D-10)
             qualified ─► GitHub writer: candidate branch + PR,     (D-11)
                          close the superseded PR
           end: succeeded only if nothing parked and no candidate failed (D-04)
Studio Deploy ─► candidate.deploy ─► merge commit on main           (D-12)
reconciler: main moved ─► line takes it in (no-op after a deploy)   (D-06)
```

### 4.2 The records

```text
LineEntry      + runId?, whole?: true, shippedBy?: principal (D-01, D-02)
LineRecord     + mainTakenIn?: sha, candidate?: candidateId (current)
RepairCause    + line_main_conflict | line_main_red | candidate_red
Verification   phase + "snapshot"   (HAS_JOB false, LANDING_EVIDENCE false)
Snapshot       { projectId, branch, commit, parent, programs[], compositionIds[], repairs[], verificationIds[], createdAt }
Candidate      { candidateId, projectId, branch, commit, programs[], state, verificationId?, pr?: {number, url, branch}, supersededBy?, deployedAt?, deployedBy?, createdAt, updatedAt }
```

Old line records read unchanged: every new field is optional, and an entry
without `whole` is one queued under P23's per-intent rule, composed as before.

## 5. Scope

### In scope

- The line fixes: main unit repairs, honest line run status, requeue (T1).
- Whole programs joining on success; `line ship` for partial work (T2).
- Main movement waking the line (T3).
- Snapshot records and `snapshot` verifications in the line run (T4).
- Candidates: cut, qualify, repair, supersede (T5).
- Candidate PRs through the GitHub writer; deployed detection (T6).
- `candidate.deploy` and the Studio line page with Deploy (T7).
- CLI, report, architecture (A-68, A-69), README, AGENTS.md, skills (T8).
- Deploy and the live proof on foodfly (T9).

### Out of scope

- Strands that join early because the plan marks them safe to ship alone (M3).
- Background proving, batch-and-bisect, targeted checks (PK-7, M3).
- Auto-merge of candidates (Q3: later, once trusted).
- Nightshift owning deployment (backlog slice 6).
- Laptop `nightshift verify <commit>` and an MCP verify tool (PK-2's other form).
- Accept-to-join in the Studio (Non-guarantees).
- Reusing evidence between verifications (PK-11).

## 6. Success criteria

| ID | Criterion |
|----|-----------|
| SC-P25-01 | A program's published intents queue nothing on the line until its run ends `succeeded`; then exactly one `whole` entry is queued at the run's final head. A `failed` run queues nothing. |
| SC-P25-02 | `nightshift line ship` queues a failed run's head only after printing what landed and what did not, and records a decision naming the owner. |
| SC-P25-03 | A main that conflicts with the line produces a `line_main_conflict` repair job; ranges in the batch are held, not parked; after the repair lands, they compose. A spent main budget parks main with its cause and last words. |
| SC-P25-04 | A line run that parked anything, or whose candidate failed, ends `failed` with a reason naming them; the report leads with them. A run that composed everything and qualified its candidate ends `succeeded`. |
| SC-P25-05 | `nightshift line requeue` returns parked entries to the queue and starts a line run; engine principals are refused. |
| SC-P25-06 | A commit pushed to main outside the line causes the reconciler to queue the main unit and start a line run within one tick; a candidate merge causes a no-op take-in. |
| SC-P25-07 | Every pushed composition writes a Snapshot naming its programs since main and its verifications. |
| SC-P25-08 | A `snapshot` verification runs every gate step against the exact commit, carries `baseSha`, `gateFingerprint`, `environment` and logs, is never landing evidence, and the classification tables are exhaustive over the new phase. |
| SC-P25-09 | An idle line whose head is not in main cuts exactly one candidate; a red qualification starts a `candidate_red` repair; the failed candidate record is never changed into another. |
| SC-P25-10 | A qualified candidate has a pinned branch and one open PR whose body lists programs, line resolutions and evidence; a newer candidate closes the older PR with a link and marks it superseded. |
| SC-P25-11 | `candidate.deploy` merges with a merge commit only when the candidate is current (qualified, unsuperseded, PR head equal, main an ancestor); otherwise it refuses with the state in words. A merge in GitHub's UI is detected and marks the candidate deployed. |
| SC-P25-12 | The Studio line page shows what a candidate ships, its state in words, and Deploy only when deployable; a stale candidate shows "Updating" and no button. |
| SC-P25-13 | The live proof of D-P25-15 runs end to end on foodfly. |

## 7. Deterministic verification

The repository's gates (`npm run build`, `typecheck`, `lint`, `test`, `synth`,
sterility) on every task's commit. Each criterion SC-P25-01 … 12 has tests in
`test/src` against the in-memory stores and the offline GitHub stand-in the
publisher suite already uses (`GitRemote` local server). SC-P25-13 is the live
proof; its evidence is the run ids, PR numbers and commits, recorded in §13.

## 8. Constraints

- One verification pipeline: the `snapshot` phase reuses the end gates'
  pipeline; no third runner.
- One repair path: main and candidate repairs are P24 repair jobs, with their
  Agent records, examinations and decisions.
- Only the GitHub writer holds a write credential; the line owner keeps its
  read token.
- Every new record is create-only or moves by a pure rule in `packages/core`,
  like the line record.
- Windows test hygiene: no real-clock ratio assertions; LF line endings.

## 9. Permissions and forbidden actions

- Allowed: edits anywhere in this repository; deploying the Nightshift stacks
  after the owner's `aws sso login`; on foodfly, the live proof's programs,
  line runs, candidate branches and PRs.
- Forbidden without the owner: merging any candidate to foodfly's main (the
  owner presses Deploy); force-pushing any branch; changing GitHub App
  permissions; editing foodfly's code outside the proof's programs.

## 10. Tasks

| Task | What | Criteria |
|------|------|----------|
| T1 | **Line honesty.** Main unit with repair causes and lineage; held not parked; line run status and report; `line requeue` rule, route and CLI. | SC-03, 04, 05 |
| T2 | **Whole programs.** Publisher stops per-intent queueing for line programs; the plane queues one `whole` entry on `run.completed`; `line ship`. | SC-01, 02 |
| T3 | **Main wakes the line.** `mainTakenIn` on the record; reconciler compares main's head per line project and starts a line run. | SC-06 |
| T4 | **Snapshots and snapshot verification.** Phase `snapshot` and its tables; the end-gate pipeline generalised to `(scope, commit)`; Snapshot store (memory, SQLite, DynamoDB) and the line run writing it. | SC-07, 08 |
| T5 | **Candidates.** Record, store and rules; cut at idle; qualify; `candidate_red` repair; supersession. | SC-09 |
| T6 | **Candidate PRs.** App token gains `pull_requests: write` (with the same fallback as `workflows`); the GitHub writer's `{kind:"candidate"}` event: push the pinned branch, open, close-as-superseded; reconciler detects merged PRs. | SC-10, 11 (detection) |
| T7 | **Deploy.** `candidate.deploy` operation, route and authorisation; Studio line page with states and Deploy. | SC-11, 12 |
| T8 | **Words.** `line status` and report sections; architecture A-68 (whole programs join; the line feeds main) and A-69 (snapshots, candidates); README, AGENTS.md, run-program skill. | — |
| T9 | **Deploy and prove.** Stacks and image; the live proof on foodfly with the owner at Deploy. | SC-13 |

T1 is first because the line must be honest before anything is built on it.
T4 → T5 → T6 → T7 are in dependency order; T2 and T3 can be built beside T4.

## 11. Risks

| Risk | Mitigation |
|------|------------|
| Full-suite qualification is slow, and every idle point cuts a candidate | Supersession keeps one PR; a candidate in qualification is finished, not abandoned, and the next idle point cuts the next. Measure qualification time in the live proof before tuning. |
| A long-running program delays everything behind it | It does not: programs join only when they finish, independently of each other. |
| The deploy unit is the whole line, which may surprise a non-engineer | The Studio lists everything a deploy ships (D-P25-13); accept-to-join is the later lever. |
| GitHub refuses the PR permission | The token falls back as it does for `workflows`, and the candidate shows "cannot open a pull request: the App lacks Pull requests permission" rather than succeeding silently. |
| Repairs of main fight a human who keeps committing to main | Each main move is one lineage; a spent budget stops the line loudly (D-P25-03). |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-11-04 | Build M2 now, ahead of P17; in session | Owner |
| 2026-11-04 | A program joins the line only when its run succeeds (option A); strands that ship alone are M3 | Owner |
| 2026-11-04 | The owner merges candidates; candidates are cut automatically; partial work only by the owner's word | Owner |
| 2026-11-04 | The Studio Deploy button is part of P25 | Owner |
| 2026-11-04 | D-P25-01 … D-P25-15 ratified as drafted; Pull requests permission granted | Owner |
| 2026-11-05 | D-P25-16 … D-P25-18: a pull request per program, draft pull requests for work that did not ship, the Studio as status board | Owner |
| 2026-11-05 | D-P25-16 reversed before deploy: one pull request for everything main lacks, as it was; D-P25-17 and 18 kept | Owner |

## 13. As built

Built in session on `program/p25-line-feeds-main`, 2026-11-04. T1 to T8 are
done; T9 (deploy and the live proof) waits on the owner (H-P25-03, H-P25-04).

### Task states

| Task | State | Commits |
|------|-------|---------|
| T1 Line honesty | done | `0bbda27` main repaired, `c798bd3` honest status, `0443cd3` requeue |
| T2 Whole programs | done | `4b10c84` |
| T3 Main wakes the line | done | `99763fe` |
| T4 Snapshot verification | done | `e3cfe3c` |
| T5 Candidates | done | `d22bc23`, `472a56d` (red candidate repaired) |
| T6 Candidate pull requests | done | `4a00401` |
| T7 Deploy and the Studio | done | `1e3f168` route, `7edcf1f` Studio |
| T8 Words | done | this commit: A-68, A-69, the run-program skill, `line status`, the line report |
| T9 Deploy and prove | waiting on the owner | — |

### Build decisions, provisional until the owner ratifies or reverses them

- **BD-01, no separate Snapshot store (amends D-P25-07).** What D-P25-07 asked
  of a snapshot record ("what is in it and what proved it") is met by the line
  record's `undeployed` list (each program pushed since the last deploy, with
  the commit that first carried it) and by the candidate itself (its commit,
  programs and verification id). A second store would have needed three
  backends and its own conformance suite for no reader the candidate does not
  already serve.
- **BD-02, candidates live on the line record (D-P25-09's storage).** Newest 20,
  changed by pure rules under the record's compare-and-swap, like compositions.
  Same ids (`cand_…`), states and immutability as ratified, plus one state the
  decision did not name: `deploying`, between the person's press and GitHub's
  merge.
- **BD-03, main and repairs are entries of the line's own program.** Main moving
  (D-P25-06) and a red candidate's repair (D-P25-10) are queued as entries whose
  program is the line's own program id, so the composer, batch, settle and push
  handle them unchanged. They are never listed as undeployed programs.
- **BD-04, the reconciler indexes every line.** DynamoDB's line index now holds
  every line, not only those with work; the readers filter. A line with no work
  written before this deploy is indexed on its next write.
- **BD-05, staleness in the Studio is read from `mainSeen`.** The panel says
  "Updating" when the main head the reconciler last saw is not the candidate's;
  the deploy route asks GitHub itself, so a stale answer can only hide the
  button, never merge a stale candidate.

### What was proven, and where

- Main's conflict and red repairs, held ranges, spent budget:
  `test/src/execution/line-compose.test.ts`.
- A line run that parked or whose candidate failed ends failed, with its reason:
  `apps/mcp/src/runner/line-owner.test.ts`, `test/src/line/line-e2e.test.ts`.
- Requeue and ship, user-only: `packages/core/src/rules/line.test.ts`,
  `apps/api/src/handler-line.test.ts`.
- Whole programs only on success: `apps/api/src/runner/publisher-line.test.ts`,
  `apps/api/src/runner/line-runner.test.ts`.
- Main waking the line: `apps/api/src/runner/line-runner.test.ts`.
- Snapshot verification on an exact commit, never landing evidence:
  `test/src/execution/step-adjustments.test.ts`.
- Cut, qualify, supersede, repair a red candidate: `line-owner.test.ts`,
  `line.test.ts`, `handler-line.test.ts`.
- Pull requests opened, closed, merged, noticed, refused:
  `apps/api/src/runner/publisher-candidates.test.ts`.
- Deploy only when current; the Studio's words and button:
  `handler-line.test.ts`, `apps/studio/src/pages/project.test.tsx`,
  `apps/studio/src/components/line-candidate.test.ts`.

### Known and not P25's

- **This laptop's git is 2.35.** `git worktree list -z` needs 2.36, so the
  worktree clean-up paths fail locally (about 38 tests in a full run, all in
  execution and parallel suites that remove worktrees). The runner image's git
  is newer; upgrading Git for Windows makes the full suite meaningful here.

- **A line run's machines outlived it.** foodfly's line run
  `run_01M6AADSRMN8BYGCENZ6N42SF6` ended `interrupted` on 2026-11-01 after a
  generation-2 launch; its two c8id.2xlarge machines (i-0242ff0549db32fdf,
  i-02ee750e293a3794a) kept running, idle, until terminated by hand on
  2026-11-05: about 100 hours each, roughly $89. Nothing tied them to a live
  dispatch, so the reconciler never stopped them. A sweep that terminates any
  Nightshift-tagged machine whose run is over or unknown is proposed.

### For the owner's trial (SC-P25-13)

1. `aws sso login --profile nightshift`, then deploy the API and runner stacks
   and a new runner image (the line owner changed).
2. Two foodfly programs that touch the same file, run to success. Watch the
   line combine both, repair the conflict once, go idle, and cut and qualify a
   candidate; one pull request appears on foodfly.
3. Commit something small to foodfly's main by hand. Within a tick the line
   takes it in, the candidate is superseded, and a new one is qualified.
4. Press Deploy in the Studio.
