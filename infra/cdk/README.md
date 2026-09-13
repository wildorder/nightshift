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

## No resources in P1

`NightshiftControlPlaneStack` deliberately defines **no resources**. P1 only
proves that the app builds, synthesizes, and is covered by assertion tests. P2
adds the DynamoDB single table, the S3 artifact bucket (A-08), the IAM execution
identity, and the control-plane API. `control-plane-stack.test.ts` fails if a
resource appears, so P2 updates that test knowingly.

## No credentials required

The stack is environment-agnostic: no `env`, no account, no region. Synth needs
no AWS credentials, no `AWS_PROFILE`, no `~/.aws`, and no network — it runs with
`--no-lookups`. If synth ever asks for an account or region, the stack has lost
its environment-agnostic property and that is the bug.

## Stack naming

`nightshift-<stage>-control-plane`, with `stage` defaulting to `dev` and
overridable via CDK context (`-c stage=...`).
