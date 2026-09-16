#!/usr/bin/env node
/**
 * The `nightshift` binary.
 *
 * Runs from `dist`, so there is no TypeScript loader between an operator and
 * their CLI. Everything it does is in {@link runCli}; this file exists to hold
 * the three things a test must never touch — `process.argv`, the ambient
 * environment, and `process.exitCode`.
 */
import { runCli } from "../cli.js";
import { createCliEnvironment } from "../environment.js";

const environment = createCliEnvironment();

runCli(environment, process.argv.slice(2))
  .then((code) => {
    // Set rather than `process.exit`, so a pending write to a slow stdout (a
    // pipe into `less`, say) is flushed instead of truncated.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // `runCli` handles its own failures, so reaching here is a bug in the CLI
    // rather than something the operator did.
    environment.err(
      `nightshift: internal_error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
