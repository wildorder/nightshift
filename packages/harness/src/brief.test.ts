import type { ExecutionNode } from "@nightshift/contracts";
import { createFixtures, makeJobContract, makeNode, makeProgramContract } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { renderWorkerBrief } from "./brief.js";

const build = (nodeOverrides: Partial<Record<keyof ExecutionNode, unknown>> = {}) => {
  const f = createFixtures();
  const program = makeProgramContract(f, {
    constraints: ["Never widen the public API."],
    verification: [
      { id: "test", command: "node --test" },
      { id: "lint", command: "npm run lint" },
    ],
  });
  const job = makeJobContract(f, {
    objective: "Add a median helper.",
    acceptance: ["median([1,2,3]) is 2", "tests pass"],
  });
  const node = makeNode(f, f.rootNodeId, nodeOverrides);
  return { brief: renderWorkerBrief({ job, node, program, worktree: "/tmp/wt/x" }), job, program };
};

describe("renderWorkerBrief", () => {
  it("leads with the objective and lists every acceptance criterion", () => {
    const { brief } = build();
    expect(brief).toContain("Add a median helper.");
    expect(brief).toContain("1. median([1,2,3]) is 2");
    expect(brief).toContain("2. tests pass");
  });

  it("states the effective scope, not the requested one", () => {
    const { brief } = build({
      scope: {
        includes: ["src/math/**"],
        excludes: ["src/math/generated/**"],
        permissions: ["fs.read", "fs.write"],
        forbiddenActions: ["publish a package"],
      },
    });
    expect(brief).toContain("src/math/**");
    expect(brief).toContain("src/math/generated/**");
    expect(brief).toContain("publish a package");
  });

  it("tells the worker never to commit, and names the git verbs", () => {
    const { brief } = build();
    expect(brief).toContain("do not commit");
    expect(brief).toContain("git commit");
    expect(brief).toContain("git push");
  });

  it("names both terminal tools and says what silence costs", () => {
    const { brief } = build();
    expect(brief).toContain("job.complete");
    expect(brief).toContain("job.fail");
    expect(brief).toContain("Exiting without calling job.complete or job.fail");
  });

  it("lists the verification commands the work will actually face", () => {
    const { brief } = build();
    expect(brief).toContain("test: node --test");
    expect(brief).toContain("lint: npm run lint");
  });

  it("asks a worker with shell.exec to run the verification itself", () => {
    const { brief } = build({
      scope: {
        includes: ["src/**"],
        excludes: [],
        permissions: ["fs.read", "fs.write", "shell.exec"],
        forbiddenActions: [],
      },
    });
    expect(brief).toContain("Run them yourself before reporting");
  });

  it("tells a worker without shell.exec that it cannot check them", () => {
    const { brief } = build({
      scope: {
        includes: ["src/**"],
        excludes: [],
        permissions: ["fs.read", "fs.write"],
        forbiddenActions: [],
      },
    });
    expect(brief).toContain("You cannot run commands");
  });

  it("never mentions a provider", () => {
    const { brief } = build();
    for (const name of ["claude", "anthropic", "openai", "codex", "bedrock", "gpt"]) {
      expect(brief.toLowerCase()).not.toContain(name);
    }
  });

  it("renders empty lists as (none) rather than an empty bullet", () => {
    const { brief } = build({
      scope: { includes: ["src/**"], excludes: [], permissions: [], forbiddenActions: [] },
    });
    expect(brief).toContain("(none)");
  });
});
