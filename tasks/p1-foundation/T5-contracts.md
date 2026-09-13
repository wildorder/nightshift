# T5 — Contracts: versioned schemas and types

**Program:** `p1-foundation`
**Depends on:** T1
**Unblocks:** T6
**Decisions applied:** D-P1-04, D-P1-07; architecture A-07, A-08, A-11, §6

## Objective

`packages/contracts` defines the zod schema and inferred TypeScript type for
every Stage 1 aggregate, with no import beyond `zod`. This is the vocabulary
every other package speaks.

## Aggregates (from the source plan, Stage 1)

```text
Project  ProgramContract  Run  ExecutionNode  JobContract  Agent
Decision  Checkpoint  Verification  Examination  RoutingDecision
Artifact  Event
```

## Deliverables

1. `src/ids.ts`: branded string types and zod schemas for every ID prefix in
   D-P1-07, with a `parseId(prefix, value)` helper. IDs are validated by
   pattern (`<prefix>_<26-char Crockford base32>`), not generated here.
2. One file per aggregate under `src/v1/`, exporting `XSchema` and `type X`.
   Every persisted aggregate has `schemaVersion: z.literal(1)` and the
   ownership chain fields required by A-07: `projectId` on all; `programId` on
   everything below Project; `runId` on everything below ProgramContract.
3. `ProgramContract` fields: objective, projectId, repository (url + program
   branch), successCriteria (id + outcome), constraints, permissions,
   forbiddenActions, verification (ordered list of commands), modelPolicy,
   examinationPolicy (risk level to requirement), delegationLimits (maxDepth,
   maxConcurrency), costPolicy. Match `docs/vision.md` Core Concepts.
4. `JobContract` fields: objective, scope (`includes`, `excludes` as path
   globs), acceptance, dependencies (job IDs), risk (`low|medium|high`),
   ambiguity (`low|medium|high`). What Nightshift decides (harness, model,
   worktree, priority, examination requirement, fallback) is **not** on the
   Job Contract; it lives on `ExecutionNode` / `RoutingDecision`.
5. `ExecutionNode`: id, kind (`program|sub-program|job`), parentNodeId
   (nullable for the root), depth, scope (inherited-and-narrowed), status,
   and the ownership chain.
6. `Decision`: exactly the fields in `docs/architecture.md` §6 plus the source
   plan: context, alternatives, choice, rationale, reversibility
   (`reversible|compensatable|irreversible`), checkpointBefore, checkpointAfter,
   affectedNodes, authority (`agent|human`).
7. `Verification`: jobId, agentId, commitSha, criterionId (optional),
   commands with exit codes, outcome (`passed|failed`), artifact references
   (never inline logs, A-08).
8. `Event`: id, idempotencyKey, occurredAt, sequence, type (closed union to be
   extended by later programs), payload reference, and the ownership chain.
9. `Artifact`: id, kind, S3 reference (bucket + key, as an opaque `uri`
   string; no AWS types), size, contentType, and the ownership chain.
10. `src/index.ts` re-exports everything under a `v1` namespace and at the top
    level.
11. Unit tests: every schema accepts a documented valid example and rejects
    (a) a missing `projectId`, (b) a wrong `schemaVersion`, (c) a malformed ID.

## Acceptance

```text
npm run build && npm run typecheck && npm run lint && npm test
```

`packages/contracts/package.json` dependencies are exactly `{ zod }`.
Architecture rule 1 (T3) passes.

## Notes

- Keep schemas strict (`.strict()`), so unknown fields are rejected. Later
  programs extend schemas deliberately, not by accident.
- Do not model state machines here. Status fields are string unions; the legal
  transitions are `core`'s job (T6).
- Do not add fields "for later". Every field must be required by Stage 1 tests
  or by a vision/architecture sentence you can cite in a comment.
