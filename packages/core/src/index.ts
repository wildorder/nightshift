/**
 * `@nightshift/core` — the pure domain.
 *
 * No I/O, no network, no filesystem, no AWS, no MCP, no harness. Time and
 * randomness arrive as injected parameters, so every rule here is deterministic
 * and every test runs offline (architecture §1, SC-P1-18).
 *
 * What lives here: the rules that decide whether something is *legal*. What does
 * not: anything that decides what to *do* about it. Scheduling, worktrees and
 * integration are the execution layer's job.
 */
export * from "./errors.js";
export * from "./ids.js";
export * from "./ports/index.js";
export * from "./rules/index.js";
export * from "./testing/index.js";
export * from "./time.js";
