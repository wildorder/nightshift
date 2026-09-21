# T1 — The contract's growth, readiness rules, the cone, the hash; the API; the restaging sweep

**Program:** `p7-planning` (see `docs/programs/p7-planning.md`)
**Depends on:** nothing
**Unblocks:** T2, T3, T4
**Decisions applied:** D-P7-02, D-P7-04, D-P7-05, D-P7-06, D-P7-07

## Objective

Everything that is a rule or a record: what a plan is, whether it is executable,
and what the engine will schedule by. The rules are pure; the API applies them.

## Deliverables

1. **`packages/contracts`**: `ProgramContract` gains `status`
   (`planning | ratified`), `strands`, `prerequisites`, `decisions`,
   `outOfScope`. All optional with empty defaults, so every existing contract
   parses unchanged. `Strand`: `id` (`S-nn`), `name`, `scope { summary, includes,
   excludes }`, `acceptance`, `successCriteria` (the SC ids it claims),
   `dependsOn`, `prerequisites`. `Prerequisite`: `id` (`HP-nn`), `description`,
   `remediation`, `verifyCommand`, `status` (`pending | satisfied`).
   `PlannedDecision`: `id`, `question`, `options`, `leaning`, `answer`,
   `rationale`, `touches` (strand ids, or all). **There is nowhere to put a job.**
2. **`packages/core/src/rules/plan.ts`**: `checkPlan(contract, planSections)`
   returning `{ ready: true } | { ready: false, reasons }`, one typed reason per
   SC-P7-03 case, all of them at once. `planSections` is strand id → the text of
   its section, handed in: this module reads nothing.
3. **Scope overlap**: `scopesOverlap(a, b)` over include and exclude globs,
   conservative (a possible overlap is an overlap), and
   `independentOverlaps(strands)`: pairs with no dependency path between them.
   Property tests: symmetric; a `dependsOn` in either direction clears a pair; an
   exclude that removes the intersection clears it.
4. **Strand gating and the cone**: `mayStartStrand(contract, outcomes, id)`;
   `downstreamCone(contract, id)`; `blockedBy(contract, outcomes)`. Written to be
   the cone P9 replays.
5. **`planHash(contract, planText)`**, stable over key order and line endings, so
   a Windows checkout and a Linux one agree. The contract's own `status` and
   prerequisite statuses are excluded, or ratifying would change the hash.
6. **`apps/api`**: `PUT program` accepts the grown contract; `planning →
   ratified` only with a plan hash, kept with a short history; a ratified
   contract's plan fields are immutable. `PUT run` for a contract that has
   strands is refused unless ratified; one with none runs as today.
   `ExecutionNodeStatus.awaiting_human`, reached from and left to `queued`, off
   the path to `verified`, not settled. A prerequisite-status write for user
   principals only, carrying the command's exit code; execution tokens may read
   prerequisites and write none, in both access tables.
7. Tests for each; the isolation suites gain the new routes; smoke covers ratify,
   the refused unratified run and the prerequisite write. Redeploy once.
8. **Restaging sweep**: Routing & Examination → P8, Decision Graph → P9, Remote
   Runner → P10, Realtime → P11, in `docs/`, `AGENTS.md`, code comments,
   user-facing messages (`REMOTE_REFUSAL`, the compatibility table's
   `availableFrom`, routing's refusal text) and their tests. P1 … P6 contracts get
   a restaging note, not a rewrite.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Then: `npm run deploy`, `npm run smoke`, twice.

## Notes

- **Do not rebuild while the owner's run is using this checkout's `dist/`.** Ask.
- The overlap rule will be the most argued-with check in the program. Its output
  shows the two scopes side by side and says which globs intersect.
