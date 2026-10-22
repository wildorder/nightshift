# Engineering effectiveness and resource measurements

## Overview

Nightshift needs a trustworthy account of the work it already executes before comparing execution strategies. This program measures resources, delays, review and repair work automatically, and asks the human only whether a finished run worked: thumbs up or thumbs down. All five design decisions are answered; the owner approved completion histories and replaced retrospective feedback forms with binary run ratings.

The owner deferred same-input comparison scenarios until there are execution-architecture alternatives to compare. This program measures actual work under today’s architecture. Its deterministic regression fixtures verify measurement arithmetic and behavior; they are not comparative agent experiments. No new harness or orchestration design is necessary here.

## Who it is for

US-01 is the foundation: a subscription run showing $0 does not tell the owner what it consumed. US-02 adds the detail needed to understand context-dependent prices rather than treating a run’s accumulated input as one large request. US-03 makes that evidence suitable for later comparisons, without claiming token counts alone measure engineering quality.

The owner explicitly distinguished instrumentation from controlled scenarios. After reviewing the draft, they approved request capture, estimated-dollar valuation and budgets, and the metadata ledger/local receiver boundary. They then directed that the full measurement scope be restored, with same-input comparisons left for later execution-architecture work. US-04 covers the human observations that engine telemetry cannot supply. A one-click run verdict is included; building a new browser evaluator or changing how examiners work belongs to the separate execution/quality-loop discussion.

## Architecture

The current accounting unit is largely a routing decision’s terminal usage. That misses the root launch in `apps/mcp/src/headless.ts`; cancellation and interruption cannot carry usage in `packages/harness/src/harness.ts`. Worker and helper aggregation differ. In `packages/execution/src/runner.ts`, a failed attempt to resume can add one segment twice. In `packages/core/src/rules/policy.ts`, missing counters can become a known zero-dollar estimate. These are accounting causes, not presentation problems.

The proposed replacement is a shared observation pipeline with compact execution summaries and artifact-backed request evidence. Observations identify the execution, launch segment, provider session/request when exposed, model, timestamp, source and counter scope. A normalized input count includes cached input; cache read/write are subsets, and reasoning is a subset of output when the provider defines it that way. Missing subsets remain absent. Context capacity is distinct from observed request input and cumulative usage. Provider-specific exceptional semantics remain documented in the adapter’s provenance.

Stable identities and counter scope matter more than the field names: request events, cumulative session snapshots and terminal summaries overlap. They are reconciliation sources, not independent values to add. A native child’s usage belongs to the launching Nightshift execution unless it has a real separately issued identity; recording its provider child/session identifier does not give it authority. Incomplete visibility must not be described as complete coverage merely because a parent reported a total.

Incremental receipt is journaled before acknowledgment, replayed idempotently, and published through existing scoped storage boundaries. Compact summaries reference durable artifact chunks; consumers use a shared reducer rather than maintaining independent sums. Receipt/delivery failures are surfaced as coverage gaps. No design can recover usage that never reached a durable observer, or a local journal lost with a machine before upload: the coverage record must say so. Existing event outbox behavior must be assessed explicitly rather than assumed crash-durable.

Provider adapters own collection and decoding. The shared harness layer can own a bounded local transport helper, with a narrow allowlisted metadata envelope. If OTLP requires a receiver, it runs in a separate launch-scoped helper process bound only to loopback, not inside the stdio MCP server. Its capability is distinct from a Nightshift execution credential, its payloads have size limits, and shutdown flushes or marks a gap. This boundary is covered by D-03. No external collector or new hosted service is needed. The remote `engine`/`project` process boundary and explicit environment construction must support this without exposing engine credentials.

Historical records remain readable. Their old counters retain provenance and uncertain semantics rather than being backfilled with invented request detail. The new schema and common sink land additively before either adapter changes.

Operational measurements extend the same observation pipeline at engine-owned boundaries. `engine.ts` already distinguishes waiting reasons, but pending-state changes are not durable intervals; `merge-queue.ts` likewise keeps queue residence in memory. Capture transitions with stable operation/attempt identity and blocker references. Preserve multiple simultaneous blockers, retain unattributed gaps, and derive interval unions and an observed completion chain rather than calling the planned dependency graph the measured critical path. Hidden repeated exploration cannot be reliably inferred from token counts: distinguish explicit repair/review activity and leave unobservable activity unclassified.

