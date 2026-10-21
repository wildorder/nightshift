# Measurements as built (P20)

What this branch implements, read from the code. `plan.md` holds the ratified
requirements; this document describes behaviour and is not a contract. The harness
capture documents are [`codex-capture.md`](codex-capture.md) and
[`packages/harness-claude/CAPTURE.md`](../../../packages/harness-claude/CAPTURE.md).
Telemetry is metadata only and observation only: it never verifies, integrates or
authorizes anything.

## 1. Token normalization

Contract: `MeasurementCountersSchema` (`packages/contracts/src/v1/measurement.ts`).

- **Input is inclusive.** Cache read and cache write are subsets of `inputTokens`;
  reasoning is a subset of `outputTokens` where the provider defines it so. Context
  window capacity is never a counter.
- **Missing subsets stay absent.** An absent counter means "not reported", never zero.
  `hasCounters` (`packages/core/src/measurement/counters.ts`) treats an empty set as
  "nothing", and reported dollars alone are not token evidence.
- **`inputIncludesCache`** (the convention flag): `true` input already contains the
  cache tokens; `false` it excludes them (Claude's `input_tokens`); absent means unknown
  and must not be asserted. `mergeInputConvention` yields a convention only if every
  contributing part agrees.
- **Report normalization** is `tokensOf` (`packages/core/src/report/resources.ts`):
  convention `false` adds the cache read/write to input; `true` or unknown keeps the raw
  input. `ResourceTokens.inputConvention` is `inclusive` when a convention was stated and
  `unknown` otherwise; `sumResources` counts unknown-convention attempts in
  `inputConventionUnknown`, and their raw input is included as reported.
- **Pricing normalization** is the reverse, `routeUsageFromCounters`
  (`packages/core/src/measurement/normalize.ts`): inclusive input has its cache tokens
  taken out so cached input is priced once.

Metric ids: `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_write`,
`tokens_reasoning` (`packages/core/src/report/definitions.ts`).

## 2. The three dollar figures

1. **API-equivalent estimate** (`api_equivalent_estimate`): tokens valued at a price
   table's list rates (`valueCounters` and the per-request valuation in
   `packages/core/src/measurement/valuation.ts`). Provenance lives in
   `MeasurementValuation`: `priceSource`, `priceVersion`, and `components[]` of
   `{model, tier, category (input|output|cacheRead|cacheWrite), tokens, usd, perMTok}`.
   The tier is chosen by each request's own normalized input; tokens no observed request
   covers are a *remainder*, valued at the base tier, and `completeness`
   (`valuedRequests`, `unvaluedRequests`, `remainderTokens`, `remainderValued`, `reasons`)
   says what could not be valued. An incomplete valuation sets `estimateIncomplete`
   (`resourcesOf`), so the estimate is a lower bound.
2. **Provider-reported estimate** (`provider_reported_estimate`): the dollars the
   harness reported (`counters.reportedUsd`, `valuation.reportedUsd`). Kept apart from
   the estimate and never added to it (`sumResources` keeps `usd.estimated` and
   `usd.reported` separate). A report row is labelled "API-equivalent estimate",
   "provider-reported", "provider-reported and API-equivalent estimate" or "unknown".
   Session-cumulative reported dollars are reconciled by scope and baseline like tokens
   (F-01).
3. **Billed or subscription spend** is never inferred. No private billing API is used and
   no figure is labelled as an invoice. A subscription run showing no estimate is
   "unknown", not free.

The infrastructure estimate (`infrastructure_estimate`, machine expense of
Nightshift-provisioned runs; `packages/core/src/report/infrastructure.ts`) and the
combined estimate (`combined_estimate`, model estimate plus machine estimate, a lower
bound when anything is missing) are separate again.

## 3. Budget evaluation (D-02)

`costPolicy.maxUsd` and `maxTokens` are enforced at dispatch time, on **known** spend.

- `readSpend` in `packages/execution/src/engine.ts` reads routing decisions and
  measurement summaries from the control plane, never from memory, so an engine attaching
  to a run agrees with the one that started it. `budgetExhausted` runs before each
  `startNext`; a spent budget holds every queued node with a `budget_spent` wait and emits
  `run.budget_spent` once.
- `spendOfRun` (`packages/core/src/rules/policy.ts`) includes the **root launch**: its
  summary (no routing decision) counts through `rootResourcesOf`, and a root without a
  summary is unmeasured, not free. One figure per attempt: reported preferred, never both.
