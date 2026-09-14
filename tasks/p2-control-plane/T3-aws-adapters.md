# T3 — DynamoDB and S3 adapters

**Program:** `p2-control-plane`
**Depends on:** T2
**Unblocks:** T7
**Decisions applied:** D-P2-02, D-P2-03, D-P2-04, D-P2-08; A-08, A-20

## Objective

Implement every `@nightshift/core` port against the key schema in the contract
§4, behind `@nightshift/persistence/aws`. The in-memory adapter is the reference
behaviour; this one must be indistinguishable from it to the conformance suite.

## Deliverables

1. `packages/persistence/src/aws/`:
   - A DynamoDB document-client adapter for every port, using the key layout in
     contract §4.1 and the `gsi_node` index in §4.2. Nothing may invent a key
     shape; if a pattern needs a key the contract does not define, stop and
     surface it.
   - An S3 adapter for artifact bodies, keys prefixed
     `<projectId>/<programId>/<runId>/…` (D-P2-08).
   - Configuration by explicit injection — table name, bucket name, clients. No
     reading of `process.env` inside the adapter; the app wires it (T4).
2. `EventStore.append` writes the event with `SK = ULID#<eventId>` and
   `sequence: null` (A-22). It is idempotent on `idempotencyKey`, enforced by a
   conditional write rather than a read-then-write, so two concurrent duplicates
   cannot both land.
3. `EventStore.listByRun` orders numbered events by sequence and leaves
   unnumbered ones last, matching `orderEvents` in `@nightshift/core`. An
   `afterSequence` cursor must not return unnumbered events — it lags rather than
   skipping, which is the documented trade.
4. `ArtifactStore.put` refuses a record carrying inline content and validates the
   URI as a reference (A-08). Large output goes to S3 and DynamoDB holds the
   reference.
5. Pagination maps to DynamoDB's `LastEvaluatedKey`, exposed as the opaque
   `cursor` string the port already defines. The in-memory adapter uses an
   offset; the port contract does not care, and the conformance suite proves both
   satisfy it.
6. Add `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` and
   `@aws-sdk/client-s3` to `packages/persistence`, pinned exactly, recorded in
   `AGENTS.md`.
7. Wire the conformance suite against this adapter in a file that is **excluded
   from `npm test`** and runs only in the smoke suite (T7), since it needs real
   AWS.

## Acceptance

Offline, and these must pass in CI with no credentials:

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

The architecture rules must still hold: only `apps/*` and `infra/cdk` may import
`@nightshift/persistence/aws`, and `@nightshift/persistence/memory` must remain
free of any AWS import. Real behavioural verification happens in T7.

## Notes

- The conformance suite is the specification. If it needs editing to make this
  adapter pass, either the port contract is wrong or the adapter is — that is a
  conversation, not an edit (contract §10).
- Marshalling: prefer `lib-dynamodb` so records round-trip as plain objects, and
  re-parse through the contract schema on read so a malformed stored record fails
  at the boundary rather than deep in the domain.
- Watch the 400 KB DynamoDB item limit. The `Event` payload bound already guards
  the hot path, but a large `ProgramContract` is plausible; decide what happens
  and write the test.
