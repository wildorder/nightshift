#!/usr/bin/env node
/**
 * Deploys both stacks from a developer machine (D-P2-09). Never run in CI.
 *
 *   AWS_PROFILE=nightshift npm run deploy
 *   AWS_PROFILE=nightshift npm run deploy -- -c stage=dev --require-approval never
 *
 * Refuses to start unless the profile resolves to the v1 account. Builds the
 * workspace first, because synth bundles the functions from compiled output.
 * Arguments after `--` go to `cdk deploy`; the stage defaults to `dev`.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Deploying as ${identity.arn} (${identity.account}, ${identity.region}).`);

const passthrough = process.argv.slice(2);
const stageGiven = passthrough.some(
  (arg, i) => arg === "-c" && passthrough[i + 1]?.startsWith("stage="),
);
const cdkArgs = [
  "cdk",
  "deploy",
  "--all",
  ...(stageGiven ? [] : ["-c", "stage=dev"]),
  ...passthrough,
];

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: SHELL });

run("npm", ["run", "build"], process.cwd());
run("npx", cdkArgs, "infra/cdk");
