import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The live decision and correction run's own config (P9 T5, SC-P9-12).
 *
 * Separate so `npm run correction` runs alone and `npm test` never loads it: the
 * file ends `.smoke.ts`, which no default include pattern matches.
 */
export default defineConfig({
  test: {
    name: "correction",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["src/smoke/correction.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Real workers, and a retry at resume: it can take a while.
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    reporters: ["verbose"],
  },
});
