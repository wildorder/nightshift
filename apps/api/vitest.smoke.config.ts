import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The smoke suite's own config (T7). Deliberately not named `vitest.config.ts`,
 * so the root project list behind `npm test` never loads it, and the suite's
 * files end in `.smoke.ts`, which no default include pattern matches. `npm test`
 * stays credential-free.
 */
export default defineConfig({
  test: {
    name: "smoke",
    root: fileURLToPath(new URL(".", import.meta.url)),
    // The P2 suite by name, not by pattern: `slice.smoke.ts` sits beside it and
    // has its own config and its own npm script. Running both from one command
    // would make a slice failure look like a smoke failure.
    include: ["src/smoke/p2.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // Real network calls, a stream consumer to wait on, and cleanup that scans.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    reporters: ["verbose"],
  },
});