Existing examination records supply finding evidence, dispositions, rulings and model attribution. Add explicit links between helper launches, examinations, findings and repair attempts when current records lack them. A `fixed` finding only means it was not raised again; an `upheld` finding means the arbiter agreed. Neither is independently established truth. A binary run verdict supplies no per-finding ground truth; reports preserve that distinction.

Dispatch attempts already retain rate, metering and lifecycle information, while compute records expose utilization. Reuse those sources for machine/volume estimates and show setup, idle occupancy and pressure alongside model usage. Local machine expense remains unavailable without a configured basis. Do not divide a shared machine’s full cost among jobs and then sum the duplicated allocations.

D-04 makes human feedback a one-click run verdict. The system captures the run, available result commit, actor and recording time automatically. One effective verdict per run can be changed or cleared by an authorized user, with concurrency protection and revision history. No explanation, effort estimate, criteria selection or defect report is requested. An execution principal cannot submit a human rating. Unrated is a distinct absence of feedback, not a negative vote.

D-05 groups source records into an explicit completion history anchored in a run, with validated project-local member references across programs. This fits existing project/program/run scoping rather than introducing an unscoped analytics tenant or replacing Program. Carry-over and correction links suggest membership, but cannot identify all failed work that contributed to a result. Membership changes are recorded, and each reported aggregate states its membership revision and as-of time. The grouping survives acceptance and later repair, preserving the first accepted result and subsequent acceptance checkpoints separately.

Common metric definitions belong in pure core reducers, not independently in Studio, CLI and export code. First-attempt success uses logical job nodes with their first implementation attempt, requires verified and integrated work, and reports unfinished/cancelled cases alongside the denominator; helpers are not extra work items. Report both run-local rates and completion-level counts without counting carried nodes again. Rework resources are linked to explicit causes; where a repair addresses multiple findings it is counted once, with shared attribution rather than full cost assigned to each finding. New feature work is not automatically repair. Monetary sums preserve component price bases, human work time is not inferred from decision counts or waiting intervals.

## Strands

### S-01 Reliable measurement records and lifecycle accounting

#### Approach

Define the versioned observation/summary contract in `packages/contracts`, pure normalization and reconciliation in `packages/core`, and the adapter emission/exit capability in `packages/harness`. The seam offered to adapters carries observations with stable launch identity and source scope, plus a final coverage status; it does not require provider imports above the adapter layer. Establish artifact references and bounded summaries using the existing core storage ports and persistence adapters, including HTTP authorization and local parity where the record surface changes.

Integrate one recorder into the execution runner, helper paths in `examine.ts`, and root/sub-orchestrator launches composed by `apps/mcp`. Do not invent a routing choice for a human-selected root model just to reuse a worker record. Relate measurement evidence to a routing decision when one exists, and directly to the execution otherwise. Retain actual observed models independently of route intent.

Regression tests should exercise replay after a persistence failure, partial completion followed by cancellation, root fallback, helper resume, repeated cumulative snapshots and the concrete undefined/throwing-resume double count. The shared fixtures establish cross-adapter invariants; adapters continue to supply their existing aggregates until their own strands land. Budget and authorization changes deserve high-risk review; other measurement work uses the inherited medium risk.

#### Considered and rejected

A UI-only fix leaves missing and duplicate inputs intact. Extending only successful terminal exits still loses work on cancellation and process loss. A separate arithmetic implementation for each role would perpetuate the current divergence. A new independent database for telemetry would duplicate tenancy and recovery responsibilities.

### S-02 Claude measurement capture

#### Approach

Extend `packages/harness-claude` around the common observation seam. Evaluate the pinned version’s metadata-only `claude_code.api_request` events for final request usage; configure capture explicitly through the adapter’s environment construction. Preserve result usage as reconciliation evidence. Assistant message IDs repeat in stream output, and streaming output usage may be a placeholder, so assistant messages alone cannot establish exact request output.

