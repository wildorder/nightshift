#!/usr/bin/env node
/**
 * Routing and examination against the deployed control plane, with real
 * models, from a developer machine only (P8 T5, SC-P8-17).
 *
 *   AWS_PROFILE=nightshift npm run routing
 *
 * Refuses to start unless the profile resolves to the v1 account, and builds
 * first because the suite drives compiled output. Never part of `npm test`,
 * never in CI: it spends the operator's own Claude Code and Codex logins.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Routing as ${identity.arn} (${identity.account}, ${identity.region}).`);

const env = { ...process.env, AWS_REGION: EXPECTED_REGION, NIGHTSHIFT_SLICE_TARGET: "deployed" };
const run = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"]);
run("npx", ["vitest", "run", "--config", "apps/api/vitest.routing.config.ts"]);
console.log("\nRouting passed. The summary above goes in the contract's as-built.");
