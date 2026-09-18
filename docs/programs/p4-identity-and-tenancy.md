# Program P4 — Identity and Tenancy

| Field | Value |
|-------|-------|
| Program ID | `p4-identity-and-tenancy` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p4-identity-and-tenancy` |
| Source stage | none. Inserted at the 2026-09-16 restaging (`staging.md`); the source plan deferred multi-user identity to after v1, and the owner pulled it into v1 as a problem to solve now. |
| Status | **Closed 2026-09-17.** Contract ratified 2026-09-16 (D-P4-01 … D-P4-08); T1 … T6 complete; deployed, smoke green twice, slice green on both harnesses. As built in §12. |
| Depends on | P3 First Vertical Slice (complete, `v1` at `7627045`) |
| Blocking decisions | none open in `architecture.md` §3. Amends A-19, A-21 and A-27. |

This contract is the stable authority for P4. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §11.

## 1. Objective

Make Nightshift safe for a second user before there is one. After P4, a caller's
organisation is a fence rather than a label, a worker holds a credential that
can do exactly its job and nothing else, and "nothing executes without a
Nightshift execution identity" (A-04) is something the control plane refuses to
violate rather than something our code happens to do. The exit gate is a second
Cognito user in a second organisation who cannot see, write to, or execute in
the first user's project, and a worker whose token cannot do anything but its
four operations on its own node.

## 2. Why now, and what was wrong

P2 built authentication correctly for the wrong scope. It conflated two things
that A-25 already named as separate worlds: *who is calling Nightshift* and
*what a running agent may do*. Three consequences are visible today:

1. **A worker holds the operator's identity.** A worker's MCP server reads the
   operator's refresh token from disk because it runs as the same OS user.
   D-P3-01 recorded this as a non-guarantee (A-27). With two users, a worker
   acts as whichever human launched it, with all that human's authority.
2. **Orgs are a label.** A-21's non-guarantee: any authenticated caller can read
   any project by id. The acting org is resolved only to create and list
   projects.
3. **A-04 is not enforced by the API.** Every agent record exists before its
   process starts because the execution layer is written that way, not because
   the control plane would refuse a caller who skipped it.

The pieces are all present: Cognito issues user identity, the table holds users,
memberships and orgs, and every record carries its ownership chain. What is
missing is the second identity kind and the checks.

## 3. Ratified decisions

Ratified by the human on 2026-09-16. The lasting ones are recorded in
`docs/architecture.md` as A-33 … A-36; A-19 carries its amendment, and the
A-21 and A-27 non-guarantees carry their closing pointers.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P4-01 | **Two principal kinds.** A request is made by a **user** (a Cognito token: a human through the interactive client, or a machine through the client-credentials grant) or by an **execution** (a Nightshift-issued token bound to one agent, one node and one run). The authorizer decides which, and the handler receives a typed `Principal` and never a raw claim set. | Naming the two kinds is what stops them being conflated again. Every authorisation rule in `core` is written over `Principal`, so the rule is testable without a token in sight. |
| D-P4-02 | **Org isolation is enforced on every project-scoped route.** A user principal's acting org is resolved as P2 defined it; the target project's `orgId` must match, or the request is refused with 403 **before any record is read**. Project creation assigns the caller's org, as today. The project→org lookup is cached per function instance with a short TTL. A-21's non-guarantee is retired and A-23 stays: isolation lives in the application. | The check A-21 said would be needed "when separation is needed". Its cost, one cached read, was priced there. |
| D-P4-03 | **Execution tokens.** When the control plane stores an `Agent`, it can mint an execution token for it: a JWT signed with an asymmetric KMS key Nightshift owns, carrying the ownership chain, the node, the agent, the role and an expiry no later than the cost policy's wall clock (default eight hours). Minting is a route only a user principal who may act for that run can call. Tokens are never persisted; the KMS key lives in the data stack and is retained. | A credential scoped to one agent is what A-04 means when it says "execution identity". KMS signing keeps the private key out of every process Nightshift runs. |
| D-P4-04 | **The Nightshift authorizer** replaces API Gateway's built-in JWT authorizer: one Lambda authorizer that validates a Cognito token against the pool's JWKS or an execution token against the KMS public key (both cached), and passes the typed principal to the handler. Every route still requires the authorizer; none is anonymous. **A-19 is amended**: the gateway still rejects a bad token before the handler runs, and the handler still contains no verification code, but the verifying code is now Nightshift's, in one function. | The built-in authorizer accepts one OIDC issuer. Two token kinds means either two issuers (Nightshift becoming an OIDC provider with a public JWKS) or one small function. The function is smaller and keeps the API's public surface unchanged. |
| D-P4-05 | **Authorisation rules in `core`.** `authorize(principal, operation, target)` is a pure table: a user may do anything within their org; an execution may read its own run, and write only its own node's progress, completion, failure and decisions, plus the events those produce. An execution cannot create a node, an agent, a run, a verification, a checkpoint or a routing decision, and cannot read another run. Refusals are typed, and the API maps them to 403. | Making a worker's reach a table in `core` means the property "a worker can do exactly four things" is a unit test, not an audit. |
| D-P4-06 | **Workers hold only an execution token.** The execution layer mints the token when it creates the agent and passes it in the worker's environment; the worker MCP role refuses to start without one and never reads `credentials.json`. Harness adapters pass the environment through unchanged, as they already must. The orchestrator's MCP server keeps using the operator's session in P4: the orchestrator is the human's proxy, and a remote orchestrator's token is P9's. | Closes A-27's non-guarantee for the party it matters for. Leaving the orchestrator on the human's session keeps human authority highest and keeps P4 bounded. |
| D-P4-07 | **A second test principal.** The data stack gains a second machine app client, for the smoke suite only, so the deployed control plane can be proven with two principals in two orgs without a human typing a password. The offline suite proves the same matrix through the local control plane with fixed claims. | Interactive users cannot obtain tokens non-interactively (P3 §13.4), and an isolation proof that only runs offline is half a proof. |
| D-P4-08 | **A-26 is re-examined, not changed.** Its trigger was "the moment a second tenant exists". Nothing secret is stored yet: cross-account external IDs are not secrets by AWS's own definition, and no provider API key exists because O-05 is open. The trigger arms the day one is stored, and P9 owns that. | Checking the trigger is the honest response to it firing; changing a storage design with nothing in it is not. |

### Non-guarantees, stated

- **The orchestrator still acts as the human** in P4. A worker cannot widen
  its reach; the orchestrator's MCP server holds the human's session by
  design. P9 gives remote orchestrators execution tokens.
- **Membership is administered by the operator**, by script. No route creates a
  user, an org or a membership.
- **An execution token is bearer.** Whoever holds it is that agent until it
  expires. It is never written to disk by Nightshift; an adapter or harness that
  logs its environment would leak it, and the brief tells workers not to print
  their environment.

## 4. Design

### 4.1 Principals

```text
Principal =
  | { kind: "user";      userId; orgId }                        from a Cognito token
  | { kind: "execution"; projectId; programId; runId; nodeId; agentId; role }  from a Nightshift token
