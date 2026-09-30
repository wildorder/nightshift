import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

/**
 * The Studio's suite runs in jsdom (D-P11-09), over the memory stores: no
 * browser, no control plane, no network. Project configs do not inherit the
 * root's `test` options (AGENTS.md), so the timeouts and exclusions are restated.
 */
export default defineProject({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
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
