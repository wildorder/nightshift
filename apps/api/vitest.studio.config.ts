import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The Studio's live suite's own config (P11, T2 deliverable 6). Separate from
 * `vitest.smoke.config.ts` so `npm run studio:smoke` and `npm run smoke` run
 * independently, and from the root config so `npm test` never loads it; the
 * file ends `.smoke.ts`, which no default include pattern matches, so `npm test`
 * stays credential-free either way.
 */
export default defineConfig({
  test: {
    name: "studio-smoke",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["src/smoke/studio.smoke.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // Real network calls, a CloudFront edge, and cleanup that scans.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    reporters: ["verbose"],
  },
});
