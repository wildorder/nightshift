# `@nightshift/cdk`

AWS CDK v2 app for the Nightshift control plane. This is the sole IaC system
(A-09); nothing else provisions AWS resources.

## Synth requires a prior build

`cdk.json` sets `"app": "node dist/bin/app.js"` (D-P1-10). The app entry is
compiled JavaScript, so there is no `ts-node`/`tsx` loader and **`cdk synth`
fails until the workspace has been built**. Always go through the root script:

```sh
npm run synth   # == npm run build && npm --workspace @nightshift/cdk run synth
```

Output lands in `infra/cdk/cdk.out` (gitignored). To synth a non-default stage:

```sh
npm run build
npm --workspace @nightshift/cdk run synth -- -c stage=staging
```

## The stacks (D-P2-07, A-24, D-P3-18, D-P11-02)

| Stack | Holds | Termination protection |
|-------|-------|------------------------|
| `nightshift-dns` | The hosted zone `nightshift.wildorder.dev` (unstaged, retained) | **on** |
| `nightshift-<stage>-data` | DynamoDB table, artifact bucket, Cognito user pool and app clients, account budget | **on** |
| `nightshift-<stage>-api` | Handler function, HTTP API (with CORS for the Studio) and the Nightshift authorizer, stream consumer and its dead-letter queue, log groups, IAM | off |
| `nightshift-<stage>-studio-cert` | The Studio's certificate, in **us-east-1** because CloudFront accepts no other region | off |
| `nightshift-<stage>-studio` | A private bucket, the CloudFront distribution with an origin access control, the `studio.<stage>` alias record, and a deployment of the app plus `config.json` | off |

`stage` defaults to `dev` and is overridden with `-c stage=...`. It must be 1-20
lowercase letters, digits or hyphens, because it appears in the Cognito domain
prefix; synth refuses anything else.

The data stack changes rarely. With one account (A-17) and no teardown testing
(A-18), the split is the only thing between a bad API deploy and the data. Every
resource type in the data stack has an explicit removal-policy expectation in
`data-stack.test.ts`; adding a resource type without choosing one fails the test.
The table, bucket and user pool are `Retain`, and the table and user pool also
carry resource-level deletion protection.

### Data stack

- **Table.** `PK`/`SK` strings, on-demand, one GSI `gsi_node` (`GSI1PK`/`GSI1SK`,
  projection `ALL`), streams `NEW_AND_OLD_IMAGES` for the sequence materializer.
  Key layout: `docs/programs/p2-control-plane.md` §4.
- **Bucket.** SSE-S3, versioning off, all public access blocked, TLS enforced.
- **Cognito (T9).** Email sign-in, no self sign-up, `Lite` feature plan set
  explicitly, mutable custom attribute `active_org` (read by the API as claim
  `custom:active_org`). Resource server `nightshift` with scope `api`.
  - Machine client: secret, client credentials only, scope `nightshift/api`.
  - Interactive client: public, authorization code with PKCE, loopback redirect
    `http://localhost:47821/callback`. Cognito has no device flow; P3's CLI uses
    this loopback redirect.
  - Both clients allow only `ALLOW_REFRESH_TOKEN_AUTH` as a direct auth flow.
  - Domain prefix `nightshift-<stage>-<account>`: prefixes are global and cannot
    be CDK-generated.
- **Budget (T8).** Monthly cost budget, 500 USD, email at 50/80/100% actual and
  100% forecast to `tim+nightshift@wingitlabs.com`. Budgets is a global service;
  the CloudFormation resource is expected to deploy from `us-west-2`, verified by
  the first deploy. A second stage creates a second budget.

### Exports

The API stack consumes the data stack by **export name**, never by construct
reference, so each stack deploys and replaces independently. Names come from
`dataExportName(stage, key)` in `src/lib/data-exports.ts`:
`nightshift-<stage>-data-<Key>` for `TableName`, `TableArn`, `TableStreamArn`,
`BucketName`, `BucketArn`, `UserPoolId`, `UserPoolArn`, `InteractiveClientId`,
`MachineClientId`, `TokenEndpoint`, `MachineScope`. Each output's `OutputKey` is
the key itself.

An exported value cannot change while another stack imports it, which is one more
reason the data stack changes rarely.

### API stack (T5)

- **HTTP API.** One `$default` route, bound to a Cognito JWT authorizer whose
  issuer is the data stack's user pool and whose audience is both app clients. No
  route is anonymous, and the assertion tests fail if one ever is. The `$default`
  stage keeps request paths unprefixed, which the handler's router relies on.
