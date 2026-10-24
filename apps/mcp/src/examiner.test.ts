/**
 * The examiner's finding submission (P20 S-05): a finding that is the same
 * defect as an earlier examination's names it in `repeats`, and the server
 * refuses a reference to an examination or finding the node does not have.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGGREGATE_EXAMPLES, type Examination } from "@nightshift/contracts";
import {
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  PLAN_REVIEW_FILE_ENV,
} from "@nightshift/execution";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { registerExaminerTools, registerPlanReviewTools } from "./examiner.js";

type Handler = (input: Record<string, unknown>) => Promise<{
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}>;

const EVIDENCE = [{ kind: "contract" as const, clause: "It works." }];

const setup = async () => {
  const earlier = structuredClone(AGGREGATE_EXAMPLES.Examination) as Examination;
  const first: Examination = {
    ...earlier,
    outcome: "findings_raised",
    findings: [
      {
        id: "F-01",
        severity: "material",
        summary: "the retry is unbounded",
        evidence: EVIDENCE,
        resolution: "unresolved",
      },
    ],
  };
  const stores = createInMemoryStores();
  await stores.examinations.put(first);
  const examinationId = "exam_01M5DZHQQ7MFBBXVAKN1R8HZ9Z" as Examination["examinationId"];
  const context: ExaminationContext = {
    examinationId,
    verificationId: first.verificationId,
    commitSha: first.commitSha,
    patchId: first.patchId,
    implementerAgentId: first.implementerAgentId,
    examinerRoute: first.examinerRoute,
    requiredByRisk: first.requiredByRisk,
    blocking: true,
    fixAttempt: first.fixAttempt + 1,
    round: 1,
    questions: [],
  };
  const tools = new Map<string, Handler>();
  registerExaminerTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer,
    {
      identity: {
        scope: { projectId: first.projectId, programId: first.programId, runId: first.runId },
        executionNodeId: first.executionNodeId,
        jobContractId: "job_01M5DZHQQ7MFBBXVAKN1R8HZ9Y",
        agentId: first.examinerAgentId,
        worktree: "/tmp",
      } as never,
      environment: {
        stores,
        clock: { now: () => Date.parse("2026-10-21T00:00:00.000Z") },
      } as never,
      ids: { next: () => "unused" } as never,
      env: { [EXAMINATION_CONTEXT_ENV]: JSON.stringify(context) },
    },
  );
  const submit = tools.get("examination.submit") as Handler;
  return { first, stores, submit, examinationId };
};

describe("examination.submit repeats", () => {
  it("records a repeats reference to an earlier examination's finding", async () => {
    const { first, stores, submit, examinationId } = await setup();
    const result = await submit({
      outcome: "findings_raised",
      findings: [
        {
          severity: "material",
          summary: "the retry is still unbounded",
          evidence: EVIDENCE,
          repeats: { examinationId: first.examinationId, findingId: "F-01" },
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const stored = await stores.examinations.get(
      { projectId: first.projectId, programId: first.programId, runId: first.runId },
      examinationId,
    );
    expect(stored?.findings[0]?.repeats).toEqual({
      examinationId: first.examinationId,
      findingId: "F-01",
    });
  });

  it("refuses an unknown examination and an unknown finding, recording nothing", async () => {
    const { first, stores, submit, examinationId } = await setup();
    const scope = { projectId: first.projectId, programId: first.programId, runId: first.runId };
    const finding = (repeats: { examinationId: string; findingId: string }) => ({
      outcome: "findings_raised",
      findings: [{ severity: "material", summary: "again", evidence: EVIDENCE, repeats }],
    });

    const unknownExamination = await submit(
      finding({ examinationId: "exam_01M5DZHQQ7MFBBXVAKN1R8HZ00", findingId: "F-01" }),
    );
    expect(unknownExamination.isError).toBe(true);
    expect(unknownExamination.structuredContent).toMatchObject({ code: "validation_failed" });
    expect(String(unknownExamination.structuredContent?.message)).toMatch(
      /not an earlier examination/,
    );

    const unknownFinding = await submit(
      finding({ examinationId: first.examinationId, findingId: "F-09" }),
    );
    expect(unknownFinding.isError).toBe(true);
    expect(String(unknownFinding.structuredContent?.message)).toMatch(/did not raise/);

    expect(await stores.examinations.get(scope, examinationId)).toBeUndefined();
  });

  it("leaves repeats off a finding that names none", async () => {
    const { first, stores, submit, examinationId } = await setup();
    await submit({
      outcome: "findings_raised",
      findings: [{ severity: "minor", summary: "new", evidence: EVIDENCE }],
    });
    const stored = await stores.examinations.get(
      { projectId: first.projectId, programId: first.programId, runId: first.runId },
      examinationId,
    );
    expect(stored?.findings[0]).not.toHaveProperty("repeats");
  });
});

describe("plan.review.submit (PIP-32)", () => {
  const reviewTool = async () => {
    const file = join(await mkdtemp(join(tmpdir(), "plan-review-")), "review.json");
    const tools = new Map<string, Handler>();
    registerPlanReviewTools(
      {
        registerTool: (name: string, _config: unknown, handler: Handler) => {
          tools.set(name, handler);
        },
      } as unknown as McpServer,
      { env: { [PLAN_REVIEW_FILE_ENV]: file } } as never,
    );
    return { submit: tools.get("plan.review.submit") as Handler, file };
  };

  it("refuses a revise that names nothing to change, and takes it once it does", async () => {
    const { submit, file } = await reviewTool();
    const empty = await submit({ verdict: "revise", summary: "Not right.", findings: [] });
    expect(empty.isError).toBe(true);
    expect(String(empty.structuredContent?.message)).toContain("add a finding");
    const named = await submit({
      verdict: "revise",
      summary: "Not right.",
      findings: [{ severity: "material", summary: "J1 and J2 collide", jobs: ["J1"] }],
    });
    expect(named.isError).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8")).findings).toHaveLength(1);
  });
});
