import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

/**
 * Project configs do not inherit the root's `test` options (AGENTS.md), so
 * the exclusions are restated. The resolve conditions (D-02) are restated
 * too: this project has no config of its own to walk up from otherwise, and
 * needs "source" ahead of vite's defaults to resolve @nightshift/* from
 * their TypeScript sources rather than dist.
 */
export default defineProject({
  resolve: {
    conditions: ["source", ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      // "module" dropped: see the root vitest.config.ts for why (AWS SDK v3 /
      // Smithy's own exports break under Node's native loader with it present).
      conditions: ["source", ...defaultServerConditions.filter((c) => c !== "module")],
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
