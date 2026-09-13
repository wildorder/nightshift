# T3 — Sterility check and architecture tests

**Program:** `p1-foundation`
**Depends on:** T1
**Unblocks:** T4
**Decisions applied:** D-P1-09; architecture A-01, §1 dependency rule

## Objective

Make the greenfield boundary and the layering rule machine-enforced. These
checks are the enforcement of SC-P1-01 … SC-P1-04 and SC-P1-19 … SC-P1-21.

## Deliverables

### Sterility check (`scripts/check-sterility.mjs`, wired to `npm run check:sterility`)

Fails (non-zero exit, lists every offender) if any of the following is true
anywhere in the tracked tree (use `git ls-files`, never the working directory):

1. A file named `nightshift.config.json`, `docs/as-built.md`, or any file under
   `docs/programs/` or `tasks/` whose name or content marks it as a v0 manifest
   (a JSON or YAML file with a top-level `workstreams` key).
2. Any `package.json` depending on `@wildorder/nightshift` or any package whose
   name contains `program-pipeline`.
3. Any source, config, or doc file containing the strings
   `program-pipeline`, `nightshift:sha256=`, `deciderAgent`, or `reviewerAgent`.
   Exclude `scripts/check-sterility.mjs`, its test, and `tasks/**` (this spec
   quotes the markers).
4. `AGENTS.md` missing the exact sentence: "Do not inspect legacy branches, tags,
   commits, or prior Nightshift source unless explicitly instructed by a human."
5. Any tracked file under `dist/`, `build-logs/`, `unused/`, or `worktrees/`.

The script must not read git history or any ref other than `HEAD`.

### Architecture tests (`test/architecture/*.test.ts`, run by `npm test`)

Static analysis over `git ls-files '*.ts'` plus every package's
`package.json`. For each rule, collect offending file and import specifier and
fail with the full list.

1. `packages/contracts` and `packages/core` import nothing whose specifier
   starts with `@aws-sdk/`, `aws-cdk-lib`, `@modelcontextprotocol/`,
   `@nightshift/harness`, `@nightshift/persistence`, or `node:` (no Node
   builtin at all). Their `package.json` dependencies are a subset of
   `{zod, ulid}` plus their own layer.
2. No package above the adapter layer (`execution`, `routing`, `verification`,
   `apps/*`, `core`, `contracts`) imports `@nightshift/harness-claude`,
   `@nightshift/harness-codex`, or `@nightshift/harness-agentcore`, nor any
   provider SDK (`@anthropic-ai/`, `openai`, `@aws-sdk/client-bedrock*`).
3. `packages/persistence/src/memory/**` imports nothing under `@aws-sdk/`.
4. No package imports `@nightshift/persistence/aws` except `apps/*` and
   `infra/cdk`.
5. Reference direction in every `tsconfig.json` matches the layer diagram: a
   package may only reference packages in its own layer or below. Encode the
   layer table once in the test.

Each rule gets a **negative fixture test**: a temporary in-memory file list
containing a violation must make the rule fail. Otherwise a silent no-op passes
forever.

## Acceptance

```text
npm run check:sterility   # exit 0 on the clean tree
npm test                  # architecture rules pass, negative fixtures pass
```

Temporarily add a violating import to `packages/core/src/index.ts`, confirm
`npm test` fails with the file named, revert.

## Notes

The checks must be fast (under a few seconds) and dependency-free beyond Node
builtins and vitest. Do not add dependency-cruiser, madge, or similar.
