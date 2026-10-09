import type { ProgramContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { nightshiftToolNames, renderWorkerBrief, STRAND_DEPARTURE_PREFIX } from "./brief.js";

const build = (programOverrides: Partial<Record<keyof ProgramContract, unknown>> = {}) => {
  const f = createFixtures();
  const program = makeProgramContract(f, {
    constraints: ["Never widen the public API."],
    verification: [
      { id: "test", command: "node --test" },
      { id: "lint", command: "npm run lint" },
    ],
    ...programOverrides,
  });
  const job = makeJobContract(f, {
    objective: "Add a median helper.",
    acceptance: ["median([1,2,3]) is 2", "tests pass"],
  });
  const node = makeNode(f, f.rootNodeId);
  return { brief: renderWorkerBrief({ job, node, program, worktree: "/tmp/wt/x" }), job, program };
};

describe("renderWorkerBrief", () => {
  it("leads with the objective and lists every acceptance criterion", () => {
    const { brief } = build();
    expect(brief).toContain("Add a median helper.");
    expect(brief).toContain("1. median([1,2,3]) is 2");
    expect(brief).toContain("2. tests pass");
  });

  // The owner's ruling, 2026-10-09: no path scope, and the program's forbidden
  // actions told from the contract.
  it("tells the worker the program's forbidden actions, and to change whatever the job needs", () => {
    const { brief } = build({
      scope: {
        includes: ["src/math/**"],
        excludes: ["src/math/generated/**"],
        permissions: ["fs.read", "fs.write"],
        forbiddenActions: ["publish a package"],
      },
    });
    expect(brief).toContain("ACTIONS FORBIDDEN IN THIS PROGRAM");
    expect(brief).toContain("  - publish a package");
    expect(brief).toContain("Anywhere in this repository.");
    expect(brief).not.toContain("src/math/**");
    expect(brief).not.toContain("src/math/generated/**");
    expect(brief).not.toContain("fs.write");
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

  it("asks every worker to run the verification itself", () => {
    const { brief } = build();
    expect(brief).toContain("Run them yourself before reporting");
    expect(brief).not.toContain("You cannot run commands");
  });

  it("says nothing of forbidden actions when the program forbids none", () => {
    const { brief } = build({
      scope: { includes: ["src/**"], excludes: [], forbiddenActions: [] },
    });
    expect(brief).not.toContain("ACTIONS FORBIDDEN");
  });

  it("never mentions a provider", () => {
    const { brief } = build();
    for (const name of ["claude", "anthropic", "openai", "codex", "bedrock", "gpt"]) {
      expect(brief.toLowerCase()).not.toContain(name);
    }
  });

  it("renders empty lists as (none) rather than an empty bullet", () => {
    const { brief } = build({ constraints: [] });
    expect(brief).toContain("PROGRAM CONSTRAINTS\n  (none)");
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
    // For a repair of a gate alone (P15, D-P15-04): the tool refuses anything else.
    expect(nightshiftToolNames("program", planned)).toContain("delegate");
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
      "delegate { objective, acceptance, risk, ambiguity, testability, jobKind }",
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

describe("the program's rulings, as memory (P15)", () => {
  const ruling = {
    decisionId: "dec_01M4BHBEV4HGHTQQ419AD8BC58",
    runId: "run_01M4B8ZQ33D60K0AS9RBJ4Q6Y1",
    findingId: "F-01",
    finding: "Seeding trusts the reference's lockfiles, not its install marker.",
    rationale: "A failed reference setup leaves new lockfiles over an old tree.",
    paths: ["packages/verification/src/install.ts"],
    commitSha: "de4cae15fcd9b8965127f781962578a5cd5bad00",
    patchId: "0".repeat(40),
  };
  const briefFor = (kind: "job" | "sub-program", withRulings: boolean, examine = false) => {
    const f = createFixtures();
    const program = makeProgramContract(f);
    const job = makeJobContract(f);
    const node = makeNode(f, f.rootNodeId, { kind });
    return renderWorkerBrief({
      job,
      node,
      program,
      worktree: "/tmp/wt/x",
      ...(withRulings ? { rulings: [ruling] } : {}),
      ...(examine
        ? {
            task: {
              kind: "examine" as const,
              round: 1 as const,
              evidence: {
                diff: "",
                diffTruncated: false,
                changedTests: [],
                verification: [],
                risk: "high" as const,
                blocking: true,
                fixAttempt: 0,
              },
            },
          }
        : {}),
    });
  };

  it("tells a worker what has been decided, as context to follow where its job touches it", () => {
    const brief = briefFor("job", true);
    expect(brief).toContain("RULINGS ALREADY MADE IN THIS PROGRAM");
    expect(brief).toContain(`F-01 (${ruling.decisionId}, run ${ruling.runId}): ${ruling.finding}`);
    expect(brief).toContain(`Upheld because: ${ruling.rationale}`);
    expect(brief).toContain("Where: packages/verification/src/install.ts");
    expect(brief).toContain("context, not a task");
  });

  it("tells an orchestrator the work it delegates is examined against them", () => {
    expect(briefFor("sub-program", true)).toContain(
      "the work you delegate is examined against them",
    );
  });

  it("tells an examiner to hold the change to them where it applies, and to cite the ruling", () => {
    const brief = briefFor("job", true, true);
    expect(brief).toContain("a change that");
    expect(brief).toContain("contradicts it is a material finding; cite the ruling");
  });

  it("says nothing of rulings when the program has none", () => {
    expect(briefFor("job", false)).not.toContain("RULINGS ALREADY MADE");
  });
});

/**
 * The owner's ruling, 2026-10-09: a job carries no path scope. Every agent
 * Nightshift starts is told the program's forbidden actions, read from the
 * program contract, and no brief tells any agent what it may or may not change
 * by path.
 */
describe("every agent's brief, after jobs lost their path scope", () => {
  const f = createFixtures();
  const FORBIDDEN = ["deploy any stack", "push to main"];
  const strand = {
    id: "S-01",
    name: "The examiner",
    scope: {
      summary: "examination",
      includes: ["packages/execution/src/examine.ts"],
      excludes: ["packages/execution/src/flaky.ts"],
    },
    acceptance: ["green"],
    successCriteria: [],
    dependsOn: [],
    prerequisites: [],
  };
  const program = makeProgramContract(f, {
    status: "planning",
    strands: [strand],
    scope: {
      includes: ["packages/**"],
      excludes: ["packages/generated/**"],
      permissions: ["fs.read", "fs.write", "shell.exec"],
      forbiddenActions: FORBIDDEN,
    },
  });
  const job = makeJobContract(f);
  const repairJob = makeJobContract(f, {
    repair: { cause: "red_base", gates: ["test"], decisionId: f.ids.next("dec") },
  });
  const worker = makeNode(f, f.rootNodeId);
  const subProgram = makeNode(f, f.rootNodeId, { kind: "sub-program" });
  const evidence = {
    diff: "diff --git a/x b/x",
    diffTruncated: false,
    changedTests: [],
    verification: [],
    risk: "high" as const,
    blocking: true,
    fixAttempt: 0,
  };
  const finding = {
    id: "F-01",
    severity: "material" as const,
    summary: "It is wrong.",
    evidence: [{ kind: "contract" as const, clause: "acceptance 1" }],
    resolution: "disputed" as const,
  };
  const briefs: Record<string, string> = {
    worker: renderWorkerBrief({ job, node: worker, program, worktree: "/w" }),
    repair: renderWorkerBrief({ job: repairJob, node: worker, program, worktree: "/w" }),
    "sub-program orchestrator": renderWorkerBrief({
      job,
      node: subProgram,
      program,
      worktree: "/w",
    }),
    "strand orchestrator": renderWorkerBrief({
      job: makeJobContract(f, { strandId: "S-01" }),
      node: subProgram,
      program,
      worktree: "/w",
    }),
    root: renderWorkerBrief({
      job: makeJobContract(f, { objective: "# The plan" }),
      node: makeRootNode(f, { status: "validated" }),
      program,
      worktree: "/w",
    }),
    examiner: renderWorkerBrief({
      job,
      node: worker,
      program,
      worktree: "/w",
      task: { kind: "examine", round: 1, evidence },
    }),
    "repair examiner": renderWorkerBrief({
      job: repairJob,
      node: worker,
      program,
      worktree: "/w",
      task: { kind: "examine", round: 1, evidence },
    }),
    arbiter: renderWorkerBrief({
      job,
      node: worker,
      program,
      worktree: "/w",
      task: { kind: "arbitrate", finding, dispute: "It is right.", questions: [], diff: "" },
    }),
    answerer: renderWorkerBrief({
      job,
      node: worker,
      program,
      worktree: "/w",
      task: { kind: "answer", questions: ["Why?"] },
    }),
  };

  it.each(Object.keys(briefs))("tells the %s the program's forbidden actions", (role) => {
    const brief = briefs[role] as string;
    expect(brief).toContain("ACTIONS FORBIDDEN IN THIS PROGRAM");
    for (const action of FORBIDDEN) expect(brief).toContain(`  - ${action}`);
  });

  it.each(Object.keys(briefs))("never limits by path what the %s may change", (role) => {
    const brief = briefs[role] as string;
    for (const limit of [
      /you may change:/i,
      /may change: /i,
      /may delegate within/i,
      /outside (your|the|its) scope/i,
      /sit inside yours/i,
      /authority, not advice/i,
      /not yours to change/i,
      /scope violation/i,
      /permissions granted/i,
      /fs\.write|shell\.exec/,
      /packages\/generated\/\*\*/,
    ]) {
      expect(brief, `${role}: ${limit}`).not.toMatch(limit);
    }
  });

  it("tells a strand's orchestrator where the plan expects its work, as guidance and not a limit", () => {
    const brief = briefs["strand orchestrator"] as string;
    expect(brief).toContain("WHERE THE PLAN EXPECTS THIS STRAND'S WORK — guidance, not a limit");
    expect(brief).toContain("  - packages/execution/src/examine.ts");
    expect(brief).toContain(
      "This is not a limit: you and your jobs change whatever the work needs",
    );
    expect(briefs["sub-program orchestrator"]).not.toContain("WHERE THE PLAN EXPECTS");
  });
});
