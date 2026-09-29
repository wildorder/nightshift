# Program P12 — Local Instance

| Field | Value |
|-------|-------|
| Program ID | `p12-local-instance` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p12-local-instance` |
| Source stage | none: the owner's direction of 2026-09-28 (§3.1), after the P11 close |
| Status | **Built 2026-09-28** (T1 … T5, §13); dev redeployed on Node 24, smoke suites green; awaiting the owner's trial (SC-P12-10) and their word on the build decisions (§13). |
| Depends on | P3 (the local control plane the slice suite runs, the CLI session), P4 (principals, execution tokens), P11 (the Studio, `persistence/http/browser`) |
| Blocking decisions | none: D-P12-01 … D-P12-09 ratified |

This contract is the stable authority for P12. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Let one developer run all of Nightshift on one machine with no AWS account and
no sign-in: `nightshift local` starts the control plane on loopback over a
durable local store and serves the Studio beside it; `nightshift init`,
`plan`, `run`, `resume`, `report` and the MCP server work against it unchanged;
close the terminal, start it again, and every run is still there. Then open the
repository: a licence, and a README that takes a stranger from clone to a run
they can watch.

**Why now.** Everything in v1 is gated behind the owner's hosted plane and a
user the owner creates (§1 of `p11-studio.md` names the gaps). The open-source
projects with Nightshift's shape (Temporal, Prefect, Dagster) all offer a local
instance of the same server, and sell running it. A-06's rule was one
authoritative plane, never two truths; it said nothing about where the one
truth lives. The local instance is an instance of the same plane, and the
hosted plane and Studio at `nightshift.wildorder.dev` stay what they are.

**What P12 is not.** Not self-hosting in someone else's AWS account (the account
and zone are still pinned; a later program parameterises them). Not P10. Not
multi-user locally, not a second store beside the plane, not a Cognito
replacement.

### What exists today

- **The local control plane exists, as a test harness.**
  `apps/api/src/testing/local-control-plane.ts` runs the **production handler**
  on a loopback HTTP server over injected stores: real routing, validation,
  `enforce`, `authorize`, signed uploads and downloads served by the same server,
  and execution tokens minted through the real route and verified with the real
  verifier over a per-process RSA key. Only three things are stood in for: the
  identity the gateway would have validated (a principal injected verbatim, or
  a `test-principal.` bearer any caller may forge), the table (the memory
  store) and the bucket (a `Map`). Nothing survives the process.
- **The memory store is built on one primitive.** `ScopedMap` in
  `persistence/memory/scoped-map.ts`: `set`, `get`, `has`, `delete`,
  `scan(prefix)`, `all`, `clear`, `size`, all synchronous, keyed by the ownership
  chain. Every store method is a few lines over it; sequence numbering is
  synchronous when `deferSequencing` is off.
- **`node:sqlite` is in Node 22** (unflagged since 22.13; this machine's 22.22
  runs it, with an `ExperimentalWarning`) and stable in Node 24, with a
  synchronous API. The workspace pins `>=22 <23` and `.node-version` is `22`.
- **The CLI and the MCP server share one session module**
  (`persistence/http/session`): one `profile.json` (`apiEndpoint`, `authDomain`,
  `clientId`, `stage`), one `credentials.json` (a Cognito refresh token), and a
  token provider that spends the refresh token at
  `https://<authDomain>/oauth2/token`, scheme hard-coded. Signing in elsewhere
  overwrites both files.
- **Workers reach the plane with an endpoint and an execution token** in their
  environment (`NIGHTSHIFT_API_ENDPOINT`, the token variable), nothing else.
- **The Studio** reads `/config.json` at startup, signs in through Cognito with
  PKCE, learns the acting org from the projects the token can list, and speaks
  the same routes over `persistence/http/browser`.
- **The repository is `UNLICENSED`** and every package `private`; the README
  points at the documents and the verify gate and says nothing about running
  Nightshift.

## 2. Environment and human prerequisites

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P12-01 | Ratify D-P12-01 … D-P12-09 | **satisfied 2026-09-28** |
| H-P12-02 | P11 merged (`main` is v1) | **satisfied 2026-09-28** |