```

The authorizer produces it; `core`'s `authorize` consumes it; the handler
threads it. `orgId` on a user principal is the acting org P2 resolves
(`custom:active_org`, else the only membership).

### 4.2 The authorizer

```text
Authorization: Bearer <token>
        │
        ▼
Nightshift authorizer (Lambda)
   ├─ header says iss = Cognito pool  → verify against the pool's JWKS (cached) → user principal
   ├─ header says iss = Nightshift    → verify signature with the KMS public key (cached),
   │                                     check exp, kind, chain → execution principal
   └─ anything else                  → 401
        │
        ▼
handler receives { principal } in the request context; no verification code of its own
```

The Cognito pool, client ids and issuer are the P2 ones. The KMS key is
asymmetric (RSA-2048 or ECC P-256, chosen in T2), sign/verify, in the data stack
with `RemovalPolicy.RETAIN` and an alias `nightshift-<stage>-execution-tokens`.
The API function may `kms:Sign` with it; the authorizer may `kms:GetPublicKey`.

### 4.3 The execution token

```text
{ iss: "https://api.<stage>.nightshift.wildorder.dev",
  sub: "<agentId>",  aud: "nightshift-api",
  nightshift: { kind: "execution", projectId, programId, runId, nodeId, agentId, role: "worker" },
  iat, exp }
