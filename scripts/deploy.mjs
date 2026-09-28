#!/usr/bin/env node
/**
 * Deploys every stack from a developer machine (D-P2-09). Never run in CI.
 *
 *   AWS_PROFILE=nightshift npm run deploy
 *   AWS_PROFILE=nightshift npm run deploy -- -c stage=dev --require-approval never
 *   AWS_PROFILE=nightshift npm run deploy -- nightshift-dns          # one stack only
 *   AWS_PROFILE=nightshift npm run deploy -- -c hostnames=zone-only  # first deploy (D-P3-18)
 *
 * Refuses to start unless the profile resolves to the v1 account. Builds the
 * workspace first, because synth bundles the functions from compiled output.
 * Arguments after `--` go to `cdk deploy`; the stage defaults to `dev`. Naming a
 * stack deploys that stack alone; otherwise every stack is deployed — the
 * Studio's certificate stack in `us-east-1` among them (P11, D-P11-02), which
 * needs that region bootstrapped once: `npx cdk bootstrap aws://755348349819/us-east-1`
 * from `infra/cdk`.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Deploying as ${identity.arn} (${identity.account}, ${identity.region}).`);

const passthrough = process.argv.slice(2);
const stageGiven = passthrough.some(
  (arg, i) => arg === "-c" && passthrough[i + 1]?.startsWith("stage="),
);
// A positional argument is a stack name. `-c stage=dev` and `--flag value` pairs
// are not positionals, so their values are skipped over.
const VALUED_FLAGS = new Set([
  "-c",
  "--context",
  "--require-approval",
  "--profile",
  "--toolkit-stack-name",
]);
const stackNamed = passthrough.some(
  (arg, i) => !arg.startsWith("-") && !(i > 0 && VALUED_FLAGS.has(passthrough[i - 1])),
);
const cdkArgs = [
  "cdk",
  "deploy",
  ...(stackNamed ? [] : ["--all"]),
  ...(stageGiven ? [] : ["-c", "stage=dev"]),
  ...passthrough,
];

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: SHELL });

run("npm", ["run", "build"], process.cwd());
run("npx", cdkArgs, "infra/cdk");
