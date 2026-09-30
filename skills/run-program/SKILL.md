---
name: run-program
description: Run a ratified Nightshift program from this session — by default with this session as the orchestrator, delegating each strand through the Nightshift MCP server and keeping the human in the loop as it goes; or, when asked to run it dark, unattended to a report. The step after plan-program. Use when someone says "run the program", "start the run", "kick off {id}", "run it dark", "resume the run", or asks how a run is going.
---

# Running a ratified program

The plan is ratified. There are two ways to run it, and **the default is the
one where the human can watch**:

- **Attended (default).** This session is the root orchestrator. It creates the
  run with `nightshift run {id} --attended`, attaches through the Nightshift MCP
  server, hands each strand to an orchestrator of its own with
  `strand.delegate`, and waits with `job.wait`, which comes back at least every
  minute with what every strand and job did meanwhile. You relay that, decide
  retries, and finish the run. The human sees the run as it happens and can
  interject.
- **Dark.** Only when the human says so ("run it dark", "run it unattended",
  "I'm going to bed"): `nightshift run {id}` starts a headless orchestrator of
  its own and returns hours later with a report. Nothing of it reaches this
  conversation until then.

## 0. Make sure it is Nightshift v1

`nightshift --help` must list `run`, `resume` and `preflight`. If it does not,
the `nightshift` on the PATH is an older tool of the same name: stop and say so.

## 1. Before starting

Check, and say what you find, without fixing anything the human did not ask for:

- **The checkout is on the program branch and clean.** `git branch --show-current`
  is the contract's `repository.programBranch`, and `git status --porcelain`
  prints nothing but, at most, `docs/programs/{id}/report.md` from an earlier
  run. Nightshift integrates by fast-forwarding the branch the checkout is on and
  refuses a dirty tree; a run started on the wrong branch fails its first landing
  hours later.
- **The plan is ratified and unchanged.** `nightshift plan check {id}` says
  `READY`. The run itself refuses an edited plan; this only saves the wait.
- **Prerequisites.** `nightshift preflight {id}` when the contract has any. An
  unmet prerequisite that a *first* strand needs stops the run before it starts;
  one that only a later strand or a verification step needs does not: the work
  carries on a provisional line and the checks that need it are deferred until
  the human is back. Say which kind each unmet one is.
- **Cost, in plain numbers.** `maxConcurrency` from the merged contract times
  the verification's cost is what this machine will do at once: with a setup of
  `npm ci`, a gate of build + typecheck + lint + test and `maxConcurrency` 2,
  expect up to two installs and two full gates running together.
- **Setup.** Every checkout Nightshift creates starts with nothing that is not
  committed, and the contract's `setup` is what prepares it. A repository that
  needs installed dependencies and has no `setup` will fail its checks for
  reasons that have nothing to do with the work. Say so before starting, and send
  it back to planning: the fix is a `setup` in `nightshift.config.json` or the
  contract, never an install folded into the gate. Say it once, and let the human choose
  `--model` or lower the limit in `nightshift.config.json` if they want.

## 2. Attended: this session orchestrates

1. `nightshift run {id} --attended` creates the run and prints its id. It runs
   preflight first and stops with remediations if a first strand's prerequisite
   is unmet.
2. `run.attach { runId, model: "<the model you are>" }`.
3. `strand.delegate { strandId }` for **every** strand, at once. You name the
   strand and nothing else: its orchestrator is handed its plan section
   verbatim, the human's decisions that touch it, and the other strands'
   scopes. Nightshift holds a strand until what it depends on has succeeded, so
   do not sequence them yourself. Plain `delegate` is refused: the plan fixes
   the strands, and how each divides into jobs is its orchestrator's call.
4. Loop on `job.wait { jobIds }` over the strands still in flight. **Every
   return carries `Meanwhile:`, the lines since the last one** — strands
   starting, their orchestrators' own notes on how they divided the work and
   why, jobs landing, verification failing, retries, a tool-call count as a
   heartbeat. After each wait, tell the human what changed **in a sentence or
   three, in the plan's terms**: which strand did what, what landed, what went
   wrong and what you are doing about it. Do not paste the lines; do not stay
   silent across waits either. When nothing changed but heartbeats, say so in
   five words or not at all. `run.activity` replays the whole run if the human
   asks what happened.