- `budgetEvaluation` reports `complete` only when `unpriced`, `unmeasured` and
  `estimateIncomplete` are all 0. *Unpriced*: token counters but no dollar figure.
  *Unmeasured*: neither counters nor dollars. *Unvalued* (`estimateIncomplete`): a
  valuation leaving some usage unvalued.
- An incomplete evaluation is enforced on what is known, announced once per distinct count
  with `run.budget_evaluation_incomplete`, and **never certified as within budget**. The
  report and Studio say "cannot be evaluated completely" with the three counts
  (`apps/studio/src/components/run/overview/tiles.tsx`, `apps/studio/src/lib/overview.ts`:
  "Within budget." only for a complete evaluation). The export carries it as
  `budget.evaluation`.

## 4. Coverage

`MeasurementCoverageSchema`: `complete`, `partial`, `unknown`, `legacy`; reports add
`missing` (`ResourceCoverage`).

- `complete`: every launch's evidence was received and no gap is listed (the summary
  schema rejects `complete` with gaps).
- `partial`: some evidence is known to be absent; the `gaps[]` name why.
- `unknown`: nothing reliable reported.
- `legacy`: only the route's own usage figures exist, from before request-level capture
  (`legacySummaryOf`, `packages/core/src/measurement/legacy.ts`).
- `missing`: no summary and no route counters. Never shown as zero.

Gap reasons (`CoverageGapSchema`): `receipt_lost`, `journal_lost`, `delivery_failed`,
`adapter_unsupported`, `stopped_before_flush`, `native_child_unscoped`, `baseline_unknown`,
`discrepancy`, `other`. A **receipt** is the journal write-and-fsync resolution
(`packages/execution/src/measurement/journal.ts`); `observe` is not a receipt. Observations
accepted but never durably received become a `receipt_lost` gap (`recorder.ts`). Gaps with
the same reason and detail coalesce with counts (`coalesceGaps`,
`packages/core/src/measurement/gaps.ts`); overflow merges into one `other` gap, never
silently dropped. Metric id: `coverage`.

## 5. Time

- **Verification time** (`packages/core/src/report/verification-time.ts`): per step and
  phase (`queue`, `candidate`, `run`), summed from `Verification` records. `timeOf`
  counts the original run **plus** a rerun or the flaky first run, so each extra run is
  time spent (`rerunRuns`, `rerunMs` are shown inside `totalMs`). Metric ids
  `queue_time`, `integration_time`, `examination_time`.
- **Summed work vs elapsed**: `summed_work_time` sums every attempt's working time and
  overlaps, so it can exceed `elapsed_completion_time`, the wall clock counted once
  (`operations.concurrency.summedWorkMs`, `averageOverElapsed`).
- **Agent time vs settlement time**: `agent_time` is the harness execution time
  (`usage.agentMs`); `settlement_time` runs from the attempt's start until its node
  settled, including verification, queue and integration (`usage.wallClockMs`). Settlement
  is the longer. Absent values stay absent.

## 6. Routing dataset v2

`packages/execution/src/dataset.ts`, schema `RoutingDatasetLineSchema`
(`packages/contracts/src/v1/routing-decision.ts`).