```

Minted by `POST …/runs/{runId}/agents/{agentId}/token`, callable by a user
principal whose org owns the project, for an agent in `created` or `started`.
Expiry is `min(costPolicy.maxWallClockSeconds, 8h)`. Returned once, never
stored.

### 4.4 What each principal may do

| Operation | User (own org) | Execution (own node) | Execution (other node or run) |
|-----------|----------------|----------------------|-------------------------------|
| Create or read project, program, run | yes | read own run only | no |
| Create node, agent, routing decision, checkpoint, verification | yes | **no** | no |
| Mint an execution token | yes | no | no |
| Read own node, job, agent | yes | yes | no |
| Node `report_implemented`, `fail`, progress events, decisions on own node | yes | yes | no |
| Append `mcp`-sourced events for own node | yes | yes | no |
| Anything in another org | **no** | no | no |

The table is `authorize` in `core`; the API applies it in one place before
dispatching to an operation.

### 4.5 The worker's environment

The seven identity variables of P3 §4.2 stay. `NIGHTSHIFT_EXECUTION_TOKEN` is
added and `NIGHTSHIFT_CONFIG_DIR` is no longer passed to a worker. The worker
role's `compose` builds its transport from the token and nothing else. The
scripted harness and the Claude adapter need no change beyond passing the
environment through, which they already do.

## 5. Scope

### In scope

- `core`: `Principal`, `authorize`, the execution-token claim schema, and the
  scope rules.
- `contracts`: the principal and token shapes; the mint route's body and response.
- `apps/api`: the authorizer function; principal threading; org enforcement on
  every project-scoped route; the mint route; the KMS signer; per-instance
  caches.
- `infra/cdk`: the KMS key (data stack, retained); the authorizer function and
  its wiring in place of the JWT authorizer; the second machine client; IAM for
  sign and verify; assertion tests, including "every route carries the
  Nightshift authorizer and none is anonymous".
- `packages/execution`: minting the worker's token at agent creation; the
  environment.
- `apps/mcp`: the worker role's transport from the token; refusal to start
  without it.
- `packages/persistence/http`: a token provider over a static execution token
  (exists as `staticTokenProvider`; confirm and reuse).
- `apps/api/src/admin`: the bootstrap script creates a user in a named or new
  org, and the smoke suite seeds two machine principals in two orgs.
- Suites: the offline two-principal matrix through the local control plane;
  the worker-token matrix; the smoke suite's live halves.
- Docs: A-19 amended, A-21 and A-27 non-guarantees retired, A-33 … A-36 added
  on ratification; `AGENTS.md` short form.

### Out of scope

- Execution tokens for orchestrators (P9), or any remote principal.
- Any route that creates users, orgs or memberships.
- Rate limiting, audit logging beyond the events already written, or a
  console for identity.
- Changes to the key schema. `orgId` stays only on `Project`, resolved through a
  cache, as A-21 priced.
- Secrets storage (D-P4-08).

## 6. Success criteria

**Isolation**

- **SC-P4-01** A user in org B, holding a valid token, receives 403 for every
  project-scoped route against a project in org A: read, write and list.
- **SC-P4-02** A user in org B cannot mint an execution token for an agent in
  org A's run.
- **SC-P4-03** Listing projects returns only the caller's org's projects.

**Execution identity**

- **SC-P4-04** A worker's token can perform exactly the operations in §4.4 on
  its own node and is refused every other operation, including creating a
  node, writing another node, reading another run, and minting a token.
- **SC-P4-05** A request with no token, an expired execution token, an
  execution token signed by another key, or a token for a deleted agent is
  rejected by the authorizer, never by the handler.
- **SC-P4-06** The worker MCP server reads no credentials file: the offline
  suite plants one and proves it unread, and the worker's environment carries
  no `NIGHTSHIFT_CONFIG_DIR`.
- **SC-P4-07** The complete P3 slice, offline and deployed, still passes with
  workers on execution tokens.

**Structure**

- **SC-P4-08** `authorize` is a pure table in `core` with an exhaustive test
  over principal kind × operation, and the API calls it in exactly one place.
- **SC-P4-09** Every route is bound to the Nightshift authorizer and none is
  anonymous (the P2 assertion, retargeted).
- **SC-P4-10** The handler contains no token verification code.

**Exit gate**

- **SC-P4-11** Against the deployed stack, two machine principals in two orgs
  run the isolation matrix live; a real Claude worker completes the P3
  fixture job holding only an execution token; the smoke suite passes.

## 7. Deterministic verification

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm test                 # includes the two-principal and worker-token matrices, offline
npm run synth
npm run check:sterility
npm run check:architecture
```

