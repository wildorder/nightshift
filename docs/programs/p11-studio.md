# Program P11 — Studio

| Field | Value |
|-------|-------|
| Program ID | `p11-studio` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p11-studio` |
| Source stage | Stage 10 (Realtime and Analytics Surface), extended by the owner to the Studio UI (§3.1) |
| Status | **Built 2026-09-28** (T1 … T6, §13), deployed, live suites green; awaiting the owner's trial (SC-P11-12) and their word on the build decisions (§13, §12). |
| Depends on | P4 (users, orgs, the authorizer), P7 (plans, the report), P8 (org policy, routes, examinations), P9 (the decision graph, reversal). P10 is deferred and nothing here waits on it. |
| Blocking decisions | none: D-P11-01 … D-P11-10 ratified; O-02 resolved by D-P11-05 |

This contract is the stable authority for P11. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Give the owner **visibility into runs** through a web console, the Nightshift
Studio: hosted on Nightshift's AWS account, signed in through the existing
Cognito pool, laid out like an ordinary SaaS dashboard. Projects are listed and
selected; the signed-in user is shown and can sign out; a settings page edits
what Nightshift has made configurable; every run of a project is listed; and a
run page shows, from the control plane alone, what happened: the execution tree,
the agents and their models, the timeline, each job's routes, verifications and
examinations, the strands and success criteria, cost, and the decision graph.
From the decision graph the owner can reverse a decision, exactly as
`nightshift decision reverse` does, and is shown the correction's next step.

**How this departs from the source plan.** Stage 10 says "do not build the
Studio itself"; A-15 and `vision.md` exclude the UI from v1. The owner's restaging
of 2026-09-28 (`staging.md`) supersedes those: the owner is the sole user, runs
attended on an always-on machine, and wants to *see* runs and decisions now. The
Studio remains what A-15 asked it to be, **a client of the centralized APIs and
not a backend**; P11 builds the UI over them and adds to the control plane only
what a browser client needs and cannot have otherwise (§4.4). Stage 10's
requirements (SC-17, SC-18) are met by the Studio rather than by a headless
"realtime client". The Studio does not start runs (A-32; P10's dispatch).

**What P11 is not.** Nothing remote (P10). No new harness. No change to the
engine, the merge queue, routing, examination or correction. No learned routing
and no new analytics dataset: `nightshift routes export` (P8) is the dataset.
No self-service sign-up or org administration (post-v1).

### What exists today

- **Every record the Studio needs is already served over HTTP** by the routes in
  `packages/persistence/src/http/routes.ts`: projects, programs (with plans,
  ratifications, prerequisites), runs, nodes and their children, jobs, agents,
  events (with an `afterSequence` cursor), decisions, checkpoints, verifications,
  examinations, routing decisions, artifacts, and the org's config. `authorize`
  in `core` is total over them; a user principal may read all of them in its own
  org and write org config, projects, programs and human decisions.
- **The report already reconstructs a run from records alone** (`gatherReport`
  and `gatherDecisionGraph` in `packages/execution`): strands, jobs with routes
  and examinations, rulings, criteria, prerequisites, usage and cost, the decision
  graph with produced commits and reversals. That is SC-18's proof, rendered as
  markdown for a terminal. `getRunState` reads every node and event of a run and
  its own comment says a realtime surface should keep a cursor instead.
- **The API is not reachable from a browser.** It sets no CORS headers, the only
  interactive Cognito client accepts a loopback callback (`localhost:47821`), and
  the authorizer refuses a token from any client it was not told about.
- **Artifact bodies cannot be read through the control plane.** It signs uploads
  only (A-28); the API role holds one S3 read, `plans/*`. Transcripts and
  verification logs are `s3://` URIs a browser cannot open.
- **`@nightshift/persistence/http` is a Node module.** Its stores and transport
  are plain `fetch`, but `planning.ts` uses `node:crypto` and `session/` the file
  system, so the package cannot be bundled for a browser as it stands.
- **`apps/studio` is a reserved, empty workspace**; the layer table
  (`test/src/architecture/rules.ts`) has no row for it.

## 2. Environment and human prerequisites

Everything from P3 … P9 stands: the account, the region, the zone, the pool.

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P11-01 | Ratify D-P11-01 … D-P11-10 | **satisfied 2026-09-28** |
| H-P11-02 | P9 merged into `v1` | **satisfied 2026-09-27** (PR #22) |

**Explicitly not required.** No new account, zone, delegation or console step.
CloudFront's certificate lives in `us-east-1` (D-P11-02), which means the CDK
toolkit is bootstrapped there once (`cdk bootstrap aws://755348349819/us-east-1`);
the deploy profile can do that itself, so it is a task step, not a prerequisite.

## 3. Decisions

### 3.1 The owner's direction, 2026-09-28

| # | Question | Answer |
|---|----------|--------|
| Q1 | P10 or P11 next? | **P11, the Studio**, for visibility into runs; P10 is deferred with its research kept |
| Q2 | Where does the Studio run? | **Hosted on Nightshift's AWS infrastructure, reached over the web** |
| Q3 | Who may use it? | **Signed-in users of the Cognito pool** |
| Q4 | What does it look like? | **A typical SaaS dashboard**: projects listed and selectable; the user shown, with sign-out; a settings page for everything configurable; the project's runs; a run page that describes what happened |
| Q5 | What may the owner do from it? | **Reverse a decision** ("trigger a different decision") from the run page; more later |
| Q6 | How much to build? | **Expose what is already collected.** Many features come later |
| Q7 | Hosted only, or runnable locally too? | Asked by the owner; answered by D-P11-01 |

### 3.2 Ratified decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P11-01 | **The Studio is a hosted product, and only that.** A static single-page client at `studio.<stage>.nightshift.wildorder.dev`; customers, orgs and projects reach it there and nowhere else. There is no local control plane and no local mode (A-06). Running the app from the Nightshift repository (`npm run studio`) exists **for developing the Studio itself**: it is a development affordance of this repository, not a feature, and the `http://localhost:<port>` callback that makes sign-in work from it is registered on the `dev` stage's Studio client only, never on a later `prod`. | Answers Q7. A local build shows nothing the hosted one does not, so it has no value to a user; its value is to whoever is changing a page and wants to see it before a deploy. Keeping the localhost callback off any other stage is what keeps "not available to other customers" structural. |
| D-P11-02 | **Hosting is S3 behind CloudFront on the stage's hostname.** A stateless stack `nightshift-<stage>-studio` (the asset bucket, the distribution, the alias record, and a `config.json` written at deploy time from stack values: API endpoint, auth domain, client id) and `nightshift-<stage>-studio-cert` in `us-east-1`, because CloudFront accepts certificates from that region only, referenced across regions by CDK. `npm run deploy` deploys them with the rest. Nothing stateful: the bucket is rebuilt from the repository on every deploy. | The ordinary shape for a static console; one hostname per stage per surface, as D-P3-18 laid out. The cross-region certificate is the one wrinkle, and it is CDK's to carry. Rejected: serving the app from the API's regional domain (couples the console's deploy to the API stack and puts static files behind the authorizer), and CloudFront's default hostname (no stable origin for Cognito to trust). |
| D-P11-03 | **The API grants CORS to the Studio's origins**, the stage's Studio hostname and the local development origin, on the HTTP API itself so preflight is answered before the authorizer. The Studio calls `api.<stage>.nightshift.wildorder.dev`, the hostname the CLI calls. | The Studio is a client of the same API (A-16); making it call the same address keeps that literally true. Rejected: proxying `/api` through CloudFront to avoid CORS, which creates a second address for the API and a second place a request can be shaped. |
| D-P11-04 | **A Studio app client in the pool, and the browser holds the session.** `StudioClient`: public, authorization code with PKCE, callback and logout URLs the Studio's origins; added to the authorizer's `audiences`; its id a stack output the Studio reads from `config.json`. The Studio keeps the ID token in memory, refreshes it with the refresh token as the CLI does, and stores the refresh token in `localStorage` and nowhere else: never in a URL, a log or an error. Sign-out revokes the refresh token and clears storage. | One client per surface, as the CLI has its own; a new callback on the CLI's client would let a browser flow redeem a code meant for a terminal. Storing the refresh token is what makes the console usable across tabs and days for a single owner; the CLI's one absolute rule about that token applies unchanged. Rejected: memory-only sessions (a sign-in on every tab). |
| D-P11-05 | **Realtime is polling the run's event cursor. O-02 is resolved for v1: no push transport.** While a run is live the Studio asks for events after the last sequence it saw and re-reads the records those events name; when the run is settled it stops. The interval is a few seconds; the latency is that plus the materializer's. | The events route already has the cursor (P2 wrote it for this), the reads are cheap at one watcher, and nothing is added to the control plane. Rejected: a WebSocket API (a connection table, a fan-out from the stream, and an idle-timeout dance, for one viewer) and server-sent events (the HTTP API cannot stream). Revisit when there are several watchers or the poll shows in the bill. |
| D-P11-06 | **Artifact bodies are read through a presigned `GET` the control plane signs.** `POST …/artifacts/{artifactId}/download-url`, operation `artifact.createDownloadUrl`, for user principals only; the API role gains `s3:GetObject` on `artifacts/*`, its second S3 read after `plans/*`. The Studio opens transcripts, verification logs and examination reports through it. | Mirrors the upload (D-P3-13): the function signs, the bytes never pass through it, the Lambda stays the only credential holder. Rejected: proxying bodies (a hidden size limit) and CloudFront signed URLs on the bucket (a second signer with its own key). An execution token gets no cell: workers never needed to read a transcript. |
| D-P11-07 | **The Studio reads and writes through the same ports the CLI uses, and the read models it renders live in `core`.** `@nightshift/persistence/http`'s transport, routes and stores become browser-safe (the SHA-256 in `planning.ts` is injected, as `planHash` already takes it; `session/` and the Node-only artifact read stay behind a Node entry). `gatherReport` and `gatherDecisionGraph`, which by their own account are written from records alone, move from `execution` to `core` with their tests, and the CLI imports them from there. The layer table's row for `apps/studio` is `contracts`, `core`, `persistence`. | The pages are then functions of `ProjectStores`, tested against the memory stores and the fixtures P6 … P9 already have, with no browser needed; the report the terminal shows and the page the Studio shows are one computation. Rejected: a second client in the Studio (two definitions of every route) and a subpath export of the report from `execution` (which would put a browser app above the execution layer). |
| D-P11-08 | **Reversing from the Studio records exactly what `decision reverse` records, then shows the next step.** The builder that makes the superseding human decision, and the refusals (already reversed; itself a reversal), move from `apps/cli` into `core`; the CLI and the Studio both call it. After recording, the Studio shows the `decision brief` command and says that the correction is planned with the owner in a session; it does not plan, ratify or run anything. | D-P9-02's one verb keeps its one meaning in both places. The brief needs the repository's git (the files each commit touched), which a browser does not have. Rejected: a partial brief in the browser. |
| D-P11-09 | **UI stack: React with Vite and TypeScript; TanStack Query for reads; React Router; Tailwind for styling; vitest with jsdom and Testing Library; Biome as everywhere.** No server-side framework. | A static client wants a static toolchain: Vite builds to a directory, `tsc -b` still typechecks it, Windows CI runs it. Considered and deferred, on the owner's word: Next.js on OpenNext with SST, which the owner likes; it brings a server for a client that has none today, and SST beside CDK would need A-09 superseded. Kept as the switch to make when there is a reason. A component kit comes later, once the pages exist. |
| D-P11-10 | **What P11 shows, and what it writes.** Shows: projects; a project's programs (plan status, ratification, prerequisites) and every run of them; a run's tree, agents, timeline, jobs (routes, verifications with each step's command, exit code, duration and log; examinations with findings, questions and rulings), strands and criteria, cost and usage (estimated and unpriced flagged, as the report does), and the decision graph; the org's routing and examination policy; the project's details; the run's effective policy and the contract's policies. Writes, and only these: the org config (with its version check), the project's name and description, and a human decision reversing another. Nothing starts, cancels or resumes a run from the Studio. | Q6: expose what is collected. The three writes are the ones a user principal already holds and the owner asked for. Starting work stays a terminal act (A-32) until P10 gives it a dispatch API. |

### Non-guarantees

- **No push.** A page shows an event a few seconds after it is numbered, not the
  instant it is written (D-P11-05).
- **No offline Studio.** Without the control plane there is nothing to show.
- **Not multi-tenant UX.** One org per sign-in, as the pool's active-org
  attribute says today; switching orgs is post-v1 administration.

## 4. Design

### 4.1 Shape

```text
browser ── studio.<stage>.nightshift.wildorder.dev (CloudFront → S3: the SPA, config.json)
   │
   ├── Cognito hosted UI (PKCE, StudioClient) ──► ID token, refresh token
   │
   └── api.<stage>.nightshift.wildorder.dev (CORS: the Studio's origins)
          │  the same routes, the same authorizer, the same authorize table
          └── artifacts: POST …/download-url ──► presigned S3 GET ──► browser
```

The Studio is `apps/studio`: a Vite app whose pages take `ProjectStores` and
`IdentityStores` from `@nightshift/persistence/http` (browser entry) and render
`core`'s read models. Startup reads `/config.json` (hosted) or the stage's
defaults (local), signs in if there is no session, and lists projects.

### 4.2 Pages

| Page | Reads | Writes |
|------|-------|--------|
| Sign-in / callback | the pool, `whoami` (the user, the acting org) | — |
| Projects | `project.list` | — |
| Project | `program.list`; per program, `run.list`; plan status, ratifications, prerequisites | `project.put` (name, description) |
| Run | `gatherReport` over the run (strands, criteria, jobs, rulings, usage, graph, corrections); nodes and children; agents by node; events by cursor; verifications, examinations, routing decisions by node; checkpoints; artifacts | — |
| Run › decision | the decision, its alternatives, `produced`, its reversal | `decision.put` (the reversal, D-P11-08) |
| Settings | `orgConfig.get` (ladders, rules, prices, unavailable routes, examination policy); the project; the contract's `modelPolicy`, `delegationLimits`, `costPolicy`, `examinationPolicy`, `routing`; the run's effective policy | `orgConfig.put` with `replacesVersion` |
| Me | the user, the acting org | sign-out (revoke) |

A project's runs are gathered by listing its programs and each program's runs;
no index is added. The run page polls while `run.status` is live (D-P11-05) and
invalidates the records each new event names.

### 4.3 Realtime (D-P11-05)

```text
GET …/events?afterSequence=N  ──► new events ──► invalidate: node, agent, verification, … named
                                            └──► append to the timeline
```

Events with `sequence: null` are not yet numbered; the Studio orders by sequence
(`orderEvents` in `core`) and never shows an event twice.

### 4.4 Control-plane changes

- CORS on the HTTP API for the Studio's origins (D-P11-03).
- `StudioClient` on the pool; the authorizer's `audiences` gains it (D-P11-04).
- `artifact.createDownloadUrl`: the operation in `core`'s table (user principals
  only), the route, the signer, `s3:GetObject` on `artifacts/*` (D-P11-06).
- `reversalOf` and `mayReverse` in `core`, from the CLI (D-P11-08).
- `gatherReport` and `gatherDecisionGraph` in `core`, from `execution` (D-P11-07).
- Two stacks: `nightshift-<stage>-studio`, `nightshift-<stage>-studio-cert`
  (D-P11-02); `studio.<stage>` in `hostnames.ts`, and the Studio's own restatement
  of the rule, pinned by test as the CLI's is.

### 4.5 Documents

A-15 is superseded (A-15a: the Studio is built in P11, still a client);
`vision.md`'s "Do not build" and "After v1" lists, `AGENTS.md`'s layout note and
`architecture.md`'s layering diagram say `apps/studio` is built; O-02 is marked
resolved by D-P11-05.

## 5. Scope

### In scope

The Studio app; sign-in and sign-out; the pages in §4.2; polling; the
control-plane changes in §4.4; the two stacks and the deploy; the browser-safe
persistence entry and the read models' move to `core`; the layer table row; the
documents in §4.5; the proofs; the owner's trial.

### Out of scope

- Starting, cancelling or resuming a run; planning or running a correction.
  **Forward note (the owner, 2026-09-28):** the Studio will eventually plan.
  A browser never speaks MCP (A-27: the server is a stdio child of the agent
  that uses it), and planning reads a checkout, so planning from the Studio
  means starting a hosted session, an agent with its own MCP server and a
  checkout, which the Studio reaches through the control plane. That is P10's
  runner shape and follows it. Nothing in P11 may foreclose it.
- A push transport, notifications, or e-mail.
- Org administration: creating users, inviting, switching orgs, billing.
- Editing a plan, a contract or `nightshift.config.json` from the browser.
- Charts and analytics beyond the report's usage rows; the learned-routing
  dataset (`routes export`, P8).
- Anything remote (P10).

## 6. Success criteria

- **SC-P11-01** The hosted Studio signs a pool user in through `StudioClient`
  with PKCE, shows their email and acting org, refreshes the ID token without a
  new sign-in, and sign-out revokes the refresh token and clears the browser's
  storage. The local build does the same against the same control plane.
- **SC-P11-02** Projects are listed and selectable; a project shows its programs
  with plan status, ratification and pending prerequisites, and every run of
  each with status, start, end and outcome.
- **SC-P11-03** The run page shows, from the control plane alone and for a
  recursive parallel run: the complete execution tree; every agent with harness,
  provider, model and status; the timeline in sequence order; each job's routes,
  verifications (step, command, exit code, duration, log) and examinations
  (findings, evidence, questions, rulings); strands, criteria and pending
  prerequisites; usage and cost with estimates and unpriced routes marked; the
  decision graph. (SC-18.)
- **SC-P11-04** A run under way is observed from the page without a reload: an
  event numbered while the page is open appears, and the records it names
  update, within one poll interval plus the materializer's latency. (SC-17.)
- **SC-P11-05** A transcript, a verification log and an examination report open
  from the run page through a signed URL; a request for one with an execution
  token is refused.
- **SC-P11-06** The org's routing and examination policy is edited and saved
  with the version it was read at; a save over a newer version is refused and
  shown, and the deployed API behaves the same.
- **SC-P11-07** A decision reversed from the Studio is byte-for-byte the record
  `nightshift decision reverse` writes for the same inputs, the graph shows the
  reversal, and the next step is shown; reversing a reversal is refused.
- **SC-P11-08** The deployed API answers preflight from the Studio's origins and
  grants nothing to another origin.
- **SC-P11-09** `npm run synth` includes both Studio stacks; after `npm run
  deploy` the hosted URL serves the app and a `config.json` naming the stage's
  API, auth domain and client id.
- **SC-P11-10** The pages are proven against the memory stores with the P6 … P9
  fixtures; the P1 … P9 suites pass; the architecture rules cover `apps/studio`
  and refuse it a reference to `execution` or any harness. Nothing weakened.

**Exit gate**

- **SC-P11-11** Live: `npm run studio:smoke` against the deployed stage (the
  hosted app and config, preflight, a signed download).
- **SC-P11-12** The owner's own: a real program run on a repository of the
  owner's choosing watched in the hosted Studio from start to end, the run page
  read, a decision reversed from it. The build agent does not run it.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
```

The root scripts gain the Studio's build and tests so `verify` covers them on
both CI legs. From a developer machine: `npm run deploy`, `npm run smoke`,
`npm run studio:smoke`.

## 8. Constraints

- The Studio holds no AWS credential and reads no table or bucket directly
  (A-28); every read and write is a route the authorizer and `authorize` allow.
- No logic that belongs to the control plane moves into the browser: the Studio
  renders records and read models, and writes only what D-P11-10 lists.
- The refresh token goes into `localStorage` and nowhere else (D-P11-04).
- Human authority is unchanged: a reversal from the Studio is a human decision
  because the caller is a user principal, never because the page says so.
- Nothing stateful in the Studio stacks; the data stack is untouched but for the
  app client.
- P1's transition table, the engine and the merge queue are not changed.

## 9. Permissions and forbidden actions

Permitted: editing the repository; bootstrapping `us-east-1` for the CDK
toolkit; deploying every stack; registering the local origin on the Studio
client; running the smoke suites. SC-P11-12's trial is the owner's.

Forbidden:

- Adding a route the `authorize` table does not name, or a cell for an
  execution token.
- Any `s3:*` grant to the API role beyond `GetObject` on `artifacts/*`.
- Rewriting, force-moving or deleting any ref, or pushing.
- Weakening the P1 … P9 suites or the architecture rules.
- Inspecting the legacy Nightshift's branches or tags.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | A browser can be a client: the browser-safe persistence entry; the report and decision graph in `core`; `reversalOf` in `core`; the layer table row; the `apps/studio` workspace with sign-in, the shell, projects and the user | — | — |
| T2 | The control plane and the stacks: CORS, `StudioClient` and the authorizer's audiences, the download URL route and grant, the two Studio stacks with `config.json`, hostnames, the deploy; `npm run smoke` green | — | AWS |
| T3 | Project, programs, runs and settings pages; the org config editor with its version check | T1 | — |
| T4 | The run page: the report's views, the tree and agents, the timeline with polling, verifications, examinations, routes, artifacts through signed URLs | T1, T2 | — |
| T5 | Decisions: the graph, a decision's page, reversal from the Studio and the next step; the CLI on the shared builder | T4 | — |
| T6 | Proofs against the memory stores and the fixtures; `studio:smoke`; the document sweep (§4.5); as-built; ready for the owner's trial | T3, T5 | AWS |

```text
T1 ──┬── T3 ──────────┐
     └── T4 ── T5 ────┴── T6
T2 ──────┘
```

Specs live in `tasks/p11-studio/`.

## 11. Risks

| Risk | Handling |
|------|----------|
| The cross-region certificate makes the studio stacks awkward to synth or deploy | Both Studio stacks carry an explicit region; synth stays credential-free; if CDK's cross-region references misbehave, the certificate ARN is passed by context and the plan is amended in §12, never by hand-editing a stack |
| A browser bundle drags Node modules out of `persistence` | The browser entry is bundled in CI (`vite build`) and fails the build on a Node import; the split is a package export, not a bundler rule |
| Polling a long run reads a lot of events | The cursor is dense and monotonic; only events after it are read, and the records re-read are the ones named. The page stops polling when the run settles |
| Rendering the report needs every record of a run on first load | The same reads `nightshift report` makes today; measured on the tree fixture in T6, and paginated by node if it shows |
| The refresh token in the browser | `localStorage` on the Studio's own origin only, revoked on sign-out; the pool's refresh validity is the ceiling; the CLI's rule against echoing it holds in the Studio's errors too |
| A reversal from a click is easier than from a terminal | The page shows the decision's alternatives and `produced` commits first, asks for the new choice and the reason (both required, as the CLI requires them), and records it as the CLI would; nothing else moves (D-P9-02) |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-28 | **Built.** T1 … T6 on `program/p11-studio`, T2 in a worktree beside T1 and merged; deployed; `smoke`, `studio:smoke`, `verify` green. The build decisions of §13 are provisional until the owner ratifies or reverses them. SC-P11-01's hosted sign-in and SC-P11-04's live half need a signed-in browser and are the first steps of the owner's trial (SC-P11-12). | Agent, for human ratification |
| 2026-09-28 | **T2's build decisions, provisional until the owner ratifies or reverses them.** (1) **The API role's second S3 read is `proj_*`, not `artifacts/*`**: artifact bodies live at `<projectId>/<programId>/<runId>/<artifactId>` (D-P2-08), so the literal prefix in D-P11-06 and §9 named no object; `proj_*` is the bodies and nothing else, `plans/*` excluded by construction, both pinned by test. D-P11-06 and §9 read accordingly. (2) **The certificate stack takes the zone id by context** (`hostedZoneId`, defaulted in `cdk.json`), because CloudFormation exports are regional and `us-east-1` cannot import the `us-west-2` DNS export; §11 anticipated this. (3) **One anonymous route, `OPTIONS /{proxy+}`**: found live, `$default` matched preflight and answered 401, which a browser rejects; the gateway now answers 204 with no authorizer, the stack test names it as the only exception, and the Lambda answers a stray OPTIONS 204 before looking for a principal. | Agent, for human ratification |
| 2026-09-28 | **Contract ratified.** D-P11-03, D-P11-06, D-P11-07, D-P11-08 and D-P11-10 agreed as written after the owner walked the other five. The owner's forward note on planning from the Studio recorded in §5. Task specs T1 … T6 written. | **Human** |
| 2026-09-28 | **D-P11-04 and D-P11-09 ratified**: a second app client for the Studio; React, Vite, TanStack Query, Router, Tailwind. Next.js on OpenNext/SST considered and deferred until there is a reason to switch. `studio.` confirmed as the subdomain. | **Human** |
| 2026-09-28 | **D-P11-02 ratified**: S3 behind CloudFront on `studio.<stage>`, the certificate stack in `us-east-1`. A marketing site later takes the apex or `www`, its own record and stack. | **Human** |
| 2026-09-28 | **D-P11-01 ratified, reworded on the owner's question**: the Studio is hosted only; running it from the Nightshift repository is for developing the Studio, with the localhost callback on the `dev` client alone. | **Human** |
| 2026-09-28 | **D-P11-05 ratified**: polling the event cursor; no push transport for now. O-02 is resolved for v1. | **Human** |
| 2026-09-28 | Contract drafted from the owner's direction (§3.1) and the code: ten decisions proposed for ratification, O-02 resolved by D-P11-05, the Studio built as a client (A-15 to be superseded). | Agent, for human ratification |

## 13. As built

Built 2026-09-28 on `program/p11-studio`, T1 … T6, with T2 built beside T1 in a
worktree of its own and merged.

### Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | **done** | `@nightshift/persistence/http/browser`; the report and decision graph in `core`; `buildReversal` in `core`; `apps/studio` with sign-in, the shell, projects |
| T2 | **done**, deployed | CORS, `StudioClient` (`5ouksqs8o9tnakehqnit7pumig` on `dev`), `artifact.createDownloadUrl`, `nightshift-dev-studio-cert` and `nightshift-dev-studio`, `npm run studio:smoke`; `us-east-1` bootstrapped once |
| T3 | **done** | the project page, organisation settings, project and policy settings |
| T4 | **done** | the run page, live by polling |
| T5 | **done** | the decision page and reversal |
| T6 | **done** | the document sweep (§4.5), the live battery below, this as-built; SC-P11-12 is the owner's |

### What was proven, and where

| SC | State | By |
|----|-------|----|
| SC-P11-01 | met offline; **hosted sign-in is the owner's first step** | `auth/session.test.ts` (PKCE, state checked, only the refresh token stored, refresh near expiry, sign-out revokes and clears), `auth/oauth.test.ts`, `auth/pkce.test.ts` (the RFC 7636 vector). The hosted flow needs a human at the hosted UI; the build agent cannot sign in. `studio:smoke` proves the hosted app, its `config.json` and the client id it names |
| SC-P11-02 | met | `pages/project.test.tsx`: programs with plan state, ratification and a pending prerequisite's remediation; runs across two programs, latest first, with duration and outcome; the name edited and written back |
| SC-P11-03 | met | `pages/run.test.tsx`: the tree, agents with harness and model, jobs with verifications (step, command, exit code, duration, log), criteria, checkpoints, the timeline in sequence order narrated, the decision graph with alternatives and produced commits; the report's views over `gatherReport` (P7 … P9's own suites hold the computation) |
| SC-P11-04 | met offline; **live half is the owner's** | `pages/run.test.tsx` "follows a live run": a node delegated and started while the page is mounted appears in the timeline and the tree within one poll interval, over the memory stores. Live, watching a run needs a signed-in browser (SC-P11-01) |
| SC-P11-05 | met, **live** | `pages/run.test.tsx` opens a verification log through the signed URL; `studio:smoke` phase 3: an artifact uploaded, a download URL issued, the bytes read back, an unrecorded artifact refused, an execution token refused |
| SC-P11-06 | met | `pages/settings.test.tsx`: the examination policy and a ladder edited and saved as version 1; a save over a newer version refused and shown; an unparseable draft shown. The deployed API's version check is P8's (`npm run smoke`) |
| SC-P11-07 | met | `pages/decision.test.tsx`: the record written from the page is deep-equal to `buildReversal`'s for the same inputs, which is what the CLI writes (`test/src/cli/decision.test.ts`, `ruling.test.ts`, unchanged); the next step shown; a reversal of a reversal refused by `whyNotReversible` (`core`'s `decisions.test.ts`) |
| SC-P11-08 | met, **live** | `studio:smoke` phase 2: preflight granted to both Studio origins with the bearer client's methods and headers; nothing granted to another origin; a real request answered with the origin echoed. The stack test pins the origin list per stage |
| SC-P11-09 | met, **live** | both Studio stacks in `synth`; deployed; `https://studio.dev.nightshift.wildorder.dev` serves the app and a `config.json` naming the stage's API, auth domain and client id (`studio:smoke` phase 1) |
| SC-P11-10 | met | the Studio's 27 tests over the memory stores; `npm run verify` 3,202 tests; `check:architecture` with the `apps/studio` row and its negative fixture. Nothing weakened |
| SC-P11-11 | met, **live**, 2026-09-28 | `npm run studio:smoke` 10 of 10 after the deploy that serves the real app; `npm run smoke` 90 of 90 |
| SC-P11-12 | **the owner's** | below |

### The live battery, 2026-09-28

After T2 merged: `npm run deploy` (five stacks; the Studio stack now serves
`apps/studio/dist` instead of the placeholder), `npm run smoke` 90 of 90,
`npm run studio:smoke` 10 of 10, `npm run verify` green (3,202 tests),
`npm run check:architecture` green. `curl` of the hosted root answers the app's
`index.html`; `/config.json` names `api.dev`, the pool's hosted domain and
`5ouksqs8o9tnakehqnit7pumig`; a deep link answers the page.

### For the owner's trial (SC-P11-12)

1. Open `https://studio.dev.nightshift.wildorder.dev` and sign in with the pool
   user you use for `nightshift login`. You land on your projects.
2. From a terminal, start a program run on a repository of your choosing
   (`nightshift run <program>`, or `/run-program`), then open the project in the
   Studio and the run from its table: the header says *live · following the run*
   and the timeline advances a few seconds behind the terminal.
3. When it ends, read the run page: strands and jobs, verifications, cost, the
   decision graph. Open a transcript or a verification log.
4. Pick a close call in the decision graph, open it, and record a reversal with
   your choice and reason. Then, from the terminal, `nightshift decision brief
   <program> <decisionId> --run <runId> --out docs/programs/<fix>/brief.md` and
   ask `plan-program` to plan the correction from it.
5. Settings: read the organisation's policy; change one thing and save; note the
   version climbs. Open the project's settings for the contract's policies.

Look for: what the run page does not say that you wanted to know; anything the
timeline narrates badly; whether the reversal form asked enough.

### Build decisions, provisional until the owner ratifies or reverses them

1. **The browser entry is a subpath, `./http/browser`, not a split of `./http`.**
   T1's spec had `./http` become browser-safe and the Node parts move to
   `./http/node`; that renames the import in forty files for no gain. The
   guarantee the spec wanted (a bundler sees no `node:` import) is the same, and
   is held by `browser-entry.test.ts` over the new entry.
2. **The Studio typechecks itself.** The Node-wide typecheck program excludes
   `apps/studio`: it needs the DOM lib and JSX, and one program cannot have
   per-file libs. `npm run typecheck` runs both.
3. **jsdom is pinned to 29.1.1.** 30.x requires Node ≥ 22.22.2; the owner's
   machine and `.node-version` (22) may resolve lower.
4. **The organisation editor is forms for the examination policy and the
   ladders, JSON for rules, unavailable routes and prices.** T3's spec said
   forms with a JSON view beside; the three JSON parts are where a form buys
   least and validation by schema catches the same mistakes.
5. **The timeline's phrasing is restated in the Studio** (`lib/narrate.ts`)
   from `apps/mcp/src/activity.ts`, not imported: an app may not import another
   app. A shared home in `core` is the proper fix and is left for when a third
   reader appears.
6. **The brief command shows `<program>` as a placeholder.** The CLI names a
   program by its directory under `docs/programs/`, which the control plane does
   not know; the page says which contract the directory must name.
7. **`reversalOf` and `mayReverse` are `buildReversal` and `whyNotReversible`.**
   The CLI already had a private `reversalOf` meaning "the reversal of", and a
   boolean would have lost the message the CLI prints.
8. **A reversal recorded elsewhere between the page's read and its save is not
   a refusal.** The CLI refuses only a reversal of a reversal; the Studio does
   the same, writes the owner's word, and shows the latest. Both records stand.

### What changed in earlier programs' suites, and why

Nothing was weakened.

- **P7 … P9**: `gatherReport`, `renderReport`, `DEPARTURE_PREFIX` and the
  decision graph import from `@nightshift/core` where they imported from
  `@nightshift/execution`; `packages/execution/src/report.test.ts` moved with
  them, unchanged. `unattended.test.ts` and `correction.smoke.ts` changed only
  their import.
- **P9** `apps/cli/src/commands/decision.ts` builds the reversal through
  `buildReversal`; `test/src/cli/decision.test.ts` and `ruling.test.ts` pass
  unchanged, which is SC-P11-07's first half.
- **P3** `session/tokens.ts` re-exports `tokenClaims` and `tokenExpiry` from
  `claims.ts`; its tests pass unchanged.
- **P1** the layer table gains `apps/studio`; the negative fixture gains the
  Studio referencing `execution`.
