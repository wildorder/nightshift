# T5 — The second principal, the bootstrap script, and the isolation suites

**Program:** `p4-identity-and-tenancy`
**Depends on:** T3
**Unblocks:** T6
**Decisions applied:** D-P4-02, D-P4-07

## Objective

Prove isolation against the real control plane with two principals in two
orgs, and give the operator the tooling to create a second human user in a
second org.

## Deliverables

1. **Data stack**: a second machine app client, `TestPrincipalClient`, same
   scope, exported. Its only purpose is the smoke suite; the comment says so.
2. **Bootstrap script** (`npm run admin:user`): `--org` may name an existing
   org or `new`; the script prints the org it used. A second `--email` with
   `--org new` is how the operator creates the second human.
3. **Smoke suite**: seed two machine principals in two throwaway orgs; run the
   §4.4 matrix live: every project-scoped route as A against A's project (200s)
   and as B against A's project (403s); mint an execution token as A for A's
   agent and prove B cannot; drive the worker matrix with the minted token.
   Cleanup covers both orgs.
4. **Contract §7** gains a subsection describing the isolation suite: what it
   asserts, in a table a reader can check against the smoke output.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

Then, with T6's deploy: `npm run smoke`, twice.

## Notes

- Interactive users cannot obtain tokens without a browser (P3 §13.4). The
  machine principals are the live proof; the offline matrix already covers the
  same table with user principals.
