# T5 — The API stack

**Program:** `p2-control-plane`
**Depends on:** T1, T4, T6, T9
**Unblocks:** T7
**Decisions applied:** D-P2-01, D-P2-07, D-P2-09, D-P2-10; A-19, A-24

## Objective

Deploy-shaped infrastructure for everything stateless: the handler function, the
HTTP API in front of it with IAM authorisation, the stream consumer, log groups
and IAM. Nothing in this stack holds state, so it can be replaced freely.

## Deliverables

1. `NightshiftApiStack` (`nightshift-<stage>-api`), consuming the data stack's
   outputs by name rather than by construct reference, so the two stacks can be
   deployed and replaced independently.
2. The handler function from T4:
   - Node 22 runtime, bundled. Architecture `arm64` unless there is a reason not
     to; record the choice.
   - Environment: table name, bucket name, stage. Nothing secret.
   - Least-privilege IAM: exactly the DynamoDB actions the adapters use on the
     table and its index, and exactly the S3 actions on the bucket. No wildcards
     on resources. `AdministratorAccess` on the deploy role is not a licence for a
     broad execution role.
3. An HTTP API (API Gateway v2) with a **Cognito JWT authorizer** on every route
   (A-19, built in T9). A request with no token or a bad token must be rejected by
   the gateway, which T7 asserts. No route may be **unauthenticated**, including
   health checks.

   To be precise about what this does and does not mean: the endpoint is
   internet-facing, on public DNS, reachable from anywhere. That is deliberate and
   required — it is how a local MCP server on a laptop reaches the control plane,
   and later how the AgentCore runtime does. The authorizer means every request
   must carry a valid token, so the endpoint is publicly *reachable* but not
   publicly *usable*. A private API behind a VPC endpoint was not chosen because a
   laptop cannot reach one without a VPN, which would defeat the local execution
   model entirely.
4. The materializer function from T6, wired to the table's stream:
   - Batch size and window chosen for latency over throughput, since this sets
     how far behind the realtime surface runs. Record the numbers and why.
   - `reportBatchItemFailures` on, with a partial-batch response, so one bad
     record does not stall a run's numbering.
   - A dead-letter queue, and a comment stating what it means operationally if
     anything lands in it: events durable but permanently unnumbered.
   - IAM limited to reading the stream and updating that table.
5. Log groups created explicitly with 30-day retention (D-P2-10), not left to
   Lambda's implicit group with infinite retention.
6. CDK assertion tests: the stack synthesizes; every route has `AWS_IAM`
   authorisation and none is public; the execution role has no wildcard resource;
   log retention is 30 days; the stream consumer has a DLQ and partial-batch
   failure reporting; the function runtime is Node 22.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint
npx vitest run --project @nightshift/cdk
npm run synth
```

Still no credentials for any of the above. First deploy is T7.

## Notes

- The "every route requires the authorizer" assertion is worth more than it looks. Since
  A-19 makes API Gateway solely responsible for authentication, a single route
  authored with `authorizationType: NONE` would be an unauthenticated hole in an
  internet-facing API, and nothing downstream would catch it — the handler has no
  auth code by design.
- Add a root `npm run deploy` script that deploys both stacks under
  `AWS_PROFILE=nightshift`, and keep it out of CI (D-P2-09).
- Bundling: prefer CDK's Node bundling over a hand-rolled build step, and confirm
  the workspace's project references do not break it.
