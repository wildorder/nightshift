/**
 * `findProgram` (P21 S-02): a program found by name on the plane, and the import
 * of one planned before P21.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, findProgram, openSession, runCli } from "@nightshift/cli";
import type { ProgramContract } from "@nightshift/contracts";
import { createFixtures, makeCheckpoint, makeNode, makeRootNode, makeRun } from "@nightshift/core";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
} from "../slice/fixture-repo.js";
import { recordHealthyGates } from "./gate-health.js";
import { type Operator, signIn } from "./operator.js";
import { putFromFiles } from "./plan-scratch.js";

const PROGRAM = "p1-demo";
const PLAN = "# Demo\n\n## Strands\n\n### S-01 The module\n\nA module exists, with its test.\n";

let op: Operator;
let fixture: MaterialisedRepo;
let contract: ProgramContract;

const programPath = (...parts: string[]): string =>
  join(fixture.repo, "docs", "programs", PROGRAM, ...parts);

const writeProgram = async (plan: string = PLAN): Promise<void> => {
  const {
    projectId: _p,
    verification: _v,
    modelPolicy: _m,
    delegationLimits: _d,
    costPolicy: _c,
    ...authored
  } = contract;
  await mkdir(programPath(), { recursive: true });
  await writeFile(programPath("contract.json"), `${JSON.stringify(authored, null, 2)}\n`);
  await writeFile(programPath("plan.md"), plan);
};

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, [...argv, "--repo", fixture.repo]);
};

const find = async (use: "latest" | "ratified", repoPath = fixture.repo) =>
  findProgram(op.environment, await openSession(op.environment), { repoPath, name: PROGRAM, use });

const draftsOf = () =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
    actingOrg: op.orgId,
  }).planDrafts;

beforeEach(async () => {
  op = await signIn();
  const created = await createProject(op.environment, { name: "source-demo" });
  fixture = await materialiseFixtureRepo({ projectId: created.projectId as never });
  const base = await authoredProgram();
  contract = {
    ...base,
    projectId: created.projectId as never,
    status: "planning",
    strands: [
      {
        id: "S-01",
        name: "The module",
        scope: { summary: "the source tree", includes: base.scope.includes, excludes: [] },
        acceptance: ["its tests pass"],
        successCriteria: base.successCriteria.map((criterion) => criterion.id),
        dependsOn: [],
        prerequisites: [],
      },
    ],
    prerequisites: [],
  };
  await writeFile(
    join(fixture.repo, "nightshift.config.json"),
    `${JSON.stringify({ schemaVersion: 1, projectId: created.projectId, contextDocs: [], verification: base.verification, modelPolicy: base.modelPolicy, delegationLimits: base.delegationLimits, costPolicy: base.costPolicy }, null, 2)}\n`,
  );
  await writeProgram();
});

afterEach(async () => {
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
});

describe("findProgram", () => {
  it("finds a draft by name with no docs/programs directory on disk", async () => {
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    await rm(join(fixture.repo, "docs"), { recursive: true, force: true });
    const found = await find("latest");
    expect(found.id).toBe(PROGRAM);
    expect(found.contract.programId).toBe(contract.programId);
    expect(found.contract.projectId).toBe(contract.projectId);
    expect(found.planText).toContain("The module");
    expect(found.draft.name).toBe(PROGRAM);
    expect(found.version.version).toBe(1);
  });

  it("returns the ratified plan after a newer version was put", async () => {
    await recordHealthyGates(op, fixture.repo, PROGRAM);
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    expect(await cli("plan", "ratify", PROGRAM)).toBe(0);
    await writeProgram(`${PLAN}\nA later edit.\n`);
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    const ratified = await find("ratified");
    expect(ratified.planText).not.toContain("A later edit");
    expect(ratified.contract.planHash).toBeDefined();
    expect((await find("latest")).planText).toContain("A later edit");
  });

  it("refuses ratified for a program never ratified", async () => {
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    await expect(find("ratified")).rejects.toThrow(/has not been ratified/);
  });

  it("imports committed files as version 1 once, saying so on stderr", async () => {
    const first = await find("latest");
    expect(first.version.version).toBe(1);
    expect(first.draft.name).toBe(PROGRAM);
    expect(op.err.join("\n")).toContain("importing");
    op.err.length = 0;
    const second = await find("latest");
    expect(second.draft.latestVersion).toBe(1);
    expect(op.err.join("\n")).not.toContain("importing");
  });

  it("names a draft the plane holds for the committed contract's program", async () => {
    // Put without a name (by program id), then find by name.
    const scratch = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
    try {
      await writeFile(join(scratch, "contract.json"), await readFile(programPath("contract.json")));
      await writeFile(join(scratch, "plan.md"), PLAN);
      expect(await cli("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    const found = await find("latest");
    expect(found.version.version).toBe(2);
    expect(found.draft.name).toBe(PROGRAM);
    expect(op.err.join("\n")).not.toContain("importing");
  });

  it("names neither a plane draft nor a committed program: a usage error naming plan put", async () => {
    await rm(join(fixture.repo, "docs"), { recursive: true, force: true });
    await expect(find("latest")).rejects.toThrow(/plan put/);
  });
});

describe("nightshift plan put <name>", () => {
  it("records the name, keeps it on a put without one, and refuses another program's", async () => {
    expect(await putFromFiles(cli, fixture.repo, "p1-demo")).toBe(0);
    const stored = await draftsOf().get(contract.projectId, contract.programId);
    expect(stored?.name).toBe("p1-demo");
    const scratch = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
    try {
      await writeFile(join(scratch, "contract.json"), await readFile(programPath("contract.json")));
      await writeFile(join(scratch, "plan.md"), `${PLAN}\nMore.\n`);
      await writeFile(join(scratch, ".nightshift-plan-version"), "1\n");
      expect(await cli("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    expect((await draftsOf().get(contract.projectId, contract.programId))?.name).toBe("p1-demo");
  });
});

describe("commands that find a program only in the plane", () => {
  beforeEach(async () => {
    await recordHealthyGates(op, fixture.repo, PROGRAM);
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    expect(await cli("plan", "ratify", PROGRAM)).toBe(0);
    await rm(join(fixture.repo, "docs"), { recursive: true, force: true });
  });

  it("preflight finds it and answers on its prerequisites", async () => {
    expect(await cli("preflight", PROGRAM), op.err.join("\n")).toBe(0);
    expect(op.out.at(-1)).toBe("no human prerequisites: nothing to check");
  });

  it("report finds it, and says it has no run rather than no program", async () => {
    expect(await cli("report", PROGRAM)).not.toBe(0);
    const said = op.err.join("\n");
    expect(said).not.toMatch(/does not exist|has not been ratified|no program/);
    expect(said).toContain(PROGRAM);
  });

  it("resume finds it, and says it has no run rather than no program", async () => {
    const code = await cli("resume", PROGRAM);
    const said = [...op.out, ...op.err].join("\n");
    expect(said, `exit ${code}`).not.toMatch(/does not exist|has not been ratified|no program/);
    expect(said).toContain(PROGRAM);
  });
});

describe("nightshift decision brief", () => {
  it("renders from the plan text rootNode.plan names, with no plan.md on disk", async () => {
    await recordHealthyGates(op, fixture.repo, PROGRAM);
    const text = `${PLAN}\nKeep orders in one table, said the plane.\n`;
    await writeProgram(text);
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    expect(await cli("plan", "ratify", PROGRAM)).toBe(0);
    await rm(join(fixture.repo, "docs"), { recursive: true, force: true });

    const stores = createHttpStores({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("ignored-by-the-local-plane"),
      }),
      actingOrg: op.orgId,
    });
    const ratified = await stores.programContracts.get(contract.projectId, contract.programId);
    if (ratified?.planDocument === undefined || ratified.planHash === undefined) {
      throw new Error("not ratified");
    }
    const base = createFixtures();
    const f = {
      ...base,
      scope: { ...base.scope, projectId: contract.projectId, programId: contract.programId },
    };
    const root = makeRootNode(f, {
      plan: { planHash: ratified.planHash, planDocument: ratified.planDocument },
    });
    await stores.runs.put(makeRun(f, { rootNodeId: root.executionNodeId }));
    await stores.executionNodes.put(root);
    const node = makeNode(f, root.executionNodeId);
    await stores.executionNodes.put(node);
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.repo,
      encoding: "utf8",
    }).trim();
    const checkpoint = makeCheckpoint(f, root.executionNodeId, { commitSha: head as never });
    await stores.checkpoints.put(checkpoint);
    const decisionId = f.ids.next("dec");
    await stores.decisions.put({
      schemaVersion: 1,
      ...f.scope,
      decisionId,
      executionNodeId: node.executionNodeId,
      agentId: null,
      context: "S-01: how to store orders",
      alternatives: [{ summary: "a table per region", rejectedBecause: "more to migrate" }],
      choice: "one table",
      rationale: "simplest",
      reversibility: "reversible",
      checkpointBefore: checkpoint.checkpointId,
      produced: { commits: [] },
      affectedNodes: [],
      authority: "agent",
      supersedesDecisionId: null,
      createdAt: "2026-09-27T10:01:00.000Z",
    } as never);

    const out = join(fixture.repo, "brief.md");
    expect(
      await cli("decision", "brief", PROGRAM, decisionId, "--out", out),
      op.err.join("\n"),
    ).toBe(0);
    expect(await readFile(out, "utf8")).toContain("Keep orders in one table, said the plane.");
  });
});
