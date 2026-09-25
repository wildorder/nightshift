/**
 * `nightshift ruling reverse` (P8, D-P8-13): the owner's reversal of an
 * arbiter's ruling, recorded as a human decision superseding it, through the
 * real CLI against the real handler. It replays nothing, and says so.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@nightshift/cli";
import type { Decision, ProgramContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
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
import { type Operator, signIn } from "./operator.js";

let op: Operator;
let repo: string;

beforeEach(async () => {
  op = await signIn();
  repo = await mkdtemp(join(tmpdir(), "nightshift-ruling-"));
});

afterEach(async () => {
  await op.cleanup();
  await rm(repo, { recursive: true, force: true });
});

const seed = async () => {
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
    name: "ruling",
    createdAt: "2026-09-25T10:00:00.000Z",
  });
  const program: ProgramContract = makeProgramContract(f);
  await stores.programContracts.put(program);
  const root = makeRootNode(f);
  await stores.runs.put(makeRun(f, { rootNodeId: root.executionNodeId }));
  await stores.executionNodes.put(root);
  const node = makeNode(f, root.executionNodeId);
  await stores.executionNodes.put(node);
  const arbiter = makeAgent(f, node.executionNodeId, { role: "arbiter", model: "claude-opus-5-5" });
  await stores.agents.put(arbiter);
  const checkpoint = makeCheckpoint(f, root.executionNodeId, {
    ref: "refs/nightshift/checkpoints/before-ruling",
  });
  await stores.checkpoints.put(checkpoint);
  const ruling: Decision = {
    schemaVersion: 1,
    ...f.scope,
    decisionId: f.ids.next("dec"),
    executionNodeId: node.executionNodeId,
    agentId: arbiter.agentId,
    context: "The arbiter's ruling on finding F-01 of an examination.",
    alternatives: [{ summary: "uphold", rejectedBecause: "the arbiter chose to overturn" }],
    choice: "overturn",
    rationale: "the retry is bounded by its caller",
    reversibility: "reversible",
    checkpointBefore: checkpoint.checkpointId,
    affectedNodes: [node.executionNodeId],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: "2026-09-25T10:00:00.000Z",
  };
  await stores.decisions.put(ruling);
  await mkdir(join(repo, "docs", "programs", "demo"), { recursive: true });
  await writeFile(join(repo, "docs", "programs", "demo", "contract.json"), JSON.stringify(program));
  await writeFile(join(repo, "docs", "programs", "demo", "plan.md"), "# Demo\n");
  return { stores, ruling, scope: f.scope };
};

describe("nightshift ruling reverse (D-P8-13)", () => {
  it("records the owner's reversal as a human decision superseding the ruling, and replays nothing", async () => {
    const { stores, ruling, scope } = await seed();
    const code = await runCli(op.environment, [
      "ruling",
      "reverse",
      "demo",
      ruling.decisionId,
      "--reason",
      "the retry is not bounded: the caller loops",
      "--repo",
      repo,
    ]);
    expect(code, op.err.join("\n")).toBe(0);
    expect(op.out.join("\n")).toContain("Nothing is replayed");
    expect(op.out.join("\n")).toContain(
      "git reset --hard refs/nightshift/checkpoints/before-ruling",
    );

    const decisions = (await stores.decisions.listByRun(scope)).items;
    const reversal = decisions.find(
      (decision) => decision.supersedesDecisionId === ruling.decisionId,
    );
    expect(reversal).toMatchObject({
      authority: "human",
      choice: "uphold",
      checkpointBefore: ruling.checkpointBefore,
      rationale: "the retry is not bounded: the caller loops",
    });
  });

  it("refuses a decision that is not an arbiter's ruling", async () => {
    const { ruling } = await seed();
    const code = await runCli(op.environment, [
      "ruling",
      "reverse",
      "demo",
      "dec_01HF7YAT09GGGGGGGGGGGGGGGG",
      "--reason",
      "no",
      "--repo",
      repo,
    ]);
    expect(code).not.toBe(0);
    expect(op.err.join("\n")).toContain("holds decision");
    expect(ruling.choice).toBe("overturn");
  });
});
