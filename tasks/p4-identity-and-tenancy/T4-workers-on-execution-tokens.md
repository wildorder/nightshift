# T4 — Workers on execution tokens

**Program:** `p4-identity-and-tenancy`
**Depends on:** T2, T3
**Unblocks:** T6
**Decisions applied:** D-P4-06; A-04, A-27 (amended), A-28

## Objective

Give every worker its own credential and take the human's away.

## Deliverables

1. **Execution layer**: after storing the `Agent`, mint its token through the
   http adapter (the orchestrator's user session may), and put it in the
   worker's environment as `NIGHTSHIFT_EXECUTION_TOKEN`. Stop passing
   `NIGHTSHIFT_CONFIG_DIR` to workers.
2. **Worker MCP role** (`apps/mcp`): the transport is built from the token via
   `staticTokenProvider`; the role refuses to start without the token and never
   calls `requireProfile` or reads `credentials.json`. The `job.*` tools are
   unchanged.
3. **Adapters**: confirm the Claude adapter and the scripted harness pass the
   environment through unchanged; add the assertion that the worker's
   environment contains the token and not the config directory.
4. **Brief**: one sentence telling the worker never to print its environment.
5. **Tests**: the slice suite passes unchanged with workers on tokens; a new
   test plants a credentials file in a worker's config directory and proves it
   is never opened (an injected filesystem or a canary path); the worker-token
   matrix from T3 is exercised through the real worker MCP server.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

## Notes

- The orchestrator keeps the operator's session (D-P4-06). Do not mint it a
  token in P4; that is P9's change and it needs the remote runner to justify
  it.
