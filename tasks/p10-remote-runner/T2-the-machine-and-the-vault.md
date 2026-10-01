# T2 — The machine and the vault

**Program:** `p10-remote-runner`
**Depends on:** T1; H-P10-02, H-P10-03 (satisfied)
**Unblocks:** T3, T5
**Decisions applied:** D-P10-12, D-P10-13, D-P10-16, D-P10-17, D-P10-21, D-P10-23

## Objective

A `RunnerStack` exists, the Nightshift AMI builds, and an instance launched
from it boots `nightshift-runner` as the `engine` user, bootstraps an engine
token and heartbeats to the deployed control plane. The `Credentials` table and
its key exist in the data stack. Rootless Docker and Chromium are measured on
the real machine and the result is recorded.

## Deliverables

1. **Data stack** (`infra/cdk/src/lib/data-stack.ts`): the `Credentials`
   DynamoDB table (PK `ORG#`, SK `PROVIDER#`, pay-per-request, **no stream**, no
   GSI, deletion protection, `RETAIN`) and `CredentialsKey` (symmetric KMS,
   rotation on, `RETAIN`) whose key policy grants `kms:Decrypt` and
   `kms:GenerateDataKey` to the API function's role only, with a condition on
   `kms:EncryptionContext:orgId` being present. New exports `CredentialsTableName`,
   `CredentialsTableArn`, `CredentialsKeyArn`. A stack test asserts: no stream
   on the table; no principal but the API function has read or decrypt (the
   synthesized template's policies are enumerated, SC-P10-12).
2. **`RunnerStack`** (`infra/cdk/src/lib/runner-stack.ts`, composed in
   `stacks.ts` after the API stack):
   - An **EC2 Image Builder** pipeline (`CfnComponent`, `CfnImageRecipe`,
     `CfnInfrastructureConfiguration`, `CfnDistributionConfiguration`,
     `CfnImagePipeline`) on the latest Amazon Linux 2023 arm64 parent, with one
     component per concern: Node 24 (pinned), git, rootless Docker prerequisites
     (`docker`, `fuse-overlayfs`, `slirp4netns`, `uidmap`), Chromium's shared
     libraries, `gcc`/`make`/`python3`/`pip`, `rustup` with stable, `pnpm`, the
     pinned `@anthropic-ai/claude-code` and `@openai/codex` CLIs, and the
     Nightshift runner tarball fetched from the artifact bucket under
     `runner/<version>.tgz`. The recipe's version is the repository's
     `package.json` version; the AMI is tagged `nightshift:amiVersion`.
   - A **launch template** per tier is not needed: one template, with the
     instance type supplied at launch; IMDSv2 required, hop limit 1;
     `nightshift:*` tags; user-data is a short script that reads the dispatch id
     and bootstrap secret reference from instance tags and starts the runner.
   - The **instance role**: `ssm:GetParameter` on `/nightshift/dispatch/<id>/*`
     (the bootstrap secret, written by the dispatch Lambda, deleted on first
     read), `s3:PutObject` on `runs/<runId>/*` of the artifact bucket,
     `logs:*` on its own log group, nothing else. No DynamoDB, no KMS, no EC2.
   - A **security group** with no inbound rules.
   - The **reconciler** Lambda on an EventBridge schedule of one minute, the
     **dispatch** Lambda, and the **publisher** Lambda (bodies in T3, T4, T6;
     here the functions exist with a no-op handler each and the IAM they will
     need: `ec2:RunInstances`/`TerminateInstances`/`Describe*`,
     `ec2:CreateVolume`/`AttachVolume`/`CreateSnapshot`/`DeleteVolume`/
     `DeleteSnapshot` with a tag condition `nightshift:managed=true`,
     `ssm:PutParameter`/`DeleteParameter` under the dispatch path, and for the
     publisher alone `secretsmanager:GetSecretValue` on `nightshift/github-app`).
   - Stack tests like the API stack's: every grant enumerated and asserted; a
     negative test that the instance role has no DynamoDB or KMS action; the
     AMI recipe pins every version.
3. **The runner** (`apps/mcp`): a second bin, `nightshift-runner` →
   `dist/runner/main.js`, and `apps/mcp/src/runner/`:
   - `bootstrap.ts`: reads the dispatch id from IMDSv2 tags, fetches and deletes
     the bootstrap secret, exchanges it at `POST /runs/{runId}/dispatch/bootstrap`
     (added here to the T1 routes) for the first engine token and the dispatch
     record; refuses to continue if the recorded `amiVersion` is not the
     machine's.
   - `heartbeat.ts`: every 20 seconds, `POST .../heartbeat` with the generation,
     a utilization sample (`/proc/meminfo`, `/proc/stat`, `df`, `dmesg` OOM
     lines, swap) and metered seconds; installs the renewed token for the
     engine's HTTP stores; on `stop: true` begins graceful shutdown (T6 completes
     it). Missing three heartbeats in a row from the runner's own side exits the
     process non-zero.
   - `users.ts`: creates `engine` (the runner's own user, created by the AMI)
     and `worker-<n>` users on demand with rootless Docker configured
     (`dockerd-rootless-setuptool.sh`), home on `/workspace/runs/<runId>/users/`;
     `nft` owner-match rule allowing IMDS (`169.254.169.254`) only for `engine`'s
     uid, applied at boot. The worker launch in `compose.ts` gains a
     `runAs?: string` the execution layer passes per worker (`setuid` via
     `sudo -u` with a sudoers rule for `engine` only, no password, no shell).
   - `main.ts`: bootstrap → mount check (`/workspace` present, T3 fills it) →
     heartbeat loop → (T3) workspace → (T4) headless root.
4. **Measurements on the real machine**, recorded in `docs/programs/p10-remote-runner.md`
   §15 as a table: rootless Docker runs `postgres:16` and a client connects over
   the user network; `docker build` of a small arm64 image succeeds; CDK
   bundling with `DockerImageAsset` under rootless Docker; Chromium launched by
   `playwright` under a worker user; `cargo build` of a hello world; cold boot
   to first heartbeat in seconds. Each row is pass, fail with the message, or
   not attempted, and a failed row names the project it affects (§14's audit).
5. **Scripts**: `npm run image:build` (triggers the pipeline, waits, prints the
   AMI id; asserts the account), `npm run runner:boot` (launches one `good`
   instance from the latest AMI with a throwaway dispatch, waits for the first
   heartbeat, terminates; prints the seconds). Both opt-in, never in CI.

## Acceptance

- `npm run verify`, `npm run check:architecture` and `npm run synth` green;
  the two stacks' tests enumerate every grant.
- `npm run image:build` produces an AMI; `npm run runner:boot` reaches a
  heartbeat and terminates cleanly.
- The measurement table is in the contract, every row filled, and the owner
  has seen any failed row before T3 begins.
