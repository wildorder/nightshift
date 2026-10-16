# Program P17 — Verification Forecast

| Field | Value |
|-------|-------|
| Program ID | `p17-verification-forecast` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p17-verification-forecast` |
| Source stage | none: the owner's direction of 2026-10-16 (§3.1), after keki-backend's `lightning-ux` runs took the night several times over on gates |
| Status | **Built 2026-10-16** in a coding-agent session (PR #31). D-P17-01 … D-P17-08 ratified with the owner's amendments (§12). SC-P17-08 met on keki-backend's `lightning-ux` (§12) |
| Depends on | A-52 (the mechanical gate audit), P15 (the gate standard, the gate-health record, the report's gate-health section), P16 (the runtime measurement in `nightshift gates`), A-57 (end gates) |
| Blocking decisions | none: D-P17-01 … D-P17-08 ratified |

This contract is the stable authority for P17. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Nightshift can provide the ground a project's gates run on, but it cannot make
the project use it well: a project that runs its end-to-end suite on every
landing, or boots a database for every check, pays for it all night and never
sees the bill. P17 makes the bill visible, **in time, before the run**, with
the fix priced beside it — and shows the real bill afterwards.

`nightshift gates {id}` becomes to a run what `cdk synth` is to a deploy: it
runs setup and every gate once, as today, and from that prints the
**verification plan** — what will run, when (every landing, twice for an
examined job, once at the end), how long each step took, what a landing costs,
what the night is projected to cost — and a ranked list of **recommendations**,
each a numbered rule of the gate standard, the evidence it saw, and the time it
would save. After the run, the report shows the actuals against the forecast
and re-prices the same recommendations with the real durations.

It is deterministic, optional and advisory. It never gates anything.

### Who it is for

| Story | Who | Today | Afterwards |
|-------|-----|-------|------------|
| US-01 | The owner, before a run | Knows a run "takes too long"; finds out why by reading transcripts in the morning, if at all. The fix that would have saved two hours (`e2e` at the end) was a one-line contract change nobody knew to make. | Runs `nightshift gates lightning-ux` and reads: "e2e at end saves ~2h 10m over 12 landings; here is the edit." Decides in a minute. |
| US-02 | A developer bringing a repository to Nightshift | Has no idea what their gates will cost under Nightshift's conditions until the first night. | Sees the verification plan for their contract before ratifying it: every step timed, when it runs, what a landing costs, what to move or fix first. |
| US-03 | The owner, the morning after | The report says what landed and what was repaired; nothing says where the night's hours went. | The report's gate-health section shows verification time per step and phase, forecast against actual, and the recommendations re-priced with the machine's real durations. |

> US-01: "it would be awesome if nightshift could come back and say after the run: you could save 2hrs by doing x, 30min by doing y, etc..."
>
> On the unit: "i don't even need 'cost' measured in money, i need it measured in time first and foremost. i wouldn't proxy cost if we can't get it exact."
>
> On the shape: "i still believe we should have an audit but up-front and optional cli command that produces recommendations. you'd almost certainly be able to look at the scripts that will act as gates and make recommendations. it's almost like the cdk synth"
>
> On the line between Nightshift and the project, which this program respects (§3.1 Q5): "i like the idea of one postgres per machine kept alive, but it seems very keki-focused... who is the rightful owner of the testing environment? what is the natural split between nightshift's responsibilities and the project?"

### What exists today

- **The mechanical audit (A-52; `auditGates`, `nightshift gates {id}`).** Runs
  setup and every check once on a fresh checkout of the base, exactly as
  verification does, and reports pass / fail / deferred / waiting. It has every
  step's `durationMs` in hand (`onStep`) and discards it in the verdict. On a
  machine the runner does the same audit before the root starts (`auditOnMachine`).
- **The gate standard (D-P15-05)**, eight numbered rules, among them *7. Costs
  what it should*. It reads as prose for the planning agent and the repair
  examiner; nothing applies it mechanically to a contract's commands.
- **End gates (A-57, 2026-10-16).** A step may say `at: "end"`. The forecast's
  largest single recommendation is the case for it.
- **The verification runner streams a step's output** (`StepChunk`), so the time
  a step is quiet before its first line is measurable; nothing records it.
- **Every verification records each step's exit code and duration**
  (`Verification.commands[].durationMs`), with the phase (`queue`, `candidate`,
  `run`). The actuals already exist, per record, nowhere summed.
- **The report and the Studio's Status tab have a gate-health section**
  (D-P15-09): the audit, repairs and flakes. Time is not among them.
- **The gate-health record** (D-P15-07) is the project's per-fingerprint record
  of its gates; `nightshift gates --record` writes it.
- **`nightshift gates` already measures runtimes** (P16): it is the command that
  measures the project under Nightshift's conditions.

## 2. Environment and human prerequisites

None beyond what `nightshift gates` needs today: a checkout of the program's
repository, and for the keki trial the same Docker the gates need.

## 3. Decisions

### 3.1 The owner's direction, 2026-10-16

| # | Question | Answer |
|---|----------|--------|
| Q1 | What is the unit? | **Time, exact or stated.** "i need it measured in time first and foremost. i wouldn't proxy cost if we can't get it exact." Money, if ever, is derived from time; it is not this program. |
| Q2 | Before the run or after? | **Both, the up-front one first.** "i still believe we should have an audit but up-front and optional cli command that produces recommendations." The post-run actuals complete the loop (US-01's original wish). |
| Q3 | How does it know? | **By measuring, and by reading the gate machinery.** "you'd almost certainly be able to look at the scripts that will act as gates and make recommendations." |
| Q4 | What is it like? | **`cdk synth`.** A deterministic projection of what will happen, printed before it happens. |
| Q5 | Who owns the testing environment? | **The project owns what has semantics; Nightshift owns the ground and its promises, and tells the truth about the context it created.** Nightshift never learns what a database is. So the fix for a slow service is a project script leaning on Nightshift's promises, and Nightshift's part is the facts the script needs (D-P17-06) and the recommendation that names the rule (D-P17-03). |
| Q6 | Does it gate? | **No.** As P15's audit: advisory, never certification (P15 Q-rulings stand). |

### 3.2 Decisions

| ID | Decision | Rationale | Status |
|----|----------|-----------|--------|
| D-P17-01 | **Time is the unit, and every number says where it came from.** A duration is *measured* (this machine, this run of the audit) and labelled so. A total is measured × a *multiplier* the output states (per landing: 1; per examined job: 2; per run: the landings assumed). A saving is a stated formula over measured numbers. No money. No number without its provenance on the same line. | Q1. A projection that hides its assumption is a proxy; one that states it is arithmetic the reader can check. | ratified 2026-10-16 |
| D-P17-02 | **`nightshift gates {id}` prints the verification plan.** After the audit it has today, the command prints each step with its measured duration and when it runs (`landing`, `end`), the cost of one landing, of one examined job (candidate check + queue check), of the end gates, and the projected cost of the run for the landings assumed. The multiplier comes from `--landings N` when given, otherwise the last run's actual landings when the program has a report, otherwise 10, and the output says which. The command stays optional and never fails on a recommendation; `nightshift run`'s own pre-run audit is unchanged. | Q2, Q4, Q6. The command already runs everything once; the plan is what it learned, laid out. | ratified 2026-10-16 |
| D-P17-03 | **Recommendations are rule + evidence + time, from a deterministic catalogue.** Each recommendation names a gate-standard rule by number, quotes the evidence (the step and its measured duration, or the command line it resolved to), states the saving as a formula over measured numbers, and, when the fix is in the contract, carries the exact edit. The catalogue is code in Nightshift (§4.3); no model runs in the command. **The planning agent runs it** at §3a of `plan-program`, interprets the output, and surfaces the recommendations to the human before the run, as decisions where they change the contract. | Q3, Q4. Synth is deterministic; a recommendation the human can check line by line is one they will act on. Intelligence stays where P15 put it, and reads this. | **ratified 2026-10-16** ("yes deterministic, planning agent should run it and interpret results surfacing to user recommendations prior to run") |
| D-P17-04 | **The command reads the gate machinery.** Each gate's command is resolved through the repository's package scripts, `pre`/`post` hooks and workspace recursion to the tools it actually runs; the catalogue matches tool signatures: an end-to-end runner (`playwright`, `cypress`, `webdriver`) is a whole-system gate; `docker compose up`, `testcontainers` or a database start in a gate is a service started per verification; an install or codegen in a gate is setup folded into a check (rule 1); a lockfile at the base with no setup is already found (A-52). Extends the mechanical audit; a match is evidence quoted, never a verdict. | Q3. The scripts say what will run; reading them costs nothing and catches what one timed run cannot name. | ratified 2026-10-16 |
| D-P17-05 | **A step's quiet start is measured.** The verification runner records the time from a step's start to its first output chunk, on every `StepResult` and in every `Verification` command. The forecast reports it; a long quiet start on a gate that resolves to a service start (D-P17-04) is the evidence for rule 7's recommendation: keep the service alive and isolate per verification. | Q3, Q5. Nightshift cannot see inside a step; it can see when the step first spoke, and say what that usually means. A heuristic labelled as one. | ratified 2026-10-16 |
| D-P17-06 | **Every step is told the context it runs in.** Each setup and verification step's environment gains `NIGHTSHIFT_VERIFICATION_ID` (unique per verification, stable across its reruns), `NIGHTSHIFT_HEAD_SHA` (the commit under verification) and `NIGHTSHIFT_BASE_SHA` (the commit it is being landed onto; absent in the audit and the end gates, where there is none). With these a project script can keep a service alive across verifications and give each one a database of its own, or run only what changed since the base. | Q5. The project owns the service and its semantics; Nightshift owns the facts about the context it created, and today withholds them. The smallest change that makes rule 7's fix possible without Nightshift learning what a database is. | ratified 2026-10-16 |
| D-P17-07 | **The forecast is recorded, and the report shows actuals against it.** `nightshift gates --record` adds the forecast (each step's measured duration and quiet start, the machine it ran on, the multipliers assumed) to the project's gate-health record (D-P15-07). After a run, `report.md` and the Studio's Status tab gain **Verification time**: per step, the count of runs and total time by phase (`queue`, `candidate`, `run`); the forecast beside the actual where one was recorded; and the catalogue's recommendations re-priced with the run's real durations. | Q2, US-03. The same catalogue over measured actuals is the post-run advice the owner first asked for, and forecast-against-actual is what makes the forecast trustworthy over time. | ratified 2026-10-16 |
| D-P17-08 | **A contract edit is printed, not written.** When a recommendation's fix is a change to the program contract (`"at": "end"` on a step), the command prints the exact JSON edit and the file it belongs in. It does not write it: the contract is ratified by a human, and `plan-program` is where it changes. | A printed edit is applied in a minute and stays under the human's hand; a written one is a change to a ratified document by a diagnostic command. | ratified 2026-10-16 |

### Non-guarantees

- **A laptop's duration is not the machine's.** P16 measured the difference. The
  forecast says where it was measured; the report says what the machine did.
- **The multiplier is an assumption.** How many landings a night brings is not
  known before the night; the output names the number it used, and the report
  names the number it was.
- **Static reading is pattern-matching.** A gate that starts a database through a
  script the catalogue does not recognise is not found; a match quotes its
  evidence so a false one is seen for what it is.
- **It recommends; the project decides.** A recommendation ignored costs what it
  always cost, and the report will say so again.

## 4. Design

### 4.1 The verification plan

```text
nightshift gates lightning-ux

