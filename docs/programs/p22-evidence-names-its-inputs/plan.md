# P22 Evidence Names Its Inputs

## Overview

Pipkin M1a, now PK-1 (PIP-7) alone. M1 was split at the owner's request so the
low-risk part is built and tried before PK-3 (one owner per development line,
M1b). Planning then moved PK-2 (verify any commit on demand) to M2, beside PK-4
(snapshots) and PK-5 (candidates): before PK-4 a verification made outside a
run has no honest home, and PK-2's main consumers are candidate qualification
and background proving (D-02).

What changes is what a verification *is*. It records what it ran against, so
two results can be compared and trusted later. It counts as landing evidence
only when its phase is named as one that lands, so a kind of verification added
later can never let work land by accident. And once written it never changes.
PK-4, PK-5 and PK-11 all build on that evidence identity.

Landing behaviour does not change: exactly what lands today still lands.

## Who it is for

US-01 is whoever relies on a verification after the fact: the owner asking why
something landed, and the Pipkin work that will reuse and compare evidence.

## Architecture

The code map (2026-10-26) found:

- **No production path writes a verification twice.** Every result mints a new
  `ver` id and is put once: `runVerification` in `execution/src/verify.ts`, and
  the candidate check's own builder in `execution/src/examine.ts`. Progress is
  events, flaky reruns are folded in before the put, end gates and resume make
  new records, and step adjustments are decisions. The API already answers a
  different second write with 409 (`createOrConfirm`). Only the memory/SQLite
  and DynamoDB adapters overwrite, so create-only is a store change, not a
  behaviour change.
- **Landing evidence is accepted by exclusion**: `core/rules/verification.ts`
  (`phase === "candidate"` is a mismatch; used by `markVerified` and by the
  API's node transitions in `apps/api/src/operations/nodes.ts`),
  `execution/src/integrate.ts`, `merge-queue.ts`, `strand.ts` (excludes
  `candidate` and `run`) and `dataset.ts`. `end-gates.ts` reads `phase ===
  "run"` for its own records, which is not a landing question.
- **The phases are written by hand in several places**: the schema's inline
  enum, a copy in `core/src/report/verification-time.ts` (an unknown phase
  crashes `emptyPhases`), a three-way breakdown in `report.ts`, and hard-coded
  `byPhase` keys in the Studio's `run/gate-health.tsx`.
- **Where the inputs are known**: the base SHA is already on
  `RunVerificationInput` (passed only to step env today); the gate fingerprint
  is `fingerprintAtCommit` in `execution/src/gate-fingerprint.ts`, which needs
  the gate-health record's `machinery`; the site and dispatch generation are
  `ExecutionEnvironment.site`; the image version is on the dispatch
  (`amiVersion`) and in the API's environment, but nothing in the engine reads
  it yet.

## Strands

### S-01 Evidence that names its inputs

**What will exist afterwards.** A verification record carries optional
`baseSha`, `gateFingerprint` and an environment identity (laptop, or machine
with dispatch generation and image version), filled wherever a verification is
built. The phases are declared once, in contracts, and one core rule says which
of them are landing evidence; every acceptor asks it, and a test over the whole
vocabulary fails for a phase nobody classified. Every verification store refuses
a different second write.

#### Approach

- **Contracts**: the three optional fields; the phase vocabulary exported as a
  constant the schema's enum is built from. Old records parse unchanged. The
  `jobContractId ⇔ phase` refine keeps its meaning but is phrased over that
  vocabulary, so a later phase states whether it has a job.
- **Core**: an `isLandingEvidence(phase)` rule beside `markVerified`, with an
  exhaustive test in the style of the transition tables. Replace each exclusion
  site above with it. The same constant drives the report's phase breakdown and
  verification-time totals.
- **Execution**: fill the fields in `runVerification` and the candidate builder.
  The gate fingerprint comes from `fingerprintAtCommit`; with no gate-health
  record (no `machinery`), the field is left out rather than the verification
  failing. The image version reaches the engine as the dispatch generation
  already does: the runner names it in the root's environment and
  `machineSiteOf` carries it. A laptop records `laptop`.
- **Persistence**: create-only `verifications.put` in memory/SQLite (refuse when
  the stored body differs) and DynamoDB (a conditional put; an identical body
  answers as success). The conformance suite proves it on all three.
- **Studio**: read the phases from contracts instead of its own keys.
- **Docs**: a decision row in `docs/architecture.md` for evidence identity and
  the landing-evidence rule.

The landing-evidence change is the one place this program could hurt: every
landing passes through that rule. Its orchestrator should mark those jobs high
risk.

#### Considered and rejected

- A version number on verifications so a rewrite is allowed: there is no rewrite
  to support, and immutability is the property later evidence reuse needs.
- Storing the gate definitions on each record instead of a fingerprint: large,
  repeated on every record, and comparison needs only the fingerprint.
- A separate setup hash (D-01): the fingerprint already covers setup.
- Adding PK-2's `snapshot` phase now so it is ready: a phase with no producer is
  untested vocabulary; the exhaustive test makes adding it later safe.

## Decisions

D-01 and D-02 are in the contract, answered.

## Risks

- The landing-evidence rule: guarded by the exhaustive test and the constraint
  that exactly today's phases land. Its jobs are high risk and examined.
- DynamoDB's conditional put: an identical retry must answer as success, or a
  retried request after a lost response would fail a landing. The conformance
  suite covers both.
