# T6 — Core: domain rules and persistence ports

**Program:** `p1-foundation`
**Depends on:** T5
**Unblocks:** T7
**Decisions applied:** D-P1-07, D-P1-08; architecture A-04, A-05, A-07, A-11, §4, §6

## Objective

`packages/core` implements the pure domain rules from Stage 1 as functions over
`contracts` types, plus the persistence port interfaces. No I/O, no clock, no
randomness except through injected interfaces. Everything is deterministic.

## Deliverables

### Rules (one module each under `src/rules/`)

1. **Project ownership.** `assertSameProject(a, b)` and a generic
   `assertOwnershipChain(parent, child)`: a child's `projectId`, `programId`,
   `runId` must equal its parent's. A job can never be re-parented across
   projects (SC-P1-12).
2. **Execution-tree parentage.** An `ExecutionTree` value type built from a
   list of nodes: `addChild(tree, parentId, node)` rejects unknown parents,
   duplicate IDs, and any edge that would create a cycle (SC-P1-11). Depth is
   computed, not trusted from the record.
3. **Scope inheritance and authority narrowing.** `Scope` is `{ includes,
   excludes }` of path globs plus `permissions` and `forbiddenActions`.
   `narrow(parent, child)` returns the child's effective scope and **throws**
   if the child includes a path outside the parent's includes, removes a
   parent exclude, adds a permission the parent lacks, or removes a parent
   forbidden action (SC-P1-10, A-11). Define set semantics for globs precisely
   and document them; a simple prefix-and-glob containment is acceptable if
   its limits are stated.
4. **Recursion depth and concurrency.** `checkDelegation(tree, parentId,
   limits)` rejects a delegation that would exceed `maxDepth` (SC-P1-16) or
   exceed `maxConcurrency` among running nodes at the same parent. Return a
   typed reason, not a boolean.
5. **State transitions.** A table-driven state machine for `ExecutionNode`
   status with, at minimum:

   ```text
   validated → queued → running
   running   → implemented | failed | cancelled | interrupted
   implemented → verifying
   verifying → verified | verification_failed
   verified  → examining | sealed
   examining → sealed | examination_failed
   sealed    → integrated
   verification_failed | examination_failed | failed → queued   (retry)
   integrated, cancelled → (terminal)
   ```

   `transition(node, event)` returns a new node or throws
   `IllegalTransitionError` naming the state and event (SC-P1-15). There is no
   path from `implemented` to `sealed` or `integrated` that skips `verified`
   (SC-P1-13, A-05).
6. **Verification state.** `markVerified(node, verification)` requires a
   `Verification` record with `outcome: passed` whose `jobId`, `commitSha`,
   and ownership chain match the node (SC-P1-14). A worker-reported
   completion sets `implemented`, never `verified`.
7. **Decision authority.** `recordDecision` and `overrideDecision`: a human
   override is a new decision with `authority: human` that references the
   overridden one; an agent decision cannot override a human one. Reversibility
   is carried as recorded and never upgraded toward `reversible`
   (architecture §6).

### Identity

8. `src/ids.ts`: `IdGenerator` interface `{ next(prefix): Id }` and
   `createUlidIdGenerator(clock, random)` using `ulid` with injected time and
   randomness (D-P1-07).

### Ports (`src/ports/`)

9. Interfaces, not implementations: `ProjectStore`, `ProgramContractStore`,
   `RunStore`, `ExecutionNodeStore`, `EventStore` (append with idempotency
   key, list ordered by sequence), `DecisionStore`, `CheckpointStore`,
   `VerificationStore`, `RoutingDecisionStore`, `ArtifactStore`. Every read
   method takes the ownership chain it needs; there is no method that lists
   across projects (SC-P1-17).

### Errors

10. A small typed error hierarchy: `DomainError` with subclasses for ownership,
    scope, depth, concurrency, transition, verification, and authority. Each
    carries structured fields, not just a message.

## Acceptance

```text
npm run build && npm run typecheck && npm run lint && npm test
```

Unit tests for every rule's happy path and every named rejection.
`packages/core/package.json` dependencies are exactly
`{ @nightshift/contracts, ulid }`. Architecture rule 1 (T3) passes.

## Notes

- The property tests live in T7; write unit tests here so T7 can focus on
  generators and invariants.
- Do not implement scheduling, worktrees, or routing logic. `core` decides
  legality; `execution` (P3+) decides what to do.
- Keep functions pure: input record in, new record or throw out. No mutation.