- `judgement.link`: `attempt` when explicit links make the verification or examination
  that attempt's own; `node_final` when no link exists, giving the node's final records
  with `historical: true` (never that attempt's judgement); `none` when the node has no
  records.
- `nodeOutcome` is the node's eventual status; `outcome` is how this attempt's own route
  ended. A failed attempt of a node that later succeeded has `outcome: failed` and the
  node's final status in `nodeOutcome`.
- **Root line** (`purpose: "root"`, `routingDecisionId: null`): the root launch's summary,
  with `outcome` the run's observed result and `judgement.link: "none"`.
- Each line carries `agentMs`, `settlementMs`, `measurementSummaryId` and
  `measurementCoverage` (including `missing`).

## 7. First-attempt success and rework

From `packages/core/src/report/definitions.ts` (read it there for the full wording):

- `first_attempt_success`: delivered jobs whose attempt 1 was verified and integrated
  without a later attempt; denominator is jobs that reached a terminal state.
- `delivered_outcomes`: jobs verified and integrated, once each.
- `rework_attempts`: attempts after a node's first (escalations, retries); the first
  attempt is not rework.
- `rework_by_cause`: rework grouped by the recorded cause; an attempt with several causes
  appears under each; causeless rework is counted as unattributed.
- Association with rework is not causation, and no composite quality score exists.

Related: `examiner_dispositions`, `review_overhead` (not review quality).

## 8. Completion histories

Contract `packages/contracts/src/v1/completion.ts`; figures
`packages/core/src/report/completion.ts`.

- **Explicit membership**: a person names members (`nightshift completion add`,
  roles `anchor`, `contributing`, `correction`); never inferred from program identity;
  never across projects. Each member counts once by `programId/runId` (identity, not equal
  totals).
- **Frozen checkpoints**: named positive-verdict snapshots; a checkpoint reports from its
  stored `measured` block alone (`measureCompletion`), clipped at its boundary, so later
  changes never rewrite it. A read failure of a member's figures must refuse capture rather
  freeze a zero (program ruling F-01; verify the dispatch-read case in
  `packages/core/src/report/report.ts` before relying on it).
- **Lower bounds**: `combined.lowerBound` is true when any member or valuation is
  missing; `infrastructure` and `resources` are absent, not zero, without evidence;
  `unmeasuredMembers`, `unavailable` and `withoutMachine` keep gaps visible.
- **Figures**: `completion_lead_time` (earliest member start to the earliest `worked`
  verdict, includes the person's delay), `run_completion_time` (to the accepted run's end),
  `active_seconds` (union of member run intervals, overlap counted once).
- **Rating coverage** (`feedbackCoverageOf`, `packages/core/src/report/feedback.ts`):
  eligible = ended runs; `positiveShare` = positive / rated, so **unrated is neither
  positive nor negative** (`rating_coverage`, `human_verdict`).
- **One effective verdict per run**: feedback is one record per run id, whose revision log
  is history, not extra votes; a cleared verdict is unrated. Feedback never changes a
  run's recorded outcome.

## 9. The versioned export

`reportExportVersion = 1` (`packages/contracts/src/v1/report-export.ts`), built by
`exportReport` (`packages/core/src/report/export.ts`); CLI
`nightshift report <program> [--run <id>] --json [--role <r>] [--model <m>] [--since <iso>] [--until <iso>]`
(`apps/cli/src/cli.ts`); the filter flags require `--json`.

- Sections: `attempts`, `usage`, `budget` (only when evaluated), `operations`, `delivery`,
  `review`, `feedback`, `completions`, plus `gateHealth.verificationTime`. `metricsBySection`
  maps each section to metric ids, and `definitions` embeds exactly those metrics.
- Only `attempts` is filtered; `sampleSize` is `{matched, total}`.
- Per attempt: `agentMs`, `settlementMs`, `resources`, `coverage`, `ledgerArtifactIds`, and
  (J4) `valuation` with `components` (model, tier, category, tokens, usd), `remainder`
  `{tokens, valued}` and `priceBasis` (source, version, model, incomplete).
- No request artifacts and no raw events are embedded; absent evidence is absent.

## 10. Request-ledger artifacts

Per-request observations are stored as artifacts of kind `measurement-ledger`
(`packages/contracts/src/v1/artifact.ts`, chunks published by
`packages/execution/src/measurement/publication.ts`), not in DynamoDB records; the summary
keeps only `ledger.artifactIds` (with an index artifact chain on overflow) and counts. They
are fetched through the existing authorized route, `POST …/artifacts/{artifactId}/download-url`
(operation `artifact.createDownloadUrl`, `packages/persistence/src/http/routes.ts`), under
the usual tenancy and execution authority. `report.md` lists each attempt's ledger ids
(`packages/core/src/report/report.ts`).

## 11. Studio overview

`apps/studio/src/components/run/overview/` with the arithmetic in `apps/studio/src/lib/overview.ts`.
Absent values print as "not observed", never zero. Scope (`scope.ts`) lives in the URL:
`?scope=run` (default) or `?scope=history:<completionHistoryId>`; an id that is not one of
the run's histories falls back to the run with a note. The run scope shows attempts,
resources, budget (with the "cannot be evaluated completely" wording), time and review; the
history scope shows the history's members, checkpoints and current figures.

## 12. Opt-in live probes

Both probes are skipped, with the reason, unless explicitly enabled. They use
**different switches**; nothing reconciles them in code, so this table is the
reconciliation.

| | Claude | Codex |
| --- | --- | --- |
| Enable (live) | `NIGHTSHIFT_CLAUDE_CAPTURE_PROBE=1` | `NIGHTSHIFT_MEASUREMENT_PROBE=codex` |
| Where the record goes | `NIGHTSHIFT_CLAUDE_CAPTURE_KEEP=<dir>` (otherwise printed only); committed location `packages/harness-claude/src/__fixtures__/probe/` (`<dimension>.evidence.json`, `<dimension>.journal.ndjson`) | Always `docs/programs/p20-measurements/codex-capability-live.json` |
| Offline probe | none | auto-enabled when `codex --version` is 0.155.1 (`NIGHTSHIFT_MEASUREMENT_PROBE_ALLOW_VERSION=1` allows another); `NIGHTSHIFT_MEASUREMENT_FIXTURES=write` regenerates fixtures and `codex-capability-offline.json` |
| Version pin | `VERIFIED_CLAUDE_VERSION` 2.1.286 | `VERIFIED_CODEX_VERSION` 0.155.1 |

Commands:

```sh
NIGHTSHIFT_CLAUDE_CAPTURE_PROBE=1 NIGHTSHIFT_CLAUDE_CAPTURE_KEEP=packages/harness-claude/src/__fixtures__/probe \
  npx vitest run packages/harness-claude/src/probe.test.ts
NIGHTSHIFT_MEASUREMENT_PROBE=codex npx vitest run packages/harness-codex/src/probe-live.test.ts
npx vitest run packages/harness-codex/src/probe-offline.test.ts   # offline, no credentials
```

Capability matrix fields. Codex (`CapabilityMatrix`, `probe.ts`): `harness`,
`harnessVersion`, `producedAt`, `mode` (`offline`|`live`), `transports`, `authMode`
(auth flags observed, else `unobserved`), `fieldsObserved`, `nativeChildren`, and
`dimensions[]` (`observed`, `not_observed`, `unverified`, `failed`). Claude (evidence file
per dimension `main`, `child`, `compaction`, `interrupted`): `claudeCodeVersion`,
`captureMode`, `transport` (paths, content types), `eventCounts`, `appVersions`,
`apiRequest` (attribute types and presence), `requests`, `apiErrors`, `complete`/`reasons`,
`exit` (kind, coverage, usage scope), `stream` (snapshot counts, `sawSubagent`,
`sawCompactBoundary`) and an `unverified` reason when it could not be established. Claude
does not record an authentication mode: the sign-in state shows only as the refusal
reason. Native-child inclusion is `nativeChildren` for Codex and `child` / `sawSubagent`
for Claude. Neither record contains prompts, responses or tool text.

## 13. Live capability status

Probes were run once each on 2026-10-21 in the worker sandbox, with whatever
credentials the CLIs found on their own. No login, install or provider setting was
attempted or changed.

- **Claude Code 2.1.286: unverified.** The probe passed (it records unverified
  outcomes by design) but each of the four dimensions reported `unverified: "live
  capability unverified: the provider refused the request (api_error / authentication)"`,
  `requests: 0`, `apiErrors: 1`, `no_api_request`. That is the same outcome as the
  committed 2026-10-21 records in `packages/harness-claude/src/__fixtures__/probe/`, so
  those were left unchanged and the second run was not committed. `api_request` emission
  has never been seen live.
- **Codex 0.155.1: unverified.** `probe-live.test.ts` passed and wrote
  `docs/programs/p20-measurements/codex-capability-live.json`, committed as the sanitized
  record. It reports `real_backend: failed` ("the main run failed before a response was
  reported"), `request_counters: unverified` ("no completed response seen"),
  `native_children: unverified`, `interrupted_run` and `resume_continuation`
  `unverified`; `transport_sse` and `auth_mode` (both API-key flags `false`) were
  observed from the launch alone. The offline matrix (`codex-capability-offline.json`) is a
  scripted-provider result and proves the adapter's decoding, not live emission.

Fixtures alone do not prove current vendor emission. Until a signed-in run produces a
committed record showing request counters from the real backend, neither harness's live
emission is verified on this branch, and `CODEX_VERIFIED_TRANSPORTS` and
`CODEX_VERIFIED_NATIVE_CHILDREN` must not be widened.
