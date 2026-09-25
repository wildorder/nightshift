# Program P8 — Routing and Examination

| Field | Value |
|-------|-------|
| Program ID | `p8-routing-examination` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p8-routing-examination` |
| Source stage | Stage 6 (Model/Harness Routing) and Stage 7 (Risk-Based Examination) |
| Status | **Draft, 2026-09-24.** Five questions for the owner in §3.1; D-P8-01 … D-P8-11 proposed. Not ratified; nothing is built. |
| Depends on | P5 Harness Neutrality (the compatibility table, `RoutingDecision`, usage on exit), P6 (the engine, the merge queue, retries), P7 (strands, the report, deferral) |
| Blocking decisions | the five questions in §3.1 |

This contract is the stable authority for P8. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Two policy layers over the engine that already works, both driven by
configuration and neither by code:

- **Routing.** Each job goes to the cheapest route likely to reach a *verified*
  result (A-13), chosen deterministically from what the job says about itself.
  A route that cannot start falls back. A route that fails climbs a ladder. Every
  attempt is recorded with enough of the job and its outcome to train a router
  on later (SC-11), and what the run cost is known and bounded.
- **Examination.** Where a job's risk warrants it, a different model, or a
  different provider, examines the verified work against evidence before it
  lands (A-12). Its findings go back to the orchestrator that delegated the job.
  A material finding nobody resolved does not land when the policy says so.
  Low risk lands on deterministic verification alone.

**What P8 is not.** The cheap Bedrock route is P10's: P8 routes among what exists
(Claude Code on Anthropic models, Codex on OpenAI's) and its policy must not
assume a harness that has not been built (`staging.md`). Stage 6's first proof,
"low-risk job routes through AgentCore Harness to a cheaper Bedrock model", is
therefore proven here with the cheapest route that exists and again in P10 with
Bedrock. SC-05 stays P10's. Learned routing is after v1: P8 captures the data only.

### What exists today

- `packages/routing`: `HARNESS_COMPATIBILITY` and `configuredRoute` (rule
  `p5-configured`). It reads only `program.modelPolicy` and picks the first
  eligible pair. Job risk and ambiguity are ignored. An orchestrator may pin a
  harness or model within policy.
- `RoutingDecision` already has the right shape: eligible options, rule, override
  flag, attempt, `previousRouteId`, usage, outcome. A retry re-queues on the
  **same** route; the `escalated` outcome is never written.
- The `Examination` record, the `ExaminationStore`, the `verified → examining →
  sealed` edges and the two examination events exist. **No examiner does.**
  `assertExaminable` refuses any job whose risk requires examination
  (`examination_unavailable`, "arrives in P8"), and `nightshift init` writes
  examination off at every level.
- Usage: Claude reports tokens and a dollar cost; Codex reports tokens only.
  Nothing normalises them. Only `maxWallClockSeconds` is enforced (D-P6-07, which
  gave `maxUsd`, `maxTokens` and usage normalisation to this program, then
  numbered P7).
- A sub-orchestrator's `delegate` defaults risk and ambiguity to `low`, not to the
  program's `defaultRisk`. That is a defect and P8 fixes it: examination keyed on
  a risk nobody chose would be the ceremony A-12 rejects, in reverse.

## 2. Environment and human prerequisites

Everything from P3 … P7 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P8-01 | Ratify D-P8-01 … D-P8-11 and answer Q1 … Q5 | open |
| H-P8-02 | P7 merged | **satisfied 2026-09-24** (PRs #19, #20) |
| H-P8-03 | Claude Code and Codex signed in on the operator's machine, with the models Q2 names reachable on those subscriptions | open until Q2 is answered; checked by the live suite's own preflight |

**Explicitly not required.** No new AWS resource. The API gains a role and some
fields (§4.6) and is redeployed.

## 3. Decisions

### 3.1 Questions for the owner

Each has a leaning. None is settled until the owner answers.

| # | Question | Options | Leaning, and why |
|---|----------|---------|------------------|
| **Q1** | **Where does examination run?** | (a) **In the merge queue**, between verification on the program head and the seal. Simple, and the examined commit is exactly the one that lands, but the queue is serial (A-41), so every medium- and high-risk job holds every other job's landing for the minutes an examiner takes. (b) **Beside the queue.** When the worker finishes, its snapshot is verified in its own worktree and examined there while other work lands. The node enters the queue only once examination has passed or its findings are resolved. The queue replays and verifies as it does today. If the replayed diff (its `git patch-id`) matches the examined one, the examination carries over; if the replay changed the diff, it is examined again, in the queue. | **(b).** Examination is the slowest step P8 adds, and (a) puts it on the one serial path P6 exists to keep short. The cost of (b) is one extra verification run per examined job, and none for a job that is not examined. P1's table is untouched: the node stays `implemented` while it is examined beside the queue, and in the queue `verified → examining → sealed` passes at once by citing the examination of the same patch. |
| **Q2** | **What is the ladder?** Which models are the cheap, standard and frontier rungs, and which is the cross-provider examiner? | Any models the two harnesses can run on your subscriptions. | Cheap `claude-haiku-4-5-20251001`, standard `claude-sonnet-5`, frontier `claude-opus-5-5` (all Claude Code). Codex `gpt-5.5` as the frontier alternative and as the different-provider examiner. On subscriptions the difference between rungs is mostly rate limits, not dollars; the ladder still matters because P10 adds Bedrock beneath it and what we learn here carries over. |
| **Q3** | **Budgets: enforce `maxUsd` and `maxTokens` now?** | (a) Yes. Tokens are normalised across harnesses. Dollars are what the harness reports, or failing that an **estimate** from a price table in `nightshift.config.json`, always marked as an estimate. When a budget is spent, the engine starts nothing new and says why, as it does for wall clock. (b) Capture and normalise usage only, and enforce budgets in P10 when real money is spent. | **(a).** It is small, it completes what D-P6-07 deferred, and a cap on a cheap-route run is how a ladder that climbs too eagerly shows up before the bill does. Estimates are labelled, so nothing pretends a subscription run cost what the table says. |
| **Q4** | **A material finding the orchestrator disputes, in an unattended run.** Policy blocks on it, the fix attempts are spent, and the orchestrator says the finding is wrong. | (a) The node **fails** and its strand parks, with the finding in the report. (b) The dispute is a **human hurdle**: the node is `deferred` and lands on the provisional line (D-P7-10); work continues on it. At `nightshift resume` you accept the risk, uphold the finding (which discards what stood on it), or reject the finding. (c) The orchestrator's rejection resolves the finding. | **(b).** It is your defer-don't-park rule applied to a judgement only you can make, and it reuses the provisional line rather than inventing a second one. (c) lets an agent grade its own dispute, which is the self-grading A-12 exists to prevent. (a) wastes the night on a disagreement that is usually about wording. Where policy does **not** block, the orchestrator's rejection with a reason stands and is recorded. |
| **Q5** | **The exit gate.** | (a) A live suite only (`npm run routing`, beside `slice` and `conformance`), with real models on the deployed plane. (b) That, **and** a real planned program on a repository you name, with routing and examination on. | **(b)**, as P7's was. The live suite proves the mechanics. Only a real run says whether the ladder saves anything and whether the examiner's findings are worth the time. Name a repository (foodfly again is fine) when you have one. |

### 3.2 Proposed decisions

Proposed 2026-09-24, for ratification with §3.1's answers.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P8-01 | **A job says what it is; the policy says where that goes.** The Job Contract gains two classification fields beside `risk` and `ambiguity`: `testability` (`strong`: the contract's checks exercise the change; `weak`; `none`) and `kind` (`implement`, `fix`, `refactor`, `test`, `docs`, `orchestrate`). Scope breadth is derived from `scope.includes`, never declared. The delegating orchestrator sets them; anything left unset takes the **conservative** default (`defaultRisk`, `medium` ambiguity, `weak` testability), so an unclassified job never lands on the cheapest rung by accident. Sub-orchestrators default to `defaultRisk` like the root. | Stage 6's inputs, cut to what an orchestrator can state honestly and a rule can match on. Blast radius is `risk`; a context requirement is what `scope` and the context documents already say. A field that can be derived is not a second home for the same fact. |
| D-P8-02 | **Routing is a first-match rule table in configuration.** `routingPolicy` in `nightshift.config.json` (inherited by the contract, as in P7): the ladder, **rungs** each naming one or more `(harness, model)` routes in preference order, and **rules**, each matching on classification and naming a starting rung. The first rule that matches wins. The last rule has no conditions. `modelPolicy` still intersects everything: a rung route that policy forbids is not eligible. The rule id and the matched classification are recorded on every decision. No model, no randomness and no clock take part. | Deterministic, explainable, overrideable (SC-10). A table in config is how "changing policy changes behaviour without code changes" is literally true. First-match is the simplest thing a human can read top to bottom and predict. |
| D-P8-03 | **An override is a pin within policy, as in P5.** An orchestrator may pin a harness, a model or a rung on `delegate`. The pin must be eligible under `modelPolicy` and is recorded as `wasOverride`. A pin does not exempt the job from escalation, fallback or examination. | A-38 unchanged. An override that could escape examination would make risk a suggestion. |
| D-P8-04 | **Fallback is sideways, then up; never down.** A route is **unavailable** when configuration marks it so, or when the adapter reports it could not start on that route: not signed in, model not offered, rate-limited before any work began. Each adapter classifies its own start failures into `route_unavailable`. The decision is recorded with outcome `unavailable`, and the next route **on the same rung** is tried, then the next rung up. A route found unavailable is skipped for the rest of the run. | Stage 6's "unavailable model falls back correctly". Rate limits on subscriptions are a real cause of this and the likeliest one. Falling *down* a rung would trade a verified result for a cheap attempt, the opposite of A-13. Only the adapter can tell "could not start" from "started and failed", so the classification lives there, behind the harness boundary. |
| D-P8-05 | **A retry after a real failure climbs one rung.** When an orchestrator retries a job that ended `verification_failed`, `failed`, or `examination_failed`, the retry routes one rung above the last attempt (the top rung stays the top rung). A job that ended in a stale base, a conflict, an interrupt or an unavailable route retries on the **same** route: those failures say nothing about the model. Each attempt is a new `RoutingDecision` linked by `previousRouteId`; the one it replaced gets outcome `escalated`. The orchestrator still decides *whether* to retry. Routing only decides *where* the retry goes. | "Failures may escalate" (source plan), with the line drawn at failures that are evidence about capability. The chain of decisions is SC-11's dataset: a cheap attempt that failed and a stronger one that passed is exactly what a learned router needs. |
| D-P8-06 | **Usage is normalised, and dollars are either reported or estimated, never blended.** `usage` gains `cacheReadTokens` and `cacheWriteTokens` where a harness reports them, and `costSource: reported \| estimated \| unknown`. An estimate comes from a per-model price table in configuration. The report and any budget use `reported` where there is one and `estimated` otherwise, and say which. Budgets as Q3 decides. | Codex reports no cost; Claude does. Summing a reported figure with nothing, silently, is how D-P6-07 said a budget becomes a budget in name only. |
| D-P8-07 | **The examiner is an agent like any other, with its own role and nothing else.** It runs through the routed adapters with its own execution identity (A-04). `NIGHTSHIFT_ROLE=examiner` registers one tool, `examination.submit`, and its token may write only its own `Examination`. It works in a **detached checkout** of the commit it examines (A-39: its reach is bounded by where it runs, not by a list). Its route comes from the policy's requirement: a different model from the implementer's when `mustDifferModel`, a different provider when `mustDifferProvider`, and at high risk the **frontier rung**. | Stage 7's "examiner differs from the implementer invocation" is enforced by identity and route, not by prompt. A detached checkout means the examiner can run the tests itself and has nothing to commit. |
| D-P8-08 | **The examiner is given evidence, not the implementer's reasoning.** Its brief carries the Program Contract, the Job Contract, the diff, the changed tests, the verification results and logs, and the interfaces the scope touches. It is **not** given the worker's summary, transcript or commit message. | "Where practical, do not initially expose the implementer's rationale" (source plan). The commit message is the worker's summary (P3), so it is withheld too. |
| D-P8-09 | **A finding without evidence is refused.** Each finding names its severity (`material` or `minor`) and at least one piece of evidence: a file and line range in the examined commit, a test or command with its output, or a contract clause the diff contradicts. The examination is bound to the commit and to the diff's `patch-id`, and its full report goes to S3 (A-08). | "Examiner findings are evidence-backed" and "remain attached to exact commit/diff" (Stage 7), as schema rather than hope. Without the patch id, Q1(b)'s carry-over would be a guess. |
| D-P8-10 | **Findings go to the orchestrator that delegated the job, and only a fix or a human closes a blocking one.** A material finding reaches the delegating orchestrator through `job.wait` as the node's outcome. It may **fix** it (a retry that carries the findings in its brief, climbing per D-P8-05, and examined again) or **dispute** it with a reason. Where the policy blocks on material findings, a dispute does not resolve the finding: Q4 decides what happens instead. `risk_accepted` has authority `human`, always. | Stage 7's "the originating orchestrator receives material findings for resolution", with the self-grading hole closed. An agent may argue; it may not rule on its own argument. |
| D-P8-11 | **Examination and deferral compose, in that order.** A node whose checks are deferred (D-P7-10) is examined when its deferred checks pass at `resume`, never on unverified work. A node deferred on a disputed finding (Q4(b)) has passed every check and waits only for the human's ruling. | "Examination occurs against verified artifacts" (Stage 7), with A-05 intact. |

### Non-guarantees

- **A route that is cheapest by the ladder is not cheapest in fact.** The ladder
  is the owner's judgement, recorded. Measuring it is what SC-11's data is for.
- **An examiner can be wrong both ways.** A pass is evidence, not proof;
  deterministic verification still decides whether anything integrates.
- **Estimated cost is an estimate** from a table someone typed in. It is labelled
  wherever it appears.
- **Workers and examiners are still not contained** on the operator's machine
  (A-39, P10).

## 4. Design

### 4.1 A job's path

```text
delegate { classification, pins? }
   └─ route      rules → starting rung → first available route on it   (RoutingDecision #1)
        └─ worker  implements                                           (usage recorded)
             ├─ examination not required ─────────────────────────────┐
             └─ required: verify snapshot, examine beside the queue    │  (Q1 b)
                   passed ────────────────────────────────────────────┤
                   material findings → orchestrator: fix | dispute    │
                                                                      ▼
                                   merge queue: replay, verify on head,
                                   examined patch unchanged? → seal → integrate
                                   changed? → examine again, in the queue
   failure → orchestrator retries → one rung up                         (RoutingDecision #2, previousRouteId)
   could not start → same rung, next route; then up                     (outcome: unavailable)
```

### 4.2 Configuration

```jsonc
// nightshift.config.json (inherited by every program's contract, P7)
"routingPolicy": {
  "rungs": {
    "cheap":    [{ "harness": "claude", "model": "…" }],
    "standard": [{ "harness": "claude", "model": "…" }],
    "frontier": [{ "harness": "claude", "model": "…" }, { "harness": "codex", "model": "…" }]
  },
  "ladder": ["cheap", "standard", "frontier"],
  "rules": [
    { "id": "R-orchestrate", "when": { "kind": ["orchestrate"] }, "start": "frontier" },
    { "id": "R-high",        "when": { "risk": ["high"] },        "start": "frontier" },
    { "id": "R-bounded",     "when": { "risk": ["low"], "ambiguity": ["low"], "testability": ["strong"] }, "start": "cheap" },
    { "id": "R-default",     "when": {},                          "start": "standard" }
  ],
  "unavailable": [],
  "prices": { "<model>": { "inputPerMTok": 0, "outputPerMTok": 0 } }
},
"examinationPolicy": { "low": {…}, "medium": {…}, "high": {…} }   // P5's shape, now honoured
```

`nightshift init` writes this with Q2's models and examination **on** for
medium and high (today it writes examination off at every level, because none
existed).

### 4.3 Where the code goes

| Concern | Home |
|---------|------|
| Rule matching, the ladder, fallback and escalation choice, examiner route choice, the self-examination rule | `packages/routing` and `core`'s rules: pure, table-tested, offline |
| Classifying a start failure as `route_unavailable` | each `harness-*` adapter, behind the adapter contract |
| Beside-the-queue verification and examination, carry-over by patch id | `packages/execution` |
| The examiner role, its brief, `examination.submit` | `apps/mcp`, `packages/harness` (brief) |
| Budgets | the engine, beside wall clock |
| Usage normalisation and cost estimation | `packages/routing` (price table), recorded by the runner |

### 4.4 The examination record

P5's `Examination` stands, gaining `patchId`, `examinerRoute`, per-finding
`evidence[]`, and a resolution per finding with its authority. The rule that
examiner ≠ implementer (already in the schema) gains the model and provider
checks the policy requires. They are checked in `core` and **again by the API**
when the examination is written, so an examiner that should not have been chosen
cannot record a verdict.

### 4.5 The report and the dataset

`report.md` gains, per strand: the routes tried and why (rule, rung, fallbacks,
escalations), what it cost (reported or estimated, labelled), each examination
and its findings with their resolution. `nightshift routes export <run>` (and
`--project`) writes the run's routing decisions as JSON Lines. Each line is
self-contained: the classification, eligible options, rule, route, attempt chain,
usage, verification outcome and examination outcome. That is SC-11: nothing
needs a join to be trained on.

### 4.6 Control-plane changes

| Change | Why |
|--------|-----|
| `JobContract` gains `testability`, `kind` (optional, defaulted conservatively) | D-P8-01. A contract written before P8 parses to what it was |
| `RoutingDecision` gains `classification`, `rung`, outcome `unavailable`; `usage` gains cache tokens and `costSource` | D-P8-04 … D-P8-06 |
| `Examination` gains `patchId`, `examinerRoute`, evidence, resolutions | D-P8-09, D-P8-10 |
| An **examiner** execution role: may write its own `Examination`, read its run, nothing else; the checks in §4.4 at write time | D-P8-07. A new cell in both `authorize` tables |
| A deferral whose reason is a disputed finding (Q4 b) | Reuses `deferred` and its edges; **no change to P1's table** |

## 5. Scope

### In scope

- Classification on the Job Contract and `delegate`; the sub-orchestrator's
  risk default fixed.
- `routingPolicy`: rules, rungs, ladder, unavailable routes, prices; its schema in
  `contracts`, inherited through `nightshift.config.json`; `nightshift init`
  writes a working one.
- Deterministic rule routing, overrides, fallback, escalation, all recorded.
- Start-failure classification in both adapters.
- Usage normalisation, cost estimation, budgets per Q3.
- The examiner: role, brief, route choice, `examination.submit`, placement per Q1,
  carry-over by patch id, resolution per D-P8-10 and Q4.
- Retiring `assertExaminable`'s refusal.
- The report's routing and examination sections; `nightshift routes export`.
- The `plan-program`, `run-program` and `nightshift` skills: how to classify a job,
  what a finding means, how to fix or dispute one.
- The live suite `npm run routing`; the exit gate per Q5.

### Out of scope

- The AgentCore harness, Bedrock, anything remote (P10). O-05.
- Learned routing, or any routing input that is not in the job's own record.
- Examining whole programs or strands (program verification is P6's and stays
  deterministic).
- Replaying a cone after a finding is upheld at `resume` beyond what P7's discard
  does (P9).
- A Studio view of any of it (P11 ships the data surface).

## 6. Success criteria

- **SC-P8-01** Routing is deterministic: the same classification, policy and
  availability always give the same route, proven table-driven and by property
  over random policies.
- **SC-P8-02** Every routing decision records its eligible options, the rule and
  rung responsible, the classification it matched, whether it was an override,
  and, once known, its usage, latency, outcome and the attempt it replaced.
- **SC-P8-03** An override within policy selects a different model or harness
  and is recorded as one; an override outside policy is refused, by name.
- **SC-P8-04** An unavailable route falls back to the next route on its rung,
  then up, never down; the unavailable attempt is recorded; a route found
  unavailable is not tried again in the run.
- **SC-P8-05** A retry after a verification, worker or examination failure
  climbs one rung; a retry after a stale base, conflict, interrupt or unavailable
  route does not; the final outcome lists every attempted route.
- **SC-P8-06** Usage is captured from both harnesses in one normalised shape;
  cost is reported or estimated and says which; budgets behave per Q3.
- **SC-P8-07** A low-risk job integrates with no examiner when the policy says
  so.
- **SC-P8-08** A medium-risk job is examined by a different model; a high-risk
  job by a different-provider frontier examiner.
- **SC-P8-09** Self-examination is refused: the same agent always; the same
  model or provider when the policy requires a difference. Refused in `core` and
  again by the API.
- **SC-P8-10** Every examination is bound to a commit and a patch id; every
  finding carries evidence, and one without is refused.
- **SC-P8-11** A material finding reaches the delegating orchestrator; a fix is
  re-examined; under a blocking policy nothing but a fix or a human ruling lets
  the work integrate, and in an unattended run the outcome is Q4's.
- **SC-P8-12** Changing `routingPolicy` or `examinationPolicy` changes behaviour
  with no code change: one fixture, run under two configurations, takes two
  different paths.
- **SC-P8-13** `nightshift routes export` produces self-contained lines, one per
  decision, covering every attempt of a run.
- **SC-P8-14** The P1 property tests, the P4 isolation suites, the P5 conformance
  suite, the P6 tree and the P7 planned fixture pass unchanged, except where a
  ratified decision adds a status, a role or a field, listed in the as-built.

**Exit gate**

- **SC-P8-15** Live, with real adapters against the deployed control plane:
  a bounded job on the cheap rung integrates; a job whose cheap attempt fails
  escalates and integrates; a pinned override takes effect; a route made
  unavailable falls back; a medium-risk job is examined by a different model and
  a high-risk one by Codex, whose planted defect is found with evidence and fixed
  before it lands. Plus Q5's trial, if (b).

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy`, `npm run smoke` (twice),
`npm run conformance -- --harness all`, `npm run slice`, `npm run routing`.

## 8. Constraints

- No model decides a route, whether a job needs examining, or whether a finding
  has evidence. The examiner judges the work; everything around it is
  deterministic.
- A-05 holds: examination never substitutes for verification, and nothing it
  does lets unverified work integrate.
- One home per fact: the ladder and rules live in configuration, not in code and
  not in a prompt.
- P1's transition table is not changed.
- A-39: no adapter or examiner gains an allow-list, a sandbox or an approval
  policy.
- Pins exact; scripts run on Windows and Linux.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.6; running the
smoke, slice, conformance and routing suites; running Claude Code and Codex
headless on the operator's subscriptions, on the models Q2 names; running Q5's
trial on the repository the owner names.

Forbidden:

- Letting a model choose a route or waive an examination.
- Letting an agent record `risk_accepted`, or resolve a blocking finding by
  disputing it.
- Weakening the P1, P4, P5, P6 or P7 suites.
- Rebuilding this checkout's `dist/` while the owner's run is using it.
- Anything remote or on Bedrock (P10). Settling O-02, O-03, O-05 or O-06.
- Inspecting the legacy Nightshift's branches or tags.

## 10. Tasks

Drafted after §3.1 is answered: Q1 and Q4 change T3's shape.

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Contracts, rules and the API: classification, `routingPolicy`, the examiner role, the examination record, `authorize`; deploy | — | AWS |
| T2 | Routing: rules, overrides, fallback and adapter start-failure classes, escalation, usage and cost, budgets | T1 | — |
| T3 | Examination: the examiner, its brief and route, placement, carry-over, findings to the orchestrator, resolution and deferral | T1, T2 | — |
| T4 | Orchestrator tools, skills, `init`, the report, `routes export` | T2, T3 | — |
| T5 | Fixture proofs; the live suite; the exit gate; as-built | T4 | AWS, Claude Code, Codex, Q5's repository |

```text
T1 ── T2 ── T3 ── T4 ── T5
```

Specs will live in `tasks/p8-routing-examination/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| The cheap rung fails so often the ladder costs more than starting higher | SC-11's data shows it per rule; the rule table is config, so the fix is one line. The exit gate's trial is the first real measure |
| Orchestrators classify everything as low risk to get cheap routes and skip examination | Unset means conservative (D-P8-01); the classification is recorded on every decision and shown in the report, so a pattern is visible |
| Examiners raise noise, and material findings stall runs | Evidence is required; the severity split is the examiner's, but only material findings block, and only where the policy says so; Q4 decides what a dispute costs |
| Beside-the-queue examination is stale by the time the job lands | Carry-over only on an identical patch id; otherwise examined again in the queue (Q1 b) |
| Subscription rate limits make "unavailable" flap | A route found unavailable stays skipped for the run (D-P8-04); the report says so |
| The program runs long | Staging's split point stands: Stage 7 (T3) splits off after T2, where routing decisions are persisted |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-24 | Contract drafted after P7 closed. D-P8-01 … D-P8-11 proposed; Q1 … Q5 put to the owner. Tasks to be drafted once they are answered. | Agent, for human ratification |

## 13. As built

Not started.
