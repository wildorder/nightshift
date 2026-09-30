/** The run graph's model (SC-P13-11): nodes, markers, dependency edges, and a decision's two sets. */
import type { ExecutionNode, JobContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeDecision,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
  type RunReport,
  type StrandReport,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { buildRunGraph, reachOf } from "./run-graph";

const f = createFixtures();
const strandDef = (id: string, dependsOn: string[] = []) => ({
  id,
  name: `The ${id}`,
  scope: { summary: "s", includes: ["src/**"], excludes: [] },
  acceptance: ["it works"],
  successCriteria: [],
  dependsOn,
  prerequisites: [],
});

/** A three-strand run: S-02 depends on S-01; S-03 stands alone. Each strand has one job. */
const world = () => {
  const root = makeRootNode(f);
  const contracts: JobContract[] = [];
  const nodes: ExecutionNode[] = [root];
  const add = (strandId: string, landed: string) => {
    const strandJob = makeJobContract(f, {
      jobContractId: f.ids.next("job"),
      objective: `orchestrate ${strandId}`,
      strandId,
    });
    const strandNode = makeNode(f, root.executionNodeId, {
      kind: "sub-program",
      jobContractId: strandJob.jobContractId,
      status: "succeeded",
    });
    const job = makeJobContract(f, {
      jobContractId: f.ids.next("job"),
      objective: `build ${strandId}`,
    });
    const jobNode = makeNode(f, strandNode.executionNodeId, {
      kind: "job",
      status: "integrated",
      jobContractId: job.jobContractId,
      commitSha: landed as never,
    });
    contracts.push(strandJob, job);
    nodes.push(strandNode, jobNode);
    return { strandNode, jobNode };
  };
  const s1 = add("S-01", "1".repeat(40));
  const s2 = add("S-02", "2".repeat(40));
  const s3 = add("S-03", "3".repeat(40));
  const program = makeProgramContract(f, {
    status: "ratified",
    planHash: "c".repeat(64),
    planDocument: { uri: "s3://b/x", sha256: "b".repeat(64), sizeBytes: 1 },
    strands: [strandDef("S-01"), strandDef("S-02", ["S-01"]), strandDef("S-03")],
  });
  const decision = makeDecision(f, s1.strandNode.executionNodeId, {
    produced: { commits: ["1".repeat(40)] },
  });
  const strandReport = (id: string, jobNode: ExecutionNode, attempts = 1): StrandReport => ({
    id,
    name: `The ${id}`,
    outcome: "succeeded",
    acceptance: ["it works"],
    reason: undefined,
    blockedBy: [],
    departures: [],
    attempts: 1,
    waitingOn: [],
    jobs: [
      {
        nodeId: jobNode.executionNodeId,
        objective: `build ${id}`,
        status: jobNode.status,
        commitSha: jobNode.commitSha,
        attempts,
        reason: undefined,
        routes: [],
        examinations: [],
      },
    ],
  });
  const report: RunReport = {
    program,
    run: makeRun(f, { status: "succeeded" }),
    strands: [
      strandReport("S-01", s1.jobNode),
      strandReport("S-02", s2.jobNode, 3),
      strandReport("S-03", s3.jobNode),
    ],
    criteria: [],
    pendingPrerequisites: [],
    graph: [{ decision, place: "strand", where: "S-01", correctedBy: [] }],
    corrections: [],
    usage: [],
    rulings: [],
  };
  return { root, nodes, contracts, report, decision, s1, s2, s3 };
};

describe("the run graph's model", () => {
  it("has the program, each strand and each job, the tree edges and the dependency edge", () => {
    const { nodes, contracts, report, s1, s2 } = world();
    const graph = buildRunGraph(nodes, contracts, report);
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual([
      "job",
      "job",
      "job",
      "program",
      "strand",
      "strand",
      "strand",
    ]);
    expect(graph.edges.filter((e) => e.kind === "tree")).toHaveLength(6);
    expect(graph.edges.filter((e) => e.kind === "depends")).toEqual([
      expect.objectContaining({
        source: s1.strandNode.executionNodeId,
        target: s2.strandNode.executionNodeId,
      }),
    ]);
  });

  it("marks decisions, retries and landings on the right nodes", () => {
    const { nodes, contracts, report, s1, s2 } = world();
    const byId = new Map(buildRunGraph(nodes, contracts, report).nodes.map((n) => [n.id, n]));
    expect(byId.get(s1.strandNode.executionNodeId)?.markers.decisions).toBe(1);
    expect(byId.get(s2.jobNode.executionNodeId)?.markers.retried).toBe(2);
    expect(byId.get(s1.jobNode.executionNodeId)?.markers.landed).toBe("1".repeat(40));
    expect(byId.get(s1.strandNode.executionNodeId)?.label).toBe("S-01 The S-01");
  });

  it("gives a decision two sets: what it produced, and what was built after it, and nothing else", () => {
    const { nodes, contracts, report, decision, s1, s2, s3 } = world();
    const reach = reachOf(decision, nodes, contracts, report);
    expect([...reach.produced]).toEqual([s1.jobNode.executionNodeId]);
    // S-02 depends on S-01: its strand and its job were built after, on top of it.
    expect([...reach.builtAfter].sort()).toEqual(
      [s2.strandNode.executionNodeId, s2.jobNode.executionNodeId].sort(),
    );
    // S-03 stands alone, and the root is not "after" anything: neither is marked.
    expect(reach.builtAfter.has(s3.strandNode.executionNodeId)).toBe(false);
    expect(reach.builtAfter.has(s3.jobNode.executionNodeId)).toBe(false);
    expect(reach.produced.has(s1.strandNode.executionNodeId)).toBe(false);
  });
});
