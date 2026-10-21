import type { ExecutionNode, ExecutionNodeStatus, JobContract } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeJobContract, makeNode, makeRootNode } from "../testing/factories.js";
import { orchestratingDetail, PROGRESS_DETAIL_MAX } from "./orchestration-progress.js";

describe("orchestratingDetail (2026-10-21)", () => {
  const f = createFixtures();
  const root = makeRootNode(f);
  const strand = (id: string, status: ExecutionNodeStatus, at = "2026-10-21T00:00:00.000Z") => {
    const job: JobContract = makeJobContract(f, {
      jobContractId: f.ids.next("job"),
      strandId: id as never,
    });
    const node: ExecutionNode = makeNode(f, root.executionNodeId, {
      kind: "sub-program",
      jobContractId: job.jobContractId,
      status,
      createdAt: at,
    });
    return { job, node };
  };
  const jobUnder = (parent: ExecutionNode, status: ExecutionNodeStatus): ExecutionNode =>
    makeNode(f, parent.executionNodeId, { status, depth: 2 });

  it("says nothing has been delegated when only the root exists", () => {
    expect(orchestratingDetail([root], [])).toBe("no work delegated yet");
  });

  it("tells a planned run by its strands: landed count, then each other one by name", () => {
    const s1 = strand("S-01", "integrated", "2026-10-21T00:01:00.000Z");
    const s2 = strand("S-02", "integrated", "2026-10-21T00:02:00.000Z");
    const s3 = strand("S-03", "verifying", "2026-10-21T00:03:00.000Z");
    const s4 = strand("S-04", "running", "2026-10-21T00:04:00.000Z");
    const s5 = strand("S-05", "queued", "2026-10-21T00:05:00.000Z");
    const s6 = strand("S-06", "validated", "2026-10-21T00:06:00.000Z");
    const nodes = [
      root,
      s1.node,
      s2.node,
      s3.node,
      s4.node,
      s5.node,
      s6.node,
      jobUnder(s4.node, "merged"),
      jobUnder(s4.node, "merged"),
      jobUnder(s4.node, "running"),
      jobUnder(s1.node, "merged"),
    ];
    expect(
      orchestratingDetail(
        nodes,
        [s1, s2, s3, s4, s5, s6].map((s) => s.job),
      ),
    ).toBe(
      "2 of 6 strands landed; S-03 verifying; S-04 building (2 merged, 1 running); S-05, S-06 waiting",
    );
  });

  it("names a failed, deferred or handed-in strand by what happened to it", () => {
    const a = strand("S-01", "verification_failed");
    const b = strand("S-02", "deferred");
    const c = strand("S-03", "implemented");
    expect(orchestratingDetail([root, a.node, b.node, c.node], [a.job, b.job, c.job])).toBe(
      "0 of 3 strands landed; S-01 verification failed; S-02 deferred; S-03 landing",
    );
  });

  it("falls back to the node's id when its job contract is not among the jobs", () => {
    const a = strand("S-01", "running");
    expect(orchestratingDetail([root, a.node], [])).toMatch(
      /^0 of 1 strand landed; strand [0-9A-Z]{6} building$/,
    );
  });

  it("tells a run with no strands by its jobs", () => {
    const nodes = [
      root,
      jobUnder(root, "integrated"),
      jobUnder(root, "integrated"),
      jobUnder(root, "running"),
      jobUnder(root, "failed"),
      jobUnder(root, "queued"),
    ];
    expect(orchestratingDetail(nodes, [])).toBe("2 of 5 jobs landed; 1 running; 1 failed");
  });

  it("never exceeds the schema's cap on a detail", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      strand(`S-${String(i + 1).padStart(2, "0")}`, "running"),
    );
    const detail = orchestratingDetail(
      [root, ...many.map((s) => s.node)],
      many.map((s) => s.job),
    );
    expect(detail.length).toBeLessThanOrEqual(PROGRESS_DETAIL_MAX);
    expect(detail.endsWith("…")).toBe(true);
  });
});
