---
name: run-program
description: Start a ratified Nightshift program's unattended run from this session, watch it to the report, and read the report back — the step after plan-program, without going to a terminal. Use when someone says "run the program", "start the run", "kick off {id}", "resume the run", or asks how a run is going.
---

# Running a ratified program

The plan is ratified; this is the night. `nightshift run {id}` does everything:
holds the plan on disk to the ratified hash, runs preflight for what the first
strands need, starts a headless orchestrator through the routed adapters, and
writes `docs/programs/{id}/report.md` when the run has ended. Your job is to
start it right, stay out of its way, and read the report to the human.

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
  the verification's cost is what this machine will do at once: with a gate of
  `npm ci` + build + typecheck + lint + test and `maxConcurrency` 2, expect up to
  two full gates running together. Say it once, and let the human choose
  `--model` or lower the limit in `nightshift.config.json` if they want.

## 2. Start it, detached

The run takes minutes to hours and `nightshift run` blocks until it ends. Do not
hold a tool call open for it. Start it in the background with its output going to
a file next to the report, and return at once:

```sh
mkdir -p docs/programs/{id}/runs
nohup nightshift run {id} > docs/programs/{id}/runs/$(date +%Y%m%dT%H%M%S).log 2>&1 &
echo $!
```

Then say, in a few lines: the run id from the log's first line (it appears
within seconds; read the file), where the log is, where the report will be, and
that the human can close the laptop lid only if this machine stays awake — the
orchestrator and every worker run here. Flags the human may want:
`--harness claude|codex` and `--model <name>` choose the root orchestrator
(workers are routed by the contract's policy); `--attended` creates the run and
stops, for a session that will orchestrate it itself with the `nightshift`
skill.

## 3. While it runs

When asked how it is going, read the log's tail and the control plane's view, and
report in the plan's terms, strand by strand, never job by job:

- `nightshift` prints a line per strand event in the log; `program.status` from
  an attached session shows the tree.
- A strand **parked** is one that failed with everything downstream of it; the
  rest carries on. That is by design, and the report will say why.
- A job **deferred** is waiting on a human prerequisite, on the provisional
  line. Not a failure; nothing to do until the run ends.
- Do not touch the repository while it runs. Do not `git checkout`, do not
  commit, do not run the tests yourself in that checkout: a worktree per job
  keeps workers apart, but the program checkout is where every landing goes.

Stop a run only when the human asks: `kill <pid>` of the `nightshift run`
process interrupts it cleanly, every node and agent is recorded, and the report
is still written.

## 4. When it ends

`nightshift run` exits 0 when every strand succeeded, 3 when nothing failed but
some work is deferred, 1 otherwise, and always writes
`docs/programs/{id}/report.md`. Read the report and give the human the shape of
it, in this order:

1. The one line: succeeded, deferred, or failed, and how many strands each way.
2. Every **departure** from the plan's approach, first, strand by strand: that
   is the code telling the human the plan was wrong about something, and it is
   what they most need to know.
3. What was **parked**, what blocked it, and the reason on the strand that broke.
4. What is **deferred**, what it waits on, and the two commands to land it when
   the prerequisite is done: `nightshift preflight {id}`, then
   `nightshift resume {id}`.
5. The success criteria table, and the run's own decisions.

Then the human's choices, plainly: review the branch and merge it; do the
prerequisites and resume; or re-plan (`/plan-program {id}` reads this report
first and starts from the departures and the parked strands).

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
