# T2 — Org scoping in the ports

**Program:** `p2-control-plane`
**Depends on:** nothing
**Unblocks:** T3, T4
**Decisions applied:** D-P2-05; A-21

## Objective

Make "list the projects in an organisation" a real port method, implemented by the
in-memory adapter and covered by the shared conformance suite, so T3's AWS adapter
has a contract to satisfy rather than inventing one.

## Background

`Project` already carries `orgId` (added during P2 planning, amending D-P1-07).
What does not exist yet is any way to *query* by it. The contract's access-pattern
table marks pattern 2 as new in P2; this is that work.

**`listByOrg` is a grouping query, not an authorisation check.** v1 enforces no
org separation at all: nothing maps a caller to an org, so any principal able to
sign a request can read any project in any org (A-21 non-guarantee). Do not add
an org check here and do not imply one in the naming — a half-enforced boundary
is worse than an absent one, because it gets trusted.

`orgId` is deliberately **not** in the ownership chain. Do not add it to the other
twelve aggregates, and do not add it to `RunScope`. A-21 explains why: `projectId`
is a globally unique ULID, so project-scoped records need no org prefix to be
unambiguous, and adding one would buy nothing while costing a migration.

## Deliverables

1. `packages/core/src/ports/stores.ts`:
   - Extend `ProjectStore` with `listByOrg(orgId: OrgId, page?: PageRequest):
     Promise<Page<Project>>`.
   - Decide and document whether an `Organisation` aggregate is needed in v1, or
     whether an org is just an identifier that projects reference. Default to the
     latter — the contract's key schema has an `ORG#<org>` / `META` row available
     but nothing yet requires it. If you add the aggregate, it needs a contracts
     schema, a registry entry and an example, and the registry-driven tests will
     tell you if you missed one.
2. `packages/persistence/src/memory`: implement `listByOrg`, keyed so the query
   cannot return another org's projects.
3. Extend the shared conformance suite (`test/src/conformance/persistence-ports.ts`)
   with org coverage: a project round-trips with its `orgId`; `listByOrg` returns
   only that org's projects; two orgs holding projects do not leak into each
   other; an org with no projects returns an empty page, not an error.
4. Confirm the architecture rules still pass unchanged — in particular that
   `core` has gained no dependency.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

The conformance suite must still pass against the in-memory adapter, and the new
org tests must be part of it rather than a separate file, so T3's adapter inherits
them automatically.

## Notes

- Resist widening `RunScope`. If a method seems to need `orgId` alongside the
  chain, that is a signal the design drifted; surface it rather than adding the
  field.
- This is the last task that can add a port method cheaply. After T3 exists, every
  port addition means two implementations.
