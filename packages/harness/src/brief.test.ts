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

  it("tells a sub-program's orchestrator how to classify, and what each examination ending asks of it (P8)", () => {
    // The owner's first planned runs showed a strand orchestrator never claiming
    // low ambiguity and redelegating a stopped job: it reads this, not the skill.
    const brief = renderWorkerBrief({
      job: makeJobContract(f, { strandId: "S-01" }),
      node: makeNode(f, f.rootNodeId, { kind: "sub-program" }),
      program: planned,
      worktree: "/tmp/w",
    });
    expect(brief).toContain(
      "delegate { objective, scope, acceptance, risk, ambiguity, testability, jobKind }",
    );
    expect(brief).toContain("low when your objective and acceptance say exactly what to change");
    for (const ending of [
      "examination_failed",
      "examination_upheld",
      "examination_ruling_unmet",
      "finding.dispute",
    ]) {
      expect(brief, ending).toContain(ending);
    }
    expect(brief).toContain("Do NOT");
    expect(brief).toContain("delegate the same work again as a new job");
  });
});

describe("headless sessions", () => {
  const f = createFixtures();
  const program = makeProgramContract(f);
  const job = makeJobContract(f);

  it("tells every role not to end its turn before its own finishing call", () => {
    const worker = renderWorkerBrief({
      job,
      node: makeNode(f, f.rootNodeId),
      program,
      worktree: "/tmp/w",
    });
    const orchestrator = renderWorkerBrief({
      job,
      node: makeNode(f, f.rootNodeId, { kind: "sub-program" }),
      program,
      worktree: "/tmp/w",
    });
    for (const brief of [worker, orchestrator]) {
      expect(brief).toContain("NOBODY WILL PROMPT YOU AGAIN");
      expect(brief).toContain("stopped with it");
    }
    expect(worker).toContain("job.complete or job.fail: a session that ends");
    expect(orchestrator).toContain("subprogram.complete or subprogram.fail: a session that ends");
  });

  it("resumes a session that stopped without reporting with a reminder, not the whole brief", () => {
    const brief = renderWorkerBrief({
      job,
      node: makeNode(f, f.rootNodeId),
      program,
      worktree: "/tmp/w",
      task: { kind: "continue", reminder: 1, of: 2 },
    });
    expect(brief).toContain("you have not reported how your work ended");
    expect(brief).toContain("run it again and wait for it");
    expect(brief).toContain("job.complete or job.fail");
    expect(brief).toContain("reminder 1 of 2");
    expect(brief).not.toContain("ACCEPTANCE CRITERIA");
  });

  it("says where a dead attempt's work is, applied or not", () => {
    const carried = {
      fromAttempt: 1,
      ref: "refs/nightshift/unfinished/n/1",
      paths: ["src/a.ts"],
      patchPath: "/state/wt.attempt-1.patch",
    };
    const applied = renderWorkerBrief({
      job,
      node: makeNode(f, f.rootNodeId),
      program,
      worktree: "/tmp/w",
      carriedOver: { ...carried, applied: true, conflicts: [] },
    });
    expect(applied).toContain("THE LAST ATTEMPT'S UNFINISHED WORK");
    expect(applied).toContain("already in your working directory");
    expect(applied).toContain("src/a.ts");
    const conflicted = renderWorkerBrief({
      job,
      node: makeNode(f, f.rootNodeId),
      program,
      worktree: "/tmp/w",
      carriedOver: { ...carried, applied: false, conflicts: ["src/a.ts"] },
    });
    expect(conflicted).toContain("did not apply cleanly");
    expect(conflicted).toContain("/state/wt.attempt-1.patch");
  });

  it("names the setup that prepared the worktree", () => {
    const brief = renderWorkerBrief({
      job,
      node: makeNode(f, f.rootNodeId),
      program: { ...program, setup: [{ id: "install", command: "npm ci" }] },
      worktree: "/tmp/w",
    });
    expect(brief).toContain("prepared this worktree with the program's");
    expect(brief).toContain("install: npm ci");
  });
});
