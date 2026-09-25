# Program P8 — Routing and Examination

| Field | Value |
|-------|-------|
| Program ID | `p8-routing-examination` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p8-routing-examination` |
| Source stage | Stage 6 (Model/Harness Routing) and Stage 7 (Risk-Based Examination) |
| Status | **Contract ratified 2026-09-25** (D-P8-01 … D-P8-15; §3.1, §12). Not started; build from T1. |
| Depends on | P4 (organisations), P5 (the compatibility table, `RoutingDecision`, usage on exit), P6 (the engine, the merge queue, retries), P7 (strands, the report, the provisional line) |
| Blocking decisions | none |

This contract is the stable authority for P8. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Two policy layers over the engine that already works, both driven by
configuration and neither by code:

- **Routing.** Each job goes to the cheapest route likely to reach a *verified*
  result (A-13), chosen deterministically from what the job says about itself,
  over **ladders** an organisation configures. A route that cannot start falls
  back. A route that fails climbs its ladder. Every attempt is recorded with
  enough of the job and its outcome to train a router on later (SC-11), and what
  a run costs is known and bounded.
- **Examination.** Where a job's risk warrants it, a different model or a
  different provider examines the verified work against evidence before it lands
  (A-12). Its findings go to the orchestrator that delegated the job. A blocking
  finding is closed by a fix, or, when the orchestrator disputes it, by an
  independent **arbiter**, whose ruling the owner can reverse. Low risk lands on
  deterministic verification alone.

**What P8 is not.** The cheap Bedrock route is P10's: P8 routes among what exists
(Claude Code on Anthropic models, Codex on OpenAI's) and its policy must not
assume a harness that has not been built (`staging.md`). Stage 6's first proof,
"low-risk job routes through AgentCore Harness to a cheaper Bedrock model", is
proven here with the cheapest rung that exists, and again in P10 with Bedrock.
SC-05 stays P10's. Learned routing is after v1: P8 captures the data only.

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
- The compatibility table's Codex default is `gpt-5.5`, which Codex's own catalog now lists as a legacy model. P8 moves defaults into the org's ladders, so the table keeps only what each harness *can* run.
- Configuration exists per repository (`nightshift.config.json`) and per program
  contract. An organisation holds nothing but its members and projects.
- A sub-orchestrator's `delegate` defaults risk and ambiguity to `low`, not to the
  program's `defaultRisk`. That is a defect and P8 fixes it: examination keyed on
  a risk nobody chose would be the ceremony A-12 rejects, in reverse.

## 2. Environment and human prerequisites

Everything from P3 … P7 stands.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P8-01 | Ratify D-P8-01 … D-P8-15 | **satisfied 2026-09-25** |
| H-P8-02 | P7 merged | **satisfied 2026-09-24** (PRs #19, #20) |
| H-P8-03 | Claude Code and Codex signed in on the operator's machine, with every model on the org's ladders reachable on those subscriptions | **satisfied 2026-09-25** for all six models on the owner's ladders: each answered a one-line prompt headless (`claude -p --model`, `codex exec -m`). Rechecked by `npm run routing`'s preflight before every live run |
| H-P8-04 | A repository for the exit gate's trial, and a program to plan on it (SC-P8-18) | open, needed by T5 only |

**Explicitly not required.** No new AWS resource: organisation configuration is a
record in the existing table. The API gains routes, roles and fields (§4.6) and is
redeployed.

## 3. Decisions

### 3.1 The owner's answers, 2026-09-25

| # | Question | Answer |
|---|----------|--------|
| Q1 | Where does examination run? | **Beside the merge queue**, not in it (D-P8-09) |
| Q2 | What is the ladder? | **Configurable per organisation**, with a ladder per provider. The owner's own: Claude `claude-haiku-4-5-20251001 → claude-sonnet-5 → claude-opus-5-5`; Codex, as amended the same day from Codex's own model catalog: `gpt-6-luna → gpt-6-sol → gpt-6-astra`. The repository and the contract may **narrow** the org's configuration, never widen it (D-P8-02, D-P8-03) |
| Q3 | Enforce `maxUsd` and `maxTokens` now? | **Yes**, with estimated dollars labelled as estimates (D-P8-08) |
| Q4 | A blocking finding the orchestrator disputes, unattended | **An independent arbiter rules, and the ruling stands**: overturned lands, upheld fails and parks. The ruling is a recorded decision the owner can reverse (D-P8-13) |
| Q5 | The exit gate | **The live suite and a real planned program** on a repository the owner names (SC-P8-17, SC-P8-18) |
| Q6 | How many fixes does a blocking finding get? | **Two.** After the second, the arbiter rules whether or not the orchestrator disputed; the ruling is recorded against a checkpoint and becomes a rollback point, and the run moves on (D-P8-13) |
| Q7 | Where does work go when a route cannot start? | **Another model on the rung, then the other provider's ladder at the same tier, then one rung up**, as drafted (D-P8-06) |
| Q8 | Does a retry climb? | **One rung on every real failure**, as drafted (D-P8-07) |
| Q9 | What does the examiner see? | **Evidence only, and it may ask the builder direct questions**: up to three, one round, answered by resuming the builder's own session (the owner's proposal; D-P8-11, D-P8-15) |
| Q10 | The default examination policy | **Low not examined; medium examined by a different model, advisory; high examined by the other provider's frontier model, blocking**, as drafted (§4.2) |

### 3.2 Ratified decisions

Proposed 2026-09-24; revised to §3.1's answers and ratified by the owner 2026-09-25.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P8-01 | **A job says what it is; the policy says where that goes.** The Job Contract gains two classification fields beside `risk` and `ambiguity`: `testability` (`strong`: the contract's checks exercise the change; `weak`; `none`) and `kind` (`implement`, `fix`, `refactor`, `test`, `docs`, `orchestrate`). Scope breadth is derived from `scope.includes`, never declared. The delegating orchestrator sets them; anything left unset takes the **conservative** default (`defaultRisk`, `medium` ambiguity, `weak` testability), so an unclassified job never lands on the cheapest rung by accident. Sub-orchestrators default to `defaultRisk` like the root. | Stage 6's inputs, cut to what an orchestrator can state honestly and a rule can match on. Blast radius is `risk`; a context requirement is what `scope` and the context documents already say. A field that can be derived is not a second home for the same fact. |
| D-P8-02 | **Routing policy belongs to the organisation.** `routingPolicy` is stored in the control plane per org, read and written by the org's members (`nightshift org config`). It holds **ladders**, one or more, each an ordered list of rungs, and each rung one or more routes in preference order. A route is a `(harness, model)` pair with an optional **`effort`** (`low`, `medium`, `high`, `xhigh`, `max`), which the adapter passes to its harness (`claude --effort`, Codex's `model_reasoning_effort`); absent, the harness's own default applies. A rung may therefore be the same model as the rung below at a higher effort. Rungs carry a **tier** (`cheap`, `standard`, `frontier`) so rules and examiners can speak across ladders. It also holds the **rules**, the price table, routes marked unavailable, and the default `examinationPolicy`. A new org is seeded with a working default, which the owner's org then replaces with Q2's ladders. | The owner's answer to Q2. Ladders and prices are a team's standing choice, not a repository's; a second project should not have to restate them. Tiers let ladders of different lengths be compared without pretending they are the same, and name the rung another provider's work falls back to. |
| D-P8-03 | **The repository and the contract may only narrow.** `nightshift.config.json` and the Program Contract inherit the org's policy and may forbid a route, drop a ladder, raise a rule's starting tier or tighten an examination requirement. They may not add a model, a harness or a ladder the org does not have, or loosen examination. The effective policy is computed in `core`, and what it was is recorded on the run. | A-11 applied to configuration: children narrow, never widen. It is also the only reading of "configurable by org" in which the org's choice means anything. |
| D-P8-04 | **Routing is a first-match rule table.** Each rule matches on classification and names a starting **ladder** and **tier**. The first rule that matches wins; the last has no conditions. A ladder without the named tier starts at its lowest rung at or above it. `modelPolicy` still intersects everything. The rule id, the ladder, the rung and the classification matched are recorded on every decision. No model, no randomness and no clock take part. | Deterministic, explainable, overrideable (SC-10). A table is how "changing policy changes behaviour without code changes" is literally true, and first-match is the simplest thing a human can read top to bottom and predict. |
| D-P8-05 | **An override is a pin within policy, as in P5.** An orchestrator may pin a harness, a model, a ladder or a tier on `delegate`. The pin must be eligible under the effective policy and is recorded as `wasOverride`. A pin does not exempt the job from escalation, fallback or examination. | A-38 unchanged. An override that could escape examination would make risk a suggestion. |
| D-P8-06 | **Fallback is sideways, then up; never down.** A route is **unavailable** when policy marks it so, or when the adapter reports it could not start on that route: not signed in, model not offered, rate-limited before any work began. Each adapter classifies its own start failures into `route_unavailable`. The attempt is recorded with outcome `unavailable`, and the next route is tried in this order: the next route on the same rung; the rung of the **same tier on another ladder**; the next rung up the job's own ladder. A route found unavailable is skipped for the rest of the run. | Stage 6's "unavailable model falls back correctly". Rate limits on one subscription are the likeliest cause, and a second provider's ladder at the same tier is the natural place to go. Falling *down* would trade a verified result for a cheap attempt, the opposite of A-13. Only the adapter can tell "could not start" from "started and failed", so the classification lives there. |
| D-P8-07 | **A retry after a real failure climbs one rung of its ladder.** When an orchestrator retries a job that ended `verification_failed`, `failed` or `examination_failed`, the retry routes one rung above the last attempt on the same ladder; the top rung stays the top rung. A job that ended in a stale base, a conflict, an interrupt or an unavailable route retries on the **same** route: those failures say nothing about the model. Each attempt is a new `RoutingDecision` linked by `previousRouteId`; the one it replaced gets outcome `escalated`. The orchestrator still decides *whether* to retry; routing decides *where*. | "Failures may escalate" (source plan), with the line drawn at failures that are evidence about capability. The chain of decisions is SC-11's dataset: a cheap attempt that failed and a stronger one that passed is exactly what a learned router needs. |
| D-P8-08 | **Usage is normalised, dollars are reported or estimated and never blended, and budgets are enforced.** `usage` gains `cacheReadTokens` and `cacheWriteTokens` where a harness reports them, and `costSource: reported \| estimated \| unknown`. An estimate comes from the org's price table. Budgets use `reported` where there is one and `estimated` otherwise. Once `maxUsd` or `maxTokens` is spent the engine starts nothing new and says why, as it does for wall clock (D-P6-07); work already running finishes. The report says which figures are estimates. | The owner's answer to Q3. Codex reports no cost; Claude does. Summing a reported figure with nothing, silently, is how D-P6-07 said a budget becomes a budget in name only. |
| D-P8-09 | **Examination runs beside the merge queue.** When a worker finishes a job that needs examining, the execution layer verifies its snapshot in its own worktree and an examiner examines that verified snapshot, while other work lands. The node enters the queue only once examination has passed or its findings are resolved. The queue replays and verifies as it does today. If the replayed diff's `git patch-id` matches the examined one, the examination carries over and `verified → examining → sealed` passes at once, citing it; if the replay changed the diff, the node is examined again, in the queue. The node stays `implemented` while it is examined beside the queue: **P1's table is unchanged**. | The owner's answer to Q1. Examination is the slowest step P8 adds; in the queue it would sit on the one serial path P6 exists to keep short. The cost is one extra verification run per examined job, and none for a job that is not examined. |
| D-P8-10 | **The examiner is an agent like any other, with its own role and nothing else.** It runs through the routed adapters with its own execution identity (A-04). `NIGHTSHIFT_ROLE=examiner` registers two tools, `examination.ask` (D-P8-15) and `examination.submit`, and its token may write only its own `Examination`. It works in a **detached checkout** of the commit it examines (A-39: its reach is bounded by where it runs, not by a list). Its route: a different model from the implementer's when `mustDifferModel`; a route from **another provider's ladder** when `mustDifferProvider`; at high risk, that ladder's **frontier** tier. | Stage 7's "examiner differs from the implementer invocation", enforced by identity and route, not by prompt. With a ladder per provider, "different provider" is simply "another ladder". |
| D-P8-11 | **The examiner is given evidence, not the implementer's reasoning.** Its brief carries the Program Contract, the Job Contract, the diff, the changed tests, the verification results and logs, and the interfaces the scope touches. It is **not** given the worker's summary, transcript or commit message; where it needs intent, it asks (D-P8-15). | "Where practical, do not initially expose the implementer's rationale" (source plan). The commit message is the worker's summary (P3), so it is withheld too. A question gets the one answer the examiner needed, not the reasoning that would talk it round. |
| D-P8-12 | **A finding without evidence is refused.** Each finding names its severity (`material` or `minor`) and at least one piece of evidence: a file and line range in the examined commit, a test or command with its output, or a contract clause the diff contradicts. The examination is bound to the commit and the diff's `patch-id`, and its full report goes to S3 (A-08). | "Examiner findings are evidence-backed" and "remain attached to exact commit/diff" (Stage 7), as schema rather than hope. The patch id is what makes D-P8-09's carry-over exact. |
| D-P8-13 | **Findings go to the delegating orchestrator; two fixes, then an arbiter; the owner can reverse the arbiter.** Under a **non-blocking** requirement (the default for medium), findings are recorded and handed to the delegating orchestrator, and the work lands; the orchestrator may delegate a follow-up fix. Under a **blocking** requirement (the default for high), a material finding ends the node `examination_failed` and reaches the orchestrator through `job.wait`. It may **fix** it (a retry that carries the findings in its brief, climbs per D-P8-07, and is examined again), at most **twice** per job, a limit the engine enforces; or **dispute** it with a reason at any point. A dispute, or a material finding still standing after the second fix, goes to an **arbiter**: a fresh frontier-tier invocation of a model that neither the implementer nor the examiner used (a third provider's ladder when the org has one), with its own role (`NIGHTSHIFT_ROLE=arbiter`, one tool, `finding.rule`), given the finding, its evidence, the examiner's questions and answers, any dispute, and the diff. It **overturns** the finding, and the work proceeds to land, or **upholds** it, and the job fails and its strand parks with its cone (D-P7-09). Either way the run moves on. Each ruling is a `Decision` with authority `agent`, made by the arbiter, naming the finding, with **`checkpointBefore`** the program head before the ruled work could land and **`checkpointAfter`** the head after it landed, so it is a rollback point; it is flagged first in the report and reversible by the owner, as a `human` decision superseding it. `risk_accepted` has authority `human`, always. | The owner's answers to Q4 and Q6. The orchestrator never grades its own dispute, a disagreement costs at most three builds and an arbiter call, and the owner has the last word after the night. With two providers the arbiter cannot differ in provider from both sides; it differs in model and invocation from both, and the report says which. **Before P9, reversing a ruling is recorded and reported and replays nothing**: the checkpoints make the rollback addressable (`git reset` to `checkpointBefore` by hand), and the minimum-cone replay is P9's (SC-13). |
| D-P8-15 | **The examiner may ask the builder.** Before it submits, the examiner may put up to **three** questions, in **one** round, through `examination.ask`. They are answered by **resuming the builder's own session** (both harnesses can), told only to answer; when the session cannot be resumed, by a fresh invocation of the builder's route given its saved transcript, and the answer says which. The questions and answers are recorded on the examination, shown to the arbiter, and printed in the report. A resumed builder can change nothing: it answers in a read-only detached checkout and its answer is text. | The owner's proposal. A blind examiner flags deliberate choices it cannot see a reason for; showing it the builder's reasoning would talk it round. A direct question gets exactly the intent it needed and nothing else, and one bounded round keeps an examination's time and cost predictable. Resuming the session answers from memory of the work, not a reconstruction. |
| D-P8-14 | **Examination and deferral compose, in that order.** A node whose checks are deferred (D-P7-10) is examined when its deferred checks pass at `resume`, never on unverified work. | "Examination occurs against verified artifacts" (Stage 7), with A-05 intact. |

### Non-guarantees

- **A route that is cheapest by the ladder is not cheapest in fact.** The ladders
  are the org's judgement, recorded. Measuring them is what SC-11's data is for.
- **An examiner, and an arbiter, can be wrong both ways.** A pass is evidence,
  not proof; deterministic verification still decides whether anything
  integrates, and the owner can reverse any ruling.
- **With two providers, the arbiter shares a provider with one side.** It never
  shares a model or an invocation with either.
- **Estimated cost is an estimate** from a table someone typed in. It is labelled
  wherever it appears.
- **Workers, examiners and arbiters are still not contained** on the operator's
  machine (A-39, P10).

## 4. Design

### 4.1 A job's path

```text
delegate { classification, pins? }
   └─ route      effective policy → first matching rule → ladder, tier → first available route
        └─ worker  implements                                          (RoutingDecision, usage)
             ├─ no examination required ───────────────────────────────┐
             └─ required: verify snapshot, examine beside the queue    │
                   passed ────────────────────────────────────────────┤
                   (may ask the builder ≤3 questions, one round)          │
                   advisory findings → recorded, work lands ──────────┤
                   blocking finding → orchestrator
                        fix (≤2) → retry, one rung up, examined again  │
                        dispute, or still failing after 2 → arbiter
                                     overturned (rollback point) ──────┤
                                     upheld → failed, strand parks      │
                                                                       ▼
                     merge queue: replay, verify on head
                       examined patch unchanged → seal → integrate
                       changed                   → examine again, in the queue
   failure → orchestrator retries → one rung up its ladder
   could not start → next route on rung → same tier, other ladder → one rung up
