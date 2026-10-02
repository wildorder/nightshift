import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The runner's live proof (P10, T2 and T3), by name and alone: it launches real
 * machines in the v1 account, so it has its own script (`npm run runner:boot`)
 * and never runs with the smoke suites.
 */
export default defineConfig({
  test: {
    name: "runner-boot",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["src/smoke/runner-boot.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // Two machines boot, install, stop and are snapshotted in turn: an hour at
    // the outside, not minutes.
    testTimeout: 60 * 60_000,
    hookTimeout: 15 * 60_000,
    reporters: ["verbose"],
  },
});
