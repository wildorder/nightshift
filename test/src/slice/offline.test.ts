/**
 * SC-P3-14 and SC-P3-15: what `npm test` is allowed to need.
 *
 * SC-P3-15 is a claim about the *suite itself*, not about Nightshift: that the
 * whole slice runs with no credentials, no Claude Code sign-in, and no endpoint
 * other than loopback. It is the difference between a proof and a demonstration
 * — a suite that quietly required an AWS profile would pass on the author's
 * machine and nowhere else, and would stop being run.
 *
 * SC-P3-14 is proved by the architecture suite; this file names where, so a
 * reader following the success criteria finds it rather than concluding nobody
 * checked.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ARCHITECTURE_RULES, loadRepo } from "../architecture/rules.js";
import { configuredUrls, createLocalContext, type SliceContext, sliceTarget } from "./context.js";

let context: SliceContext | undefined;

afterEach(async () => {
  await context?.close().catch(() => {});
  context = undefined;
});

describe("SC-P3-15: the offline slice needs nothing but loopback", () => {
  it("configures the server with a 127.0.0.1 endpoint and no other", async () => {
    context = await createLocalContext();
    const urls = configuredUrls(context);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).hostname, url).toBe("127.0.0.1");
    }
  });

  it("hands the server no AWS credential and no token that is worth anything", async () => {
    context = await createLocalContext();
    for (const [name, value] of Object.entries(context.serverEnv)) {
      expect(name.startsWith("AWS_"), `${name} is an AWS variable`).toBe(false);
      expect(value).not.toMatch(/^ASIA|^AKIA/);
    }
    // The local plane ignores the Authorization header entirely: the token it is
    // given is a placeholder, and saying so is the point.
    expect(context.serverEnv.NIGHTSHIFT_API_TOKEN).toContain("ignored");
  });

  it("defaults to the local target, so `npm test` never reaches the deployed stack", () => {
    // Set deliberately by `npm run slice`, and by nothing else.
    expect(sliceTarget()).toBe(
      process.env.NIGHTSHIFT_SLICE_TARGET === "deployed" ? "deployed" : "local",
    );
    if (process.env.NIGHTSHIFT_SLICE_TARGET === undefined) expect(sliceTarget()).toBe("local");
  });

  it("puts every worktree and spool under a temporary state directory, never the checkout", async () => {
    context = await createLocalContext();
    const stateDir = context.serverEnv.NIGHTSHIFT_STATE_DIR;
    expect(stateDir).toBeDefined();
    expect(String(stateDir).startsWith(context.fixture.repo)).toBe(false);
    expect(String(stateDir)).toBe(context.fixture.stateDir);
  });
});

describe("SC-P3-14: no harness-specific import above the adapter layer", () => {
  /**
   * The real check is AR-2 in `test/src/architecture/`, run over the tracked
   * tree by `architecture.test.ts` and over synthetic violating trees by
   * `negative-fixtures.test.ts`. Repeated here as a pointer, and as a guard
   * against the rule being deleted rather than merely weakened.
   */
  it("is enforced by AR-2, over this repository, right now", () => {
    const rule = ARCHITECTURE_RULES.find((candidate) => candidate.id === "AR-2");
    expect(rule, "AR-2 has been removed").toBeDefined();
    expect(rule?.check(loadRepo())).toEqual([]);
  });

  it("still forbids an adapter import outside a composition root", () => {
    const rule = ARCHITECTURE_RULES.find((candidate) => candidate.id === "AR-2");
    // A synthetic violation, so a rule that had silently stopped detecting
    // anything fails here too.
    const violations = rule?.check({
      sources: [
        {
          path: "packages/execution/src/runner.ts",
          text: 'import { createClaudeHarness } from "@nightshift/harness-claude";',
        },
      ],
      manifests: [],
      tsconfigs: [],
    });
    expect(violations).toHaveLength(1);
  });
});
