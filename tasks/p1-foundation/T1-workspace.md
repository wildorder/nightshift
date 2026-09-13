# T1 — Workspace scaffold and tooling

**Program:** `p1-foundation` (see `docs/programs/p1-foundation.md`)
**Depends on:** nothing
**Unblocks:** T2, T3, T5
**Decisions applied:** D-P1-01, D-P1-02, D-P1-03, D-P1-05, D-P1-07

## Objective

Create the monorepo so that every directory in `docs/architecture.md` §1 exists
as a buildable, typecheckable, lintable package, and the root scripts in the
contract's §6 all exist and exit 0 on an empty codebase.

## Deliverables

1. Root `package.json`:
   - `"private": true`, `"workspaces"` listing `apps/*`, `packages/*`,
     `infra/*`, `test`.
   - `engines.node` `>=22 <23`; `.nvmrc` / `.node-version` with `22`.
   - Scripts: `build`, `typecheck`, `lint`, `lint:fix`, `test`, `synth`,
     `check:sterility`, `check:architecture` (the last two are wired by T3 and
     may be stubs here that exit 0 with a message).
   - Every dependency pinned exactly to D-P1-05. Commit `package-lock.json`.
2. `tsconfig.base.json` (strict, `module`/`moduleResolution` `NodeNext`,
   `target` ES2022, `declaration`, `composite`, `isolatedModules`) and a root
   `tsconfig.json` that is a pure references list.
3. One package per directory: `apps/api`, `apps/cli`, `apps/mcp`,
   `apps/studio` (reserved: `package.json` and a README line only, no build),
   `packages/contracts`, `packages/core`, `packages/persistence`,
   `packages/execution`, `packages/routing`, `packages/verification`,
   `packages/harness`, `packages/harness-claude`, `packages/harness-codex`,
   `packages/harness-agentcore`, `infra/cdk`, `test`. Each has `package.json`
   (`@nightshift/<dir-name>`, `"type": "module"`, exports pointing at `dist`),
   `tsconfig.json` extending the base with `references` matching the layer
   diagram, and `src/index.ts`.
4. `packages/persistence` declares subpath exports `./memory` and `./aws`
   (D-P1-08). `./aws` may export nothing yet.
5. `biome.json` at the root: formatter and linter on, recommended rules,
   2-space indent, line width 100, organize imports on.
6. `vitest.workspace.ts` (or `vitest.config.ts` with `projects`) covering every
   package so `npm test` at the root runs everything and exits 0 with zero
   tests.
7. `.gitignore` extended for `dist/`, `cdk.out/`, `*.tsbuildinfo`,
   `node_modules/`, `.env*`.
8. `README.md` at the root: one paragraph, pointers to `docs/`.
9. `AGENTS.md` dependency table updated if any pin had to change (record why in
   the contract's §11).

## Acceptance

```text
npm ci
npm run build       # tsc -b, all references
npm run typecheck   # tsc -b --noEmit equivalent, or tsc -p per package
npm run lint        # biome check .
npm test            # vitest run, 0 tests, exit 0
```

All exit 0 on Windows (Git Bash) and Linux. `git status` is clean after a
build (build output is ignored).

## Notes

- Do not add any dependency beyond D-P1-05 without recording it.
- No shell scripts. If a script needs logic, it is a `.mjs` under `scripts/`.
- Reference direction must match the layer diagram exactly. `contracts` and
  `core` reference nothing. `execution`, `routing`, `verification` reference
  `core` and `contracts` (and `harness` for `execution`). `harness-*` reference
  `harness`. `apps/*` may reference anything below them.
