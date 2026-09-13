/**
 * `@nightshift/contracts` — versioned domain schemas and types.
 *
 * Imports nothing but zod. No AWS SDK, no MCP SDK, no harness, no Node builtin,
 * no network (architecture §1). The future Studio is a browser client of these
 * same contracts, which is why nothing here assumes a Node runtime.
 *
 * Schemas are exported both at the top level (the current version) and under
 * the `v1` namespace (explicit version pinning), so a later v2 can be
 * introduced beside v1 without breaking either caller.
 */

export * from "./ids.js";
export * as v1 from "./v1/index.js";
export * from "./v1/index.js";