**Explicitly not required.** No AWS resource, no deploy, no console step. The
hosted stage is untouched.

## 3. Decisions

### 3.1 The owner's direction, 2026-09-28

| # | Question | Answer |
|---|----------|--------|
| Q1 | Open source posture | **Open the repository as a portfolio piece and an internal tool**; no ambition of traction. The hosted plane, Studio and (later) runners are the paid shape; a local instance is the open one |
| Q2 | Does a local instance break A-06? | **No, as reasoned on 2026-09-28**: A-06 forbids two truths, not a local instance of the one plane. The rule stays |
| Q3 | Dogfooding | The owner is open to it; **P12 is still hand-written**, as P1 … P11 were. A later program may change the policy |
| Q4 | Priority | **The local instance first**; self-hosting in another account later |

### 3.2 Ratified decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P12-01 | **The local instance is the same control plane in one process on loopback, started by the CLI.** `nightshift local` spawns `apps/api`'s new bin, `nightshift-local`, which runs the production handler (`handleRequest`) over a durable local store, serves signed uploads and downloads itself, and serves the Studio at its root. Loopback only (`127.0.0.1`), one port (D-P12-08), foreground like `temporal server start-dev`; `Ctrl-C` stops it. The CLI never imports `apps/api`: it spawns a bin path from its assets, as it spawns `nightshift-orchestrate`. | The test harness proved the shape in P3: one handler, every rule real. Promoting it is the honest local instance and keeps the layer table intact. Rejected: a local mode inside the CLI process (the CLI would import the API and become a second composition of it), and a Docker image (a dependency for the one thing that should need none). |
| D-P12-02 | **Storage is `node:sqlite`, through the memory store's own logic.** `ScopedMap` becomes an interface (`KeyValueTable`: `set`, `get`, `has`, `delete`, `scan(prefix)`, `all`, `clear`, `size`) with two implementations: the `Map` it is today and a SQLite table (`key TEXT PRIMARY KEY, value TEXT`, prefix scans by range). `createLocalStores({ file })` in `@nightshift/persistence/local` is `createInMemoryStores` over the SQLite table; one file under the state dir, `nightshift.sqlite`. The workspace moves to **Node 24** (`engines >=24 <25`, `.node-version` `24`, CI follows), where `node:sqlite` is no longer experimental; the Lambda runtime moves to `nodejs24.x` if this CDK offers it, else stays where it is (the API does not load `node:sqlite`). | Zero dependencies, synchronous like the `Map` it replaces, and every store method stays the one implementation the offline suites already prove; the equivalence is a property test over both tables. Rejected: `better-sqlite3` (a native module to build on Windows CI), a JSON snapshot rewritten per write (a run appends thousands of events), and a second store implementation (the two would drift). |
| D-P12-03 | **One local operator, one org, and a per-instance secret as the bearer.** On first start the plane seeds `User local-operator` and a minted org with a `Membership`, persisted with the rest. The operator is an ordinary `User` with ordinary `Membership` rows, so a second local org later is one more row and the acting-org selection the API already has (`org_selection_required`, answered today by a Cognito claim and tomorrow by the local profile); nothing here forecloses it, and nothing here builds it. It writes a random token to `<state>/local/token` (mode 0600) and accepts exactly that bearer as the operator's user principal; the `test-principal.` header stays in the test harness and is never accepted by the product bin. Execution tokens are real JWTs (`mintExecutionToken`, `verifyExecutionToken`) over an RSA key generated on first start and persisted beside the token, issuer `https://api.local.nightshift.invalid`, so a worker's token survives a restart within its lifetime. | Authorisation stays real: `enforce` and `authorize` run unchanged, and a worker still holds only its four operations. The token file is the same protection the CLI's `credentials.json` has today: another local account cannot read it. Rejected: no authentication (any local process could write the plane), and a local OAuth server (a Cognito impersonation nobody needs). |
| D-P12-04 | **The Studio is served by the local plane, same origin, and signs in from the start URL.** `nightshift-local` serves `apps/studio/dist` (a path handed to it, never an import) at `/` with a `config.json` of `{ stage: "local", apiEndpoint: <origin>, auth: { kind: "token" } }`. `nightshift local` prints `http://127.0.0.1:<port>/#token=<secret>`; the Studio reads the fragment once, keeps the token in `sessionStorage`, strips it from the URL, and uses it as the bearer over the same transport. No CORS, no Cognito, no `localStorage` refresh token: there is none. The hosted Studio's `config.json` gains `auth: { kind: "cognito", authDomain, clientId }`; the P11 shape stays valid by default. | Jupyter's pattern, minus the cookie: one URL to open, the secret never in a query string a server logs, and the Studio's every page unchanged. Rejected: a dev identity with no token (the plane would trust any browser on the machine) and a cookie (a CSRF surface for nothing). |
| D-P12-05 | **Profiles per stage, and `nightshift use <stage>`.** `profile.json` and `credentials.json` move under `<config>/profiles/<stage>/`; `<config>/current` names the stage in use. `nightshift login` writes the stage it signed into and makes it current; `nightshift local` writes the `local` profile (`auth: "token"`, the token path) and makes it current while it runs; `nightshift use dev` switches back without a browser. The session module reads the current profile, so the CLI and the MCP server switch together. A `local` profile's token provider is a static token read from the file; a `cognito` profile's is the refresh flow it is today. | The owner runs the hosted stage and the local one on the same machine; one profile made every switch a sign-in. Rejected: one profile overwritten (what exists), and an environment variable per shell (invisible to the MCP server a harness spawns). |
| D-P12-06 | **Artifact and plan bodies are files under the state dir.** `<state>/local/objects/<key>`, written by the plane's own upload handler and read back by its download handler, exactly as the test harness holds them in memory; `uri` stays `s3://nightshift-local/<key>` so nothing above the store learns the difference. | The bytes have to outlive the process, and a directory is the honest S3 of one machine. |
| D-P12-07 | **The repository is licensed Apache-2.0, and the README starts a stranger.** `LICENSE` at the root; `package.json` licences from `UNLICENSED` to `Apache-2.0` (the packages stay `private`: nothing is published to npm, D-P11's successor question). The README leads with what Nightshift is, then a quick start (`npm ci`, `npm run build`, `npm link` from `apps/cli`, `nightshift local`, open the URL, `nightshift init` in a repository, plan and run), then the documents. The hosted stage is described as the owner's. | Q1. A permissive licence says what a portfolio should; a defensive one describes a business that does not exist. Rejected: MIT (fine, but Apache's patent grant is the convention for infrastructure), and BSL or "fair code" (the HashiCorp lesson, for no gain). |
| D-P12-08 | **One port, `47820`, overridable.** `--port` on `nightshift local` and `NIGHTSHIFT_LOCAL_PORT`; the CLI's loopback sign-in keeps `47821`. The state dir is `stateDir()/local`, overridable by `NIGHTSHIFT_STATE_DIR` as today, so a test runs an instance from a temp directory. | Fixed so the printed URL is stable across restarts and the Studio's `sessionStorage` (per origin) survives one. |
| D-P12-09 | **The test harness becomes a thin wrapper over the product server.** `apps/api/src/local/` holds the server (the handler over stores, the object store, the token verifier, the Studio static route); `apps/api/src/testing/local-control-plane.ts` composes it with the memory table, an in-memory object store and the injected-principal authenticator, and keeps its interface so the slice, CLI and planning suites do not change. | One implementation of the loopback plane, proved by the suites that already run it; the product bin adds only what tests never needed (durability, the token file, the Studio). Rejected: leaving the harness as a copy (the two would drift, and the product one would be the less tested). |

### Non-guarantees

- **Not multi-user.** One operator, one org, one machine. A second account on
  the machine has no access, and no way to get one.
- **Not a service.** Foreground process; nothing installs it, restarts it or
  runs it at login. A later program may.
- **Not a migration path.** Records in a local instance stay there; nothing
  moves them to the hosted plane or back.
- **Node 22 is no longer supported** after P12. The owner does not need it, and
  `node:sqlite` is stable only from 24.

## 4. Design

### 4.1 Shape

```text
nightshift local  ──spawns──►  nightshift-local (apps/api bin), 127.0.0.1:47820
                                 │  handleRequest over createLocalStores(<state>/local/nightshift.sqlite)
                                 │  bearer == <state>/local/token  → user principal (local-operator, the seeded org)
                                 │  execution JWTs over <state>/local/keys (RS256), the real mint and verify
                                 │  /objects/…: uploads and downloads, bytes under <state>/local/objects
                                 └  /: apps/studio/dist + config.json { stage: "local", auth: { kind: "token" } }
CLI, MCP server ──── profiles/local (auth: token) ────► the same routes, the same stores port
Studio (browser) ─── #token=… → sessionStorage → bearer ─► the same routes, same origin
Workers ──────────── NIGHTSHIFT_API_ENDPOINT + execution token ─► unchanged
```

### 4.2 Storage (D-P12-02)

```ts
interface KeyValueTable<T> { set; get; has; delete; scan(prefix): readonly T[]; all(); clear(); size }
createInMemoryStores({ tables?: () => KeyValueTable<unknown> })   // default: Map-backed, as today
createLocalStores({ file }): NightshiftStores                    // SQLite-backed tables, one file
```

Values are the records' JSON; parsing through the contract schema on read stays
where it is (the store methods). Sequence numbering is the synchronous path.

### 4.3 The session (D-P12-05)

```text
<config>/current                      "local" | "dev" | …
<config>/profiles/<stage>/profile.json   { apiEndpoint, stage, auth: { kind: "cognito", authDomain, clientId } | { kind: "token", path } }
<config>/profiles/<stage>/credentials.json   the refresh token (cognito only)
```

`requireProfile()` reads the current stage's profile; `createTokenProvider()`
dispatches on `auth.kind`. A profile written before P12 (the flat files) is read
once and moved under `profiles/<its stage>/`, so an existing machine keeps its
sign-in.

### 4.4 The Studio (D-P12-04)

`config.json`'s `auth` selects the session module: `cognito` is P11's; `token`
takes `location.hash`'s `token`, stores it in `sessionStorage`, replaces the URL,
and provides it as the bearer; identity shows `local-operator`, the org from the
projects list as today. The hosted stack's `config.json` writes `auth.kind:
"cognito"`; a `config.json` without `auth` is read as cognito.

### 4.5 Documents

A-48 records the local instance: A-06 clarified (one plane, local instance of
it), the licence, the profiles layout. `README.md` rewritten (D-P12-07);
`AGENTS.md` gains "As built for P12" and the profiles layout; `vision.md`'s
"do not build" keeps "an independent authoritative local database" with a note
that the local instance is not one.

## 5. Scope

### In scope

`@nightshift/persistence/local`; `apps/api/src/local/` and the `nightshift-local`
bin; the test harness over it; `nightshift local`, `nightshift use`, profiles
per stage and the migration of the flat files; the Studio's token session and
`config.json`'s `auth`; bodies on disk; `LICENSE`, `package.json` licences, the
README; the documents; an end-to-end proof through the real CLI and MCP server
against a local instance from a temp state dir, including a restart.

### Out of scope

- Self-hosting the hosted plane in another AWS account (account, zone, client
  ids as parameters).
- Publishing to npm; a single bundled package.
- Running as a service, multiple users, or moving records between instances.
- P10, and anything remote.

## 6. Success criteria

- **SC-P12-01** `nightshift local` from a fresh state dir starts the plane on
  `127.0.0.1:47820`, prints the Studio URL with the token, and stops on
  `Ctrl-C`; a second start finds the same operator, org, key and records.
- **SC-P12-02** Through the real CLI and MCP server against a local instance:
  `nightshift init` creates a project, a planned program is checked, ratified
  and run with the scripted harness to a report, `nightshift report` regenerates
  it, `decision reverse` records a reversal. Nothing in those commands changed
  for it.
- **SC-P12-03** A worker holds a real execution token verified by the local
  plane; it can do its four operations and nothing else (P4's matrix over the
  local plane).
- **SC-P12-04** The plane refuses a request with no bearer, a wrong bearer, and a
  `test-principal.` header; the token file is mode 0600 on POSIX.
- **SC-P12-05** Records, events with their sequence numbers, artifact bodies and
  plan documents survive a restart of the process; the property test holds the
  SQLite table equivalent to the `Map` over generated operations.
- **SC-P12-06** The Studio served by the local plane signs in from the start
  URL, strips the token from the address bar, shows the project, its runs and a
  run page over the local plane; the hosted Studio's behaviour is unchanged
  (its suite passes with `auth.kind: "cognito"` and with no `auth`).
- **SC-P12-07** `nightshift use dev` after `nightshift local` restores the
  hosted session without a browser; a pre-P12 flat profile is migrated once and
  its sign-in kept.
- **SC-P12-08** The slice, CLI and planning suites pass unchanged over the
  wrapped harness (D-P12-09); `npm run verify` passes on both CI legs.
- **SC-P12-09** `LICENSE` is Apache-2.0, every `package.json` says so, and the
  README's quick start is what SC-P12-02's proof runs, in order.

**Exit gate**

- **SC-P12-10** The owner's own: on this machine, `nightshift local`, then a
  program of their choosing in another repository planned, run and watched in
  the local Studio, the terminal closed and reopened, everything still there.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
npm run local:e2e     # the end-to-end proof, offline, both CI legs
```

From a developer machine: `npm run slice` (the wrapped harness), and the owner's
trial.

## 8. Constraints

- A-06 holds: the local instance is an instance of the one plane, not a store
  beside it; nothing above `persistence` learns which table is under it.
- A-28 holds: the CLI, the MCP server and the Studio reach the local plane only
  through its HTTP routes.
- `authorize` and `enforce` run unchanged; no route is anonymous but the Studio's
  static files and `config.json`.
- The secret token and the signing key are written mode 0600 and never printed
  but in the start URL.
- The hosted stage, its stacks and its Studio are not changed but for
  `config.json`'s `auth`.
- `contracts` and `core` gain no Node import (AR-1).

## 9. Permissions and forbidden actions

Permitted: editing the repository; running the offline suites and the wrapped
slice. No deploy is needed; if `config.json`'s `auth` is deployed, the Studio
stack alone.

Forbidden:

- Accepting an unauthenticated write on the local plane.
- A second implementation of any store method.
- Publishing to npm.
- Weakening the P1 … P11 suites.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Node 24; `KeyValueTable`, the SQLite table, `@nightshift/persistence/local`; the equivalence property | — | — |
| T2 | `apps/api/src/local/`: the server, token authenticator, persisted key, objects on disk, Studio static route and `config.json`; the `nightshift-local` bin; the test harness over it | T1 | — |
| T3 | Profiles per stage, `nightshift use`, the flat-file migration, the token provider by `auth.kind`; `nightshift local` | T2 | — |
| T4 | The Studio's `auth` in `config.json`, the token session, the hosted stack's `auth.kind` | — | — |
| T5 | `npm run local:e2e`; licence and README; documents (A-48, AGENTS.md, vision); as-built | T3, T4 | — |

```text
T1 ── T2 ── T3 ──┐
T4 ──────────────┴── T5
```

Specs live in `tasks/p12-local-instance/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| The Node 24 move surfaces a dependency or Lambda runtime problem | The pin moves in T1 with the whole verify behind it; the Lambda runtime moves only if the CDK offers `nodejs24.x`, and the API never loads `node:sqlite` |
| The flat-to-profiles migration loses a sign-in | Migration is a rename, tested against a captured pre-P12 layout on both platforms; the flat files are moved, never deleted first |
| Workers' execution tokens fail after a restart | The key is persisted; a token minted before a restart verifies after it (tested) |
| The Studio's token lands in browser history | It is in the fragment, never sent to a server, and replaced on first load |
| The wrapped harness changes a suite's behaviour | SC-P12-08: the slice, CLI and planning suites pass unchanged, or the wrapper is wrong |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-28 | **Built.** T1 … T5 on `program/p12-local-instance`; verify green under Node 24 (3,278 tests); `local:e2e` green; dev redeployed (all functions `nodejs24.x`), `smoke` 90 of 90, `studio:smoke` 10 of 10. The build decisions of §13 are provisional until the owner ratifies or reverses them. | Agent, for human ratification |
| 2026-09-28 | **Contract ratified.** D-P12-01, -04, -06, -08 and -09 agreed as written after the owner walked the other four. | **Human** |
| 2026-09-28 | **D-P12-07 ratified**: Apache-2.0, knowing it permits closed and commercial forks and competing hosted services; the owner accepts that exposure for a portfolio piece. | **Human** |
| 2026-09-28 | **D-P12-05 ratified**: profiles per stage, `nightshift use`, the one-time migration. | **Human** |
| 2026-09-28 | **D-P12-03 ratified**, with the owner's note: a local user may want several orgs one day; the seeded operator is an ordinary user with ordinary memberships so that is a row and the existing acting-org selection, not a redesign. | **Human** |
| 2026-09-28 | **D-P12-02 ratified**, with the owner's amendment: the workspace moves to Node 24 rather than carrying `node:sqlite`'s experimental status on 22. | **Human** |
| 2026-09-28 | Contract drafted from the owner's direction (§3.1) and the code: nine decisions proposed for ratification. Hand-written, as P1 … P11; the owner is open to dogfooding later. | Agent, for human ratification |

## 13. As built

Built 2026-09-28 on `program/p12-local-instance`, T1 … T5 in one sitting.

### Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | **done** | `KeyValueTable`; the memory store over a `TableFactory`, its sequence counters a table; `@nightshift/persistence/local`; Node 24 everywhere, the Lambda included |
| T2 | **done** | `apps/api/src/local/` (server, credentials, identity, objects, main); the `nightshift-local` bin; the harness over the same server |
| T3 | **done** | profiles per stage, the flat-file migration, `nightshift use`, `nightshift local`, `login` refusing `local` |
| T4 | **done** | the Studio's config union, the token session, the hosted `config.json`'s `auth` block (deployed) |
| T5 | **done** | `npm run local:e2e`; `LICENSE`, `NOTICE`, `license` in every `package.json`; the README; A-48, AGENTS.md, vision, staging |

### What was proven, and where

| SC | State | By |
|----|-------|----|
| SC-P12-01 | met | `test/src/local/local-e2e.test.ts` (through the CLI, port 0); by hand on this machine under Node 22 with the linked binary: 401 without the token, 200 with it, the Studio and `config.json` served, `whoami` answering as the local operator |
| SC-P12-02 | met | `local-e2e.test.ts`: `project create`, a planned program checked, ratified, run by the real headless root to a report, `report` regenerated, `decision reverse`; no command changed for it |
| SC-P12-03 | met | the same run: workers hold execution tokens the local plane minted and verified with the real verifier; the harness suites (P4's matrix among them) run over the same server |
| SC-P12-04 | met | `apps/api/src/local/local-instance.test.ts`: no bearer, a wrong one and a forged `test-principal.` all 401; the token file 0600 |
| SC-P12-05 | met | `packages/persistence/src/local/sqlite-table.test.ts` (the equivalence property over 200 generated runs; records, sequences, idempotency and config versions across a reopen); `test/src/conformance/local.test.ts` (the port conformance suite over SQLite); `local-e2e.test.ts` (the plane stopped and started, the report rebuilt from it, the plan document read back) |
| SC-P12-06 | met offline | `apps/studio/src/auth/token-session.test.ts`, `config.test.ts` over all three shapes; the P11 suites unchanged; the hosted `config.json` checked live by `studio:smoke`. The Studio's pages over a local plane in a browser are the owner's trial |
| SC-P12-07 | met | `packages/persistence/src/http/session/stages.test.ts` (selection, the migration keeping a sign-in, stage names); `apps/cli/src/commands/local.test.ts` (`use`, `local`, `login`'s refusal) |
| SC-P12-08 | met | the slice, CLI, planning, execution and MCP suites pass over the wrapped harness; `npm run verify` green under Node 24 |
| SC-P12-09 | met | `LICENSE` (Apache-2.0, verbatim), `NOTICE`, `"license": "Apache-2.0"` in all 17 manifests; the README's quick start in the order `local:e2e` runs it |
| SC-P12-10 | **the owner's** | below |

### The live battery, 2026-09-28

`npm run deploy` under Node 24: all five stacks; the four Node functions now
`nodejs24.x`. `npm run smoke` 90 of 90; `npm run studio:smoke` 10 of 10 (its
`config.json` check now expects the `auth` block). Nothing about the hosted
stage changed but the runtime and that block.

### Build decisions, provisional until the owner ratifies or reverses them

1. **The local API is served under `/api`, the Studio at `/`.** Same origin was
   ratified (D-P12-04); the Studio's page paths (`/projects/…`) are also API
   routes, so one origin cannot answer both at the root. `apiEndpoint` in the
   local profile and `config.json` is `http://127.0.0.1:47820/api`. The harness
   keeps the API at the root, so no suite changed.
2. **A profile is a tagged union with the Cognito shape unchanged**
   (`auth: "token"` plus `tokenFile`, or no `auth` key), not the nested `auth:
   { kind, … }` §4.3 sketched. Every profile written before P12 stays valid as it
   is, so the migration is a move with no rewrite.
3. **The migration runs lazily**, the first time anything reads the current
   stage, not at a fixed moment. Your own machine's `~/.config/nightshift/` will
   move under `profiles/dev/` the first time you run any command after pulling.
4. **`nightshift local` leaves the local profile selected when it stops.**
   `nightshift use dev` switches back. The alternative, restoring the previous
   stage on exit, would surprise a second terminal still pointed at local.
5. **The fixture names `--test-reporter=tap`.** Node 24 made `spec` the default
   reporter for a pipe; the P3 suites assert TAP's summary lines. The proper fix
   is the fixture saying which reporter it means, which is what it now does.
6. **The launcher is not handed a token by `local:e2e`**; it finds the local
   profile through the config directory, as a real launcher does. The P7 suite's
   placeholder token (which the harness ignored) would be refused by the product
   plane.
7. **`NOTICE` names the copyright holder as the git author, `Tim OConnell`.**
   Change it to the spelling or entity you want before the repository is public.
8. **The dev stage was redeployed**, beyond §9's "no deploy needed", because the
   Node 24 amendment moved the Lambda runtime; leaving it for a later deploy
   would have moved the runtime unobserved.

### What changed in earlier programs' suites, and why

Nothing was weakened.

- **P3** `test/fixtures/slice-repo/nightshift.program.json`: the test step names
  its reporter (build decision 5). `apps/cli/src/commands/login.test.ts`: the
  0600 leftover is planted where login now writes (D-P12-05).
  `paths.test.ts` gains the per-stage path.
- **P1** AR-3 covers the local adapter, with a negative fixture.
- **P2** the CDK test expects `nodejs24.x`.
- **P11** the studio stack test and `studio:smoke` expect the `auth` block.

### For the owner's trial (SC-P12-10)

1. Pull, `npm ci`, `npm run build`. Your default Node is 22 and works; `fnm use
   24` is the supported one.
2. `nightshift local`. The Studio opens on `127.0.0.1:47820`. Your hosted sign-in
   is untouched under `profiles/dev/`.
3. In another repository, `nightshift init` (a new project in the local org),
   plan something small with `/plan-program`, ratify, `nightshift run`, and
   watch it in the local Studio.
4. `Ctrl-C` the plane, start it again, and check the run page and the report are
   all there.
5. `nightshift use dev` to go back to the hosted stage.

Look for: anything that still assumed a hosted stage; the Studio's behaviour on
a token that has expired from `sessionStorage` (a new tab); and whether the
README's quick start is what you actually typed.
