import type { ExecutionNode } from "@nightshift/contracts";
import {
  createFixtures,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { nightshiftToolNames, renderWorkerBrief, STRAND_DEPARTURE_PREFIX } from "./brief.js";

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

describe("the plan-following briefs (P7, D-P7-09)", () => {
  const f = createFixtures();
  const strand = (id: string, dependsOn: string[] = []) => ({
    id,
    name: `Strand ${id}`,
    scope: { summary: id, includes: ["src/**"], excludes: [] },
    acceptance: ["green"],
    successCriteria: [],
    dependsOn,
    prerequisites: id === "S-02" ? ["HP-01"] : [],
  });
  const planned = makeProgramContract(f, {
    status: "planning",
    strands: [strand("S-01"), strand("S-02", ["S-01"])],
    decisions: [
      {
        id: "D-01",
        question: "REST or RPC?",
        options: ["REST", "RPC"],
        answer: "REST",
        touches: "all",
      },
      { id: "D-02", question: "Unanswered?", options: ["y", "n"], touches: "all" },
    ],
  });
  const root = makeRootNode(f, { status: "validated" });

  it("tells the root of a planned run to delegate every strand, wait, and finish truthfully", () => {
    const brief = renderWorkerBrief({
      job: makeJobContract(f, { objective: "# The plan\n\n### S-01 First\n\nA module." }),
      node: root,
      program: planned,
      worktree: "/tmp/read-only",
    });
    expect(brief).toContain(`nightshift run.attach { runId: "${root.runId}"`);
    expect(brief).toContain("S-02 Strand S-02\n    depends on: S-01\n    needs: HP-01");
    expect(brief).toContain("nightshift strand.delegate { strandId }");
    expect(brief).toContain("YOU DO NOT WRITE CODE, AND YOU DO NOT PLAN JOBS");
    expect(brief).toContain("D-01: REST or RPC? → REST");
    expect(brief).not.toContain("D-02");
    // The plan as ratified, whole, is part of the brief.
    expect(brief).toContain("THE PLAN, AS RATIFIED\n\n# The plan\n\n### S-01 First\n\nA module.");
    expect(nightshiftToolNames("program", planned)).toContain("strand.delegate");
    expect(nightshiftToolNames("program", planned)).not.toContain("delegate");
  });

  it("leaves a program node of an unplanned contract exactly as it was", () => {
    const plain = makeProgramContract(f);
    const brief = renderWorkerBrief({
      job: makeJobContract(f),
      node: root,
      program: plain,
      worktree: "/tmp/w",
    });
    expect(brief).toContain("You are a Nightshift worker.");
    expect(nightshiftToolNames("program", plain)).toEqual(nightshiftToolNames("job"));
    expect(nightshiftToolNames("program")).toEqual(nightshiftToolNames("job"));
  });

  it("tells a strand's orchestrator how to record a departure, and nobody else", () => {
    const node = makeNode(f, f.rootNodeId, { kind: "sub-program" });
    const asStrand = renderWorkerBrief({
      job: makeJobContract(f, { strandId: "S-01" }),
      node,
      program: planned,
      worktree: "/tmp/w",
    });
    expect(asStrand).toContain("YOU ARE STRAND S-01 OF A PLAN A HUMAN RATIFIED");
    expect(asStrand).toContain(`context: "${STRAND_DEPARTURE_PREFIX} `);
    const plain = renderWorkerBrief({
      job: makeJobContract(f),
      node,
      program: planned,
      worktree: "/tmp/w",
    });
    expect(plain).not.toContain("A PLAN A HUMAN RATIFIED");
  });
});