Plus, with `AWS_PROFILE=nightshift`: `npm run deploy`, `npm run smoke`,
`npm run slice`.

### 7.1 The isolation suite (T5 deliverable 4)

`npm run smoke` runs two files, in this order: the P2 suite, then
`p4-isolation.smoke.ts`. The second seeds two machine principals in two
throwaway organisations — the operational machine client as **A**, the
`TestPrincipalClient` of D-P4-07 as **B** — creates A's project, program, run,
node, job and agent as A, and then asserts this table. A reader should be able
to check each row against the suite's printed output.

| # | Assertion | Criterion |
|---|-----------|-----------|
| 1 | Two principals hold real Cognito tokens, in two organisations | D-P4-07 |
| 2 | A is refused nothing on its own project: no route answers 403 | — |
| 3 | B is refused **every** project-scoped route of A's project, with `wrong_org` | SC-P4-01 |
| 4 | `GET /projects` shows A its project and B none of A's | SC-P4-03 |
| 5 | A mints an execution token; it verifies against the deployed KMS key's public half | D-P4-03 |
| 6 | B cannot mint a token for A's agent | SC-P4-02 |
| 7 | The minted token reads its own run, node, job and agent | SC-P4-04 |
| 8 | The minted token is refused every operation §4.4 withholds, with `execution_forbidden_operation` | SC-P4-04 |
| 9 | The minted token is refused a node that is not its own, with `execution_out_of_scope` | SC-P4-04 |
| 10 | No token, an unreadable token, a foreign-signed token and an expired token are all 401 from the authorizer | SC-P4-05 |
| 11 | Every record both organisations wrote is removed, including after a failure | A-18 |

Row 3 walks the same route list as rows 2 and 8, built once from A's world, so a
route added without an authorisation decision appears in all three.

The offline halves of rows 3 … 9 are `apps/api/src/isolation.test.ts` (the
§4.4 matrix over every route, four callers) and `test/src/mcp/worker-token.test.ts`
(the real worker MCP server on a real minted token). They run in `npm test`,
with no credentials and no network beyond loopback.

## 8. Constraints

- No verification code in the handler; the authorizer is the one place tokens
  are checked, and `authorize` in `core` is the one place a principal's reach is
  decided.
- The private key never leaves KMS. No process holds it; the API signs by
  calling KMS.
- A worker's environment carries a token and an identity and nothing that could
  yield a human's credential.
- `npm test` stays free of credentials and non-loopback network; the authorizer
  is tested with locally generated keys and a fake JWKS.
- Every route's authorisation is declared beside the route, not inferred.

## 9. Permissions and forbidden actions

Permitted: editing the repository; deploying both stacks; running the smoke and
slice suites; creating the second machine client and test principals; running
the bootstrap script for test users.

Forbidden:

- Storing an execution token anywhere durable.
- Adding a route without the authorizer, or any route that bypasses `authorize`.
- Weakening the P1, P2 or P3 suites; the slice suite must pass unchanged with
  workers on tokens.
- Settling O-02, O-03, O-05 or O-06.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Principals and the authorisation table in `core` | — | — |
| T2 | The KMS key, the signer, and execution-token minting | T1 | AWS at deploy |
| T3 | The Nightshift authorizer and principal enforcement in the API | T1, T2 | — |
| T4 | Workers on execution tokens | T2, T3 | — |
| T5 | The second principal, the bootstrap script, and the isolation suites | T3 | AWS at deploy |
| T6 | Deploy, the live two-principal proof, as-built | T4, T5 | AWS, Claude Code |

```text
T1 ── T2 ── T3 ──┬── T4 ──┐
                 └── T5 ──┴── T6
```

Specs live in `tasks/p4-identity-and-tenancy/`.