```

### 4.2 Configuration

```text
org (control plane)          ladders, tiers, rules, prices, unavailable, examinationPolicy
  └─ nightshift.config.json  may narrow: forbid routes, drop a ladder, raise a starting tier,
       │                     tighten examination
       └─ Program Contract   may narrow further (modelPolicy, examinationPolicy)
            = effective policy, computed in core, recorded on the run
```

The owner's org, as answered:

```jsonc
"routingPolicy": {
  "ladders": {
    "claude": [
      { "tier": "cheap",    "routes": [{ "harness": "claude", "model": "claude-haiku-4-5-20251001" }] },
      { "tier": "standard", "routes": [{ "harness": "claude", "model": "claude-sonnet-5" }] },
      { "tier": "frontier", "routes": [{ "harness": "claude", "model": "claude-opus-5-5" }] }
    ],
    "codex": [
      { "tier": "cheap",    "routes": [{ "harness": "codex", "model": "gpt-6-luna" }] },
      { "tier": "standard", "routes": [{ "harness": "codex", "model": "gpt-6-sol" }] },
      { "tier": "frontier", "routes": [{ "harness": "codex", "model": "gpt-6-astra" }] }
    ]
  },
  "rules": [
    { "id": "R-orchestrate", "when": { "kind": ["orchestrate"] }, "start": { "ladder": "claude", "tier": "frontier" } },
    { "id": "R-high",        "when": { "risk": ["high"] },        "start": { "ladder": "claude", "tier": "frontier" } },
    { "id": "R-bounded",     "when": { "risk": ["low"], "ambiguity": ["low"], "testability": ["strong"] },
                             "start": { "ladder": "claude", "tier": "cheap" } },
    { "id": "R-default",     "when": {},                          "start": { "ladder": "claude", "tier": "standard" } }
  ],
  "unavailable": [],
  "prices": { "<model>": { "inputPerMTok": 0, "outputPerMTok": 0 } }
},
"examinationPolicy": {
  "low":    { "required": false, … },
  "medium": { "required": true, "mustDifferModel": true, "blockOnMaterialFindings": false },   // advisory
  "high":   { "required": true, "mustDifferProvider": true, "blockOnMaterialFindings": true }      // blocking
}
```

The rules above are a starting point, not a decision; they live in the org's
configuration and change without code. `nightshift init` no longer writes a
ladder into a repository: it writes a config that inherits the org's, with
examination on for medium and high (today it writes examination off at every
level, because no examiner existed).

### 4.3 Where the code goes

| Concern | Home |
|---------|------|
| Effective policy (narrowing), rule matching, ladders and tiers, fallback and escalation choice, examiner and arbiter route choice, the independence rules | `packages/routing` and `core`'s rules: pure, table-tested, offline |
| Classifying a start failure as `route_unavailable` | each `harness-*` adapter, behind the adapter contract |
| Beside-the-queue verification and examination, carry-over by patch id | `packages/execution` |
| The examiner and arbiter roles, their briefs, `examination.submit`, `finding.rule` | `apps/mcp`, `packages/harness` (briefs) |
| Budgets | the engine, beside wall clock |
| Usage normalisation and cost estimation | `packages/routing` (price table), recorded by the runner |
| Org configuration | `contracts` (schema), the API (one record per org), `apps/cli` (`nightshift org config`) |

### 4.4 The examination record

P5's `Examination` stands, gaining `patchId`, `examinerRoute`, per-finding
`evidence[]`, and `questions[]` (each with its answer and whether it came from the resumed
session or the transcript), `fixAttempt`, and per finding a resolution (`fixed`,
`disputed`, `overturned`, `upheld`, `risk_accepted`) with its authority and, for an arbiter's ruling, the
`Decision` that made it. The rule that examiner ≠ implementer (already in the
schema) gains the model and provider checks the policy requires, and the arbiter
gets its own: a different model from both sides. They are checked in `core` and
**again by the API** when the examination or the ruling is written, so an
examiner or arbiter that should not have been chosen cannot record a verdict.

### 4.5 The report and the dataset

`report.md` gains, per strand: the routes tried and why (rule, ladder, rung,
fallbacks, escalations), what it cost (reported or estimated, labelled), and
each examination with its findings and their resolution. **Arbiter rulings lead
the report**, before departures, each with what reversing it would mean.
`nightshift routes export <run>` (and `--project`) writes the run's routing
decisions as JSON Lines, each self-contained: classification, effective policy
version, eligible options, rule, ladder, rung, route, attempt chain, usage,
verification outcome, examination outcome. That is SC-11: nothing needs a join
to be trained on.

### 4.6 Control-plane changes

| Change | Why |
|--------|-----|
| An org configuration record (`routingPolicy`, default `examinationPolicy`), read by the org's members and executions in its projects, written by its members; seeded for a new org | D-P8-02 |
| The run records the effective policy it ran under | D-P8-03 |
| `JobContract` gains `testability`, `kind` (optional, defaulted conservatively) | D-P8-01. A contract written before P8 parses to what it was |
| `RoutingDecision` gains `classification`, `ladder`, `rung`, the route's `effort`, outcome `unavailable`; `usage` gains cache tokens and `costSource` | D-P8-04 … D-P8-08 |
| `Examination` gains `patchId`, `examinerRoute`, evidence, resolutions | D-P8-12, D-P8-13 |
| Harness adapters record the builder's session id, and can resume a session to answer a question (an optional capability; conformance gains a case) | D-P8-15 |
| Two execution roles, **examiner** and **arbiter**, each able to write its own record and read its run, nothing else; the independence checks of §4.4 at write time | D-P8-10, D-P8-13. New cells in both `authorize` tables |
| No change to P1's transition table | D-P8-09 |

## 5. Scope

### In scope

- Classification on the Job Contract and `delegate`; the sub-orchestrator's
  risk default fixed.
- Org routing configuration: schema, storage, API, `nightshift org config`,
  narrowing through `nightshift.config.json` and the contract; the owner's org
  set to Q2's ladders; `nightshift init` updated.
- Deterministic rule routing, overrides, fallback, escalation, all recorded.
- Start-failure classification in both adapters.
- Usage normalisation, cost estimation, `maxUsd` and `maxTokens` enforced.
- The examiner: role, brief, route choice, `examination.submit`, beside-the-queue
  placement, carry-over by patch id.
- The examiner's questions to the builder, answered by resuming its session.
- Findings to the orchestrator; two fixes, dispute; the arbiter and its
  checkpoints; the owner's reversal recorded.
- Retiring `assertExaminable`'s refusal.
- The report's routing and examination sections; `nightshift routes export`.
- The `plan-program`, `run-program` and `nightshift` skills: how to classify a
  job, what a finding means, how to fix or dispute one, how to reverse a ruling.
- The live suite `npm run routing`; the exit gate's trial.

### Out of scope

- The AgentCore harness, Bedrock, anything remote (P10). O-05.
- Learned routing, or any routing input that is not in the job's own record.
- Examining whole programs or strands (program verification is P6's and stays
  deterministic).
- Replaying anything when the owner reverses a ruling, or when a finding upheld
  at `resume` discards work (P9).
- A Studio view of any of it (P11 ships the data surface).

## 6. Success criteria

- **SC-P8-01** Routing is deterministic: the same classification, effective
  policy and availability always give the same route, proven table-driven and by
  property over random policies.
- **SC-P8-02** Every routing decision records its eligible options, the rule,
  ladder and rung responsible, the effort it ran at, the classification it matched, whether it was an
  override, and, once known, its usage, latency, outcome and the attempt it
  replaced.
- **SC-P8-03** An org's routing configuration is the default for every project in
  it. A repository or contract can narrow it and cannot widen it: a widening is
  refused, by name, and the effective policy is recorded on the run.
- **SC-P8-04** An override within policy selects a different model, harness,
  ladder or tier and is recorded as one; an override outside policy is refused,
  by name.
- **SC-P8-05** An unavailable route falls back to the next route on its rung,
  then the same tier on another ladder, then up, never down; the unavailable
  attempt is recorded; a route found unavailable is not tried again in the run.
- **SC-P8-06** A retry after a verification, worker or examination failure
  climbs one rung; a retry after a stale base, conflict, interrupt or unavailable
  route does not; the final outcome lists every attempted route.
- **SC-P8-07** Usage is captured from both harnesses in one normalised shape;
  cost is reported or estimated and says which; once `maxUsd` or `maxTokens` is
  spent, nothing new starts and the run says why.
- **SC-P8-08** A low-risk job integrates with no examiner when the policy says
  so.
- **SC-P8-09** A medium-risk job is examined by a different model; a high-risk
  job by the frontier tier of another provider's ladder.
- **SC-P8-10** Self-examination is refused: the same agent always; the same
  model or provider when the policy requires a difference. An arbiter sharing a
  model with either side is refused. Refused in `core` and again by the API.
- **SC-P8-11** Every examination is bound to a commit and a patch id; every
  finding carries evidence, and one without is refused. An examination carries
  over through the queue only for an identical patch id.
- **SC-P8-12** Under an advisory requirement, findings are recorded and handed to
  the orchestrator and the work lands. Under a blocking one, a material finding
  reaches the delegating orchestrator; a fix is re-examined; a third fix is
  refused; a dispute, or a finding standing after two fixes, goes to the arbiter;
  an overturn lands, an upheld finding fails the job and parks its strand, and
  nothing else lets the work integrate.
- **SC-P8-12a** An examiner's questions (at most three, one round) are answered by
  the builder's resumed session, or from its transcript when it cannot resume,
  saying which; they are recorded and reach the arbiter.
- **SC-P8-13** Every arbiter ruling is a `Decision` with authority `agent` and
  `checkpointBefore` and `checkpointAfter` set, leads the report, and can be reversed by the owner as a superseding `human`
  decision, which is recorded and reported.
- **SC-P8-14** Changing the org's `routingPolicy` or `examinationPolicy` changes
  behaviour with no code change: one fixture, run under two configurations, takes
  two different paths.
- **SC-P8-15** `nightshift routes export` produces self-contained lines, one per
  decision, covering every attempt of a run.
- **SC-P8-16** The P1 property tests, the P4 isolation suites, the P5
  conformance suite, the P6 tree and the P7 planned fixture pass unchanged,
  except where a ratified decision adds a role or a field, listed in the
  as-built.

**Exit gate**

- **SC-P8-17** Live, `npm run routing`, with real adapters against the deployed
  control plane: a bounded job on the cheap rung integrates; a job whose cheap
  attempt fails escalates and integrates; a pinned override takes effect; a route
  made unavailable falls back across ladders; a medium-risk job is examined by a
  different model; a high-risk job is examined by the Codex ladder, whose planted
  defect is found with evidence and fixed before it lands; an examiner's question is
  answered by the builder's resumed session; a disputed finding is ruled on by an
  arbiter.
- **SC-P8-18** A real program, planned with `plan-program` on a repository the
  owner names and run with the owner's org configuration: it finishes, the report
  shows every route and examination, and the owner judges whether the ladders
  saved anything and whether the findings were worth the time.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

Plus, from a developer machine: `npm run deploy`, `npm run smoke` (twice),
`npm run conformance -- --harness all`, `npm run slice`, `npm run routing`.

## 8. Constraints

- No model decides a route, whether a job needs examining, or whether a finding
  has evidence. Examiners judge the work and arbiters judge disputes; everything
  around them is deterministic.
- A-05 holds: examination never substitutes for verification, and nothing it
  does lets unverified work integrate.
- A-11 holds for configuration: a repository and a contract narrow the org's
  policy, never widen it.
- One home per fact: ladders and rules live in the org's configuration, not in
  code and not in a prompt.
- P1's transition table is not changed.
- A-39: no adapter, examiner or arbiter gains an allow-list, a sandbox or an
  approval policy.
- Pins exact; scripts run on Windows and Linux.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying the API stack for §4.6; writing the
owner's org configuration to Q2's ladders; running the smoke, slice, conformance
and routing suites; running Claude Code and Codex headless on the operator's
subscriptions, on the models the org's ladders name; running SC-P8-18's trial on
the repository the owner names.

Forbidden:

- Letting a model choose a route or waive an examination.
- Letting an agent record `risk_accepted`, resolve a blocking finding by its own
  dispute, or reverse an arbiter's ruling.
- A repository or contract widening the org's policy, by any path.
- Weakening the P1, P4, P5, P6 or P7 suites.
- Rebuilding this checkout's `dist/` while the owner's run is using it.
- Anything remote or on Bedrock (P10). Settling O-02, O-03, O-05 or O-06.
- Inspecting the legacy Nightshift's branches or tags.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Contracts, rules and the API: classification, org configuration and narrowing, the examiner and arbiter roles, the examination record, `authorize`; deploy | — | AWS |
| T2 | Routing: rules, ladders and tiers, overrides, fallback and adapter start-failure classes, escalation, usage and cost, budgets | T1 | — |
| T3 | Examination: the examiner, its brief and route, beside-the-queue placement, carry-over, the examiner's questions and session resume, findings, the fix limit, the arbiter and its checkpoints, reversal | T1, T2 | — |
| T4 | Orchestrator tools, skills, `init` and `org config`, the report, `routes export` | T2, T3 | — |
| T5 | Fixture proofs; the live suite; the exit gate's trial; as-built | T4 | AWS, Claude Code, Codex, H-P8-03, H-P8-04 |

```text
T1 ── T2 ── T3 ── T4 ── T5
```

Specs live in `tasks/p8-routing-examination/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| The cheap rung fails so often the ladder costs more than starting higher | SC-11's data shows it per rule; rules are org configuration, so the fix is one line. SC-P8-18 is the first real measure |
| Orchestrators classify everything as low risk to get cheap routes and skip examination | Unset means conservative (D-P8-01); the classification is on every decision and in the report, so a pattern is visible |
| Examiners raise noise, and material findings stall runs | Evidence is required; only material findings block, and only where the policy says so; a dispute costs one arbiter call, not the night |
| An arbiter overturns a real defect and it lands | The ruling leads the report and the owner can reverse it; until P9 a reversal is a record and a follow-up, not a replay (D-P8-13) |
| Beside-the-queue examination is stale by the time the job lands | Carry-over only on an identical patch id; otherwise examined again in the queue (D-P8-09) |
| Subscription rate limits make routes flap | A route found unavailable stays skipped for the run, and the other provider's ladder at the same tier takes the work (D-P8-06) |
| A provider renames or retires a model on a ladder | The live suite's preflight starts every route on the org's ladders first; at run time a route that cannot start is `unavailable` and falls back (D-P8-06) |
| The program runs long | Staging's split point stands: Stage 7 (T3) splits off after T2, where routing decisions are persisted |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-25 | **Contract ratified.** Ten decisions the owner judged low-risk, ratified as drafted: D-P8-01 … D-P8-05, -08, -09, -10, -12, -14. Five put to the owner one by one (Q6 … Q10): D-P8-06 and -07 as drafted; D-P8-13 amended to two fixes, then an arbiter that rules whether or not the finding is disputed, its ruling a checkpointed rollback point; D-P8-11 amended and **D-P8-15 added on the owner's proposal**, the examiner's direct questions to the resumed builder; the default examination policy as drafted. | **Human** |
| 2026-09-25 | **A route may carry a reasoning effort.** Both harnesses take one, and every model on the owner's ladders offers several; a rung may be a model at a higher effort. Unset on the owner's ladders for now: each harness's default applies. Task specs T1 … T5 drafted. | Human (on the agent's offer) |
| 2026-09-25 | **The owner's answers to Q1 … Q5** (§3.1): examination beside the queue; ladders configured per org, a ladder per provider, narrowed never widened below the org; budgets enforced now; a disputed blocking finding goes to an independent arbiter whose ruling stands and which the owner can reverse, on the owner's proposal of a decision agent from a different provider; the exit gate is the live suite and a real planned program. The Codex ladder was first given as `gpt-5.5 → astra`; the owner asked for the real model names, and Codex's catalog (`codex debug models`, CLI 0.156.1) gave `gpt-6-luna` ("fast and affordable"), `gpt-6-sol` ("workhorse") and `gpt-6-astra` ("frontier"), all three probed live. D-P8-02, -03, -06, -09, -10 and -13 written to them. | **Human** |
| 2026-09-24 | Contract drafted after P7 closed. D-P8-01 … D-P8-11 proposed; Q1 … Q5 put to the owner. | Agent, for human ratification |

## 13. As built

Not started.