The [official monitoring reference](https://code.claude.com/docs/en/monitoring-usage#api-request-event) documents request model, input/output, cache read/write, duration and request identifiers. The [SDK cost guidance](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-per-step-usage) explains repeated IDs, streaming limitations and estimated dollars. These describe available capabilities, not proof that the repository’s pinned binary emits every field. Verify that binary and record its version in sanitized capture fixtures. If a pin change is required, make it explicit and verify the existing adapter conformance behavior too.

Use deterministic offline replay tests plus an opt-in real invocation probe. The probe checks main work, delegated child work, compaction where practicable, and interrupted capture, documenting exactly which dimensions were observed. Missing provider evidence is a capability limit, not a reason to silently substitute a fabricated value.

#### Considered and rejected

Using assistant message fragments as final request usage produces incorrect output counts. Calling the harness’s dollar estimate actual billed spend misrepresents subscriptions. An exporter that forwards arbitrary attributes risks retaining content that this program does not need.

### S-03 Codex measurement capture

#### Approach

Extend `packages/harness-codex` to retain cache-write and reasoning fields already present in the repository’s completion fixture, and use the shared receipt pipeline for finer observations. Explicit configuration must work with `--ignore-user-config`. The [Codex observability reference](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry) documents optional telemetry; prove emitted request fields on the pinned binary and on its actual SSE/WebSocket transport before depending on them.

Local session evidence examined during research contains `last_token_usage`, `total_token_usage` and `model_context_window`. These are three different things. A versioned adapter-owned transcript reader can supply metadata that supported telemetry does not expose, but must be tested for discovery, rotation, repeated snapshots, resume, session/model attribution and native children. Prefer the supported telemetry surface when equally complete; do not silently scrape another user’s sessions or collect conversation content. Reuse the adapter’s existing transcript ownership/discovery boundaries.

Build offline fixtures from sanitized real observations and expose the same opt-in probe contract as Claude. Test last-request versus cumulative semantics and verify cache/reasoning subsets against the raw source. A cumulative run total cannot reconstruct the sequence of request context sizes.

#### Considered and rejected

Treating `turn.completed` as a model request conflates a turn with potentially many requests. Adding cached input to Codex’s inclusive input count double-counts it. Using maximum context capacity as actual context consumption answers a different question.

### S-04 Studio metrics overview, reports, valuation and exports

#### Approach

US-05 makes the Studio overview a first-class deliverable. Extend the existing run page and its linked completion view with a discoverable overview using the shared report model. Design a calm, deliberate hierarchy: a header identifying the run or completion history and acceptance state; a compact row of headline summaries; then a generous bottleneck timeline beside resource and rework breakdowns; finally review/quality evidence and links to details. Keep run status and human acceptance visually separate. The same layout adapts to a single run and a multi-run completion history with an explicit scope label and contributing-run count.

Headline summaries should answer “what was delivered?”, “how long did it take?”, “what did it consume?” and “how much repair did it need, and did it work?”. Show token use prominently, with API-equivalent/model and infrastructure estimates clearly labeled underneath. Delivery summaries include first-attempt success with its denominator. Review summaries retain their evidence instead of implying a quality score. The human verdict is Worked, Did not work or Not rated, with one-click controls. Secondary model/cache/context breakdowns belong behind progressive disclosure, not in an overwhelming grid of equally weighted counters.

Use an interval timeline for concurrent work and wait/bottleneck evidence, and clearly labeled bars for resource or rework composition where components are actually additive. Keep token units distinct from dollars. Direct labels, useful empty states and accessible text summaries matter more than animation. Selecting a metric or visual segment opens its definition and the relevant attempts, findings, feedback or artifacts. Do not load every request artifact to paint the overview. Use the existing polling/query invalidation conventions to update a running view without resetting focus, scroll or selected scope.

Build within `apps/studio/src/pages/run.tsx` and the existing run components, extracting overview components as needed. Follow `theme.css`, semantic utilities, shared UI components and the theme guard; chart colors are theme tokens too. Make whitespace, type scale and alignment carry the hierarchy in both themes. Stack visual panels on narrow screens, preserve meaningful labels, and offer keyboard-accessible navigation and non-color status cues. Keep feedback entry from S-06 close to its corresponding summary without turning the overview into a form.

Use realistic fixture-backed browser previews to refine the design during implementation. Review rendered desktop/mobile, light/dark examples of complete, sparse and running data, plus failed/error states; capture review evidence and fix visual problems before completion. Automated checks should assert meaningful behavior and data honesty, not freeze arbitrary pixel positions. This visual acceptance work proves the Studio deliverable; it does not add general product-acceptance automation to Nightshift.

Use the shared reducer in `packages/core/src/report`, `packages/core/src/rules/policy.ts`, report rendering and Studio. Display known totals with their coverage, and offer request artifact retrieval through the existing authorized artifact route. Keep the read model compact; the run page must not download every request simply to show a total.

Under D-02, dollars are derived API-equivalent estimates with a recorded pricing basis. Extend the configured price representation only as needed for per-request tiers and cache categories; no live pricing fetch occurs during a run. Preserve a provider-reported estimate separately. An absent component required to value a request makes that valuation incomplete. Unknown usage must not silently satisfy a configured budget: retain existing dispatch-time budget enforcement and explicitly report when a limit cannot be evaluated completely, rather than claiming a precise cap or removing it.

Correct `verification-time.ts` to include both retained original and rerun durations. Separate agent execution time from the worker’s current settlement duration, which can extend through verification/integration. Correct `packages/execution/src/dataset.ts` so the final node result is not presented as evidence for each earlier attempt or helper. Persist exact attempt links going forward where they are available; expose historical uncertainty.

S-04 is the final presentation/integration strand after S-06 and both adapters: use S-05’s operational reducers and S-06’s feedback/completion records in the CLI report, Studio and versioned exports. Provide evidence drill-down, metric definitions and denominators, filters and sample sizes, and an as-of timestamp. Completion views show model and infrastructure valuation separately and a combined estimate with coverage, alongside human run verdicts and rating coverage. The root run report links to this broader history rather than silently treating its own success as completion. Preserve the per-run view for diagnosis.

A deterministic cross-package history exercises parallel execution, a failed attempt, examination and repair, an integration conflict, a thumbs-down verdict, a correction run, thumbs up and a changed/cleared rating. Assert arithmetic, rating coverage and source linkage through report, export, CLI and Studio. No comparison benchmark is added.

Cross-package tests reconcile summaries against artifact evidence and cover every role and unsuccessful ending. The opt-in live probes record a capability matrix with harness version, authentication mode when observable, transport, native-child inclusion and supported fields. Use existing credentials only; a missing provider login is reported, never repaired by the agent. Offline configured gates remain credential-free. An unavailable live probe means live capability is unverified and must be stated in the completion report; fixtures alone do not prove current vendor emission. Run the inherited build, typecheck, lint, test, synth and sterility checks.

#### Considered and rejected

A run’s total input cannot select a per-request price tier. Summed parallel work duration is not elapsed time. Attaching a node’s final pass to every failed retry biases future comparisons even if its token counts are correct.

### S-05 Completion bottlenecks, rework and examination effectiveness

#### Approach

Instrument the lifecycle owners in `packages/execution/src/engine.ts`, `merge-queue.ts`, setup, integration, examination and runner code, together with remote provisioning/runner milestones in `apps/api` and `apps/mcp`. Use the S-01 observation seam for start/end/reason transitions, operation identity and causal references. Persist blockers as a set: dependency and capacity waits can overlap. Recovery closes an interval only when supported by an observed boundary; otherwise reports retain an open or incomplete interval.

Add pure reducers in `packages/core/src/report` for phase/work duration, elapsed interval unions, wait occupancy, observed critical chains, first-attempt completion and repair resources. Shared work is counted once. The chain is based on observed causal dependencies and queue order, not a counterfactual claim about how much faster another schedule would be. Expose utilization and dispatch lifetime/cost beside phase measures so startup and idle machine occupancy are visible.

Use `Examination` evidence, `resolvedBy`, ruling references and repair links to derive coverage, dispositions and associated expense. Extend the producer paths where linkage is missing; same-node timestamp proximity is not sufficient attribution. Keep examiner, answerer and arbiter overhead distinct from implementation repairs. Do not label an upheld ruling a true positive or a clean examination a defect-free result.

Test synthetic overlapping timelines, cancellation/recovery, skipped/deferred gates, conflict repair, repeated findings, mixed causes and shared dispatches with exact expected durations and counts. These tests prove the metrics; they do not run alternative agent arrangements. S-05 can develop alongside the two adapters after their common accounting foundation exists.

#### Considered and rejected

Inferring all waits from status timestamps loses their causes. Choosing one primary blocker discards evidence about concurrent constraints. A planned longest dependency path does not explain actual queueing. Treating every retry as a model failure confounds infrastructure, verification, review and integration causes.

### S-06 Human feedback and completion histories

#### Approach

Under D-04 and D-05, add versioned schemas in `packages/contracts`, storage ports and authorization rules in `packages/core`, and equivalent memory/local/AWS/HTTP implementations through the existing persistence layering. Use bounded run-scoped records anchored to an existing run for feedback and completion history, with validated references to other runs in the same project. Large evidence uses the existing artifact mechanism. The HTTP API checks the ownership and reach of every referenced source, including sources in another program of the same project. Changing these persisted interfaces and authority rules merits high-risk review.

Add a compact Worked / Did not work control to the finished-run Studio overview, using thumbs icons with accessible labels and a clear selected/unrated state. Saving is immediate and needs no form or follow-up prompt; failure must be visible and must not leave a falsely saved vote. Users can change or clear the verdict. Equivalent CLI operations use the same API. Idempotency and concurrent-update checks retain one current verdict per run and an attributed revision history. Completion-history membership uses the separately approved explicit workflow.

A positive verdict means the user says this run worked; a negative verdict means it did not. Neither creates a Verification, changes the recorded execution outcome or identifies a defect. The result commit is captured when available, never selected manually. Report positive and negative counts with the number of rated versus eligible finished runs; positive share uses rated runs as its denominator. Revisions are not extra votes. This program does not measure human hours or escaped defects and does not request per-finding validity assessments.

Completion membership explicitly includes failed contributing runs and cross-program corrections, deduplicating carry-over at source identity. Suggested membership can use `Run.carriedStrands`, plan hashes and `Program.corrects`; it is not silently accepted. For the current membership and a named positive-verdict checkpoint, calculate calendar lead time from the earliest contributing start, union of active run intervals and the model/infrastructure components. Later fixes remain visible after first acceptance instead of rewriting its original measurement. Completeness depends on the selected history and recorded feedback, which the report displays.

Test persistence conformance and HTTP authorization, CLI/Studio round trips, repeated submissions, concurrent changes, changing and clearing a vote, shared run membership, cross-project refusal and a down-rated run followed by an up-rated correction. No new external service or account is required.

#### Considered and rejected

Manual time logs, defect reports and per-finding assessment forms were rejected by the owner. Decision counts cannot measure human effort. Engine success is not a human verdict. Automatically grouping every run under a program mixes unrelated attempts and misses corrections in other programs. Auto-linking later defects to an examiner would invent causal evidence. A new external issue tracker integration is unnecessary to record this feedback.

## Decisions

### D-01 Request detail in this first program

The draft includes capture because it answers the context-size question and avoids losing evidence needed for later analysis. The owner’s prior uncertainty is real: correcting aggregate accounting is useful even if request capture is deferred. Choosing that smaller scope requires revising this draft’s strands and criteria, not leaving capture nominally required but unimplemented.

### D-02 Dollar estimates and existing budgets

The proposal preserves useful estimates without presenting them as subscription expenditure. The existing `maxUsd` policy creates a behavioral consequence: removing estimates also requires an explicit decision about those limits. Tokens and their normalized semantics must be consistent between budgeting and reporting.

### D-03 Evidence storage and local collection boundary

The proposed artifact-backed ledger keeps request detail out of large database records. A separate local helper, when needed for OTLP, preserves the MCP process’s no-socket rule while adding a transport surface that needs review. The owner approved this persisted shape and process boundary through D-03.

### D-04 One-click run verdict

The owner rejected retrospective time logs and defect forms because people will not fill them in. The chosen interaction is simply thumbs up/down on a run. The system retains attribution and history automatically; it collects all other measurements from execution records.

### D-05 Completion across runs

The draft proposes explicit membership rather than equating a program with one completed outcome. Failed attempts, carry-over and correction runs need to be counted, while unrelated work should not be folded in. This is a persisted grouping that determines the meaning of cost and time to acceptance; the owner approved this grouping in D-05.

## Risks

Voluntary binary feedback limits quality conclusions. Show rated-run coverage and do not treat non-response as failure or success. A negative verdict does not identify a defect or explain its cause, and a positive verdict does not prove defect-free output. Human work duration and escaped-defect counts remain unmeasured.

Long-lived completion histories can overlap or change membership. Version membership and deduplicate source identities when aggregating several histories; totals from overlapping histories are not directly additive. Clock differences and recovery gaps can make causal timing uncertain, so retain source/receipt timestamps and mark uncertainty instead of reporting false precision.


Vendor documentation may describe fields newer than the pinned CLI, and one transport may emit different evidence from another. Probe early within each adapter strand and record capability limits. A missing essential capability is a plan decision to surface, not a reason to report guessed precision.

Native child totals may overlap the parent’s aggregates. Reconciliation needs explicit inclusion scope; if the source cannot establish it, coverage is partial and the ambiguous sources cannot simply be summed.

Incremental durable collection adds overhead. Keep records small, batch artifact publication, bound buffers and test shutdown/backpressure so measurements do not hang agent execution. If collection fails, the run retains its engineering outcome and reports the measurement failure.

The actor audit found no new account, billing or infrastructure setup needed to build this program. Live verification consumes existing provider authentication and must report unavailable access honestly. Remote process-boundary parity is covered in deterministic tests; no deployment or production run is authorized by this plan.
