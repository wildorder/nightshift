# T1 — Principals and the authorisation table in `core`

**Program:** `p4-identity-and-tenancy` (see `docs/programs/p4-identity-and-tenancy.md`)
**Depends on:** nothing
**Unblocks:** T2, T3
**Decisions applied:** D-P4-01, D-P4-05; A-04, A-07, A-23

## Objective

Define who can be calling and what each may do, as pure code in `core` and
`contracts`, before any token or route exists.

## Deliverables

1. `contracts`: `PrincipalSchema` (the two kinds of §4.1), `ExecutionTokenClaimsSchema`
   (§4.3), the mint route's response shape. No JWT library; the claims are a
   zod object.
2. `core`: `Operation` as a closed union naming every API operation that
   exists today (one per route), `authorize(principal, operation, target) →
   Allowed | Refused`, where `target` carries the ownership chain and, where
   relevant, the node and agent. The table of §4.4, with a typed refusal
   (`wrong_org`, `execution_out_of_scope`, `execution_forbidden_operation`).
3. Tests: exhaustive over principal kind × operation, plus the two `target`
   dimensions that matter (same org / other org; same node / other node / other
   run). Every cell is asserted; nothing is sampled.
4. Every operation the API serves is in the union, enforced by a test that
   reads the route table from `apps/api`? `core` cannot import `apps/api`, so
   the test lives in `apps/api` (T3) and asserts the reverse: every route names
   an `Operation`.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`core` gains no dependency.

## Notes

- Resist a permission language. The table has two principal kinds and a fixed
  operation list; that is what makes it exhaustively testable.
- An execution's read of its own run is included because `job.get` needs the
  job contract and the node; keep it to reads.
