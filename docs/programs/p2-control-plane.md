# Program P2 — Control Plane

| Field | Value |
|-------|-------|
| Program ID | `p2-control-plane` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p2-control-plane` |
| Source stage | Stage 2 (AWS Control Plane) |
| Status | Decisions ratified and tasks drafted 2026-09-13. Implemented 2026-09-14; deployed and smoke-tested 2026-09-15 (§13). Budget email delivery still to confirm. |
| Depends on | P1 Foundation (complete) |

This contract is the stable authority for P2. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Make centralized project and run state real, and prove it is isolated, before any
agent depends on it. After P2 there is an authoritative backend that exists and
behaves correctly with no agent execution anywhere near it.

## 2. Environment

Settled. One AWS account, no development account (A-17).

| Item | Value |
|------|-------|
| Account | `755348349819` (`nightshift-prod`) |
| Region | `us-west-2` |
| CLI profile | `nightshift`: IAM Roles Anywhere certificate `CN=tim-mac-agent` assumes role `nightshift-agent` (`AdministratorAccess`); no SSO login (D-P2-18) |
| CDK bootstrap | done, `CDKToolkit` v32, termination protection on |
| Deploys run from | a developer machine, not CI (D-P2-09) |
| Budget notifications | `tim+nightshift@wingitlabs.com` |

The account is treated as a sandbox until Nightshift is launched and supported.
It is nonetheless the only environment there is, which is why D-P2-07 splits the
stacks and A-18 drops teardown testing rather than pointing it at real data.

## 3. Ratified decisions

Ratified by the human on 2026-09-13 during a design review. The lasting ones are
also recorded as A-19 … A-24 in `docs/architecture.md`.

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P2-01 | Lambda behind an API Gateway HTTP API, **Cognito JWT authorizer**. Resolves **O-01**. | Reversed from IAM SigV4 on 2026-09-14 before implementation (A-19a). SigV4 would require every caller to hold an IAM identity in the Nightshift account — fine for one internal user, fatal for distribution. The gateway still rejects bad tokens before the handler runs, so there is still no auth code to write. |
| D-P2-13 | Tenancy comes from a **token claim**, never from the URL | A path segment that must match the token is redundancy you have to validate on every request. If the org cannot be expressed in the URL, a cross-org request cannot be formed. Matches how Stripe, Slack and AWS itself work. |
| D-P2-14 | Cross-account access to a project's AWS account is by role assumption with an external ID (A-25). P2 **reserves the fields, builds nothing.** | `Project` gains an optional role ARN and external ID so the shape exists before anything depends on it. Actually assuming roles is execution-layer work in P3 and later. |
| D-P2-15 | Secrets in DynamoDB plaintext for now (A-26) | Explicit risk decision. Single account, single user, all principals are admin already. Revisit before a second tenant or any non-admin principal exists. |
| D-P2-02 | One DynamoDB table, one GSI. On-demand capacity. | Every access pattern is chain-prefixed; a second table buys nothing. On-demand because the load is one user and bursty. |
| D-P2-03 | `PK` always begins with `projectId` | Makes a cross-project query structurally impossible instead of merely forbidden. This is the data-layer half of SC-P2-05. |
| D-P2-04 | Event sequence numbers are stamped **after** durability by a DynamoDB Streams consumer | Keeps `append` synchronous so the P1 port contract survives, and moves the fragile step somewhere a retry is harmless. A crash cannot burn a number. Readers must tolerate a briefly absent `sequence`. |
| D-P2-05 | A project belongs to an org. `Project` gains `orgId`; the ownership chain is unchanged. | `projectId` is a globally unique ULID, so project-scoped items need no org prefix to be unambiguous. Decided now because the *key namespace* is expensive to retrofit even though the attribute is not. |
| D-P2-06 | **Project** isolation is enforced in the application, not in IAM. Org separation is **not** enforced in v1 — see the A-21 non-guarantee in `docs/architecture.md` §2. | One user, and per-tenant IAM identities are not how multi-tenant products are usually built. Isolation lives in exactly one place. |
| D-P2-07 | Two stacks: `nightshift-<stage>-data` (stateful) and `nightshift-<stage>-api` (stateless) | The data stack carries termination protection and changes rarely; the API stack can be replaced freely. With one account that split is the only thing between a bad deploy and the data. |
| D-P2-08 | One S3 bucket, SSE-S3, versioning off, keys prefixed `<projectId>/<programId>/<runId>/…` | Mirrors the DynamoDB chain, so an artifact's ownership is legible from its key alone. Versioning off because artifacts are write-once. |
| D-P2-09 | Deploys run from a developer machine; CI stays credential-free | Faster, and it keeps the six-gate CI contract from P1 intact. Revisit via GitHub OIDC if it becomes tedious. |
| D-P2-10 | CloudWatch log retention 30 days. No alarms in P2. | Enough to debug a run, cheap, and alarms without an operator are noise. |
| D-P2-11 | Budget alarm notifies `tim+nightshift@wingitlabs.com` | Matters more with a single account than it would with a separate sandbox. |
| D-P2-12 | The smoke test is the P1 port conformance suite run against the deployed stack, plus live-only assertions, plus cleanup. Opt-in, never in `npm test`. | The conformance suite exists precisely so one suite covers both adapters. Keeping it out of `npm test` preserves the credential-free gate. |

## 4. Data design

### 4.1 Key schema

Single table. `PK` always begins with `projectId` (D-P2-03), with one ratified
exception: identity records (D-P2-17), which exist above any project.

| Entity | PK | SK |
|--------|----|----|
| User (T9, D-P2-17) | `USER#<sub>` | `META` |
| Membership (T9, D-P2-17) | `USER#<sub>` | `MEMBER#<org>` |
| Organisation | `ORG#<org>` | `META` |
| Org → project pointer | `ORG#<org>` | `PROJ#<proj>` |
| Project | `PROJ#<proj>` | `META` |
| Program contract | `PROJ#<proj>` | `PROG#<prog>` |
| Run | `PROJ#<proj>#PROG#<prog>` | `RUN#<run>` |
| Execution node | `RUN#<proj>#<prog>#<run>` | `NODE#<id>` |
| Job contract | `RUN#…` | `JOB#<id>` |
| Agent | `RUN#…` | `AGENT#<id>` |
| Decision | `RUN#…` | `DEC#<id>` |
| Checkpoint | `RUN#…` | `CKPT#<id>` |
| Verification | `RUN#…` | `VER#<id>` |
| Examination | `RUN#…` | `EXAM#<id>` |
| Routing decision | `RUN#…` | `ROUTE#<id>` |
| Artifact | `RUN#…` | `ART#<id>` |
| Event | `EVT#<proj>#<prog>#<run>` | `ULID#<eventId>` |
| Sequence counter | `EVT#…` | `COUNTER` |
| Idempotency marker (D-P2-17) | `EVT#…` | `IDEM#<idempotencyKey>` |

