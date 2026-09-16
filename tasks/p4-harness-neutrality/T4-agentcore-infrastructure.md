# T4 — AgentCore infrastructure and the JWT spike

**Program:** `p4-harness-neutrality`
**Depends on:** nothing
**Unblocks:** T5
**Decisions applied:** D-P4-03, D-P4-03a, D-P4-07, D-P4-08; A-17, A-19, A-28

## Objective

Create the harness Nightshift's remote workers run in, with the narrowest role
and the JWT front door that keeps AWS credentials off the operator's machine.
And before any adapter code is written, answer the one question the docs do
not: which operations the JWT path authorises.

## The spike, first

With a scratch harness created by hand (SDK, not the outdated CLI), inbound
JWT configured for the P2 pool, and the operator's ID token:

1. `InvokeHarness` with a bearer token: expected to work (documented).
2. `InvokeAgentRuntimeCommand` with a bearer token: **unknown**.
3. Stopping or abandoning a session with a bearer token: **unknown**.
4. From inside a session: fetch a presigned `GET` URL with Python's `urllib`,
   and `PUT` a file to a presigned URL. Measure how long installing Node on the
   managed image takes (`apt-get`), since the fixture's tests need it.

Record the four answers in the contract's §12 as the D-P4-03a outcome, with the
API responses quoted. Delete the scratch harness. T5 is written to the answers,
not to the hope.

## Deliverables

1. In the API stack: `AWS::BedrockAgentCore::Harness` `nightshift-<stage>-worker`
   (L1, since no L2 exists in 2.269.0), with: no memory; `allowedTools`
   `["@builtin/shell", "@builtin/file_operations"]` plus the inline function
   names T5 registers; the shared brief as system prompt; default model
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`; the JWT authorizer
   (`discoveryUrl` from the P2 pool's issuer, `allowedClients` the two P2
   client ids, imported by export name); public network mode.
2. **Execution role**: trust `bedrock-agentcore.amazonaws.com`;
   `bedrock:InvokeModel` and `InvokeModelWithResponseStream` on exactly the
   three inference profiles and their foundation models; `s3:GetObject` and
   `s3:PutObject` on the artifact bucket's objects; the CloudWatch Logs, metrics
   and X-Ray statements the docs list for the managed image; ECR Public token
   access. **Nothing** for browser, code interpreter, memory, gateway,
   `sts:AssumeRole`. Assertion tests pin the action set and the resource
   scoping.
3. Outputs: `WorkerHarnessArn`, exported.
4. `@aws-sdk/client-bedrock-agentcore-control` is **not** needed in CDK (the
   L1 does it); the SDK pins land in T5's package.
5. Smoke: `GetHarness` via the SDK reports `READY`; an `InvokeHarness` with
   the smoke suite's machine token and a one-line prompt streams a `messageStop`
   (cost: a few hundred tokens; recorded).
6. Redeploy, with T2.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run synth
AWS_PROFILE=nightshift npm run deploy -- --require-approval never
AWS_PROFILE=nightshift npm run smoke
```

## Notes

- The harness is stateless configuration; it belongs in the API stack, not the
  data stack, and can be replaced freely.
- `runtimeSessionId` must be at least 33 characters; an `agent_` id is 32. T5
  prefixes it. Note it here so the L1's tests do not assume otherwise.
- If the spike shows the JWT path cannot run commands, D-P4-03a's fallback is
  the model's `shell` tool with fixed instructions. State which was chosen and
  do not build both.
