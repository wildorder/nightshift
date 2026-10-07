/**
 * `nightshift decision reverse`, `decision brief`, `report`, and `plan check`
 * on a correction (P9, D-P9-02 … D-P9-06, SC-P9-03 … SC-P9-07), through the real
 * CLI against the real handler, over a real git repository.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@nightshift/cli";
import type { Decision, ProgramContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeCheckpoint,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordHealthyGates } from "./gate-health.js";
import { type Operator, signIn } from "./operator.js";

let op: Operator;
let repo: string;

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();

beforeEach(async () => {
  op = await signIn();
  repo = await mkdtemp(join(tmpdir(), "nightshift-decision-"));
  git("init", "-q", "--initial-branch=main");
  await writeFile(join(repo, "README.md"), "start\n");
  git("add", "-A");
  git("commit", "-qm", "start");
});

afterEach(async () => {
  await op.cleanup();
  await rm(repo, { recursive: true, force: true });
});

const commitFile = async (path: string, subject: string): Promise<string> => {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), `${subject}\n`);
  git("add", "-A");
  git("commit", "-qm", subject);
  return git("rev-parse", "HEAD");
};

const PLAN = "# Demo\n\n## Strands\n\n### S-01 The store\n\nKeep orders in one table.\n";

/** A finished run with a plan decision and an orchestrator's decision, the latter stamped. */
const seed = async (reversibility: Decision["reversibility"] = "reversible") => {
  const stores = createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("unused"),
    }),
  });
  const f = createFixtures();
  await stores.projects.put({
    schemaVersion: 1,
    projectId: f.scope.projectId,
    orgId: op.orgId,
    name: "decisions",
    createdAt: "2026-09-27T10:00:00.000Z",
  });
  const program: ProgramContract = makeProgramContract(f, {
    repository: { url: repo, baseBranch: "main", programBranch: "main" },
  });
  await stores.programContracts.put(program);
  const root = makeRootNode(f);
  await stores.runs.put(makeRun(f, { rootNodeId: root.executionNodeId }));
  await stores.executionNodes.put(root);
  const node = makeNode(f, root.executionNodeId);
  await stores.executionNodes.put(node);

  const before = git("rev-parse", "HEAD");
  const checkpoint = makeCheckpoint(f, root.executionNodeId, { commitSha: before as never });
  await stores.checkpoints.put(checkpoint);
  const produced = await commitFile("src/orders.js", "one table for orders");
  const later = await commitFile("src/report.js", "a report over orders");

  const decision: Decision = {
    schemaVersion: 1,
    ...f.scope,
    decisionId: f.ids.next("dec"),
    executionNodeId: node.executionNodeId,
    agentId: null,
    context: "How to store orders",
    alternatives: [{ summary: "a table per region", rejectedBecause: "more to migrate" }],
    choice: "one table",
    rationale: "simplest",
    reversibility,
    checkpointBefore: checkpoint.checkpointId,
    produced: { commits: [produced as never] },
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: "2026-09-27T10:01:00.000Z",
  };
  await stores.decisions.put(decision);
  await mkdir(join(repo, "docs", "programs", "demo"), { recursive: true });
  await writeFile(join(repo, "docs", "programs", "demo", "contract.json"), JSON.stringify(program));
  await writeFile(join(repo, "docs", "programs", "demo", "plan.md"), PLAN);
  return { stores, f, program, decision, produced, later };
};

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, argv);
};

describe("nightshift decision reverse (D-P9-02)", () => {
  it("records a superseding human decision, changes nothing else, and says how to correct it", async () => {
    const { stores, f, decision } = await seed();
    const code = await cli(
      "decision",
      "reverse",
      "demo",
      decision.decisionId,
      "--choice",
      "a table per region",
      "--reason",
      "regions will diverge",
      "--repo",
      repo,
    );
    expect(code, op.err.join("\n")).toBe(0);
    const said = op.out.join("\n");
    expect(said).toContain("Nothing else changed");
    expect(said).toContain(`nightshift decision brief demo ${decision.decisionId}`);
    const all = (await stores.decisions.listByRun(f.scope)).items;
    const reversal = all.find((d) => d.supersedesDecisionId === decision.decisionId);
    expect(reversal).toMatchObject({
      authority: "human",
      choice: "a table per region",
      rationale: "regions will diverge",
      reversibility: "reversible",
    });
    expect(reversal?.produced).toBeUndefined();
    // The original is untouched.
    expect(all.find((d) => d.decisionId === decision.decisionId)).toEqual(decision);
  });

  it("says an irreversible decision will need confirming before its correction runs", async () => {
    const { decision } = await seed("irreversible");
    await cli(
      "decision",
      "reverse",
      "demo",
      decision.decisionId,
      "--choice",
      "x",
      "--reason",
      "y",
      "--repo",
      repo,
    );
    expect(op.out.join("\n")).toContain("will ask you to confirm");
  });
});