verification plan for lightning-ux at 7f3a2c1e, measured on this machine (Darwin arm64)

  setup    install            3.1 s   seeded from the program checkout when lockfiles match
           browsers           0.4 s

  landing  build             41.2 s
           typecheck         28.0 s
           lint              12.4 s
           unit              55.1 s
           db-test         9m 10 s   quiet for 3m 05 s before its first line
           e2e            11m 40 s

  one landing            23m 06 s   (every job)
  one examined job       46m 12 s   (candidate check, then the queue's)
  end gates                none

  projected: 12 landings (the last run's; set with --landings) ≈ 4h 37m of verification

recommendations, by time saved

  1. e2e at the end                                          saves ≈ 2h 10m
     rule 9 (A-57): a whole-system gate proves the program, not a job.
     e2e resolves to `playwright test` (package.json → test:e2e); 11m 40s per landing × 12,
     against 2 runs at the end. Edit docs/programs/lightning-ux/contract.json:
       { "id": "e2e", ..., "at": "end" }

  2. db-test starts a service every time                     saves ≈ 37m
     rule 7: costs what it should.
     db-test resolves to `docker compose up -d postgres && …` (scripts/test-docker.sh:14) and is
     quiet for 3m 05s of 9m 10s on every run. Keep the service alive across verifications and give
     each one its own database; NIGHTSHIFT_VERIFICATION_ID names it. 3m 05s × 12.

  3. install is seeded                                       nothing to save
     setup takes 3.1 s when the lockfiles match; the program checkout seeds every worktree.
```

Everything above the recommendations is measured and arithmetic. Each
recommendation is one rule, its evidence, and one formula.

### 4.2 The time model

- **A step's cost** is its measured duration in the audit, labelled with where
  it was measured.
- **A landing** costs setup (0 when seeded, else its measured duration) plus
  every `landing` step. **An examined job** costs two landings (D-P8-09's
  candidate check, then the queue's). **The end gates** cost setup plus every
  `end` step, once per `run.finish succeeded`; the forecast assumes two (one
  pass, or one failure and its fix).
- **A run** costs landings × the multiplier, plus the end gates, plus the
  examined jobs' second landing for the share the examination policy makes
  examined — stated as "assuming N landings, M examined".
- **A saving** is the difference between the plan as declared and the plan with
  the recommendation applied, over the same multiplier, as a formula the line
  shows.

Nothing is summed that was not measured, and nothing measured is shown without
its label.

### 4.3 The catalogue

Each entry: the rule it serves, what it reads, what counts as evidence, the
saving's formula, and the fix (a contract edit when it is one).

| Entry | Rule | Evidence | Saving | Fix |
|-------|------|----------|--------|-----|
| Whole-system gate on every landing | 9 (A-57; added to the standard by this program) | A `landing` step whose command resolves to an end-to-end runner (Playwright, Cypress, WebDriver, a browser-driven suite). **Never on time alone**: a slow gate is not thereby a whole-system gate (the owner, 2026-10-16) | duration × (landings − 2) | the contract edit: `"at": "end"` |
| Service started per verification | 7 | A step that resolves to a compose/container/database start, with a quiet start over the entry's threshold | quiet start × landings | keep the service alive; isolate per verification with `NIGHTSHIFT_VERIFICATION_ID` (D-P17-06) |
| Setup folded into a gate | 1 | A gate that resolves to an install or codegen, or a `pre` hook that does | the install's share of the step, × landings | move it to `setup` |
| Setup not seeded | 7 | Setup measured long with lockfiles that match the program checkout's and no seed taken | setup duration × landings | the D-P10-24 marker; usually a Nightshift defect to report, not the project's |
| Candidate checks double the bill | — (fact) | An examination policy that examines most jobs | shown, not saved: the forecast states the examined cost | none; the human sees what examination costs in gates |
| Flaky gate | 5 | From actuals only: flakes recorded in the run | the rerun time, plus any attempt that climbed for it | the repair the run already opened |

The threshold constants are named in code and printed with the evidence, so a
reader can see why a line fired.

### 4.4 Facts to steps (D-P17-06)

`runCheckoutSteps` and `rerunFailedChecks` add to every step's environment:

| Variable | Value |
|----------|-------|
| `NIGHTSHIFT_VERIFICATION_ID` | the `Verification` id about to be written, the same for the step's rerun |
| `NIGHTSHIFT_HEAD_SHA` | the commit under verification |
| `NIGHTSHIFT_BASE_SHA` | in the queue, the program head the commit is replayed onto; in a candidate check, the job's base; absent in the audit and the end gates |

The gate audit sets an id of its own so a script need not special-case it. The
gate standard's rule 7 gains the pattern: a long-lived service, state keyed by
content (a template database named by a hash of the migrations), a database per
verification named by the id, dropped afterwards.

### 4.5 Actuals (D-P17-07)

`gatherReport` already reads every `Verification` of the run. It sums, per step
and phase, the count and the total `durationMs` and quiet start; where the
project's gate-health record carries a forecast, it places the forecast beside
the actual; and it runs the catalogue over the actuals, so the report's
recommendations are priced in the machine's time. The Studio's Status tab shows
the same table.

## 5. Scope

### In scope

- The verification plan in `nightshift gates` (D-P17-02) and its time model (§4.2).
- The catalogue (§4.3), the script resolver (D-P17-04), and rule 9 in the gate standard.
- The quiet-start measurement in the verification runner and the `Verification` record (D-P17-05).
- The three facts in every step's environment (D-P17-06).
- The forecast on the gate-health record; the report's and Studio's *Verification time* (D-P17-07).
- The printed contract edit (D-P17-08).

### Out of scope

- Any cost in money.
- A model in the command; the planning agent's use of the forecast is a skill-text change only.
- Running the forecast on the machine before a run (the runner's audit stays a verdict; its durations reach the report through the verifications).
- Writing the contract.
- Any change to how verification decides a landing.

## 6. Success criteria

| ID | Outcome | Serves |
|----|---------|--------|
| SC-P17-01 | `nightshift gates {id}` prints every step's measured duration and when it runs, one landing's cost, one examined job's, the end gates', and the run's projection with its multiplier named | US-01, US-02 |
| SC-P17-02 | A contract with a `landing` step that resolves to Playwright gets the end-gate recommendation with the saving as a formula and the exact `"at": "end"` edit | US-01 |
| SC-P17-03 | A step quiet for longer than the threshold before its first output, resolving to a service start, gets rule 7's recommendation with the quiet time × landings | US-01 |
| SC-P17-04 | Every setup and verification step sees `NIGHTSHIFT_VERIFICATION_ID`, `NIGHTSHIFT_HEAD_SHA` and, where there is one, `NIGHTSHIFT_BASE_SHA`; a rerun sees the same id | US-01 |
| SC-P17-05 | Every `Verification` command records its quiet start | US-03 |
| SC-P17-06 | `gates --record` stores the forecast; the report and the Studio show verification time per step and phase, the forecast beside the actual, and the recommendations re-priced | US-03 |
| SC-P17-07 | No recommendation fails the command, the pre-run audit or a run | Q6 |
| SC-P17-08 | On keki-backend's `lightning-ux`, the forecast names `e2e` at the end as its first recommendation with the edit, and `db-test`'s quiet start under rule 7 | US-01 |

## 7. Deterministic verification

`npm run verify` (build, typecheck, lint, test, synth, sterility). SC-P17-08 is
the owner's trial on keki-backend.

## 8. Constraints

- Deterministic: commands, exit codes, durations, bytes. No model in the command.
- Every number carries its provenance (D-P17-01).
- One home per fact: the forecast on the gate-health record; the actuals in the
  verifications; the catalogue in code; the rules in the gate standard.
- Nightshift learns no service's semantics (Q5).

## 9. Permissions and forbidden actions

As P15. Nothing here writes to a product repository.

## 10. Tasks

| Task | What |
|------|------|
| T1 | The facts to steps and the quiet-start measurement (D-P17-05, D-P17-06): runner, `StepResult`, `Verification` command, `runVerification`, the audit |
| T2 | The time model and the verification plan in `nightshift gates` (D-P17-01, D-P17-02) |
| T3 | The script resolver and the catalogue, rule 9 in the gate standard and its embedded copy, the printed edit (D-P17-03, D-P17-04, D-P17-08) |
| T4 | The forecast on the gate-health record; *Verification time* in the report and the Studio (D-P17-07) |
| T5 | Skills: `plan-program` reads the forecast at §3a; `run-program` §4 reads the actuals; the gate standard's rule 7 pattern |
| T6 | Deploy API, runner image and Studio; the owner's keki-backend trial (SC-P17-08) |

## 11. Risks

- **A forecast nobody runs.** It is optional by ruling (Q6). The planning skill
  asks for it at §3a, and the report's actuals say the same things afterwards,
  so the advice reaches the human from one side or the other.
- **Thresholds that misfire.** A quiet start of 20 s on a compiler is not a
  service. Thresholds are named constants printed with the evidence; a line that
  fires wrongly shows why, and the constant moves.
- **Resolving scripts across package managers.** npm, pnpm and yarn scripts
  with hooks and workspace recursion; Makefiles and shell wrappers beyond them.
  The resolver follows what it can and quotes the deepest line it reached; an
  unresolved command is reported as unresolved, not guessed.
- **A second place that knows a step's cost.** Durations live in the audit and
  in the verifications; the forecast is a copy of the audit's. It is written
  once with `--record` and labelled, never derived twice.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-10-16 | Contract drafted from the owner's direction (§3.1); D-P17-01 … D-P17-08 proposed | Agent, for human ratification |
| 2026-10-16 | **Built** (T1–T6, PR #31). The keki-backend trial (SC-P17-08): one landing measured at 8m 27s on the laptop, 16m 55s for an examined job, 1h 24m projected for ten; the first recommendation is `e2e` at the end (saves ≈ 26m over ten landings), evidenced by `scripts/test-docker.sh:262: pnpm exec playwright test`, with the contract edit; `build`, `db-test` and `e2e` are reported once under rule 7 as starting a service through `docker run` at `scripts/test-docker.sh:171`, unpriced because the script prints within half a second, so the start is not visible from outside. Two things the trial taught the catalogue: a tool is matched where a line *runs* it, not where an `echo` names it; and a script that does several things by its first argument is read for the mode it was called with (`case`, first match wins, `*` the default). The run's two red gates were keki's own flakes (a same-millisecond `updated_at` assertion; a crawl spec) | Agent; the owner's trial follows |
| 2026-10-16 | D-P17-01 … D-P17-08 ratified. Amendments: the planning agent runs the forecast and surfaces its recommendations to the human before the run (D-P17-03); the facts to steps go in (D-P17-06); the diagnostic never edits and never gets in the way (D-P17-08); the whole-system-gate entry fires on tool signatures only, never on time alone ("i don't think we should tell people to move to the end based on time alone.. that would be just wrong") | Human |
