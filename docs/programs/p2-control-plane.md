# Program P2 — Control Plane

| Field | Value |
|-------|-------|
| Program ID | `p2-control-plane` |
| Project ID | `nightshift` |
| Base branch | `v1` |
| Program branch | `program/p2-control-plane` |
| Source stage | Stage 2 (AWS Control Plane) |
| Status | Decisions ratified 2026-09-13. Tasks not yet drafted. |
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
| CLI profile | `nightshift` (SSO session `nightshift`, role `AdministratorAccess`) |
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
| D-P2-01 | Lambda behind an API Gateway HTTP API, IAM SigV4 auth. Resolves **O-01**. | API Gateway rejects an unsigned request before the function runs, so there is no auth code to write. The Lambda is the whole API and the only holder of data credentials. |
| D-P2-02 | One DynamoDB table, one GSI. On-demand capacity. | Every access pattern is chain-prefixed; a second table buys nothing. On-demand because the load is one user and bursty. |
| D-P2-03 | `PK` always begins with `projectId` | Makes a cross-project query structurally impossible instead of merely forbidden. This is the data-layer half of SC-P2-05. |
| D-P2-04 | Event sequence numbers are stamped **after** durability by a DynamoDB Streams consumer | Keeps `append` synchronous so the P1 port contract survives, and moves the fragile step somewhere a retry is harmless. A crash cannot burn a number. Readers must tolerate a briefly absent `sequence`. |
| D-P2-05 | A project belongs to an org. `Project` gains `orgId`; the ownership chain is unchanged. | `projectId` is a globally unique ULID, so project-scoped items need no org prefix to be unambiguous. Decided now because the *key namespace* is expensive to retrofit even though the attribute is not. |
| D-P2-06 | Project isolation is enforced in the application, not in IAM | One user, and per-tenant IAM identities are not how multi-tenant products are usually built. Isolation lives in exactly one place. |
| D-P2-07 | Two stacks: `nightshift-<stage>-data` (stateful) and `nightshift-<stage>-api` (stateless) | The data stack carries termination protection and changes rarely; the API stack can be replaced freely. With one account that split is the only thing between a bad deploy and the data. |
| D-P2-08 | One S3 bucket, SSE-S3, versioning off, keys prefixed `<projectId>/<programId>/<runId>/…` | Mirrors the DynamoDB chain, so an artifact's ownership is legible from its key alone. Versioning off because artifacts are write-once. |
| D-P2-09 | Deploys run from a developer machine; CI stays credential-free | Faster, and it keeps the six-gate CI contract from P1 intact. Revisit via GitHub OIDC if it becomes tedious. |
| D-P2-10 | CloudWatch log retention 30 days. No alarms in P2. | Enough to debug a run, cheap, and alarms without an operator are noise. |
| D-P2-11 | Budget alarm notifies `tim+nightshift@wingitlabs.com` | Matters more with a single account than it would with a separate sandbox. |
| D-P2-12 | The smoke test is the P1 port conformance suite run against the deployed stack, plus live-only assertions, plus cleanup. Opt-in, never in `npm test`. | The conformance suite exists precisely so one suite covers both adapters. Keeping it out of `npm test` preserves the credential-free gate. |

## 4. Data design

### 4.1 Key schema

Single table. `PK` always begins with `projectId` (D-P2-03).

| Entity | PK | SK |
|--------|----|----|
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

1. **Reachability and auth.** An unsigned request gets 403; a signed one gets
   200. The only proof SigV4 is wired rather than the API being open.
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

Not yet drafted. To be written once this contract is reviewed.

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-13 | D-P2-01 … D-P2-12 ratified in design review; O-01 resolved as A-19 | Human |
| 2026-09-13 | Event sequencing moved out of the request path (D-P2-04), superseding an earlier preference for an in-request atomic counter. The counter survives; it moved to the stream consumer. | Human |
| 2026-09-13 | Teardown verification dropped (A-18) after establishing that it was inherited from a plan assuming a disposable account | Human |
