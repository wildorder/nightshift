#!/usr/bin/env node
/**
 * The live walk-away fixture (P10, T8), from a developer machine only:
 *
 *   AWS_PROFILE=nightshift NIGHTSHIFT_SMOKE_ANTHROPIC_KEY=... npm run remote [-- --keep]
 *
 * The customer's way through the deployed plane, against the disposable fixture
 * repository: a throwaway org with the GitHub App's installation recorded and a
 * provider credential sealed, a ratified program, a dispatch on `good`. The
 * laptop is out of it from there: the proof only reads the record. The cold
 * run's machine is **terminated behind the runner's back** a little way into
 * the run; the lease lapses, the reconciler replaces the machine on the same
 * volume, the runner restores the sidecar's copy and the root resumes, and the
 * run must still end **published**, at the second generation. Then a warm run
 * comes up on the project's snapshot and the project's warm cache is checked.
 * Everything it made is removed; what could not be is listed. Refuses to start
 * outside the v1 account; never part of `npm test`.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(
  `Running the walk-away fixture as ${identity.arn} (${identity.account}, ${identity.region}).`,
);
if (!process.env.NIGHTSHIFT_SMOKE_ANTHROPIC_KEY) {
  console.error(
    "NIGHTSHIFT_SMOKE_ANTHROPIC_KEY is not set: the fixture runs a program to its end and needs a provider credential.",
  );
  process.exit(2);
}

const env = {
  ...process.env,
  AWS_REGION: EXPECTED_REGION,
  NIGHTSHIFT_SMOKE_BENCH_KILL: "1",
  // The fixture program is short: the machine is killed 45 s into `running`,
  // while the root is coming up or the worker has just started.
  NIGHTSHIFT_SMOKE_KILL_AFTER_SECONDS: process.env.NIGHTSHIFT_SMOKE_KILL_AFTER_SECONDS ?? "45",
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
