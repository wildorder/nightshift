# T9 — Cognito, the JWT authorizer, and the membership model

**Program:** `p2-control-plane`
**Depends on:** T2
**Unblocks:** T4, T5, T7
**Decisions applied:** D-P2-01, D-P2-13; A-19, A-19a, A-21, A-23

## Objective

Give the control plane an identity model that survives distribution: a Cognito
user pool, a JWT authorizer on the API, and enough of a user/membership model to
resolve a token to an organisation.

## Why this replaced IAM SigV4

A-19a records it. SigV4 requires every caller to hold an IAM identity in the
Nightshift AWS account. That is fine for one internal operator and impossible for
anyone else — it would mean issuing IAM users to customers. It also forced the
operator to carry a Nightshift profile alongside whatever client-account
credentials they were already using, which is exactly backwards: **which AWS
profiles a user holds must be irrelevant to the control plane** (A-25's two
credential worlds).

## Deliverables

1. **Cognito** in the data stack, since a user pool is stateful and must not be
   replaced by an API deploy (A-24):
   - A user pool. Email sign-in. No self-service sign-up in v1 — the operator
     creates users.
   - An app client for interactive clients, configured for authorization code
     with PKCE and a **loopback redirect**, which is what a local CLI needs. This
     is the flow `aws sso login` and `gh auth login` use.
   - A second app client for machine callers, for the smoke suite now and the
     AgentCore runner later.
   - Explicit removal policy and termination protection. Losing the pool means
     losing every user identity.
2. **The JWT authorizer** on the HTTP API (T5 wires it): issuer the user pool,
   audience the app client. Every route authorized, none anonymous. The handler
   still contains no authentication code — the gateway rejects a bad token before
   invocation, which is the property that made SigV4 attractive and is preserved
   here.
3. **Membership model** in `@nightshift/contracts`:
   - A `User` aggregate keyed by the Cognito `sub`, and a `Membership` joining a
     user to an org. A user may belong to several orgs; a contractor working for
     several clients is the motivating case, not a hypothetical.
   - Registry entries and examples, so the registry-driven tests cover them.
   - Ports and in-memory implementation, plus conformance coverage.
4. **Token to org resolution**, as a function in `apps/api`:
   - Input the validated claims, output the acting org, or a typed refusal.
   - The active org comes from a claim. Where a user belongs to several orgs,
     define how one is selected and write it down; do not leave it implicit.
   - Never read the org from a path or a body (D-P2-13).
5. **Reserved cross-account fields** on `Project` (D-P2-14, A-25): optional role
   ARN and external ID. Fields and validation only. No `sts:AssumeRole` anywhere
   in P2 — that is execution-layer work.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run synth
```

Offline tests must cover token-to-org resolution, including a token with no org
claim, a token whose claimed org the user is not a member of, and a user in
several orgs. T7 proves a real token works end to end.

## Notes

- **Do not enforce org isolation here yet.** A-21's non-guarantee still stands:
  resolving a token to an org is not the same as refusing cross-org access, and a
  half-enforced boundary is worse than an absent one because it gets trusted. This
  task makes the *derivation* real. Enforcement is a separate, deliberate step.
- The interactive login flow belongs to the CLI, which P3 builds. P2 needs only a
  machine token for the smoke suite, so do not build a login UX here.
- Cognito has no native OAuth device flow. For a local CLI the loopback PKCE
  redirect is the right choice; note it so P3 does not go looking.
- Secrets in this task, if any, follow A-26: plaintext for now, upgrade path
  recorded. Do not invent a different scheme.
