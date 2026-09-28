# T1 — Contracts, rules and the API

**Program:** `p9-decision-graph-replay`
**Depends on:** —
**Unblocks:** T2, T3, T4
**Decisions applied:** D-P9-01, D-P9-02, D-P9-04, D-P9-05

## Objective

The records a correction needs exist, and the control plane holds them to the
rules: what a decision produced, what a correction corrects, and the owner's
confirmation of an irreversible reversal.

## Deliverables

1. **`Decision.produced`** (`contracts`): `{ commits: CommitSha[] }`, optional, so
   every decision recorded before P9 parses as it did. Set once. `core`'s decision
   update rule allows exactly two late writes to a recorded decision:
   `checkpointAfter` once and `produced` once, by the operator's session or the
   engine; nothing else about a decision ever changes. P8's ruling-only
   `checkpointAfter` path becomes this general one.
2. **`ProgramContract.corrects`**: `[{ programId, runId, decisionId, reversedBy }]`,
   optional, never defaulted (as P7's planned fields). `planHash` covers it.
3. **The confirmation of an irreversible reversal** is a `Decision`, authority
   `human`, recorded on the correction run's root, whose `context` names the
   reversal it confirms; `core` has `confirmsIrreversible(decision)` and
   `unconfirmedIrreversible(contract, decisions)`, used by `run` (T3).
4. **`core` rules**: `mayCorrect(contract, recorded)`: every `corrects` entry names
   a program and run of the same project, a decision that exists there, and a
   `reversedBy` that is a human decision superseding it; otherwise refused by name.
   Used by `plan check` and again by the API at ratification.
5. **API**: the decision update path (late `checkpointAfter`, `produced`), with
   `authorize` cells for the operator and the engine's session and none for an
   execution token; `corrects` held to the caller's own chain at ratification;
   `GET …/decisions` already exists.
6. Examples, invariants and table tests for each; `authorize` tables gain the
   cells; the API's isolation suites cover the new update path.
7. **Deploy**; `npm run smoke` green twice.

## Acceptance

- Every decision recorded before P9 still parses and reads the same.
- A second write of `produced` or `checkpointAfter` is refused; so is any other
  change to a recorded decision.
- A correction naming a decision that has not been reversed, or another org's
  program, is refused by `plan check` and by the API.
- `npm run verify` green; deployed; smoke twice.
