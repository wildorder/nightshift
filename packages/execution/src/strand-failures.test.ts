/**
 * What a strand's fix round is told when its examination stopped it (D-P18-05,
 * D-P8-13): the blocking findings, or, once an arbiter has upheld one, the
 * ruling, which is final. p19-step-timeouts' run (2026-10-20) resumed S-02
 * after an upheld ruling with a brief that named nothing: an upheld finding is
 * no longer open, so the blocking findings alone were empty.
 */
import type { Examination, ExecutionNode, ProgramContract } from "@nightshift/contracts";
import type { ProjectStores, RunScope } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import type { ExecutionEnvironment } from "./environment.js";
import { strandFailures } from "./strand.js";

const scope = { projectId: "proj_1", programId: "prog_1", runId: "run_1" } as unknown as RunScope;
const node = {
  executionNodeId: "node_s02",
  kind: "sub-program",
  status: "examination_failed",
} as unknown as ExecutionNode;

const finding = (resolution: "unresolved" | "upheld") => ({
  id: "F-01",
  severity: "material" as const,
  summary: "a red gate can be skipped after a failed rerun",
  evidence: [{ kind: "contract" as const, clause: "D-06" }],
  resolution,
  ...(resolution === "upheld"
    ? { resolvedBy: { decisionId: "dec_ruling", reason: "the skip check must see the rerun" } }
    : {}),
});

const examination = (resolution: "unresolved" | "upheld"): Examination =>
  ({
    examinationId: "exam_1",
    createdAt: "2026-10-20T02:16:00.000Z",
    blocking: true,
    fixAttempt: 2,
    findings: [finding(resolution)],
  }) as unknown as Examination;

const failuresOf = (examinations: readonly Examination[]) =>
  strandFailures(
    {
      stores: {
        verifications: { listByNode: async () => [] },
        examinations: { listByNode: async () => examinations },
      } as unknown as ProjectStores,
    } as unknown as ExecutionEnvironment,
    { scope, program: {} as ProgramContract },
    node,
  );

describe("a strand's fix round after its examination", () => {
  it("is told the blocking findings while they are open", async () => {
    const failures = await failuresOf([examination("unresolved")]);
    expect(failures.findings.map((found) => found.id)).toEqual(["F-01"]);
    expect(failures.rulings).toBeUndefined();
  });

  it("is told an arbiter's upheld ruling, with the finding it upholds, once one is in force", async () => {
    const failures = await failuresOf([examination("upheld")]);
    expect(failures.rulings).toEqual([
      {
        findingId: "F-01",
        decisionId: "dec_ruling",
        summary: "a red gate can be skipped after a failed rerun",
        rationale: "the skip check must see the rerun",
      },
    ]);
    expect(failures.findings.map((found) => found.id)).toEqual(["F-01"]);
  });
});
