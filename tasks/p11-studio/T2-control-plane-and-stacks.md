# T2 — The control plane and the stacks

**Program:** `p11-studio`
**Depends on:** —
**Unblocks:** T4
**Decisions applied:** D-P11-01, D-P11-02, D-P11-03, D-P11-04, D-P11-06

## Objective

A browser on the Studio's origin can call the API, sign in through its own app
client and open an artifact; the Studio is served from CloudFront on the stage's
hostname; `npm run deploy` deploys all of it. Independent of T1: what is served
may be a placeholder until T1 lands.

## Deliverables

1. **CORS on the HTTP API** (`infra/cdk`, `corsPreflight` on `HttpApi`): origins
   `https://studio.<stage>.nightshift.wildorder.dev` and, for the `dev` stage
   only, `http://localhost:<port>`; methods `GET`, `PUT`, `POST`, `OPTIONS`;
   `authorization` and `content-type` headers; no credentials flag (bearer
   tokens, not cookies). Preflight is answered by the gateway before the
   authorizer. The stack test asserts the origin list per stage.
2. **`StudioClient`** on the pool (`data-stack.ts`): public, `authFlows: {}` then
   pinned to refresh only as the others are, authorization code grant, the same
   four scopes as `InteractiveClient`, callback and logout URLs the Studio's
   origins (`/callback`, `/`), the same read and write attributes.
   `StudioClientId` is a data export; the API stack adds it to
   `NIGHTSHIFT_COGNITO_AUDIENCES`. The authorizer test covers a token from it.
3. **`artifact.createDownloadUrl`**: the `Operation` in `core`'s union and
   `authorize` table (user: allowed within their org; execution: `forbidden`,
   every role); `POST …/artifacts/{artifactId}/download-url` returning
   `{ url, expiresAt }` for an artifact record that exists; an
   `ArtifactDownloadSigner` port in `core`, the S3 implementation in
   `persistence/aws` (presigned `GET`, 15 minutes, as the upload's TTL), wired in
   `apps/api/src/lambda/api.ts`; the route-table totality test and the isolation
   suites gain the operation. The API role gains `s3:GetObject` on
   `artifacts/*` and nothing else (the stack test pins the two prefixes).
4. **Two stacks** (`infra/cdk`): `nightshift-<stage>-studio-cert` in
   `us-east-1` (the certificate for `studio.<stage>…`, DNS-validated against the
   zone's exported id) and `nightshift-<stage>-studio` (a private bucket, a
   CloudFront distribution with an origin access control, the alias record, and
   a `BucketDeployment` of `apps/studio/dist` plus `Source.jsonData("config.json",
   {…})` resolved from the API endpoint, auth domain and `StudioClientId`).
   Both carry an explicit region; `crossRegionReferences: true`; synth stays
   credential-free. `hostnames.ts` gains `studioHostnameFor`; `app.ts` wires the
   dependencies; the `hostnames=zone-only` mode omits both, as it omits the
   API's domain. Removal policies explicit; nothing stateful.
5. **Deploy**: `cdk bootstrap` in `us-east-1` once (document it in the as-built);
   `npm run deploy` deploys all four stage stacks; `npm run smoke` green twice.
6. **`npm run studio:smoke`** (`apps/api/src/smoke/studio.smoke.ts`, its own
   config, from a developer machine): the hosted URL answers 200 with the app
   and a `config.json` naming the stage's API, auth domain and client id; a
   preflight from the Studio origin is granted and one from `https://example.com`
   is not; a download URL is issued for an artifact the suite uploads and the
   bytes read back through it; an execution token asking for one is refused.

## Acceptance

- Stack tests: CORS origins per stage, `StudioClient` shape, both S3 read
  prefixes, both Studio stacks present in `full` mode and absent in `zone-only`.
- `npm run synth` green; deployed; `npm run smoke` twice; `npm run studio:smoke`.
- `authorize` table tests: no execution cell for the new operation.