## 11. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-16 | Program inserted at the restaging; contract drafted; D-P4-01 … D-P4-08 proposed; tasks T1 … T6 drafted | Agent, for human ratification |
| 2026-09-16 | **Contract ratified**, D-P4-01 … D-P4-08 as drafted, after the owner's review of the restaging. Recorded as A-33 … A-36. | Human |
| 2026-09-18 | **Defect found in review after the merge, fixed directly on `v1`.** `node.put` was `own_node` for an execution, and nothing limited which status the request asked for, so a worker's token could move its own node to any status `core`'s table allowed: `verifying`, `cancelled`, `interrupted`, back to `queued`. Never `verified`, which needs a `Verification` it cannot write, so A-05 held and no unverified work could integrate; but D-P4-05 grants a worker its node's *completion and failure* and nothing else, and the comment beside the table claimed exactly that while nothing enforced it. `authorize` now takes the requested status and refuses an execution anything but `implemented` or `failed`, fail-closed on a missing status; `enforce` reads it from the body for `node.put` only. The 260-cell matrix missed it because it is keyed by operation, and this was a question about what a permitted operation may contain (§12.5, item 4). | Human and agent |
| 2026-09-17 | T1 … T6 implemented and deployed. RSA-2048 / RS256 chosen for the signing key (§12.2). Three departures recorded in §12.6, none of which revises a ratified decision. Three defects found only by the live run (§12.5). Exit gate met: SC-P4-11 green. | Agent |

## 12. As built

Closed 2026-09-17. Six tasks, all complete; both stacks deployed to `dev`; the
smoke suite green twice; the slice green on both harnesses.

### 12.1 Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | Complete | `Principal`, `Operation` (41 members), `authorize`; 260 assertions |
| T2 | Complete | RSA-2048 key, signer, verifier, mint route; offline tests sign with a local key pair through the same code path |
| T3 | Complete | Lambda authorizer, `enforce`, principal threading, the offline matrix (181 assertions) |
| T4 | Complete | Minting at agent creation, worker transport from the token alone, the credential paragraph in the brief |
| T5 | Complete | `TestPrincipalClient`, `--org new`, the live isolation suite |
| T6 | Complete | This section |

### 12.2 The key type, and why (T2 deliverable 1)

**RSA-2048, signed as `RS256`**, asymmetric sign/verify, alias
`nightshift-dev-execution-tokens`, `RemovalPolicy.RETAIN`, in the data stack.
Rotation is not applicable: KMS does not rotate asymmetric key material.

ECC P-256 / `ES256` was the alternative. Both are KMS key specs and Node 22
handles both natively, so library support decided nothing. Three things did:

1. **Verification is the hot path.** The authorizer verifies on every request
   that is not served from the gateway's decision cache; minting happens once
   per agent. RSA verification with the standard public exponent is markedly
   cheaper than ECDSA P-256 verification, and ECC's advantage is on the side
   Nightshift does rarely. The KMS round trip dominates signing whatever the key
   type.
2. **No signature transcoding.** KMS returns an ECDSA signature DER-encoded, as
   a SEQUENCE of two INTEGERs; JOSE's `ES256` wants fixed-width raw `r‖s`.
   Converting means handling leading zeros and short integers correctly — code
   that is wrong only in rare cases, which is the worst failure shape a
   signature can have. `RS256`'s signature is already the bytes JOSE wants.
3. **The cost is a longer token**: 256 signature bytes rather than 64, so about
   256 more base64url characters in an environment variable and a header.

The reasoning lives in `apps/api/src/tokens/mint.ts`, beside the code that
depends on it.

### 12.3 Measured latency

The authorizer's own duration, from its log group over an hour of smoke traffic
(n = 62 invocations):

| | Duration |
|---|---|
| Warm (n = 33) | p50 **4.0 ms**, max 57 ms |
| Cold (n = 29) | up to **1.04 s**, including the first JWKS fetch and `kms:GetPublicKey` on that instance |

End to end, `GET /projects` with the operator's Cognito ID token against
`api.dev.nightshift.wildorder.dev`: **2.1 s** on the first call with both
functions cold, then **69–115 ms**.

Most requests never invoke the authorizer at all: API Gateway caches a decision
for `AUTHORIZER_CACHE_TTL` (5 minutes), keyed by the `Authorization` header. The
TTL is bounded deliberately — the cache is keyed by the token, so an unbounded
one would extend every token's life past its own expiry.

### 12.4 The live matrix (§7.1)

`npm run smoke` run twice, 81 assertions across two files, both clean, both
cleaning up after themselves. The P4 half reported:

