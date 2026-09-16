#!/usr/bin/env node
/**
 * The operator bootstrap, from a developer machine only (T2, D-P3-16).
 *
 *   AWS_PROFILE=nightshift npm run admin:user -- --email you@example.com
 *
 * Refuses to start unless the profile resolves to the v1 account, builds the
 * workspace (the script runs from compiled output, like every AWS-touching
 * script), then runs it with stdio inherited so the password prompt has a real
 * terminal. Never part of `npm test`, never in CI.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Bootstrapping as ${identity.arn} (${identity.account}, ${identity.region}).`);

const env = { ...process.env, AWS_REGION: EXPECTED_REGION };
const run = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"]);
run("node", ["apps/api/dist/admin/user.js", ...process.argv.slice(2)]);
