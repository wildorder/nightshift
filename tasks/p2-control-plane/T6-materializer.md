# T6 — The sequence materializer

**Program:** `p2-control-plane`
**Depends on:** T2
**Unblocks:** T5
**Decisions applied:** D-P2-04; A-22

## Objective

Stamp dense sequence numbers onto events after they are durable. This is the
consumer A-22 depends on, and the reason a crash cannot burn a number.

## The property this must hold

Within one run, numbering is **dense from zero and gap-free**, and assigned in the
order the stream delivers records. Because numbering happens after the write
commits and the consumer resumes from its last committed position, a crash causes
redelivery rather than a skipped number. That is the entire argument for the
design, so the tests must actually exercise redelivery.

## Deliverables

1. The handler logic as a pure-ish function, separated from the Lambda event
   shape, so it is testable without constructing a DynamoDB Streams event.
2. Numbering:
   - Atomic increment of the per-run counter item (`PK=EVT#…`, `SK=COUNTER`),
     returning the new value.
   - Conditional update stamping `sequence` on the event, conditional on
     `sequence` still being null. An already-numbered event is skipped, not
     renumbered.
   - Process only `INSERT` records for event items. Ignore the counter item's own
     stream records, or you will build a loop.
3. Idempotency under redelivery. Streams deliver at least once, so the same record
   may arrive twice. The conditional update handles it, but prove it: a test must
   replay a batch and assert numbering is unchanged and no number was consumed.
4. Ordering. Records for one run arrive in order on one shard. Do not parallelise
   within a run. If a batch spans runs, per-run ordering must still hold.
5. Partial-batch failure: return the failed record identifiers so the rest of the
   batch commits. A single poison record must not stall a run's numbering.
6. Offline tests against the in-memory adapter, reusing `materializeSequences()`
   as the reference behaviour where it helps. Cover: a fresh run numbers from
   zero; a mixed batch leaves already-numbered events alone; redelivery is a
   no-op; two runs in one batch number independently; a record for a deleted event
   is skipped rather than throwing.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

All offline. T7 proves it end to end against the real stream.

## Notes

- The counter is the one genuinely serialised point in the system. It is fine
  here, where it is off the request path, and it would not have been fine in the
  request path — that is the whole trade in A-22.
- If a number *is* ever burned, `findSequenceGaps` in `@nightshift/core` is what
  detects it. Do not add a second gap-detection implementation here.
- Think about what happens when the stream's 24-hour retention expires during an
  outage: events stay durable and permanently unnumbered. Note it in the DLQ
  comment; a repair path is not in P2 scope, but the failure mode should be
  written down rather than discovered.
