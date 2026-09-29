# T2 — The local plane

**Program:** `p12-local-instance`
**Depends on:** T1
**Unblocks:** T3
**Decisions applied:** D-P12-01, D-P12-03, D-P12-06, D-P12-08, D-P12-09

## Objective

One loopback server in `apps/api` runs the production handler with durable
storage, a real operator identity, real execution tokens, bodies on disk and the
Studio at its root; the test harness is that server over test doubles.

## Deliverables

1. **`apps/api/src/local/server.ts`**: `startLocalServer(options)` from the
   harness's server (`handleRequest` over `ApiDeps`, the `/objects/` upload and
   download routes with the same three refusals, the execution-token verifier
   over an injected key), plus a static route: when `studioDir` is given, `/`
   and any path the router does not know answer `index.html` (the Studio's
   router owns paths), assets by path, and `/config.json` from
   `options.studioConfig`. Authentication is an injected `authenticate(header):
   RequestPrincipal | undefined | "malformed"`.
2. **`apps/api/src/local/identity.ts`**: `ensureOperator(stores, ids, now)`
   seeds `User local-operator` and one org with a `Membership` on first start
   and returns them; `tokenAuthenticator(secret, principal)` accepts exactly
   `Bearer <secret>`; `loadOrCreateSecret(path)` and `loadOrCreateKeyPair(dir)`
   write mode 0600 (`chmod` no-op on Windows, as `session/store.ts` does).
3. **`apps/api/src/local/objects.ts`**: `createFileObjectStore(dir)` for the
   upload and download handlers and the plan document store: bytes at
   `<dir>/<key>`, `uri` `s3://nightshift-local/<key>`.
4. **The bin**, `apps/api/bin/nightshift-local.js` → `dist/local/main.js`:
   flags `--port` (default 47820, `NIGHTSHIFT_LOCAL_PORT`), `--state <dir>`
   (default `stateDir()/local`), `--studio <dir>`; composes `createLocalStores`,
   the identity, the object store, `startLocalServer`; prints one line with the
   URL and the fragment token; exits cleanly on `SIGINT`/`SIGTERM`, closing the
   store. `package.json` `bin` and `exports` gain it; the Lambda entry does not
   import any of it (a test asserts the bundle graph, as P3's did).
5. **The harness**: `startLocalControlPlane` keeps its signature and behaviour,
   composed from `startLocalServer` with `ScopedMap` tables, an in-memory object
   store and the injected-principal authenticator (which also accepts
   `test-principal.`); `LOCAL_TOKEN_ISSUER` shared.
6. Tests: the authenticator's refusals (none, wrong, `test-principal.` on the
   product path); a token minted through the route verifies after the key is
   reloaded from disk; bodies round-trip through the file store; the static
   route serves `index.html` for a deep link and `config.json`; the slice, CLI
   and planning suites pass unchanged.

## Acceptance

- SC-P12-03, SC-P12-04 and the durability half of SC-P12-05 proven offline.
- SC-P12-08's suites unchanged and green.
