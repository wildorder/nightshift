# Program P15 — Gate Health

| Field | Value |
|-------|-------|
| Program ID | `p15-gate-health` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p15-gate-health` |
| Source stage | none: the owner's direction of 2026-10-06 (§3.1), after keki-backend's playspace-time-reservations run |
| Status | **Ratified 2026-10-06.** D-P15-01 … D-P15-06 are the owner's, from the conversation; D-P15-07 … D-P15-11 were proposed and ratified the same day. Built by Nightshift itself, on a remote run (§13) |
| Depends on | P7 (planning, `plan check`, ratification), P8 (examination and risk), P9 (decisions), P10 (the runner), A-52 (the mechanical gate audit, built 2026-10-06) |
| Blocking decisions | none: D-P15-01 … D-P15-11 ratified |

This contract is the stable authority for P15. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Nightshift can only be as good as the repository's gates. P15 makes gate health
something Nightshift **judges, records and repairs**, instead of something a run
discovers at 3 a.m.

- **Before ratification**, planning audits the gates against Nightshift's own
  gate standard. The audit is intelligent: the planning agent reads the gate
  machinery and runs the gates. What it finds becomes decisions the human
  answers, and a gate-health strand every other strand depends on builds them.
  A plan is not ready until the audit is complete. The record of it is kept per
  project, fingerprinted, so a later program whose gates have not changed skips
  it.
- **During the run**, a gate that breaks is repaired, not escalated. A red base
  at the start becomes the run's first job. A gate that fails and then passes on
  the same commit is flaky: the work lands, and a repair job runs beside the
  rest. Every repair is recorded as a decision for the owner to review. Nothing
  is re-planned.

### Who it is for

| Story | Who | Today | Afterwards |
|-------|-----|-------|------------|
| US-01 | A developer bringing a repository to Nightshift | The gates fail in Nightshift's conditions for reasons nobody saw: installs folded into pre-hooks, two gates sharing a build folder, an undeclared Docker dependency. The first run finds out, hours in, and lands nothing. | Planning tells them what has to be cleaned up before Nightshift can run reliably. They decide each fix once, and the first strand builds it. |
| US-02 | The owner reviewing a run in the morning | A gate that breaks mid-run fails every job, retries climb to dearer models, and the answer offered is to re-plan. | The run repaired the gate itself, carried on, and recorded what it did as decisions they can review and reverse. |

> US-01: "suppose a super unhealthy piece of shit build starts using nightshift. nightshift should be able to say, umm, we need to get this cleaned up before i can reliably run"
>
> US-02: "the fucking thing is designed to get the job done and record what happened so it can be REVIEWED. NOT replanned."

### What exists today

- **A mechanical audit (A-52, 2026-10-06).** `nightshift gates {id}` and the
  start of `nightshift run` run setup and every check once in a fresh checkout
  of the base. A red gate stops a local run before it is created, and fails a
  remote run before its root starts. It reads exit codes only: it would have
  passed keki-backend while missing everything wrong with it.
- **Verification is pristine (2026-10-06).** It cleans with `clean -fdx`, so a
  worker's leftovers no longer decide a result.
- **A failed verification blames the model.** The job ends
  `verification_failed`; a retry climbs a rung (`failureClimbs`). A flaky gate
  therefore buys a dearer model to redo sound work.
- **A planned run adds no work.** The root delegates its strands and refuses any
  other job (`plan_fixes_strands`, D-P7-04); a strand's orchestrator delegates
  only inside its strand's scope. Nothing in a run can repair a gate that sits
  outside every strand, such as keki-backend's suite registry under `scripts/`.
- **Setup and gates are fixed for the run.** They are part of the ratified
  contract, read from the control plane's record.

## 2. Environment and human prerequisites

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P15-01 | Ratify D-P15-07 … D-P15-11 | **satisfied 2026-10-06** |
| H-P15-02 | keki-backend available for the trial (SC-P15-10) | satisfied: `~/projects/keki-backend`, project `proj_01M3RFCG…` |

**Explicitly not required.** No new AWS resource beyond a table item type.
The API, the runner image and the Studio are redeployed at the end.

## 3. Decisions

### 3.1 The owner's direction, 2026-10-06

| # | Question | Answer |
|---|----------|--------|
| Q1 | Does the audit need intelligence? | **Yes.** "I'd argue that it DOES, because only then can it be audited for compliance with nightshift." |
| Q2 | What happens when a gate breaks in a run? | **Repair and record, never re-plan.** "the fucking thing is designed to get the job done and record what happened so it can be REVIEWED. NOT replanned." |
| Q3 | When is the audit done? | **Before ratification.** "i think we ought to have the audit completed before the user ratifies the plan. they can wait. it's better than sending it to nightshift as a total turd which then has to make a bunch of decisions. force the user to make the decisions up front... they are basically initializing nightshift. we can only do as good as their testing is setup" |
| Q4 | Run the gates once or twice at the start? Keep `--allow-red-gates`? | **Once; no override.** "i'd prefer not to run it twice up front. no allow-red-gates is necessary." |
| Q5 | What may a repair job change? | **Anything it needs.** "yes, let it do whatever the hell it needs to do..." |
| Q6 | A gate that passes on a rerun | **Land, and repair off the blocking path.** "i agree with opening a repair job but not on a blocking path (and obviously a decision gets logged during all repair jobs)" |
| Q7 | Who defines a healthy gate? | **Nightshift.** "yeah nightshift should have some opinion on gate standards" |
| Q8 | Priorities | "the goal is to make it easy, fast, and reliable. fast gives way first if necessary (to a point)" |

### 3.2 Decisions

| ID | Decision | Rationale | Status |
|----|----------|-----------|--------|
| D-P15-01 | **The deep audit happens in planning, and must be complete before ratification.** The planning agent runs the gates in the foreground and reviews the gate machinery against the gate standard (D-P15-05). Each finding becomes a contract decision the human answers. When there is anything to fix, the plan gains a **gate-health strand** that every other strand `dependsOn`, and it builds the answers. | Q1, Q3. The human is present at planning and absent in the run. Their answers are constraints the run cannot get wrong. | agreed 2026-10-06 |
| D-P15-02 | **Gate health is recorded per project, against a fingerprint.** The fingerprint covers the setup and gate commands, the lockfiles, and the files the auditor names as gate machinery (scripts, test and build configs, registries). A plan whose fingerprint matches a healthy record skips the audit. | Q8: fast without trading reliability. The gates are the repository's, not a program's. | agreed 2026-10-06 |
| D-P15-03 | **A run repairs, never stops, for its gates.** The mechanical pass at the start of the run stays (one pass, Q4). A red gate there becomes the run's **first job**, a repair, and the strands wait on it alone. The A-52 stop and the remote `failBeforeStart` give way to it. | Q2, Q4. After D-P15-01 a red start is rare: something changed between ratification and the run. | agreed 2026-10-06 |
| D-P15-04 | **A repair job may change anything, including setup and the gate commands.** It is a new kind of job a planned run may add outside its strands (amending D-P7-04 for repairs only). Every repair records a decision. It is examined at high risk, and weakening a gate (a retry wrapper, a looser assertion, a deleted or skipped test) is a blocking finding unless the decision says why. A changed gate definition applies to verifications after the repair lands. | Q5. The run fixes what blocks it and the owner reviews; the examiner is the guard against a cheap "fix". | agreed 2026-10-06 |
| D-P15-05 | **Nightshift ships a gate standard.** A document beside the planning skill says what a Nightshift-healthy gate is (§4.1). The planning audit and the repair examiner both judge against it. | Q7. | agreed 2026-10-06 |
| D-P15-06 | **A flaky gate does not block.** When a check fails, verification reruns that check once on the same commit. A pass is recorded as **flaky** on the verification, the work lands, the route does not climb, and a repair job is opened **off the blocking path**: no strand waits on it. A decision records the flake and the repair. | Q6. Fast for the run, and the flake still gets fixed and is still seen. | agreed 2026-10-06 |
| D-P15-07 | **The record lives on the control plane**, one per project: the fingerprint, the commit audited, the verdict (`healthy` or `repairing`), the findings with the decisions that answered them, the gate-machinery paths, and who audited and when. `nightshift gates {id} --record` writes it; `plan check` reads it; the run updates it when a gate-health strand or a repair lands. | Prerequisite statuses already live there, set only by a Nightshift command. The Studio and a remote runner can read it, and a hand edit in the repository cannot fake it. | ratified 2026-10-06 |
| D-P15-08 | **`plan check` enforces D-P15-01.** READY needs one of two things: a healthy record whose fingerprint matches the plan's base, or a `repairing` record whose findings are each answered by a contract decision, with a gate-health strand every other strand depends on. | The check is where Nightshift already says "not yet"; Q3 asks for exactly that. | ratified 2026-10-06 |
| D-P15-09 | **Repair work is visible as its own kind.** The report gains a *Gate health* section: the audit's verdict, each repair job with its decision, and each flake. The Studio shows the same on the run's Status tab. | US-02: the owner reviews what the run repaired. | ratified 2026-10-06 |
| D-P15-10 | **A repair job's scope is the whole program scope**, not a strand's. A repair that touches a strand's files lands through the merge queue like anything else. A strand orchestrator whose job then conflicts retries it on the new head. | Q5, and the merge queue already serialises landings. | ratified 2026-10-06 |
| D-P15-11 | **After a repair lands, the program checkout is the setup reference.** Setup runs once there, so every later worktree is seeded from it (D-P10-24). Today a laptop's program checkout has no install marker, so seeding rarely happens. | Speed: one real install per lockfile change, not one per worktree. | ratified 2026-10-06 |

### Non-guarantees

- **The audit is as good as the standard and the agent.** It catches what the
  standard names and what running the gates shows, not every way a test suite
  can be wrong.
- **A flaky gate can hide a flake a job introduced.** D-P15-06 accepts that for
  speed; the repair job and its decision are where it is caught.
- **A repair can change what later work is checked against.** That is Q5's
  intent; the decision and the high-risk examination are the control, and the
  owner reviews.

## 4. Design

### 4.1 The gate standard

`skills/plan-program/gate-standard.md`, shipped with the skills. A healthy gate
set:

1. **Declares setup.** Installs and code generation are `setup`, never folded
   into a gate or a pre-hook.
2. **Passes on a fresh checkout of the base**, with setup, in the gate order.
3. **Is hermetic.** No gate reads what an earlier run, another gate or the
   developer's machine left behind. Two gates never write different builds to
   one output folder.
4. **Declares outside dependencies.** Docker, a database, a network service or
   a credential is a prerequisite with a `verifyCommand`, and a step that needs
   it says `requires`.
5. **Is deterministic.** No sleeps or timing races, no reliance on test order,
   no unseeded randomness, and no fixed ports shared between gates.
6. **Can be kept healthy by the work.** A registry or allow-list that new work
   must extend is reachable from the strands that will extend it.
7. **Costs what it should.** One verification's time, multiplied by
   `maxConcurrency`, is said out loud in the plan.

### 4.2 Planning

```text
plan-program
  ├─ fingerprint matches a healthy record ─▶ skip; say so
  └─ otherwise
       ├─ nightshift gates {id}                (mechanical, foreground)
       ├─ review the gate machinery against the standard
       ├─ findings ─▶ decisions D-nn, answered by the human
       ├─ any to fix ─▶ gate-health strand S-00; every strand dependsOn it
       └─ nightshift gates {id} --record       (healthy | repairing + findings)
