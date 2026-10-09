import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // D-02: resolve workspace packages from source, not dist, so a test sees a
  // source change without a build first. The "source" condition is prepended
  // rather than replacing vite's defaults (which `resolve.conditions` would
  // otherwise do), and both the client and server (SSR/node) condition lists
  // are covered since vitest executes tests through the SSR pipeline.
  resolve: {
    conditions: ["source", ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      // "module" is dropped from vite's server defaults here: several AWS SDK
      // v3 / Smithy packages list a "module" condition before "node" in their
      // own subpath exports, pointing at an extensionless ESM-for-bundlers
      // build that Node's native loader (which Vitest hands externalized
      // dependencies to) cannot resolve. Node has no built-in "module"
      // condition; dropping it restores their working "node"/"import" branch.
      conditions: ["source", ...defaultServerConditions.filter((c) => c !== "module")],
    },
  },
  test: {
    // One root project list so `npm test` at the root runs every suite.
    projects: [
      // The packages have no configuration of their own and inherit this one:
      // a glob would give each of them vitest's defaults instead, among them a
      // five-second test timeout that a real-git test under the full suite's
      // load overran (2026-10-04). The apps carry their own configurations.
      { extends: true, test: { name: "contracts", root: "packages/contracts" } },
      { extends: true, test: { name: "core", root: "packages/core" } },
      { extends: true, test: { name: "execution", root: "packages/execution" } },
      { extends: true, test: { name: "harness", root: "packages/harness" } },
      { extends: true, test: { name: "harness-agentcore", root: "packages/harness-agentcore" } },
      { extends: true, test: { name: "harness-claude", root: "packages/harness-claude" } },
      { extends: true, test: { name: "harness-codex", root: "packages/harness-codex" } },
      { extends: true, test: { name: "persistence", root: "packages/persistence" } },
      { extends: true, test: { name: "routing", root: "packages/routing" } },
      { extends: true, test: { name: "verification", root: "packages/verification" } },
      "apps/api",
      "apps/cli",
      "apps/mcp",
      "apps/studio",
      "infra/cdk",
      "test",
    ],
    // Skeleton packages legitimately hold no tests during P1 (SC-P1-08 requires
    // the empty suite to exit 0). Coverage of the invariants is enforced by the
    // named property tests in T7, not by requiring every package to have a file.
    passWithNoTests: true,
    // Never collect compiled output. The build excludes *.test.ts, so this is
    // belt-and-braces against a stray emitted test.
    // `**/fixtures/**` keeps the slice fixture's own `node --test` files out:
    // they are run by a verification step inside a materialised copy, never here.
    exclude: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**", "**/fixtures/**"],
    // P1 tests are offline and deterministic; nothing should need longer.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ["default"],
  },
});
