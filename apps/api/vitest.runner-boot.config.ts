import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The runner's boot proof (P10, T2), by name and alone: it launches a real
 * machine in the v1 account, so it has its own script (`npm run runner:boot`)
 * and never runs with the smoke suites.
 */
export default defineConfig({
  test: {
    name: "runner-boot",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["src/smoke/runner-boot.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // A machine boots, builds nothing, and heartbeats: minutes, not seconds.
    testTimeout: 20 * 60_000,
    hookTimeout: 10 * 60_000,
    reporters: ["verbose"],
  },
});
