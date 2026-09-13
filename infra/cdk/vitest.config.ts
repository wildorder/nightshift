import { defineConfig } from "vitest/config";

// Project config for @nightshift/cdk. The root vitest config lists this
// directory as a project, and project configs do not inherit the root's `test`
// options, so the timeouts are repeated here: the first `Template.fromStack`
// call pays a one-off aws-cdk-lib load that exceeds vitest's 5s default on a
// cold CI runner.
export default defineConfig({
  test: {
    name: "@nightshift/cdk",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**"],
  },
});