describe("nightshift decision brief (D-P9-03)", () => {
  it("writes the fork in the road, what it produced, everything after, and the owner's reversal", async () => {
    const { decision } = await seed();
    await cli(
      "decision",
      "reverse",
      "demo",
      decision.decisionId,
      "--choice",
      "a table per region",
      "--reason",
      "regions will diverge",
      "--repo",
      repo,
    );
    const out = "docs/programs/demo-fix/brief.md";
    expect(
      await cli("decision", "brief", "demo", decision.decisionId, "--out", out, "--repo", repo),
      op.err.join("\n"),
    ).toBe(0);
    const brief = await readFile(join(repo, out), "utf8");
    expect(brief).toContain("Chose: one table");
    expect(brief).toContain("- a table per region: rejected because more to migrate");
    expect(brief).toContain("Why: regions will diverge");
    // What it produced, with its files, and what landed after it.
    const produced = brief.indexOf("## What it produced");
    const after = brief.indexOf("## Everything that landed after it");
    expect(brief.slice(produced, after)).toContain("one table for orders");
    expect(brief.slice(produced, after)).toContain("  - src/orders.js");
    expect(brief.slice(after)).toContain("a report over orders");
  });
});

describe("a correction's contract (D-P9-04, D-P9-05)", () => {
  const writeCorrection = async (corrects: ProgramContract["corrects"], base: ProgramContract) => {
    const contract: ProgramContract = {
      ...base,
      programId: op.ids.next("prog") as never,
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The store",
          scope: { summary: "src", includes: ["src/**"], excludes: [] },
          acceptance: ["green"],
          successCriteria: base.successCriteria.map((criterion) => criterion.id),
          dependsOn: [],
          prerequisites: [],
        },
      ],
      ...(corrects === undefined ? {} : { corrects }),
    };
    await mkdir(join(repo, "docs", "programs", "demo-fix"), { recursive: true });
    await writeFile(
      join(repo, "docs", "programs", "demo-fix", "contract.json"),
      JSON.stringify(contract),
    );
    await writeFile(join(repo, "docs", "programs", "demo-fix", "plan.md"), PLAN);
  };

  it("is not ready when it names a decision nobody reversed, and flags an irreversible one when it is", async () => {
    const { decision, f, program } = await seed("irreversible");
    const target = {
      programId: program.programId,
      runId: f.scope.runId,
      decisionId: decision.decisionId,
    };
    await writeCorrection([{ ...target, reversedBy: op.ids.next("dec") as never }], program);
    await recordHealthyGates(op, repo, "demo-fix");
    expect(await cli("plan", "check", "demo-fix", "--repo", repo)).toBe(1);
    expect(op.err.join("\n")).toContain("is not a decision of run");

    await cli(
      "decision",
      "reverse",
      "demo",
      decision.decisionId,
      "--choice",
      "x",
      "--reason",
      "y",
      "--repo",
      repo,
    );
    const reversal = /Recorded (dec_[0-9A-Z]+)/.exec(op.out.join("\n"))?.[1];
    await writeCorrection([{ ...target, reversedBy: reversal as never }], program);
    expect(await cli("plan", "check", "demo-fix", "--repo", repo), op.err.join("\n")).toBe(0);
    expect(op.out.join("\n")).toContain(`FLAG ${decision.decisionId} is irreversible`);
  });
});

describe("nightshift report (D-P9-06, D-P9-08)", () => {
  it("writes the report again, with the decision graph showing a reversal", async () => {
    const { decision } = await seed();
    await cli(
      "decision",
      "reverse",
      "demo",
      decision.decisionId,
      "--choice",
      "x",
      "--reason",
      "y",
      "--repo",
      repo,
    );
    expect(await cli("report", "demo", "--repo", repo), op.err.join("\n")).toBe(0);
    const report = await readFile(join(repo, "docs", "programs", "demo", "report.md"), "utf8");
    expect(report).toContain("## Decision graph");
    expect(report).toContain("How to store orders");
    expect(report).toContain("Weighed: a table per region, rejected because more to migrate");
    expect(report).toContain("**Reversed by you**");
    expect(report).toContain("Not corrected yet");
  });
});
