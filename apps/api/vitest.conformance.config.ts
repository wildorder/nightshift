import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The deployed conformance run's own config (P5 T5).
 *
 * Deliberately separate from the smoke and slice configs so each of `npm run
 * smoke`, `npm run slice` and `npm run conformance` runs alone, and separate from the root config so
 * `npm test` never loads it. The file ends `.smoke.ts`, which no default include
 * pattern matches, so `npm test` stays credential-free either way.
 */
export default defineConfig({
  test: {
    name: "conformance",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["src/smoke/conformance.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // A real model, a real network and a real verification run. The Claude leg
    // is the long one; the scripted leg finishes in seconds.
    testTimeout: 900_000,
    hookTimeout: 300_000,
    reporters: ["verbose"],
  },
});
