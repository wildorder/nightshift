#!/usr/bin/env node
/**
 * Boot one runner machine from the latest image and watch it heartbeat (P10,
 * T2), from a developer machine only:
 *
 *   AWS_PROFILE=nightshift npm run runner:boot [-- --keep]
 *
 * Seeds a throwaway ratified program and a remote run in the deployed plane,
 * dispatches it on `good`, does what the dispatch Lambda will do in T3 (a
 * volume, a first engine token in SSM, a machine from the launch template),
 * waits for the runner's `ready` heartbeat, measures the machine (rootless
 * Docker, a browser, Rust) over SSM, cancels, and removes what it made. The
 * seconds from launch to the first heartbeat are printed. Refuses to start
 * outside the v1 account; never part of `npm test`.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Booting a runner as ${identity.arn} (${identity.account}, ${identity.region}).`);

const env = {
  ...process.env,
  AWS_REGION: EXPECTED_REGION,
  ...(process.argv.includes("--keep") ? { NIGHTSHIFT_RUNNER_BOOT_KEEP: "1" } : {}),
};
const run = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"]);
run("npx", ["vitest", "run", "--config", "apps/api/vitest.runner-boot.config.ts"]);
