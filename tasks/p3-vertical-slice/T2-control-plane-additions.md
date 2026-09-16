# T2 — Control-plane additions and the local control plane

**Program:** `p3-vertical-slice`
**Depends on:** nothing
**Unblocks:** T3, T5
**Decisions applied:** D-P3-02, D-P3-13, D-P3-16; A-03, A-08, A-19, A-22, A-23

## Objective

Give the local machinery everything it needs from the control plane, in one
task: the routes for the remaining port methods, update semantics for runs and
agents, a presigned artifact upload, an operator bootstrap, and a local in-process
control plane for tests. Redeploy once at the end.

## Deliverables

### `core`

1. **Run and agent transition tables**, in `packages/core/src/rules/`, in the
   same style as `transitions.ts` (exported table, exhaustive negative test):
   - Run: `pending → running`; `running → succeeded | failed | cancelled |
     interrupted`; terminal statuses leave nothing. A terminal run must carry
     `endedAt`; a non-`succeeded` terminal run must carry `outcomeReason`.
   - Agent: `created → started`; `started → completed | failed | cancelled |
     interrupted`; `created → cancelled`. A non-`completed` end must carry
     `outcomeReason`, and `endedAt` is required on every end.
2. **Stores split.** `NightshiftStores` becomes `ProjectStores & IdentityStores`
   (names are yours; the split is the point). `ProjectStores` is everything
   project scoped; `IdentityStores` is `users` and `memberships`. The API
   handler keeps taking the full set. The conformance suite gains an option so
   its identity section runs only when an adapter supplies identity stores;
   this is a deliberate amendment in the D-P2-16 tradition, recorded in the
   contract's §12, not a quiet edit.
3. **`ArtifactBodyStore`** lifted from `packages/persistence/src/aws/` into
   `packages/core/src/ports/`, with the `aws` implementation unchanged apart
   from importing the type. Add an `ArtifactUploadTarget` shape the http
   adapter will need: the `s3://` URI, the upload URL, the key.

### `apps/api`

4. Routes, each following the existing operation pattern (schema first, chain
   from the path, `createOrConfirm` where create semantics apply):
   - `PUT`/`GET …/jobs/{jobContractId}`, `GET …/jobs`.
   - `PUT`/`GET …/agents/{agentId}`, `GET …/nodes/{nodeId}/agents`. `PUT` on an
     existing agent applies the agent table; anything else about the record is
     immutable.
   - `PUT run` on an existing run applies the run table; `rootNodeId`,
     `location` and `startedAt` are immutable.
   - `GET …/nodes`, `GET …/nodes/{nodeId}/children`.
   - `GET …/decisions/{decisionId}`, `GET …/decisions`; `GET
     …/checkpoints/{checkpointId}`, `GET …/checkpoints`; `GET
     …/verifications/{verificationId}`, `GET …/nodes/{nodeId}/verifications`;
     `GET …/nodes/{nodeId}/routing-decisions`; `GET …/artifacts/{artifactId}`,
     `GET …/artifacts`; `GET /projects/{projectId}/programs`; `GET …/runs`.
   - `PUT`/`GET …/examinations/{examinationId}`, `GET
     …/nodes/{nodeId}/examinations`. Create only; nothing in P3 writes one.
   - `POST …/artifacts/{artifactId}/upload-url` with body `{ kind, contentType,
     sizeBytes }`: returns a presigned S3 `PUT` for
     `<projectId>/<programId>/<runId>/<artifactId>` that pins the content type
     and expires in minutes, plus the `s3://` URI. The run must exist. The
     handler does not touch S3; it signs. Response shape in
     `@nightshift/contracts` `api.ts`, like every other body.
5. **Local control plane** at `apps/api/src/testing/local-control-plane.ts`,
   exported as `@nightshift/api/testing`: `startLocalControlPlane({ stores,
   claims, clock })` serves `handleRequest` over `node:http` on a loopback port,
   ignores the `Authorization` header, injects the fixed claims, and serves
   presigned uploads itself by returning a URL back to its own loopback address
   and holding bodies in memory (reuse the fake object client under
   `persistence/aws/testing` if it fits). Returns `{ url, close, bodies }`.
   Never bundled into the Lambda; never deployed.
6. **Operator bootstrap** at `apps/api/src/admin/`, run as `npm run admin:user
   -- --email <email> [--org <org_…>]`:
   - Looks the email up in the pool first. An existing user is used as is; a
     missing one is created with `AdminCreateUser` and `MessageAction:
     SUPPRESS`, then given a permanent password with `AdminSetUserPassword`
     (prompted, never a flag, never printed) so it lands in `CONFIRMED`. The
     pool's default mailer is best-effort and capped at 50 messages a day; on
     2026-09-15 the operator's invitation never arrived, so nothing here may
     depend on that email.
   - Writes the `User` (`kind: human`, with the email) and `Membership` rows for
     the user's `sub` through the AWS adapter, minting an org id when `--org`
     is absent and printing it. Idempotent: existing rows are reported, not
     rewritten, and a second membership is refused unless `--org` names it.
   - Guarded by the account check every AWS script uses. The operator's own
     user was seeded by hand before this script existed (contract §2); the
     script's first real test is re-running it against that user and changing
     nothing.

### `infra/cdk`

7a. **Pool hardening** (D-P3-16), in the data stack: the invitation message
   template gains the hosted sign-in URL for the interactive client alongside
   the username and temporary password placeholders; a `userNotification`
   ERROR log delivery to an explicitly created log group with 30-day retention
   (D-P2-10), replacing the hand-made
   `/aws/cognito/nightshift-dev-userpool-delivery-diag`, which is deleted after
   the deploy. Assertion tests for both.
7. `s3:PutObject` for the API function on `<bucket>/*`, and the
   `@aws-sdk/s3-request-presigner` dependency pinned at `3.1131.0` and recorded
   in `AGENTS.md`. Assertion tests: the statement exists, is scoped to the
   bucket, and no other S3 action was added.

### Smoke

8. Extend the P2 smoke suite's phase 3 with: job and agent round trips including
   one legal and one illegal agent transition; a run moved to `running` then
   `succeeded`; a presigned upload that lands an object under the project
   prefix with the declared content type, followed by the `Artifact` record;
   an examination round trip. Extend cleanup to cover the new records.

## Acceptance

Offline, in CI:

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run synth
npm run check:architecture
```

Then, from a developer machine:

```sh
AWS_PROFILE=nightshift npm run deploy -- --require-approval never
AWS_PROFILE=nightshift npm run smoke
```

Both exit 0. Run the smoke suite twice, as T7 of P2 did.

## Notes

- `apps/api` is still the only package importing `@nightshift/persistence/aws`.
  The admin script lives there for that reason, next to the smoke suite.
- The upload route is where A-08 is enforced for the local machinery: the
  request carries a size, the presigned URL carries a content type, and the
  `Artifact` record comes after the bytes. Do not add a proxied upload through
  the Lambda; its payload limit would become a hidden artifact size limit.
- Keep the route table readable. It is the API surface, and P9 will read it.
- The local control plane is test infrastructure, but it runs the production
  handler. If it needs a behaviour the handler lacks, that is a gap in the
  handler, not a feature of the fake.
