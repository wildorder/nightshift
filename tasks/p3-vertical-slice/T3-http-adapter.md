# T3 — The HTTP adapter and the local session

**Program:** `p3-vertical-slice`
**Depends on:** T2
**Unblocks:** T6, T7
**Decisions applied:** D-P3-01, D-P3-02; A-06, A-19, A-25

## Objective

Implement the project-scoped `NightshiftStores` ports over the control-plane API
as `@nightshift/persistence/http`, together with the local session that makes the
requests authenticated: profile, credentials file, token refresh. Prove the
adapter with the P1 conformance suite over the local control plane from T2.

## Deliverables

1. `packages/persistence/src/http/`:
   - A `Transport`: `(request: ApiRequest-like) => Promise<{ status, body }>`.
     The production transport uses global `fetch` with a `TokenProvider`, sets
     `Authorization: Bearer <id token>`, retries idempotent requests on network
     failure and 5xx with backoff, and never retries a 4xx.
   - Stores for every project-scoped port, mapping each method to its route.
     `put` sends the whole record and treats 200 and 201 as success. A 409 with
     a `DomainErrorCode` in the body is rethrown as the matching
     `@nightshift/core` error class; a 4xx without one is a typed
     `ControlPlaneError { status, code, message }`. Pagination passes the opaque
     cursor through.
   - `events.append` returns the `AppendResult` the API gives, `sequence`
     possibly null (A-22). `events.listByRun` passes `afterSequence` through.
   - `ArtifactBodyStore` over the presigned upload: request a target, `PUT` the
     bytes with the content type, compute the SHA-256 locally, return the
     `StoredBody` the S3 implementation returns.
   - Exported as `@nightshift/persistence/http` in `package.json` `exports`,
     beside `./memory` and `./aws`. The root entry still re-exports nothing.
2. **Local session** in `packages/persistence/src/http/session/`:
   - Paths: `NIGHTSHIFT_CONFIG_DIR` and `NIGHTSHIFT_STATE_DIR` with platform
     defaults (XDG on Linux and macOS, `LOCALAPPDATA` on Windows). One module,
     used by the CLI, the MCP server and the execution layer.
   - `profile.json`: API endpoint, Cognito domain, interactive client id, stage.
     Written by `nightshift login` (T7), read here.
   - `credentials.json`: the refresh token and the subject, mode `0600` where
     the platform supports it. Never the password, never printed.
   - `TokenProvider`: mints an ID token from the refresh token against the
     Cognito token endpoint (`grant_type=refresh_token`, no client secret),
     caches it until shortly before expiry, and surfaces a typed
     `NotLoggedIn` error when there is no credentials file or the refresh is
     refused.
   - A `staticTokenProvider(token)` for scripts that already hold a machine
     token (the deployed slice, T9).
3. **Conformance.** `apps/api/src/http-conformance.test.ts`, in `npm test`:
   `describePortConformance` from P1, unchanged apart from the identity option
   from T2, against the http adapter over `startLocalControlPlane` with in-memory
   stores, with `settle` driving the in-memory materializer. Beside it, tests for
   the error mapping (a scope widening comes back as `ScopeWideningError`, a
   validation failure as `ControlPlaneError` 400), retry behaviour with an
   injected transport, and the token provider with an injected `fetch`.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`@nightshift/persistence/http` imports no AWS SDK. The architecture rule that
keeps `./memory` AWS-free gains a sibling for `./http`. `execution` and
`apps/mcp` never import `./aws`.

## Notes

- The conformance suite is the specification, as in P2 T3. If the http adapter
  cannot pass an assertion, either a route is missing or wrong (fix T2) or the
  suite predates a real change (a conversation). Do not edit the suite here.
- The ID token, not the access token: the authorizer's audience lists the
  interactive client, and `custom:active_org` appears only in ID tokens
  (`acting-org.ts`). Write the reason next to the header.
- Retry only what is safe. Every `PUT` here is idempotent by construction
  (create-or-confirm, or a transition to a named status), and `append` carries
  an idempotency key, so the whole surface is retryable; say so in a comment
  rather than leaving it to be rediscovered.
- Keep `fetch` injectable. Tests must not open sockets to anything but the
  local control plane.