- **Functions.** Node 22, `arm64`. The API function (10 s, 512 MB) and the
  sequence materializer (60 s, 256 MB). Environment: table name, bucket name,
  stage. Nothing secret.
- **IAM.** Hand-written roles with no managed policies. The API may `GetItem`,
  `PutItem` and `Query` the table and `gsi_node`. The materializer may read the
  stream and `GetItem`/`PutItem`/`UpdateItem` the table, and send to its
  dead-letter queue. Neither may touch S3 yet. The only wildcard is the `:*` on
  each function's own log group ARN.
- **Stream consumer.** `TRIM_HORIZON`, batch 25, no batching window,
  parallelization 1, `ReportBatchItemFailures`, 10 retries, then the dead-letter
  queue. A message in that queue means an event that is durable and will never be
  numbered; the comment in `api-stack.ts` spells out the consequences.
- **Logs.** Explicit log groups with 30-day retention (D-P2-10).
- **Outputs.** `ApiEndpoint`, both function names, the dead-letter queue URL.

### Studio stacks (P11, T2)

- **Hostname.** `studio.<stage>.nightshift.wildorder.dev` (`studioHostnameFor`),
  an alias to the distribution in the zone imported by export name. The API
  grants CORS to the Studio's origins (`studioOriginsFor`): the hosted origin on
  every stage, plus `http://localhost:5173` on `dev` alone (D-P11-01); the
  Studio's app client (`StudioClient`, exported as `StudioClientId`) uses the
  same list for its callback (`/callback`) and logout (`/`) URLs.
- **Regions.** Both stacks carry an explicit `env` (account `755348349819`;
  `us-east-1` for the certificate, `us-west-2` for the site) with
  `crossRegionReferences: true`, so CDK carries the certificate ARN across. An
  explicit environment is a constant, so synth still needs no credentials.
- **The zone id.** A CloudFormation export is regional, so the certificate stack
  cannot `Fn::ImportValue` the DNS stack's `HostedZoneId` from `us-east-1`. It
  takes the id from the `hostedZoneId` context value, defaulted in `cdk.json` to
  the v1 account's zone; pass `-c hostedZoneId=…` for another account after its
  zone-only deploy. `studio-cert-stack.ts` records the alternatives.
- **What is served.** `apps/studio/dist` when it exists, else the placeholder
  page in `studio-placeholder/`; `-c studioAssets=<dir>` names any other
  directory. Every deploy prunes the bucket, writes `config.json`
  (`apiEndpoint`, `authDomain`, `clientId`, `stage`) from the hostname rule and
  the data stack's exports, and invalidates the distribution.
- **Bootstrap.** The CDK toolkit must be bootstrapped in `us-east-1` once
  (`npx cdk bootstrap aws://755348349819/us-east-1` from this directory); the
  deploy profile can do it. Done for the v1 account on 2026-09-28.
- **`zone-only` mode omits both**, as it omits the API's domain: the certificate
  waits on a zone that is not yet delegated.

## Bundling

Both functions are `NodejsFunction`s bundled by esbuild, pinned as a
devDependency of this package so no Docker is needed. They bundle `apps/api`'s
**compiled** output (`apps/api/dist/lambda/api.js` and `materializer.js`), the
same choice D-P1-10 makes for the CDK app, so `npm run synth` and `npm run deploy`
build the workspace first.

- The AWS SDK is bundled rather than taken from the Lambda runtime, so the
  deployed SDK is the pinned one the tests ran against.
- CommonJS output, minified, with source maps (`NODE_OPTIONS=--enable-source-maps`).
- Assertion tests set the `aws:cdk:bundling-stacks` context to an empty list, so
  `npm test` never runs esbuild. `npm run synth` bundles for real.

## Deploying

From a developer machine only, never CI (D-P2-09):

```sh
AWS_PROFILE=nightshift npm run deploy
```

`scripts/deploy.mjs` refuses to start unless the profile resolves to account
`755348349819` in `us-west-2` (A-17), builds the workspace, then runs
`cdk deploy --all` with `stage=dev` unless another stage is passed after `--`.
The data stack deploys first because the API stack imports its exports; the
Studio stacks deploy after the data, DNS and certificate stacks for the same
reason. `npm run smoke` proves the API afterwards and `npm run studio:smoke`
the hosted Studio.

## No credentials required

The DNS, data and API stacks are environment-agnostic: no `env`, no account, no
region. The two Studio stacks carry an explicit environment, which is a constant
and not a lookup. Synth needs no AWS credentials, no `AWS_PROFILE`, no `~/.aws`,
and no network — it runs with `--no-lookups`. If synth ever asks for an account
or region, a stack has lost that property and that is the bug.
