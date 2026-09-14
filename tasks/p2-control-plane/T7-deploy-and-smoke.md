# T7 — First deploy and the smoke suite

**Program:** `p2-control-plane`
**Depends on:** T1, T3, T4, T5, T6
**Unblocks:** the exit gate
**Decisions applied:** D-P2-09, D-P2-12; A-17, A-18

## Objective

Deploy both stacks to the v1 account and prove the control plane actually behaves,
including everything only a real deploy can show. This task owns success criteria
SC-P2-03 through SC-P2-12.

## Environment

One account, `755348349819` / `us-west-2`, profile `nightshift` (A-17). Deploys run
from a developer machine; CI stays credential-free (D-P2-09). The account is a
sandbox but it is the **only** environment, so nothing here destroys a stack.

## Deliverables

1. A root `npm run smoke` script, opt-in, excluded from `npm test`. It must fail
   fast with a clear message if `AWS_PROFILE` is unset or resolves to any account
   other than the expected one — deploying or smoking the wrong account is the
   mistake worth engineering against.
2. **Phase 1, reachability and auth.** An unsigned request to the API returns 403
   from the gateway; the same request signed returns 200 (SC-P2-07). Without the
   unsigned half, this proves nothing about whether the API is open.
3. **Phase 2, conformance.** Run `describePortConformance` from P1 against the AWS
   adapter, unchanged (SC-P2-12). Editing the suite to pass is forbidden by
   contract §10.
4. **Phase 3, live-only assertions.**
   - Project A / Program X and Project B / Program X coexist; an A-scoped query
     cannot return a B record (SC-P2-05).
   - S3 keys are project prefixed (SC-P2-06).
   - An oversized payload is refused inline, stored in S3, and the DynamoDB item
     stays small — assert the stored item's size, not just that the call
     succeeded (SC-P2-11).
   - The same idempotency key twice yields one event (SC-P2-08).
   - Poll until the materializer has stamped sequences, then assert they are dense
     from zero (SC-P2-09). Record the observed lag in the output; it is the first
     real measurement of how far behind the realtime surface will run.
   - Rebuild current run state from stored records alone and compare to expected
     (SC-P2-10).
5. **Phase 4, cleanup.** Delete the smoke run's records and S3 prefix. Not the
   stacks. With teardown verification dropped (A-18), leaving litter in the only
   environment matters more, not less. Cleanup must run even when an assertion
   fails, and a cleanup failure must be reported rather than swallowed.
6. Writes into a throwaway project so a failed run never touches real data, and
   prints the identifiers it used so a half-cleaned run can be finished by hand.
7. Record in the contract's as-built section: deployed stack names, the table and
   bucket names CDK generated, the observed sequencing lag, and the smoke suite's
   runtime.

## Acceptance

```sh
npm run verify                      # still credential-free, still green
AWS_PROFILE=nightshift npm run deploy
AWS_PROFILE=nightshift npm run smoke
```

Both AWS commands exit 0. `npm run verify` must be unaffected by anything in this
task — if CI now needs credentials, the task went wrong.

## Notes

- Expect the first deploy to surface bundling and IAM problems that synth cannot.
  Least-privilege roles usually fail on the first real call, not at synth time.
- The polling loop in phase 3 needs a timeout with a clear failure message
  distinguishing "materializer is slow" from "materializer is broken". Silence is
  the failure mode to design against.
- Run the smoke suite twice in a row. The second run catches state the first left
  behind, which is exactly what cleanup is for.