The idempotency marker is written in the same transaction as its event, with
`attribute_not_exists` on the marker, so a second submission carrying the same key
is refused by DynamoDB rather than by a read-then-write, even when it carries a
different `eventId`.

Events sit on their own partition deliberately. They are the only high-volume,
write-heavy items, and separating them keeps them from competing with state reads
and keeps the run partition well under the 10 GB per-key limit.

### 4.2 The one GSI, `gsi_node`

```text
GSI1PK = NODE#<proj>#<prog>#<run>#<nodeId>
GSI1SK = <TYPE>#<id>
```

Agents, verifications, examinations, routing decisions, decisions and artifacts
set it to their own node. Execution nodes set it to their **parent**, with
`GSI1SK = CHILD#<nodeId>`. One index therefore serves every `listByNode` method
and `listChildren`, and nothing else needs an index.

### 4.3 Access patterns

Every pattern below is an existing method on a `@nightshift/core` port. The port
interfaces are the contract; this table is how they are served.

| # | Pattern | Port method | Query |
|---|---------|-------------|-------|
| 1 | Get project | `projects.get` | `PK=PROJ#<proj>`, `SK=META` |
| 2 | List projects in an org | *(new in P2)* | `PK=ORG#<org>`, `begins_with PROJ#` |
| 3 | Get program contract | `programContracts.get` | `PK=PROJ#<proj>`, `SK=PROG#<prog>` |
| 4 | List programs in project | `programContracts.listByProject` | `PK=PROJ#<proj>`, `begins_with PROG#` |
| 5 | Get run | `runs.get` | `PK=PROJ#…#PROG#…`, `SK=RUN#<run>` |
| 6 | List runs in program | `runs.listByProgram` | `PK=PROJ#…#PROG#…`, `begins_with RUN#` |
| 7 | Get any run-scoped record | the nine `get`s | `PK=RUN#…`, `SK=<TYPE>#<id>` |
| 8 | List one type in a run | the five `listByRun`s | `PK=RUN#…`, `begins_with <TYPE>#` |
| 9 | List children of a node | `executionNodes.listChildren` | `gsi_node`, `GSI1PK=NODE#…#<parent>`, `begins_with CHILD#` |
| 10 | List everything attached to a node | the four `listByNode`s | `gsi_node`, `GSI1PK=NODE#…#<node>`, `begins_with <TYPE>#` |
| 11 | Append event | `events.append` | put `PK=EVT#…`, `SK=ULID#<id>` |
| 12 | Read events after a point | `events.listByRun` | `PK=EVT#…`, `SK > ULID#<cursor>` |
| 13 | Next sequence | `events.nextSequence` | `PK=EVT#…`, `SK=COUNTER` |