5. When a strand comes back failed, read why with `job.get`. Retry it
   (`job.retry`) when a second attempt from the current code can fix it — a
   conflict, a flaky check, a worker that gave up early — at most twice, and
   record the decision with `decision.record`. A strand that stays failed is
   **parked** with everything that depends on it; `strand.delegate` refuses
   those as `strand_blocked`. Leave them; let the rest finish.
6. A job that ends **deferred** is done for now, waiting on a human
   prerequisite, on the provisional line. Not a failure; nothing to retry.
7. When every strand has succeeded, is deferred, or is parked:
   `run.finish { outcome, reason }` — `succeeded` only if every strand did;
   `deferred` when nothing failed and some work waits; otherwise `failed`,
   naming what was parked. Then read the report (section 4).

You do not write code during the run, and you do not touch the checkout: every
landing fast-forwards the branch it is on.

## 3. Dark: nightshift runs it alone

Only when asked. `nightshift run {id}` blocks until the run ends, minutes to
hours, so start it as a **background command** of this session (the Bash tool's
`run_in_background`), which keeps its output and tells you when it exits. Say
the run id (the output's first line), where the report will be, and that this
machine must stay awake. `--harness` and `--model` choose the headless
orchestrator. When the human asks how it is going, read the output so far and
answer in strands, not jobs.

## 4. When it ends

Attended: `run.finish` writes `docs/programs/{id}/report.md` and names it; read
it. Dark: you are notified when the command exits. `nightshift run` exits 0 when every strand succeeded, 3 when nothing failed but
some work is deferred, 1 otherwise, and always writes
`docs/programs/{id}/report.md`. Read the report and give the human the shape of
it, in this order:

1. The one line: succeeded, deferred, or failed, and how many strands each way.
2. Every **arbiter ruling**, before anything else: an agent decided a disputed
   finding, the work moved on because of it, and the human has the last word.
   Name the finding, the ruling and why, and say how to reverse it:
   `nightshift ruling reverse {id} <decisionId> --reason "…"`. Say plainly that
   reversing one records their decision and changes nothing else: correcting the
   work under it is a new plan (below).
3. Every **departure** from the plan's approach, strand by strand: that is the
   code telling the human the plan was wrong about something.
4. What was **parked**, what blocked it, and the reason on the strand that broke.
5. What is **deferred**, what it waits on, and the two commands to land it when
   the prerequisite is done: `nightshift preflight {id}`, then
   `nightshift resume {id}`.
6. What the examiners found that did not stop anything (minor findings), and
   where the routes climbed or fell back: the report's per-job lines.
7. The success criteria table and what it cost, saying which figures are
   estimates.
8. The **decision graph**: every decision the run recorded, with what was weighed
   against it and what it produced. Point out the close calls: two strong
   options, or a rejection reason that looks thin. Those are the ones worth the
   human's second look.

Then the human's choices, plainly: review the branch and merge it; do the
prerequisites and resume; re-plan (`/plan-program {id}` reads this report first
and starts from the departures and the parked strands); or **reverse a
decision** and correct it:

```text
nightshift decision reverse {id} <decisionId> --choice "<their choice>" --reason "<why>"
nightshift decision brief {id} <decisionId> --out docs/programs/<correction-id>/brief.md
```

then `/plan-program` to plan the correction from the brief, with them.

## Resuming

`nightshift resume {id}` is for a run that ended deferred. Run preflight first;
resume refuses while anything the deferred checks need is unmet, and touches
nothing if the checkout cannot be landed on. It runs the deferred checks over the
provisional commits in order, lands what passes on the program branch unchanged,
and on a check that fails records the failure and discards what was built on it,
saying so. Read the rewritten report to the human as above.

## What you must not do

- Start a run on a branch other than the program branch, or with a dirty tree.
- Edit the plan or the contract to get past a refusal. `plan_not_ratified` and
  `plan_changed` mean ratify again, after the human has looked.
- Mark a prerequisite satisfied by any means but `nightshift preflight`.
- Retry, cancel or "help" a job by hand while the run is up. The engine
  retries; the report explains.
- Summarise the report as "done" when it says deferred or parked.
