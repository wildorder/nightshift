# T1 — Contracts, rules and the API

**Program:** `p8-routing-examination` (see `docs/programs/p8-routing-examination.md`)
**Depends on:** nothing
**Unblocks:** T2, T3, T4
**Decisions applied:** D-P8-01, D-P8-02, D-P8-03, D-P8-04, D-P8-10, D-P8-12, D-P8-13, D-P8-15

## Objective

Everything that is a record or a rule: what a job says about itself, what an
org's routing policy is, how a repository and a contract narrow it, what an
examination and a ruling are, and who may write each. The rules are pure; the
API applies them. Deploy once at the end.

## Deliverables

1. **Classification** (`packages/contracts/src/v1/job-contract.ts`): `testability`
   (`strong | weak | none`) and `kind` (`implement | fix | refactor | test | docs |
   orchestrate`), both optional so every stored Job Contract parses unchanged.
   `classificationOf(job, program)` in `core` fills the conservative defaults of
   D-P8-01 and is the only way anything reads them. Fix
   `apps/mcp/src/sub-orchestrator.ts`'s `delegate`, which defaults risk and
   ambiguity to `low`: it uses `classificationOf` like the root.
2. **`RoutingPolicy`** (new `packages/contracts/src/v1/routing-policy.ts`):
   `ladders` (name → rungs; a rung is `{ tier, routes }`; a route is
   `{ harness, model, effort? }`), `rules` (`{ id, when, start: { ladder, tier } }`,
   the last with an empty `when`), `unavailable` (routes), `prices`
   (model → `{ inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok? }`).
   Schema-level checks: rule ids unique, the last rule unconditional, every
   `start.ladder` exists, tiers within a ladder non-decreasing. `effort` is
   `low | medium | high | xhigh | max`.
3. **`OrgConfig`** record: `{ orgId, routingPolicy, examinationPolicy,
   schemaVersion, updatedAt, version }`. A seeded default for a new org: one ladder
   per operator-login harness in `HARNESS_COMPATIBILITY`, built from the table's
   default models, and examination on for medium (advisory) and high
   (blocking), as §4.2.
4. **Narrowing** (`core/src/rules/effective-policy.ts`):
   `effectivePolicy(org, config, contract)` returning the policy or every
   **widening** by name (a model, harness, ladder or rung the org does not have; an
   examination requirement looser than the org's). What a repository or contract
   may do is exactly D-P8-03's list. This replaces "what the contract states
   always wins" (`inheritFromConfig`) **for `routingPolicy` and
   `examinationPolicy` only**; the other inherited fields keep P7's semantics.
   Property tests: narrowing is idempotent and order-independent, the effective
   policy is always a sub-policy of the org's, and any widening is refused.
5. **`RoutingDecision`** gains `classification`, `ladder`, `rung` (tier and
   index), `target.effort`, the effective policy's `version`, and outcome
   `unavailable`. `usage` gains `cacheReadTokens`, `cacheWriteTokens` and
   `costSource`. The routing transition rules (`routing-transitions.ts`) admit
   `unavailable` as a terminal outcome written once, like the others.
6. **`Examination`** gains `patchId`, `examinerRoute`, per-finding `evidence[]`
   (`{ kind: "location", path, startLine, endLine } | { kind: "command", command,
   exitCode, outputArtifactId } | { kind: "contract", clause }`, at least one), and
   per-finding `resolution` (`fixed | disputed | overturned | upheld |
   risk_accepted`) with `authority` and, for an arbiter's, `decisionId`. A finding
   with no evidence does not parse. It also gains `questions[]` (at most three:
   `{ question, answer, answeredBy: resumed_session | transcript }`) and
   `fixAttempt` (0, 1 or 2). `Verification` gains `phase: candidate | queue`
   (absent reads as `queue`), for T3's beside-the-queue check. The event registry
   gains `finding.disputed` and `finding.ruled`.
7. **Independence rules** (`core/src/rules/examination.ts`):
   `mayExamine(requirement, implementerRoute, examinerRoute, agents)` and
   `mayArbitrate(implementerRoute, examinerRoute, arbiterRoute)`, one typed reason
   per refusal (same agent; same model when `mustDifferModel`; same provider when
   `mustDifferProvider`; arbiter shares a model with either side). Table tests
   over every combination.
8. **Execution roles**: `ExecutionRoleSchema` gains `examiner` and `arbiter`.
   `authorize` gains `examination.put` (examiner, its own examination only;
   the execution layer as today) and `finding.rule` (arbiter, one finding of the
   examination it was minted for). The examiner also gets `examination.ask`
   (its own examination, once). Both read their run. Nothing else. The root
   and sub-orchestrators gain `finding.dispute` on findings of jobs they delegated. Cells in
   **both** access tables. `risk_accepted` and a reversal are written by user
   principals only.
9. **`apps/api`**: `GET`/`PUT /orgs/{orgId}/config` (members of that org; a `PUT`
   is validated and versioned, compare-and-swap on `version`); executions read
   their project's org config. The examination write runs `mayExamine` and the
   ruling write runs `mayArbitrate` against the stored routing decisions, so a
   verdict from an examiner or arbiter that should not have been chosen is refused
   whatever the caller says. `PUT run` records the effective policy on the run.
10. The isolation suites gain the org-config routes (a second org can neither read
    nor write the first's). Smoke covers an org-config round trip, a refused
    widening, and a refused self-examination. Redeploy once; `npm run smoke`
    twice.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Then: `npm run deploy`, `npm run smoke`, twice.

## Notes

- **Do not rebuild while the owner's run is using this checkout's `dist/`.** Ask.
- `contracts` and `core` import nothing new: the price table is data, and
  nothing here fetches a price.
- Keep P1's transition table untouched. If anything in this task seems to need
  a new node status, stop: D-P8-09 says it does not.
