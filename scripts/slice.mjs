#!/usr/bin/env node
/**
 * The deployed slice, from a developer machine only (T9 deliverable 4, T10).
 *
 *   AWS_PROFILE=nightshift npm run slice
 *
 * Three phases, in this order and for a reason: the **scripted** harness first,
 * then **Claude Code**, then **Codex** (P5). A failure in phase one is the
 * network or the control plane; a failure only in a later phase is that model
 * or its adapter. Running them together would make every failure ambiguous.
 *
 * Refuses to start unless the profile resolves to the v1 account, and builds
 * first because the suite drives compiled output — including the server binary
 * it spawns. Never part of `npm test`, never in CI.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Slicing as ${identity.arn} (${identity.account}, ${identity.region}).`);

const base = { ...process.env, AWS_REGION: EXPECTED_REGION, NIGHTSHIFT_SLICE_TARGET: "deployed" };

const run = (command, args, env) => {
  try {
    execFileSync(command, args, { stdio: "inherit", shell: SHELL, env });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
};

run("npm", ["run", "build"], base);

const phases = [
  ["scripted", "the scripted harness: a real worker process, no model"],
  ["claude", "Claude Code: a real model, on the operator's subscription"],
  ["codex", "Codex: a real model, on the operator's login (P5)"],
];

for (const [harness, description] of phases) {
  console.log(`\n=== slice phase: ${harness} — ${description}\n`);
  run("npx", ["vitest", "run", "--config", "apps/api/vitest.slice.config.ts"], {
    ...base,
    NIGHTSHIFT_SLICE_HARNESS: harness,
  });
}

// P6: the Stage 5 tree, with both real adapters and a real sub-orchestrator.
console.log("\n=== slice phase: tree — two harnesses at once, and a sub-program (P6)\n");
run("npx", ["vitest", "run", "--config", "apps/api/vitest.tree.config.ts"], base);

console.log("\nEvery slice phase passed. The run identifiers are printed above; read the");
console.log("lifecycle back with GET …/state and GET …/events using a fresh token.");