plan check ─▶ READY only per D-P15-08
```

### 4.3 The run

```text
start ─▶ one mechanical pass on the base
           └─ red ─▶ repair job first; strands wait on it alone
verification fails a check ─▶ rerun that check on the same commit
           ├─ fails again ─▶ verification_failed, as today
           └─ passes ─▶ flaky: land, no climb, decision, repair job off-path
any repair ─▶ decision; high-risk examination against the standard;
              lands; new gate definition applies after it; record updated
```

## 5. Scope

### In scope

- The gate standard (§4.1).
- The gate-health record: contracts, store port, the AWS, SQLite, memory and
  HTTP stores, API routes, and `nightshift gates --record`.
- The planning audit in `plan-program`, and `plan check`'s requirement.
- Repair jobs: the new job kind, the root's authority on a planned run, the
  decision, the examination rule, and gate definitions that change on landing.
- Flaky detection in verification, its record, and the off-path repair.
- The run start: red becomes a repair-first job, locally and on the runner.
- The report and Studio surfaces of D-P15-09.

### Out of scope

- Repairing a repository's gates outside a program.
- Measuring or rewriting test coverage.
- Changing how a strand's own jobs are cut, routed or examined.
- Backfilling records for projects already planned; their next plan audits.

## 6. Success criteria

| ID | Outcome | Serves |
|----|---------|--------|
| SC-P15-01 | Planning a program on a repository with no healthy record runs the gates and the review, and turns each finding into a decision the human answers | US-01 |
| SC-P15-02 | `plan check` does not answer READY until the audit is complete per D-P15-08 | US-01 |
| SC-P15-03 | A later plan whose gate fingerprint is unchanged skips the audit; changing a gate-machinery file brings it back | US-01 |
| SC-P15-04 | A gate-health strand lands first, and the record reads healthy afterwards | US-01 |
| SC-P15-05 | A red gate at the start of a run becomes the first job, and the strands start once it lands | US-02 |
| SC-P15-06 | A check that fails and then passes on the same commit lands the work, records it as flaky, does not climb the route, and opens a repair job no strand waits on | US-02 |
| SC-P15-07 | A repair job can change setup and gate commands, and later verifications use the new definition | US-02 |
| SC-P15-08 | Every repair job records a decision; a repair that weakens a gate is stopped by examination unless its decision says why | US-02 |
| SC-P15-09 | The report and the Studio show the gate audit, each repair and each flake | US-02 |
| SC-P15-10 | On keki-backend, planning finds at least the missing setup, the install pre-hooks and the shared e2e/build output folder, and the human's answers are built by the gate-health strand | US-01 |

## 7. Deterministic verification

`npm run verify` (build, typecheck, lint, test, synth, sterility). SC-P15-10 is
the owner's trial on keki-backend.

## 8. Constraints

- The mechanical pass stays deterministic; only the planning review and repair
  jobs use a model.
- One home per fact: the record is on the control plane; the findings' answers
  are contract decisions; the plan refers to both by id.
- No re-planning in a run (Q2).

## 9. Permissions and forbidden actions

As P14. Nothing here pushes to a product repository or deploys one.

## 10. Tasks

| Task | What |
|------|------|
| T1 | The gate standard, and the gate-health record end to end (D-P15-05, D-P15-07) |
| T2 | The planning audit in `plan-program`, `gates --record`, and `plan check` (D-P15-01, D-P15-02, D-P15-08) |
| T3 | Repair jobs: the job kind, the root's authority, the decision, the examination rule, gate definitions that change on landing, the repair-first start (D-P15-03, D-P15-04, D-P15-10) |
| T4 | Flaky detection and the off-path repair (D-P15-06) |
| T5 | The setup reference, the report and the Studio (D-P15-09, D-P15-11) |
| T6 | Deploy the API, runner image and Studio; the owner's keki-backend trial (SC-P15-10) |

## 11. Risks

- **An agent's review is noisy.** Too many findings make planning a chore. The
  standard is short on purpose, and a finding the human waves off is recorded as
  a decision, not argued again.
- **A repair job loops.** It is bounded like any job: the fix limits of D-P8-13
  apply.
- **A changed gate definition mid-run surprises a strand.** It applies only to
  verifications after it lands, and its decision says what changed.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-10-06 | Contract drafted from the owner's direction (§3.1); D-P15-01 … D-P15-06 agreed in conversation; D-P15-07 … D-P15-11 proposed | Agent, for human ratification |
| 2026-10-06 | D-P15-07 … D-P15-11 ratified ("yes. love it let's go"). The owner asked for P15 to be built by Nightshift on a remote run, the first Nightshift program Nightshift builds | Human |