No pattern crosses a project, and no signature could express one.

**Deliberately not indexed.** "What is running?" filters nodes within a run
partition, which is cheap at these concurrency limits; if P9 wants it cheaper,
that is a GSI added then. Cross-run analytics for learned routing is an export to
S3, not an OLTP query, and designing for it now would be building for Phase 2.

### 4.4 Event sequencing

```text
append()  ──►  put event, SK = ULID#<eventId>        (synchronous, durable)
                     │
               DynamoDB Streams, ordered per partition key
                     │
               materializer Lambda, one run at a time
                     │
               ADD 1 to COUNTER  ──►  stamp `sequence` on the event
```

The writer gets durability and an identifier immediately. Numbering happens after
the record is durable, by a consumer that resumes from its last committed
position, so a crash cannot burn a number. The counter still exists; it moved out
of the request path.

Consequences to design around, not discover:

- A reader may see a durable event whose `sequence` is not yet set. Every
  consumer must tolerate that, and the realtime surface is therefore a beat
  behind. Accepted.
- Idempotency is enforced on the synchronous write, conditional on the
  idempotency key, so a duplicate never reaches the stream.
- Ordering within a run is guaranteed because a run's events share one partition
  key and Streams preserve per-key order.

## 5. Scope

### In scope

- CDK: the data stack (DynamoDB, S3), the API stack (function, HTTP API, stream
  consumer, log groups, IAM), and CDK assertion tests for both.
- `@nightshift/persistence/aws`: adapters implementing every `@nightshift/core`
  port against the schema in §4.
- `apps/api`: the control-plane handler, covering create and read for project,
  program and run; create and update for execution node; append and query for
  event; record for decision, checkpoint, verification, routing decision and
  artifact reference; and query current run state.
- `orgId` on `Project` in `@nightshift/contracts`, plus the org partition.
- A Cognito user pool, a JWT authorizer, and the user/membership model needed to
  resolve a token to an org (T9).
- Reserved cross-account fields on `Project` (D-P2-14). Fields only, no assumption
  logic.
- The smoke suite (D-P2-12) and a budget alarm.

### Out of scope

- Anything agent-facing. No MCP server, no harness, no execution machinery, no
  worktrees. P2 is verified with no agent anywhere near it.
- Realtime transport (O-02, P9) and dispatch (P8).
- Teardown verification (A-18).
- Alarms beyond the budget notification (D-P2-10).
- IAM-level tenant isolation (D-P2-06).

## 6. Success criteria

Carried from the source plan's Stage 2, minus the destroy step dropped by A-18.

**Infrastructure**

- **SC-P2-01** `cdk synth` succeeds for both stacks.
- **SC-P2-02** CDK assertion tests cover both stacks.
- **SC-P2-03** A clean deploy into the v1 account succeeds.
- **SC-P2-04** The smoke suite passes against the deployed stack.

**Data isolation**

- **SC-P2-05** Project A / Program X and Project B / Program X coexist with no
  collision, and a Project A query cannot return a Project B record.
- **SC-P2-06** S3 object prefixes are project scoped.
- **SC-P2-07** API access respects the expected boundary: an unsigned request is
  rejected before reaching the function.

**Events**

- **SC-P2-08** Duplicate submissions are idempotent.
- **SC-P2-09** Event ordering is reconstructable.
- **SC-P2-10** Current state can be rebuilt from stored records alone.
- **SC-P2-11** Large output stays out of DynamoDB.

**Regression**

- **SC-P2-12** The AWS adapter passes the P1 port conformance suite unchanged.

