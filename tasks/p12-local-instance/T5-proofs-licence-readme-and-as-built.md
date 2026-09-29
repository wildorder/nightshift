# T5 — Proofs, licence, README and as-built

**Program:** `p12-local-instance`
**Depends on:** T3, T4
**Decisions applied:** all

## Objective

A stranger's path is proven end to end, offline, on both CI legs; the
repository is licensed and its README starts them; the documents say what was
built.

## Deliverables

1. **`npm run local:e2e`** (`test/src/local/`): from a temp config and state
   dir, start the real bin as `nightshift local` would (through the CLI with
   its real `exec`), `nightshift init` a temp repository, plan a small program
   with the scripted harness, `plan check`, `plan ratify`, `nightshift run` to
   a report, `nightshift report`, `decision reverse`; then stop the bin, start
   it again, and read every record, event sequence, artifact body and plan
   document back through the CLI. The Studio's `config.json` and `index.html`
   served. Runs in `npm test` on both legs (its own vitest project, serial).
2. **`LICENSE`** (Apache-2.0, the owner as copyright holder), `license` in every
   `package.json` (root and workspaces), the sterility check untouched.
3. **`README.md`**: what Nightshift is in a paragraph; the quick start in the
   order SC-P12-02 runs it; what the Studio shows; the hosted stage as the
   owner's; then the documents and the verify gate.
4. **Documents**: `architecture.md` A-48 (the local instance; A-06 clarified;
   profiles per stage; the licence); `AGENTS.md` "As built for P12" and the
   session layout; `vision.md`'s note under "do not build"; `staging.md`'s P12
   row.
5. **As-built** in `p12-local-instance.md` §13: task states, the SC table,
   build decisions for the owner, what changed in earlier suites, and the
   owner's trial (SC-P12-10).
6. PR into `main`.

## Acceptance

- `npm run verify`, `check:architecture`, `local:e2e` green on both legs;
  `npm run slice` green from a developer machine.
