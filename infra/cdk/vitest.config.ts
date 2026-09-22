import { defineConfig } from "vitest/config";

// Project config for @nightshift/cdk. The root vitest config lists this
// directory as a project, and project configs do not inherit the root's `test`
// options, so the timeouts are repeated here: the first `Template.fromStack`
// call pays a one-off aws-cdk-lib load that exceeds vitest's 5s default on a
// cold CI runner, and beat 20s on the Windows runner once the P7 suites ran
// beside it.
export default defineConfig({
  test: {
    name: "@nightshift/cdk",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**"],
  },
});
