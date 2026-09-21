# T1 — The plan schema, readiness rules, the cone, and the restaging sweep

**Program:** `p7-planning` (see `docs/programs/p7-planning.md`)
**Depends on:** nothing
**Unblocks:** T2, T3, T4, T5
**Decisions applied:** D-P7-03, D-P7-04, D-P7-05, D-P7-07, D-P7-10

## Objective

Everything pure: the shape of a plan, the rules that say whether it is
executable, and the rules the engine will schedule by. No I/O, no model.

## Deliverables

1. **`packages/contracts`**: `ProgramContract` grows by `status`
   (`planning | ratified`), `executionMode` and `executionModeReason`,
   `workstreams`, `prerequisites`, `anticipatedDecisions`, `outOfScope`. All
   optional with empty defaults, so every existing contract parses unchanged.
   `Workstream`: `id` (`WS-nn`), `name`, `specFile`, `size` (`S | M | L`),
   `scope { summary, includes, excludes }`, `dependencies`, `prerequisites`,
   `risk`, `successCriteria` (the SC ids it claims). `Prerequisite`: `id`
   (`HP-nn`), `description`, `remediation`, `verifyCommand`, `status`
   (`pending | satisfied`). `AnticipatedDecision`: `id`, `question`, `options`,
   `leaning`, `rationale`.
2. **`packages/core/src/rules/plan.ts`**: `checkPlan(contract, specs)` returning
   `{ ready: true } | { ready: false, reasons }`, one typed reason per SC-P7-04
   case, all reasons at once. `specs` is a map of spec file to its text, handed
   in: this module reads nothing.
3. **Scope overlap**: `scopesOverlap(a, b)` over include and exclude globs,
   conservative (a possible overlap is an overlap), and
   `independentOverlaps(workstreams)`: pairs with no dependency path between
   them whose scopes overlap. Property tests: symmetric; a dependency edge in
   either direction clears a pair; an exclude that removes the intersection
   clears it.
4. **Dependency gating**: `mayStartWorkstream(plan, settledById, id)`: every
   dependency integrated (or, for a sub-program, succeeded).
5. **The cone**: `downstreamCone(plan, id)`, transitive dependants, and
   `blockedBy(plan, outcomes)`: which workstreams are blocked and by which
   parked one. Written to be the cone P9 replays.
6. **The plan hash**: `planHash(manifest, specs)`, stable over key order and
   line endings, so a Windows checkout and a Linux one agree.
7. **Restaging sweep**: Routing & Examination → P8, Decision Graph → P9, Remote
   Runner → P10, Realtime → P11, in `docs/`, `AGENTS.md`, code comments,
   user-facing messages (`REMOTE_REFUSAL`, the compatibility table's
   `availableFrom`, the routing refusal text) and their tests. P1 … P6 contracts
   get the restaging note P1 … P3 got in 2026-09-16, not a rewrite.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- Do not rebuild while an operator's run is using this checkout's `dist/`. Ask.
- The overlap rule will be the most argued-with check in the program. Make its
  output show the two scopes side by side and say which globs intersect.
