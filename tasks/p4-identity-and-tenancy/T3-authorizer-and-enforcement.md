# T3 — The Nightshift authorizer and principal enforcement in the API

**Program:** `p4-identity-and-tenancy`
**Depends on:** T1, T2
**Unblocks:** T4, T5
**Decisions applied:** D-P4-01, D-P4-02, D-P4-04, D-P4-05; A-19 (amended), A-23

## Objective

Replace the built-in JWT authorizer with Nightshift's own, thread a typed
principal into the handler, and apply `authorize` and the org check on every
route in exactly one place.

## Deliverables

1. **Authorizer function** (`apps/api/src/lambda/authorizer.ts`, bundled like
   the others): reads the bearer token; by `iss`, verifies a Cognito token
   against the pool's JWKS (fetched and cached per instance, keyed by `kid`)
   or an execution token with T2's verifier; returns a simple-response
   authorizer result with the principal in `context`. Anything else: deny.
   Tests with a fake JWKS and a local key pair, including a Cognito token with
   the wrong audience and an execution token with the right signature and the
   wrong issuer.
2. **API stack**: the authorizer replaces `HttpJwtAuthorizer` on the `$default`
   route; `kms:GetPublicKey` on the key; the P2 assertion becomes "every route
   is bound to the Nightshift authorizer and none is anonymous"; a new
   assertion that the authorizer's cache TTL is set and bounded.
3. **Handler**: `ApiRequest.claims` becomes `ApiRequest.principal`; one
   function, `enforce(principal, route.operation, target)`, runs before every
   operation: for a user, resolve the acting org (P2's `resolveActingOrg`),
   load the project through a per-instance cache, refuse on mismatch; for an
   execution, `authorize` from `core`. Every route declares its `Operation`; a
   test asserts the route table is total over the union.
4. **`listProjects`** filters by the acting org, as today, and every other
   project-scoped route now refuses before reading.
5. **Offline tests** through the local control plane with two fixed user
   principals in two orgs and one execution principal: the §4.4 table as a
   matrix over every route. This is the offline half of SC-P4-01 … SC-P4-05.
6. The local control plane (`@nightshift/api/testing`) accepts a principal per
   request, so suites can switch caller mid-test.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run synth
npm run check:architecture
```

## Notes

- The handler still verifies nothing. If a test wants to check a signature in
  the handler, the design has drifted.
- The org cache is per function instance with a TTL of minutes; a project's org
  is immutable (P2), so staleness cannot grant access wrongly, only delay a
  newly created project's first read by at most the TTL. Say so in a comment.
