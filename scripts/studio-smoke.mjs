#!/usr/bin/env node
/**
 * The Studio's live suite against the deployed stage (P11, T2 deliverable 6;
 * SC-P11-08, SC-P11-09, SC-P11-11). Opt-in, from a developer machine only;
 * never part of `npm test` and never run in CI.
 *
 *   AWS_PROFILE=nightshift npm run studio:smoke
 *   AWS_PROFILE=nightshift NIGHTSHIFT_STAGE=dev npm run studio:smoke
 *
 * Refuses to start unless the profile resolves to the v1 account, builds the
 * workspace (the suite imports built packages), then runs vitest with the
 * Studio smoke config. Exits with the suite's status.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Studio smoke testing as ${identity.arn} (${identity.account}, ${identity.region}).`);

const env = { ...process.env, AWS_REGION: EXPECTED_REGION };
const run = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"]);
run("npx", ["vitest", "run", "--config", "apps/api/vitest.studio.config.ts"]);