## 7. Deterministic verification

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm test                 # still credential-free; runs on both CI legs
npm run synth
npm run check:sterility
```

Plus, from a developer machine with `AWS_PROFILE=nightshift`:

```text
npm run deploy
npm run smoke
```

`npm test` must remain runnable with no AWS credentials. Any test needing the
account belongs in the smoke suite.

## 8. The smoke suite (D-P2-12)

Four phases. Exit 0 or it failed.

1. **Reachability and auth.** A request with no token gets 401, one with a
   malformed or expired token gets 401, and a valid token gets 200. The negative
   halves are the only proof the authorizer is wired rather than the API being
   open. The token comes from the machine app client (T9), never an interactive
   login.
2. **Conformance.** `describePortConformance` from P1, against the AWS adapter.
   Unchanged. If it needs changing, either the port contract or the adapter is
   wrong, and that is a conversation (SC-P2-12).
3. **Live-only assertions.** Two projects sharing a `programId`; S3 keys project
   prefixed; an oversized payload refused inline, stored in S3, DynamoDB item
   still small; the same idempotency key twice yielding one event; poll until the
   materializer has stamped sequences, then assert they are dense; rebuild run
   state from stored records alone.
4. **Cleanup.** Delete the smoke project's records and S3 prefix. Not the stack.
   With teardown testing dropped, leaving litter in the only environment matters
   more, not less.

It writes into a throwaway `smoke-<ulid>` project, so a failed run never poisons
real data, and prints the identifiers it used.

## 9. Constraints

- Dependencies point downward only. `apps/api` may import
  `@nightshift/persistence/aws`; nothing else may, and the architecture tests
  enforce it.
- `@nightshift/contracts` and `@nightshift/core` stay offline and AWS-free. The
  `orgId` addition must not change that.
- Every external dependency pinned exactly, recorded in `AGENTS.md`.
- No resource may be named by hand where CDK can generate the name, so the two
  stages cannot collide.
- Every stateful resource declares its removal policy explicitly (A-18).

## 10. Permissions and forbidden actions

Permitted: editing the repository, deploying the two stacks to the v1 account,
running the smoke suite, creating the budget.

Forbidden:

- Deleting or replacing the `CDKToolkit` stack.
- Disabling termination protection on a stateful stack.
- Deploying to any account other than `755348349819`.
- Putting AWS credentials into CI, the repository, or agent context.
- Weakening any P1 gate, or editing the conformance suite to make the AWS
  adapter pass.
- Settling an open decision from `docs/architecture.md` §3.

## 11. Tasks

| Task | Title | Depends on | Needs AWS |
|------|-------|------------|-----------|
| T1 | Split the stacks, and build the data stack | — | no |
| T2 | Org scoping in the ports | — | no |
| T3 | DynamoDB and S3 adapters | T2 | no (verified in T7) |
| T4 | The control-plane API handler | T2 | no |
| T6 | The sequence materializer | T2 | no |
| T5 | The API stack | T1, T4, T6 | no |
| T7 | First deploy and the smoke suite | T1, T3, T4, T5, T6 | **yes** |
| T8 | Budget alarm | — | yes |
| T9 | Cognito, the JWT authorizer, and the membership model | T2 | partly |

```text
T1 ──────────────────┐
T2 ──┬── T3 ─────────┼──────── T7
     ├── T4 ──┐      │
     ├── T6 ──┼── T5 ┘
     └── T9 ──┘
