/**
 * `@nightshift/verification` — deterministic verification.
 *
 * It runs the Program Contract's verification steps in a directory the caller
 * supplies and hands back per-step evidence: exit code, duration and the whole
 * captured output as bytes. It knows nothing about execution nodes, worktrees,
 * git or S3, and it writes no `Verification` record — that writer is the
 * execution layer and nothing else (D-P3-06), and the rule that turns a record
 * into a `verified` node lives in `core` (A-05). Three separate things.
 *
 * Node builtins are fair game here; a harness package, a provider SDK and the
 * persistence layer are not.
 */
export * from "./commands.js";
export * from "./defer.js";
export * from "./environment.js";
export * from "./install.js";
export * from "./rerun.js";
export * from "./run.js";
export * from "./setup.js";
export * from "./spawn.js";
