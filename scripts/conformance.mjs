#!/usr/bin/env node
/**
 * Harness conformance against the deployed control plane, from a developer
 * machine only (P5 T5, D-P5-03).
 *
 *   AWS_PROFILE=nightshift npm run conformance -- --harness claude|codex|all
 *
 * One adapter per phase, in sequence: the fixture's identifiers are per-run but
 * the machine principal's membership is not, so two runs must not overlap.
 * Refuses to start unless the profile resolves to the v1 account, and builds
 * first because the suite drives compiled output. Never part of `npm test`,
 * never in CI: it spends the operator's own Claude Code and Codex logins.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const HARNESSES = ["claude", "codex"];

const flag = process.argv.indexOf("--harness");
const requested = flag === -1 ? "all" : process.argv[flag + 1];
if (requested !== "all" && !HARNESSES.includes(requested)) {
  console.error(`--harness must be one of: ${[...HARNESSES, "all"].join(", ")}`);
  process.exit(2);
}

const identity = assertNightshiftAccount();
console.log(`Conformance as ${identity.arn} (${identity.account}, ${identity.region}).`);

const base = { ...process.env, AWS_REGION: EXPECTED_REGION, NIGHTSHIFT_SLICE_TARGET: "deployed" };

const run = (command, args, env) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"], base);

for (const harness of requested === "all" ? HARNESSES : [requested]) {
  console.log(`\n=== conformance: ${harness}\n`);
  run("npx", ["vitest", "run", "--config", "apps/api/vitest.conformance.config.ts"], {
    ...base,
    NIGHTSHIFT_CONFORMANCE_HARNESS: harness,
  });
}

console.log("\nConformance passed. The per-job lines above go in the contract's as-built.");
