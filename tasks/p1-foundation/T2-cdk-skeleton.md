# T2 — CDK app skeleton and assertion tests

**Program:** `p1-foundation`
**Depends on:** T1
**Unblocks:** T4
**Decisions applied:** D-P1-05, D-P1-10; architecture A-09

## Objective

`infra/cdk` exists as a CDK v2 TypeScript app that synthesizes offline with no
AWS account, has CDK assertion tests, and defines **no resources**. It is the
place P2 will add DynamoDB, S3, IAM, and the API.

## Deliverables

1. `infra/cdk/cdk.json` with `"app": "node dist/bin/app.js"` (D-P1-10) and the
   standard v2 feature-flag context.
2. `infra/cdk/src/bin/app.ts`: creates an `App` and one
   `NightshiftControlPlaneStack` with **no** `env` (environment-agnostic).
3. `infra/cdk/src/lib/control-plane-stack.ts`: a `Stack` subclass with a
   constructor that accepts a typed `NightshiftStackProps` (currently only
   `stage: string`, defaulting to `dev`) and creates nothing.
4. Stack naming convention: `nightshift-<stage>-control-plane`. Record this in
   `AGENTS.md` Conventions.
5. `infra/cdk/src/lib/control-plane-stack.test.ts` using
   `aws-cdk-lib/assertions`: the template synthesizes, and `Template.toJSON()`
   has no `Resources` beyond CDK metadata.
6. Root `npm run synth` runs `npm run build` then `cdk synth` in `infra/cdk`
   with `--no-lookups` and no profile.

## Acceptance

```text
npm run build
npm run synth        # writes infra/cdk/cdk.out, exit 0, no credentials
npm test             # CDK assertion test passes
```

Must pass with no `AWS_PROFILE`, no `~/.aws` config, and no network.

## Out of scope

Any resource, any environment binding, any bootstrap. If synth asks for an
account or region, the stack is not environment-agnostic and that is the bug.
