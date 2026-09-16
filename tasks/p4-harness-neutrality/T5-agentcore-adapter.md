# T5 — The AgentCore adapter

**Program:** `p4-harness-neutrality`
**Depends on:** T1, T2, T4
**Unblocks:** T7
**Decisions applied:** D-P4-01, D-P4-03, D-P4-03a, D-P4-07, D-P4-08; A-28, A-29

## Objective

Implement version 1 of the contract for the AgentCore harness in
`packages/harness-agentcore`: a remote workspace, inline functions as the tool
transport, the operator's Cognito token as the only credential, and the job's
verification and integration unchanged on the operator's machine.

## Deliverables

1. **Clients**: `@aws-sdk/client-bedrock-agentcore` at `3.1134.0`, pinned in
   this package and recorded in `AGENTS.md`. Requests signed with **a bearer
   token** from the same `TokenProvider` the http adapter uses, not SigV4; the
   adapter takes no AWS credential and the test that plants `AWS_*` variables
   proves it reads none (SC-P4-16).
2. **Session**: `runtimeSessionId = "nightshift-" + agentId`; one per agent.
3. **Workspace in** (§4.2): tarball of the worktree computed locally (`git
   ls-files` plus untracked, minus ignored), uploaded through the http artifact
   body store as kind `workspace`; inside the session, the T4-spike-chosen
   mechanism fetches it by presigned `GET`, unpacks to `/workspace`, installs
   the toolchain the fixture needs. `agent.started` when the workspace is in
   place.
4. **Invoke**: the brief as the first message; `model` from routing
   (`bedrockModelConfig`); `maxIterations`, `maxTokens`, `timeoutSeconds` from
   the cost policy with documented defaults when it names none; `tools` the
   four inline functions with JSON schemas derived from `contracts`.
5. **Stream handling**: `toolUse` → `tool.called`; `toolResult` → `tool.completed`;
   `metadata` accumulates `usage`; `messageStop` `stopReason` maps to the exit
   per §4.2. Inline calls: `progress` and `recordDecision` pass straight to
   `WorkerTools`; `complete` first exports the tree (tarball from the session,
   `PUT` to a presigned URL as `workspace-result`), downloads and applies it to
   the local worktree (replace, add, delete), then calls `WorkerTools.complete`
   and returns its result to the model; `fail` passes through. Every tool
   result goes back with the assistant `toolUse` message, as the API requires.
6. **Cancel**: the T4-spike-chosen mechanism; settles `cancelled` locally
   regardless, and never leaves a session running past the cost policy's
   timeout.
7. **Transcript**: the raw event stream to the transcript path.
8. **Tests without AWS**: an injected client returning recorded streams (one
   from a real run, checked in); the tarball round trip against a temporary
   worktree; the apply step against a worktree with an added, a changed and a
   deleted file; the inline `complete` ordering (export before commit) asserted
   with a fake session.
9. T1's conformance suite runs against this adapter only when
   `NIGHTSHIFT_CONFORMANCE_HARNESS=agentcore`, otherwise skipped by name; each
   run prints tokens and cost.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`packages/harness-agentcore` depends on `contracts`, `core`, `harness` and the
one SDK client. It never imports `@nightshift/persistence/*`: the body store
and token provider arrive injected from the composition root.

## Notes

- The apply step must never touch `.git`. It writes files; `WorkerTools.complete`
  owns the commit (A-29).
- A session that dies mid-job is `failed`, with the `stopReason` as the reason.
  Do not retry inside the adapter; retry is P6's.
- Log the session id on `agent.started` so a human can find the session in
  AgentCore observability.
