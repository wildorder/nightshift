import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

/**
 * The Studio's suite runs in jsdom (D-P11-09), over the memory stores: no
 * browser, no control plane, no network. Project configs do not inherit the
 * root's `test` options (AGENTS.md), so the timeouts and exclusions are restated.
 * The "source" resolve condition (D-02) is prepended to vite's defaults, not
 * substituted for them, so @nightshift/* resolves from TypeScript source.
 */
export default defineProject({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
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
    name: "studio",
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