T8 (independent)
```

**Seven of eight tasks need no AWS credentials.** That is deliberate, and it is
what P1's persistence ports bought: the adapters, the handler and the materializer
are all provable against the in-memory adapter before anything is deployed. T7 is
the first task that touches the account, and it is where SC-P2-03 through SC-P2-12
are actually discharged.

T1 and T2 are independent and can start together. T2 is the last cheap moment to
change a port method — after T3 exists, every port addition means two
implementations.

Specs live in `tasks/p2-control-plane/`.

### Carried over from P1

Three things the tasks absorb rather than discover:

- P1 left one `nightshift-<stage>-control-plane` stack. T1 replaces it with the
  two-stack split before any resource exists, so nothing has to migrate later.
- "List projects in an org" needs a new port method, which means the in-memory
  adapter and the conformance suite grow too. T2.
- The materializer is a second Lambda with its own failure modes, including
  events that are durable but permanently unnumbered. T6 and T5.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-13 | D-P2-01 … D-P2-12 ratified in design review; O-01 resolved as A-19 | Human |
| 2026-09-13 | Event sequencing moved out of the request path (D-P2-04), superseding an earlier preference for an in-request atomic counter. The counter survives; it moved to the stream consumer. | Human |
| 2026-09-13 | Teardown verification dropped (A-18) after establishing that it was inherited from a plan assuming a disposable account | Human |
| 2026-09-14 | **D-P2-01 reversed**: Cognito JWT replaces IAM SigV4 (A-19, A-19a). Reason: SigV4 requires an IAM identity in the Nightshift account, which does not survive distribution and forces the operator to hold a Nightshift profile alongside client-account credentials. Adds T9. | Human |
| 2026-09-14 | D-P2-13: tenancy from the token claim, not the URL. Revises an earlier suggestion of `/orgs/{orgId}/…` paths. | Human |
| 2026-09-14 | D-P2-14 and A-25: cross-account role assumption with an external ID. P2 reserves the fields only. | Human |
| 2026-09-14 | D-P2-15 and A-26: plaintext secrets accepted for now, with the upgrade path recorded. | Human |
| 2026-09-14 | **D-P2-16**: the P1 conformance suite is amended for deferred sequencing. A-22 made `append` return an unnumbered event, which the suite (written before A-22) could not express, so SC-P2-12 was unsatisfiable as worded. The suite gains an optional `settle` hook that sequencing assertions await, runs the in-memory adapter both immediate and deferred, and keeps every assertion about the final numbering. Raised during implementation; not an edit to make an adapter pass. | Human |
| 2026-09-14 | **D-P2-17**: three key-schema and registry additions the contract did not define. (1) `IDEM#<key>` marker in the event partition, so idempotency is a write condition. (2) `USER#<sub>` / `META` and `USER#<sub>` / `MEMBER#<org>` for T9 identity, the one exception to D-P2-03 because a user spans orgs. (3) `User` and `Membership` live in a separate identity registry rather than `AGGREGATE_SCHEMAS`, whose SC-P1-17 tests require every aggregate to be project scoped. | Human |
| 2026-09-15 | **D-P2-18**: deploy and smoke credentials come from IAM Roles Anywhere rather than SSO. The `nightshift` profile's `credential_process` presents certificate `CN=tim-mac-agent` (CA `wingitlabs-roles-anywhere-ca`, expires 2027-09-15) and assumes `nightshift-agent`, which holds `AdministratorAccess` until the project is stable. Reasons: long-lived, no interactive login, and only a profile name ever reaches an agent, never a credential (§10). A scoped role was tried first and cannot chain into the CDK bootstrap roles, whose v32 trust policies do not allow `sts:SetSourceIdentity`. Revoke by disabling the trust anchor. | Human |

## 13. As built

Recorded 2026-09-14 offline and updated 2026-09-15 after the first deploy. All
nine tasks are implemented and SC-P2-01 through SC-P2-12 are discharged (see
Deployed, below). T8 still needs a notification confirmed as delivered.

Every credential-free command in §7 exits 0 on macOS: build, typecheck, lint,
`npm test` (988 tests in 40 files), synth (both stacks, both functions bundled),
`check:sterility`, and `check:architecture`. CI passed on its first run of this
branch (run 34988067065, ubuntu-latest and windows-latest).

| Task | State | Where |
|------|-------|-------|
| T1 | done | `infra/cdk/src/lib/data-stack.ts`, `data-exports.ts` |
| T2 | done | `ProjectStore.listByOrg`; memory adapter; conformance org section |
| T3 | done offline | `packages/persistence/src/aws`; conformance run in `apps/api/src/aws-conformance.test.ts` |
| T4 | done | `apps/api/src` handler, router, operations |
| T5 | done | `infra/cdk/src/lib/api-stack.ts` |
| T6 | done offline | `apps/api/src/materializer`, `packages/persistence/src/aws/sequence-ledger.ts` |
| T7 | done: deployed 2026-09-15, smoke suite passed twice | `apps/api/src/smoke`, `scripts/smoke.mjs`, `scripts/deploy.mjs` |
| T8 | deployed and verified; email delivery not yet confirmed | `infra/cdk/src/lib/budget.ts` |
| T9 | done offline | identity contracts and registry; `apps/api/src/auth/acting-org.ts`; Cognito in the data stack |

### Implementation choices worth knowing

None of these amends the contract; each is recorded where a reviewer would look.

- **Stamping is one transaction.** T6 describes an atomic increment followed by a
  conditional stamp. As two writes, a crash between them consumes a number no
  event carries, which is the gap A-22 rules out. The ledger instead advances the
  counter conditionally on the value it read and stamps the event conditionally on
  `sequence` being null, in one `TransactWriteItems`. Tests inject a crash before
  and after the commit and assert that no number is burned.
