# T2 — Routing

**Program:** `p8-routing-examination`
**Depends on:** T1
**Unblocks:** T3, T4
**Decisions applied:** D-P8-04, D-P8-05, D-P8-06, D-P8-07, D-P8-08

## Objective

A job reaches the cheapest route likely to reach a verified result, chosen by the
org's rules; a route that cannot start falls back; a route that fails climbs; what
it all cost is known and bounded.

## Deliverables

1. **`ruleRoute`** in `packages/routing` (rule id per matched rule, replacing
   `p5-configured`): `(effectivePolicy, classification, pins, unavailableSoFar,
   previousAttempt?) → RouteChoice | refusal`. First matching rule gives the
   ladder and tier; a ladder without that tier starts at its lowest rung at or
   above it; within a rung, routes in order, skipping unavailable ones; the
   compatibility table and `modelPolicy` intersect everything. Pure and
   synchronous. `configuredRoute` is retired and its tests move to the new
   function where they still describe true behaviour.
2. **Pins** (D-P8-05): `delegate` and `strand.delegate` accept `ladder`, `tier`,
   `harness`, `model`, `effort`. Eligible under the effective policy or refused by
   name; recorded as `wasOverride`.
3. **Fallback** (D-P8-06): the next route on the rung, then the same tier on
   another ladder (ladders in the policy's order), then one rung up the job's own
   ladder. Never down. The runner keeps the run's set of unavailable routes and
   hands it to `ruleRoute`; the engine records a route found unavailable once,
   with outcome `unavailable`, and starts the next attempt without a retry from
   the orchestrator (an attempt that never started is not a failure).
4. **Start-failure classes** in both adapters: `route_unavailable` for not signed
   in, model not offered, and rate-limited before the first turn; anything after
   work began stays a failure. Each class is proven from a recorded stream or exit,
   not a live call. The conformance suite gains one case: an adapter asked for a
   model its harness does not offer reports `route_unavailable`.
5. **Effort**: `HarnessStartInput` carries the route's `effort`; `harness-claude`
   passes `--effort`, `harness-codex` passes `-c model_reasoning_effort=…`; absent,
   nothing is passed. Adapter tests pin the argument lists.
6. **Escalation** (D-P8-07): `engine.retry` asks `ruleRoute` with the previous
   attempt. After `verification_failed`, `failed` or `examination_failed` it
   climbs one rung (the top stays the top); after a stale base, conflict,
   interrupt or unavailable route it keeps the route. The replaced decision's
   outcome becomes `escalated`. `job.retry`'s description says where a retry will
   go and why.
7. **Usage** (D-P8-08): Claude's cache read and write tokens captured from its
   result frame; Codex's cached input tokens from `turn.completed`.
   `estimateCost(usage, prices)` in `packages/routing`; the runner records
   `actualCostUsd` with `costSource: reported` when the harness gave one, else
   `estimatedCostUsd` with `estimated`, else `unknown`.
8. **Budgets**: the engine sums the run's usage from its routing decisions (never
   from memory, so an attached engine agrees) and, once `maxUsd` or `maxTokens` is
   spent, starts nothing new and emits the reason, as for wall clock. Running work
   finishes. The report names which figures were estimates.
9. Table-driven tests for every rule, fallback and escalation path; a property
   over random policies and classifications that `ruleRoute` is a function
   (same inputs, same route) and never returns a route below the previous
   attempt's rung.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
npm run conformance -- --harness all
```

## Notes

- `packages/routing` imports no adapter. The start-failure classification is the
  adapter's; routing only reads the class.
- A retry's climb is the router's decision, not the orchestrator's: the
  orchestrator may still pin, and a pin is recorded as an override.
