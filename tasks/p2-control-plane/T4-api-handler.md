# T4 — The control-plane API handler

**Program:** `p2-control-plane`
**Depends on:** T2
**Unblocks:** T5, T7
**Decisions applied:** D-P2-01, D-P2-06; A-19, A-23

## Objective

Build the handler that is the entire control-plane API, in `apps/api`, tested
**offline** against the in-memory adapter. This is the payoff of putting the ports
in `core` (D-P1-08): the API's behaviour is provable without AWS.

## What the handler does not do

No authentication. API Gateway validates SigV4 and rejects an unsigned request
before the function is invoked (A-19). There is no auth code to write, and adding
any would create a second place for isolation to be enforced.

## Deliverables

1. `apps/api/src/`:
   - A router mapping routes to operations, with no framework dependency beyond
     what the Lambda event shape requires. Keep it a pure function from a request
     shape to a response shape, with the Lambda entry point a thin wrapper, so
     tests never construct an API Gateway event unless they are testing the
     wrapper.
   - Operations covering exactly the contract §5 list: create and read project,
     program and run; create and update execution node; append and query event;
     record decision, checkpoint, verification, routing decision and artifact
     reference; query current run state. Plus `listByOrg` from T2.
2. Every request body validated by its contracts schema before anything else.
   A validation failure is a 400 carrying the schema's issues, not a 500.
3. Every route takes the ownership chain from the **path**, not the body, and
   rejects a body whose chain disagrees with the path. Otherwise a caller could
   write into another project by lying in the payload — this is where A-23's
   application-level isolation is actually enforced.
4. Domain rule violations map to meaningful status codes rather than 500:
   ownership violation 403, scope widening 403, illegal transition 409, verification
   evidence 409, delegation refusal 429 for concurrency and 422 for depth. Use the
   `DomainErrorCode` discriminator rather than matching on messages.
5. "Query current run state" returns the run, its execution nodes and the highest
   assigned event sequence, and must tolerate unnumbered events (A-22). Use the
   `@nightshift/core` event-stream helpers; do not reimplement the pending logic.
6. Configuration read once at cold start from the environment, validated with a
   schema, and injected. A missing variable fails at startup with a clear message,
   not on the first request.
7. Unit tests against `createInMemoryStores()`, including a suite run with
   `deferSequencing: true` so the handler is proven to behave while numbering lags.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

`npm test` must cover every operation offline. No test in this task may require
AWS credentials.

## Notes

- Keep the handler ignorant of which adapter it has. It depends on
  `NightshiftStores` from `core`; only `apps/api`'s entry point may import
  `@nightshift/persistence/aws`.
- Resist adding convenience endpoints not on the contract list. P3 will ask for
  what it needs, and each endpoint is surface area the smoke suite has to cover.
- Response shapes are part of the contract with P3 and eventually the Studio.
  Define them in `@nightshift/contracts` rather than inline, so a client can be
  typed against them.
