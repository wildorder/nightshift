# T7 — Property tests and in-memory persistence adapter

**Program:** `p1-foundation`
**Depends on:** T6
**Unblocks:** exit gate
**Decisions applied:** D-P1-02, D-P1-08

## Objective

Prove the Stage 1 invariants with fast-check property tests over generated
trees, scopes, and event sequences, and deliver the test-only in-memory
persistence adapter with a port conformance suite that P2's DynamoDB/S3 adapter
will later have to pass unchanged.

## Deliverables

### Generators (`packages/core/src/testing/arbitraries.ts`, exported for other packages)

Arbitraries for IDs (each prefix), ownership chains, scopes, execution nodes,
well-formed execution trees of bounded depth and width, delegation limits,
verification records, decisions, and random event sequences over the state
machine.

### Property tests (`packages/core/src/rules/*.property.test.ts`)

One property per success criterion. Each must state the criterion ID in the
test name.

- **SC-P1-10** For any parent scope and any child scope, `narrow` succeeds
  iff the child is contained in the parent. Generate both contained and
  uncontained children explicitly so both branches are exercised.
- **SC-P1-11** For any tree and any attempted edge, `addChild` never produces
  a tree with a cycle. Also: adding an edge from a node to any of its
  ancestors always throws.
- **SC-P1-12** For any two nodes from different projects, every ownership
  assertion throws; for any two from the same chain, none does.
- **SC-P1-13** For any random sequence of transition events applied from
  `validated`, if the node ends in `sealed` or `integrated` then the sequence
  contains a `verified` transition. Never reachable without it.
- **SC-P1-14** `markVerified` succeeds iff the verification record has
  `outcome: passed` and matches the node's job, commit, and chain.
- **SC-P1-15** For every (state, event) pair not in the transition table,
  `transition` throws `IllegalTransitionError`; for every pair in the table
  it succeeds. Enumerate the full cartesian product, not a sample.
- **SC-P1-16** For any tree and limits, `checkDelegation` rejects iff the
  child's computed depth would exceed `maxDepth`.
- **SC-P1-17** Every aggregate schema in `contracts` rejects a record whose
  `projectId` is missing or malformed. Iterate over the exported schema list
  so a new aggregate cannot be added without this check.

Run with fast-check's default run count in CI and a fixed seed only when a
failure is being reproduced; commit the seed in the test when doing so.

### In-memory adapter (`packages/persistence/src/memory/`)

Implements every port in `core/src/ports` with plain `Map`s keyed by the
ownership chain. `EventStore.append` is idempotent on `idempotencyKey` and
assigns a monotonic per-run `sequence`. No AWS import (T3 rule 3).

### Port conformance suite (`packages/persistence/src/conformance/`)

A function `describePortConformance(name, factory)` that runs the same tests
against any adapter:

- round-trips every aggregate;
- a query scoped to Project A never returns Project B's records, for every
  store (this is the offline form of P2's isolation test);
- duplicate `append` with the same idempotency key stores one event;
- events list in `sequence` order and the order is stable across calls;
- large payloads are rejected by `ArtifactStore` reference validation (a
  reference, never content, A-08).

Wire it against the memory adapter now. P2 will wire it against the AWS
adapter.

## Acceptance

```text
npm run build && npm run typecheck && npm run lint && npm test
```

Every SC-P1-10 … SC-P1-17 property passes. The conformance suite passes
against the memory adapter. Total `npm test` wall clock stays under a minute on
the dev machine; if property run counts push past that, lower counts per test
rather than skipping properties, and note it in the contract's §11.

## Exit demo (for the human)

A single vitest invocation, named in `README.md`, that runs only SC-P1-10 and
prints the generated parent scope, the child that tried to widen it, and the
`ScopeWideningError`. This is P1's demonstrable capability.
