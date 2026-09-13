import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One root project list so `npm test` at the root runs every suite.
    projects: ["packages/*", "apps/api", "apps/cli", "apps/mcp", "infra/cdk", "test"],
    // Skeleton packages legitimately hold no tests during P1 (SC-P1-08 requires
    // the empty suite to exit 0). Coverage of the invariants is enforced by the
    // named property tests in T7, not by requiring every package to have a file.
    passWithNoTests: true,
    // Never collect compiled output. The build excludes *.test.ts, so this is
    // belt-and-braces against a stray emitted test.
    exclude: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**"],
    // P1 tests are offline and deterministic; nothing should need longer.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ["default"],
  },
});
