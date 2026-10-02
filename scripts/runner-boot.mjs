#!/usr/bin/env node
/**
 * Two runs of the fixture repository on real machines, cold then warm (P10,
 * T3), from a developer machine only:
 *
 *   AWS_PROFILE=nightshift npm run runner:boot [-- --keep]
 *
 * Goes the customer's way through the deployed plane: a throwaway org with the
 * GitHub App's installation recorded, a ratified program against
 * `wildorder/nightshift-remote-fixture`, `POST …/dispatch` with the branch's
 * real head, and the dispatch Lambda doing the provisioning. Waits for `ready`
 * on each run, reads what setup took, cancels, waits for the reconciler's
 * snapshot, and prints the warm-to-cold setup ratio SC-P10-08 asks about. Then
 * removes everything it made. Refuses to start outside the v1 account; never
 * part of `npm test`.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(
  `Running the fixture remotely as ${identity.arn} (${identity.account}, ${identity.region}).`,
);

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
