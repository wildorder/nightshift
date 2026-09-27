import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The live routing and examination run's own config (P8 T5, SC-P8-17).
 *
 * Separate so `npm run routing` runs alone and `npm test` never loads it: the
 * file ends `.smoke.ts`, which no default include pattern matches.
 */
export default defineConfig({
  test: {
    name: "routing",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["src/smoke/routing.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Real models, examiners and arbiters: a high-risk phase can take a while.
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    reporters: ["verbose"],
  },
});