- **Event listings read the whole event partition.** Numbering follows commit
  order, which need not match ULID order, so the adapter orders in memory. That is
  linear in the number of events in a run, per page. A sparse index on `sequence`
  is the upgrade, and a GSI can be added later without replacing the table.
- **The DynamoDB adapter passes the conformance suite offline.** `FakeTable` is a
  strict in-process table (expression parser, transactions, cancellation reasons,
  page caps, a stream). The suite's `settle` drives the real materializer and
  ledger over the fake stream. The smoke suite runs the same suite on the real table.
- **Acting org (T9).** The claim `custom:active_org` if present, which must name a
  membership; otherwise the caller's only membership; otherwise a typed refusal.
  Resolved only to create a project and to list projects. Nothing enforces org
  separation (A-21).
- **Cognito.** Lite feature plan set explicitly. Interactive client loopback
  redirect `http://localhost:47821/callback`. Both clients allow only refresh-token
  auth as a direct flow.
- **IAM.** No managed policies. The API function may `GetItem`, `PutItem` and
  `Query`; the materializer may read the stream, `GetItem`, `PutItem` and
  `UpdateItem`, and send to its dead-letter queue. Nothing has S3 access yet.
- **The smoke suite lives in `apps/api`**, the only package §9 lets import
  `@nightshift/persistence/aws`. It is excluded from the build and from `npm test`.

### Deployed (2026-09-15)

First deploy from the Mac mini with the `nightshift` profile (D-P2-18):
`nightshift-dev-data` in 31 s and `nightshift-dev-api` in 77 s, both
`CREATE_COMPLETE`. CDK could not assume its bootstrap roles from a Roles Anywhere
session and fell back to the caller's credentials, which are in the right
account. `CDKToolkit` was not changed.

| Item | Value |
|------|-------|
| Data stack | `nightshift-dev-data`, termination protection on |
| API stack | `nightshift-dev-api` |
| Table | `nightshift-dev-data-TableCD117FA1-BF9WSGGU1TW9` |
| Bucket | `nightshift-dev-data-artifactbucket7410c9ef-rslqnihuwhgm` |
| User pool | `us-west-2_GKWK85Mub`; token endpoint `https://nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com/oauth2/token` |
| API endpoint | `https://4xnsx809u6.execute-api.us-west-2.amazonaws.com` |
| Functions | `nightshift-dev-api-ApiFunctionCE271BD4-COvjJHToizUW` and `nightshift-dev-api-MaterializerFunctionFE78AC96-bT0iH4WxAFrh`, Node 22 on arm64 |
| Budget | `MonthlyCostBudgetDB65A044-us-west-2-1789484736137-wF13ZZZznPXB`: 500 USD monthly, actual 50/80/100% and forecast 100% to `tim+nightshift@wingitlabs.com`, confirmed with `describe-budgets` |

**Smoke suite**, run twice back to back:

| Run | Tests | Runtime | Sequencing lag | Large output | Cleanup |
|-----|-------|---------|----------------|--------------|---------|
| 1 | 62 passed | 75 s | 324 ms | 24,587-byte payload in S3; event item 690 bytes | 42 items, 3 objects, 2 conformance leftovers |
| 2 | 62 passed | 34 s | 312 ms | same | same, and found none of run 1's data left |

Sequencing lag runs from the last acknowledged append to the last number stamped,
polled every 250 ms, so it is accurate to about a quarter of a second. After both
runs the table held no items, the bucket no objects and the dead-letter queue no
messages; the stream mapping reported `OK` and neither function logged an error.

**Success criteria.** SC-P2-01 and SC-P2-02 by synth and the assertion tests.
SC-P2-03 by this deploy. SC-P2-04 by both smoke runs. SC-P2-07 by phase 1: no
token, a malformed token and a forged expired token each got 401, and a valid
machine token got 200. SC-P2-05, SC-P2-06, SC-P2-08, SC-P2-09, SC-P2-10 and
SC-P2-11 by phase 3. SC-P2-12 by phase 2: 52 conformance tests against the
deployed table, with the suite as amended by D-P2-16.

### Open items

- **Deploy credentials: resolved 2026-09-15 (D-P2-18).** The `nightshift` profile
  uses IAM Roles Anywhere on the Mac mini; see §2.
- **DynamoDB point-in-time recovery is off.** No task asked for it. It is cheap
  protection for the only environment there is, and a human call.
- **Budget.** Deployed from `us-west-2` without trouble. Still open: confirm a
  notification actually arrives (T8).
- **CI** passed on the branch before merge: run 34988067065, ubuntu-latest and
  windows-latest, every gate.
