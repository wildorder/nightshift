import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    /**
     * Name this project `test` so the root script `npm run check:architecture`
     * (`vitest run --project test`) selects it. Without an explicit name vitest
     * derives the project name from `package.json` — `@nightshift/test` — and
     * the `--project test` filter matches nothing at all, which would make the
     * architecture check silently run zero suites.
     */
    name: "test",
    // Never collect compiled output; the build emits this package to dist/.
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
