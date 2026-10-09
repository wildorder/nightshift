import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

export default defineProject({
  // D-02: "source" ahead of vite's defaults, not in place of them, so
  // @nightshift/* resolves from TypeScript source rather than dist. This
  // project has no config of its own to walk up from otherwise.
  resolve: {
    conditions: ["source", ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      // "module" dropped: see the root vitest.config.ts for why (AWS SDK v3 /
      // Smithy's own exports break under Node's native loader with it present).
      conditions: ["source", ...defaultServerConditions.filter((c) => c !== "module")],
    },
  },
  test: {
    /**
     * Name this project `test` so the root script `npm run check:architecture`
     * (`vitest run --project test`) selects it. Without an explicit name vitest
     * derives the project name from `package.json` — `@nightshift/test` — and
     * the `--project test` filter matches nothing at all, which would make the
     * architecture check silently run zero suites.
     */
    name: "test",
    /**
     * Never collect compiled output, and never the fixture repository.
     *
     * `fixtures/slice-repo/test/*.test.js` are the *fixture's own* tests, written
     * for `node --test` and run by the verification step inside a materialised
     * copy. Collecting them here would run a `node:test` file under vitest, which
     * fails for reasons that have nothing to do with anything.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
    /**
     * Project configs do not inherit the root's `test` options (AGENTS.md), so
     * these are restated rather than assumed.
     *
     * The slice and execution suites are why they are generous: each test spawns
     * an MCP server, a worker process, that worker's own MCP server and a
     * verification child, cuts a git worktree and runs `node --test` in it. A
     * minute is comfortable on a developer machine and not extravagant on a
     * cold Windows runner.
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
    /**
     * One file at a time.
     *
     * Every slice test binds a loopback port, spawns four processes and creates
     * git worktrees. Running files in parallel turns a CI runner into a fork
     * bomb and makes a flaky failure impossible to attribute. The suites are
     * seconds each; the serialism costs little and buys a readable failure.
     */
    fileParallelism: false,
  },
});
