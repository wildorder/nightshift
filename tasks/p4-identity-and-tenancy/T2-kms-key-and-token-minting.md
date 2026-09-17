# T2 — The KMS key, the signer, and execution-token minting

**Program:** `p4-identity-and-tenancy`
**Depends on:** T1
**Unblocks:** T3, T4
**Decisions applied:** D-P4-03; A-04, A-24

## Objective

Give the control plane a way to issue an execution token that only Nightshift
could have signed, with the private key never leaving KMS.

## Deliverables

1. **Data stack**: an asymmetric KMS key, sign/verify, alias
   `nightshift-<stage>-execution-tokens`, `RemovalPolicy.RETAIN`, rotation not
   applicable. Choose RSA-2048 or ECC P-256 and record why (JWT `RS256` vs
   `ES256`; verification cost in the authorizer; library support in Node 22
   without a dependency). Exported by name.
2. **API stack**: `kms:Sign` for the API function on that key, nothing else on
   any key.
3. **Signer** in `apps/api`: `mintExecutionToken(agent, node, run, program,
   now)` builds the claims (T1's schema), signs through KMS, and returns the
   compact JWT. Expiry `min(costPolicy.maxWallClockSeconds, 8h)`. Injectable
   KMS client; the offline tests sign with a local key pair through the same
   code path.
4. **Route** `POST …/runs/{runId}/agents/{agentId}/token`: user principals
   only (T3 enforces; here the operation is named), agent must be `created` or
   `started`, returns the token once. Idempotency is not offered: each call is a
   new token, and that is fine because none is stored.
5. **Verifier** in `apps/api` (used by T3's authorizer): parse, check `iss`,
   `aud`, `exp`, `kind`, verify the signature with a cached public key. Pure
   over an injected key; tests cover a wrong key, an expired token, a tampered
   claim, and a token from another stage's issuer.
6. Smoke: mint a token for a smoke agent and verify it against the deployed
   key's public half.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run synth
```

Deploy happens in T6.

## Notes

- Never log a token. The mint route's response is the only place one appears.
- The public key is not secret and is fetched by the authorizer with
  `kms:GetPublicKey`; cache it per function instance.