```text
[p4-isolation] A: subject 1u3uvfmdjgju5golgjn9sjj2bg in org_…
[p4-isolation] B: subject d3j0q902aa1h8171692tuuic9 in org_…
[p4-isolation] the matrix covers 40 routes
[p4-isolation] B was refused all 40 routes with wrong_org
[p4-isolation] A minted a token expiring 2026-09-18T13:19:46.000Z
[p4-isolation] removed 12 items across both organisations
```

Every row of §7.1's table passed. The minted token was verified against the
deployed key's public half fetched with `kms:GetPublicKey`, which is the
assertion that the deployed signer and the deployed verifier agree rather than
merely both existing.

### 12.5 What the live run found that the offline one could not

Three, and the third is the reason SC-P4-11 is written as an exit gate rather
than a formality.

1. **The materializer could not start.** T2 added the token variables to the
   config schema `apps/api` shares between its functions, and the stack gives
   them to the API function only — deliberately, because the materializer signs
   nothing. So it threw `ConfigError` at cold start on every invocation and the
   stream backed up behind it. Twelve batches exhausted their retries; their
   events are durable but will never be numbered (A-22 readers tolerate that),
   and all of them belonged to throwaway smoke projects whose partitions the
   suite deleted. **The CDK assertion written in T2 encoded the bug**: it
   checked that the materializer does *not* carry the token variables, which was
   right and was not the question. Nobody checked that it could still load. Fixed
   by splitting `loadTokenConfig` out; a shared config schema holds the
   intersection of what its functions need, never the union.
2. **The authorizer did not accept the second machine client.** T5 added
   `TestPrincipalClient` to the pool but not to the authorizer's audience list,
   so every request B made came back as a bare gateway 403 with no body — which
   reads exactly like an authorisation bug. The offline matrix constructs
   principals directly and never meets an audience check, so no amount of
   offline testing could have found it. The assertion is now on the whole set:
   every `*ClientId` the data stack exports must appear in the audiences.
3. **The gateway's refusal codes moved.** `HttpJwtAuthorizer` answered 401 for
   both a missing and a bad token. A **request** authorizer distinguishes: a
   request with no identity source never reaches the function and is 401; a
   function answering `isAuthorized: false` is 403. Both refuse before the
   handler, which is what SC-P2-07 and SC-P4-05 claim, so only the code moved —
   and it is API Gateway's to choose, not Nightshift's. Both smoke suites name
   the two cases rather than sharing one number.

4. **A permitted operation was taken for a permitted content** (found
   2026-09-18, by review rather than by a run). SC-P4-04 says a worker's token
   does exactly what §4.4 grants, and the proof was a matrix over *operations*.
   `node.put` is one operation and fifteen statuses, and the gate let an
   execution ask for any of them on its own node. The transition table refused
   the illegal ones and the evidence rule refused `verified`, so the worst a
   worker could do was wedge or cancel its own job and have the record say
   Nightshift did it. That is still a worker asserting something only
   Nightshift may assert. Fixed in `core` (`EXECUTION_WRITABLE_NODE_STATUSES`),
   with all fifteen statuses walked offline, through the real worker token, and
   live. The lesson for P9, which widens execution tokens to orchestrators: for
   every write a token is granted, ask what the body may say, not only which
   route it may call.

### 12.6 Departures from the task specs

- **T3's note on the org cache** describes caching a miss ("delay a newly
  created project's first read by at most the TTL"). Misses are **not** cached.
  Remembering "no such project" leaves a window in which a project created in
  one organisation is invisible to the check, and every caller — including one
  in another org — sails past `enforce` and has the operation read the record
  for them. A miss costs one read and the operation reads anyway, so there is
  nothing to save and a boundary to lose. Written down in `auth/enforce.ts` and
  asserted.
- **"An execution cannot create a node" (D-P4-05) is enforced by scope, not by
  operation.** `node.put` is `own_node` rather than `forbidden`, because it is
  how a worker reports its own node implemented; a node it holds no token for is
  refused `execution_out_of_scope`. The outcome D-P4-05 names is delivered, by
  the narrower of the two mechanisms.
