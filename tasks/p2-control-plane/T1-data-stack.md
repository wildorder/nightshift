# T1 — Split the stacks, and build the data stack

**Program:** `p2-control-plane` (see `docs/programs/p2-control-plane.md`)
**Depends on:** nothing
**Unblocks:** T5
**Decisions applied:** D-P2-02, D-P2-03, D-P2-07, D-P2-08; A-08, A-18, A-20, A-24

## Objective

Replace P1's single placeholder stack with the two-stack split, and make the data
stack real: the DynamoDB table with its one GSI, and the artifact bucket. Nothing
stateless in this stack.

## Why the split comes first

P1 left one empty `nightshift-<stage>-control-plane` stack. D-P2-07 replaces it
with `nightshift-<stage>-data` and `nightshift-<stage>-api`. Doing that before any
resource exists means no resource ever has to move between stacks, which is the
kind of migration that is painful precisely because it risks the data.

## Deliverables

1. Delete `NightshiftControlPlaneStack` and its assertion test. Replace with
   `NightshiftDataStack` (`nightshift-<stage>-data`) and, as an empty shell for
   T5, `NightshiftApiStack` (`nightshift-<stage>-api`). Update
   `infra/cdk/src/bin/app.ts` to instantiate both, still environment-agnostic.
2. `NightshiftDataStack`:
   - One DynamoDB table, on-demand billing, key schema exactly per the contract
     §4.1: `PK` (string) partition key, `SK` (string) sort key.
   - One GSI, `gsi_node`, keys `GSI1PK` / `GSI1SK`, projection `ALL`. Justify any
     narrower projection in a comment if you choose one.
   - DynamoDB Streams enabled, view type `NEW_AND_OLD_IMAGES`. T6 consumes it.
     Record why the view type was chosen.
   - One S3 bucket: SSE-S3, versioning off, public access fully blocked, TLS
     enforced via a bucket policy.
   - **Explicit** `removalPolicy` on both the table and the bucket, and
     `terminationProtection` on the stack (A-18, A-24). Do not rely on defaults;
     the whole point is that retention is chosen.
   - Export the table name, table ARN, stream ARN and bucket name as stack
     outputs, so T5 consumes them without a cross-stack construct reference.
3. Do not hardcode the table or bucket *name*. Let CDK generate them, so two
   stages cannot collide (contract §9).
4. CDK assertion tests covering: both stacks synthesize; the table has the
   documented key schema and exactly one GSI named `gsi_node`; streams are on
   with the expected view type; the bucket blocks public access and has
   encryption; both stateful resources carry an explicit removal policy; the
   stack has termination protection; and the stack name follows
   `nightshift-<stage>-data` for a non-default stage.
5. Update `infra/cdk/README.md` and the `AGENTS.md` note about stack naming.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint
npx vitest run --project @nightshift/cdk
npm run synth          # both stacks, still no credentials needed
npm run check:sterility
```

`npm run synth` must continue to work with no AWS credentials and no `~/.aws`.

## Notes

- No deploy in this task. T7 owns the first deploy.
- The removal-policy assertion is the one test here that matters most later.
  Write it so it fails loudly if someone adds a stateful resource without
  declaring a policy, rather than only checking the two that exist today.
