# T1 — A browser can be a client

**Program:** `p11-studio`
**Depends on:** —
**Unblocks:** T3, T4
**Decisions applied:** D-P11-01, D-P11-04, D-P11-07, D-P11-08, D-P11-09

## Objective

The Studio exists as a workspace, signs a pool user in from a browser, lists
their projects, and does so through the same store ports the CLI uses, with the
read models it will render living in `core`. Everything in this task is proven
offline: the memory stores stand in for the control plane and jsdom for the
browser. Nothing here needs T2's deploy.

## Deliverables

1. **A browser-safe `@nightshift/persistence/http`.** The transport, `routes`,
   `createHttpStores`, `errors` and `createHttpExecutionTokenMinter` import
   nothing from `node:*`. `planning.ts` takes its SHA-256 as an injected function
   (as `planHash` in `core` already does); `sha256Hex` moves to the Node-only
   side. `session/` (the profile, `credentials.json`, the file-backed token
   provider) and the Node artifact read (`read` on
   `createHttpArtifactBodyStore`) sit behind a Node entry, `./http/node`, and the
   `./http` entry is what a bundler sees. A test bundles `./http` with Vite (or
   walks its import graph) and fails on any `node:` import. Every existing
   importer (`apps/cli`, `apps/mcp`, `test`) is updated; nothing they do changes.
2. **The read models move to `core`.** `report.ts` and `decision-graph.ts`
   (`gatherReport`, `renderReport`, `gatherDecisionGraph`, `gatherCorrections`,
   the renderers, their types and tests) move from `packages/execution` to
   `packages/core/src/report/`. They import only `contracts` and `core`, which is
   why they may. `execution` re-exports nothing; the CLI, the MCP server and the
   tests import them from `core`. `renderReport`'s output is byte-identical
   before and after (a golden test over the P7 fixture pins it).
3. **The reversal builder moves to `core`.** `reversalOf(decision, {choice,
   reason, decisionId, at})` returns the superseding human decision exactly as
   `apps/cli`'s `reverseDecision` builds it today (context, alternatives, choice,
   rationale, authority `human`, no `checkpointAfter`, no `produced`);
   `mayReverse(decision)` refuses a decision that is itself a reversal, with the
   CLI's message. The CLI calls both; `test/src/cli/decision.test.ts` and
   `ruling.test.ts` pass unchanged.
4. **The `apps/studio` workspace**: Vite, React, TypeScript, React Router,
   TanStack Query, Tailwind; vitest with jsdom and Testing Library in its own
   `vitest.config.ts` (restating the root's timeouts and `dist` exclusions, as
   every package config must); Biome unchanged. `tsc -b` typechecks it through a
   project reference; `npm run build` at the root runs `vite build` for it;
   `npm test` runs its suite; `npm run studio` serves it locally (D-P11-01,
   development only). Dependencies: `contracts`, `core`, `persistence`, and only
   those among the workspace packages.
5. **The layer table** (`test/src/architecture/rules.ts`) gains `apps/studio`:
   `packages/contracts`, `packages/core`, `packages/persistence`. AR-2 already
   covers `apps/*` by prefix. A negative fixture shows the Studio importing
   `execution` and is reported.
6. **Configuration at startup.** Hosted: `GET /config.json` (`apiEndpoint`,
   `authDomain`, `clientId`, `stage`), written by T2's stack. Local: the stage's
   defaults, the Studio's own restatement of the hostname rule
   (`studio.<stage>.nightshift.wildorder.dev`, `api.<stage>…`, the auth domain),
   pinned by a test as `apps/cli/src/hostnames.ts` is; the `dev` Studio client
   id is baked the way the CLI bakes `INTERACTIVE_CLIENT_IDS`, once T2 prints it.
7. **Sign-in and the session.** Authorization code with PKCE against the hosted
   UI (`authorizeUrl` and the exchange as in `apps/cli/src/oauth.ts`, shared or
   restated; the browser's `crypto.subtle` for the challenge), `state` checked,
   callback at `/callback`. The ID token in memory; the refresh token in
   `localStorage` under one key and nowhere else; refresh with the same
   `TOKEN_REFRESH_MARGIN_MS` rule as `session/tokens.ts`; sign-out `POST`s
   `/oauth2/revoke`, clears storage, returns to sign-in. Errors are described
   from named OAuth fields (`describeTokenFailure`), never a body. A token
   provider adapts this to `createHttpStores`.
8. **The shell and the first pages.** A layout with the project selector, the
   signed-in user (email and acting org from the ID token's claims: the API has
   no identity route) and sign-out; the projects page over `project.list`;
   routing for the pages T3 … T5 fill. Pages take `ProjectStores` from context,
   so a test mounts them over `@nightshift/persistence/memory`.

## Acceptance

- The `./http` entry bundles with no `node:` import; the CLI, the MCP server and
  every suite still build and pass.
- `renderReport` over the P7 fixture is byte-identical to before the move.
- A reversal built by the CLI and one built by `reversalOf` are deep-equal.
- The Studio signs in (jsdom, a fake hosted UI), lists projects from memory
  stores, signs out with storage cleared and the refresh token revoked.
- `npm run verify` green on both CI legs; `npm run check:architecture` reports
  the negative fixture.