- **Two of a worker's three writes name their node in the body**, not the path:
  `POST …/events` and `PUT …/decisions/{id}` both hang off the run. `targetFrom`
  reads `executionNodeId` from the body where the path names no node, which
  keeps the decision inside `enforce` rather than letting those two routes check
  for themselves (SC-P4-08).
- **The authorizer routes on `iss` alone.** A first draft also fell back to the
  JWT header; both token kinds are RS256 JWTs, so that sent every Cognito token
  to the execution verifier. Each verifier re-checks the issuer itself, so a
  misrouted token is refused rather than mistaken for the other kind.

### 12.7 Success criteria

| # | Claim | Proven by |
|---|-------|-----------|
| SC-P4-01 | A user in org B receives 403 for every project-scoped route against org A's project | `isolation.test.ts` (40 routes, offline); `p4-isolation.smoke.ts` (40 routes, live) ✅ |
| SC-P4-02 | A user in org B cannot mint an execution token for an agent in org A's run | Both matrices ✅ |
| SC-P4-03 | Listing projects returns only the caller's org's | Both matrices ✅ |
| SC-P4-04 | A worker's token performs exactly §4.4 on its own node and is refused everything else | `authorize.test.ts` (260 cells), `isolation.test.ts`, `worker-token.test.ts` (through the real worker MCP server), `p4-isolation.smoke.ts` ✅ |
| SC-P4-05 | No token, an expired token, a foreign-signed token or one for a deleted agent is rejected by the authorizer, never the handler | `authorizer.test.ts` (19 cases offline), `p4-isolation.smoke.ts` (live) ✅ |
| SC-P4-06 | The worker MCP server reads no credentials file, and its environment carries no `NIGHTSHIFT_CONFIG_DIR` | `worker-token.test.ts` plants a valid session and proves the worker refuses to start without a token anyway; `compose.test.ts` asserts the environment's absences ✅ |
| SC-P4-07 | The complete P3 slice, offline and deployed, still passes with workers on execution tokens | `npm test` (2216 assertions); `npm run slice`, both harnesses ✅ |
| SC-P4-08 | `authorize` is a pure table in `core` with an exhaustive test, and the API calls it in exactly one place | `authorize.test.ts`; `enforce.ts` is the only caller and `handleRequest` its only caller ✅ |
| SC-P4-09 | Every route is bound to the Nightshift authorizer and none is anonymous | `api-stack.test.ts`, asserting each route names *this* authorizer rather than some authorizer ✅ |
| SC-P4-10 | The handler contains no token verification code | Verification lives in `tokens/verify.ts` and `lambda/authorizer.ts`; the handler receives a typed `Principal` ✅ |
| SC-P4-11 | Two machine principals in two orgs run the isolation matrix live; a real Claude worker completes the P3 fixture job holding only an execution token; the smoke suite passes | `npm run smoke` twice (81 assertions, clean both times); `npm run slice`, both harnesses, with the slice asserting the worker's own agent reported `node.implemented` as `source: "mcp"` ✅ |

### 12.8 How "the worker held only an execution token" is proven

The slice asserts the record half — `node.implemented` carries `source: "mcp"`
and names a stored worker agent on its own node, and that agent is not the
orchestrator's. An event's `agentId` is written by whoever appends it, so on its
own that says the worker reported, not what credential it held.

The credential half is structural, and it is the half that matters.
`createWorkerTransport` has no fallback — no profile, no credentials file, no
`??` — and throws `MissingExecutionTokenError` without a token. A worker that
reached the control plane at all therefore held a valid execution token, and its
environment carries neither `NIGHTSHIFT_CONFIG_DIR` nor `NIGHTSHIFT_API_TOKEN`
to have used instead. `apps/mcp/src/compose.test.ts` asserts those absences,
`test/src/mcp/worker-token.test.ts` proves the server refuses to start without a
token even with a valid operator session planted beside it, and the deployed
slice proves the whole path works against the real authorizer.

### 12.9 What P4 deliberately did not do

- The orchestrator still acts as the human (D-P4-06). P9 gives remote
  orchestrators their own tokens.
- No route creates a user, an org or a membership. The operator does that with
  `npm run admin:user`.
- A-26 was re-examined and not changed (D-P4-08): nothing secret is stored yet,
  and the trigger arms the day one is.
- An execution token is bearer. Nightshift cannot revoke one; it expires. The
  brief tells a worker never to print its environment, and no adapter logs one.
