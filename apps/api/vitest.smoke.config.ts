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
    // The P2 and P4 suites by name, not by pattern: `slice.smoke.ts` sits beside
    // them and has its own config and its own npm script. Running all three from
    // one command would make a slice failure look like a smoke failure.
    //
    // `fileParallelism: false` below matters here: both suites write memberships
    // for the machine principal, and running them at once would leave it in two
    // organisations, which is the one state the API cannot resolve.
    include: ["src/smoke/p2.smoke.ts", "src/smoke/p4-isolation.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // Real network calls, a stream consumer to wait on, and cleanup that scans.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    reporters: ["verbose"],
  },
});
