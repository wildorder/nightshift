#!/usr/bin/env node
/**
 * Runs the P2 smoke suite against the deployed stacks (T7, D-P2-12). Opt-in, from
 * a developer machine only; never part of `npm test` and never run in CI.
 *
 *   AWS_PROFILE=nightshift npm run smoke
 *   AWS_PROFILE=nightshift NIGHTSHIFT_STAGE=dev npm run smoke
 *
 * Refuses to start unless the profile resolves to the v1 account, builds the
 * workspace (the suite imports built packages), then runs vitest with the smoke
 * config. Exits with the suite's status.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Smoke testing as ${identity.arn} (${identity.account}, ${identity.region}).`);

const env = { ...process.env, AWS_REGION: EXPECTED_REGION };
const run = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"]);
run("npx", ["vitest", "run", "--config", "apps/api/vitest.smoke.config.ts"]);
