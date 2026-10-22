/**
 * Why an attempt follows another (P20, S-05): every cause kind, mixed causes,
 * and a strand's round. Records are plain data; nothing runs.
 */
import { AttemptCauseSchema, type Examination, type Verification } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { type CausesOfRetryInput, causesOfRetry } from "./causes.js";

const examination = (
  id: string,
  createdAt: string,
  findings: readonly { id: string; resolution: string; decisionId?: string }[],
): Examination =>
  ({
    examinationId: id,
    createdAt,
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: "material",
      summary: `finding ${finding.id}`,
      evidence: [{ kind: "contract", clause: "It works." }],
      resolution: finding.resolution,
      ...(finding.decisionId === undefined
        ? {}
        : { resolvedBy: { decisionId: finding.decisionId, reason: "because" } }),
    })),
  }) as unknown as Examination;

const verification = (id: string, outcome: string, endedAt: string): Verification =>
  ({ verificationId: id, outcome, endedAt }) as unknown as Verification;

const of = (input: Partial<CausesOfRetryInput> & Pick<CausesOfRetryInput, "node">) =>
  causesOfRetry({ examinations: [], fix: {}, ...input });

describe("the causes of a retry", () => {
  it("names the ruling, its decisions, findings and the examination holding the upheld findings", () => {
    const held = examination("exam_1", "2026-10-01T00:00:00.000Z", [
      { id: "F-01", resolution: "upheld", decisionId: "dec_a" },
    ]);
    const later = examination("exam_2", "2026-10-02T00:00:00.000Z", []);
    const causes = of({
      node: { status: "failed", outcomeReason: "examination_failed: 1 material finding" },
      examinations: [held, later],
      fix: {
        task: {
          kind: "fix",
          findings: held.findings,
          rulings: [
            { findingId: "F-01", decisionId: "dec_a" as never, summary: "s", rationale: "r" },
          ],
        },
      },
    });
    expect(causes).toEqual([
      { kind: "ruling", decisionIds: ["dec_a"], findingIds: ["F-01"], examinationId: "exam_1" },
    ]);
  });

  it("names the latest examination and its findings when a fix has findings only", () => {
    const first = examination("exam_1", "2026-10-01T00:00:00.000Z", []);
    const latest = examination("exam_2", "2026-10-02T00:00:00.000Z", [
      { id: "F-01", resolution: "unresolved" },
      { id: "F-02", resolution: "unresolved" },
    ]);
    expect(
      of({
        node: { status: "failed" },
        examinations: [latest, first],
        fix: { task: { kind: "fix", findings: latest.findings } },
      }),
    ).toEqual([
      { kind: "examination_findings", findingIds: ["F-01", "F-02"], examinationId: "exam_2" },
    ]);
  });

  it("names the latest failed verification, and none when verifications are not given", () => {
    const verifications = [
      verification("ver_old", "failed", "2026-10-01T00:00:00.000Z"),
      verification("ver_new", "failed", "2026-10-03T00:00:00.000Z"),
      verification("ver_pass", "passed", "2026-10-04T00:00:00.000Z"),
    ];
    expect(of({ node: { status: "verification_failed" }, verifications })).toEqual([
      { kind: "verification_failed", verificationId: "ver_new" },
    ]);
    expect(of({ node: { status: "verification_failed" } })).toEqual([
      { kind: "verification_failed" },
    ]);
  });

  it("parses the conflicting paths from the queue's reason", () => {
    const reason =
      "integration_conflict: this job's changes conflict with work integrated since it started, in src/a.js, src/b.js. " +
      "Nothing was integrated and nothing was resolved.";
    expect(of({ node: { status: "failed", outcomeReason: reason } })).toEqual([
      { kind: "integration_conflict", paths: ["src/a.js", "src/b.js"] },
    ]);
    expect(
      of({ node: { status: "failed", outcomeReason: "integration_conflict: unknown" } }),
    ).toEqual([{ kind: "integration_conflict" }]);
  });

  it("names a route that could not start, an unreported exit, and an interruption", () => {
    expect(
      of({ node: { status: "failed", outcomeReason: "route_unavailable: signed out" } }),
    ).toEqual([{ kind: "route_unavailable", detail: "route_unavailable: signed out" }]);
    expect(
      of({
        node: {
          status: "failed",
          outcomeReason: "the worker exited 0 without reporting completion",
        },
      }),
    ).toEqual([{ kind: "unreported" }]);
    expect(of({ node: { status: "interrupted", outcomeReason: "session ended" } })).toEqual([
      { kind: "interrupted" },
    ]);
  });

  it("keeps the first 400 characters of any other failure's reason", () => {
    const [cause] = of({ node: { status: "failed", outcomeReason: "x".repeat(900) } });
    expect(cause).toEqual({ kind: "worker_failed", detail: "x".repeat(400) });
  });

  it("is unknown when nothing explains it", () => {
    expect(of({ node: { status: "cancelled" } })).toEqual([{ kind: "unknown" }]);
  });

  it("records a failed verification beside the findings of a fix", () => {
    const latest = examination("exam_1", "2026-10-02T00:00:00.000Z", [
      { id: "F-01", resolution: "unresolved" },
    ]);
    const causes = of({
      node: { status: "verification_failed" },
      examinations: [latest],
      fix: { task: { kind: "fix", findings: latest.findings } },
      verifications: [verification("ver_1", "failed", "2026-10-02T00:00:00.000Z")],
    });
    expect(causes.map((cause) => cause.kind)).toEqual([
      "examination_findings",
      "verification_failed",
    ]);
  });

  it("gives a strand's round strand_landing and one cause for each kind of failure it carries", () => {
    const upheld = examination("exam_1", "2026-10-01T00:00:00.000Z", [
      { id: "F-01", resolution: "upheld", decisionId: "dec_a" },
    ]);
    const open = examination("exam_2", "2026-10-02T00:00:00.000Z", [
      { id: "F-02", resolution: "unresolved" },
    ]);
    const causes = of({
      node: { status: "examination_failed" },
      examinations: [upheld, open],
      verifications: [verification("ver_1", "failed", "2026-10-02T00:00:00.000Z")],
      strandFailures: {
        failedChecks: [{ stepId: "test", command: "npm test", exitCode: 1, output: "" }],
        findings: open.findings,
        rulings: [
          { findingId: "F-01", decisionId: "dec_a" as never, summary: "s", rationale: "r" },
        ],
        conflict:
          "integration_conflict: this job's changes conflict with work merged onto its strand since it started, in src/z.js. Nothing was merged.",
      },
    });
    expect(causes).toEqual([
      { kind: "strand_landing" },
      { kind: "verification_failed", verificationId: "ver_1" },
      { kind: "examination_findings", findingIds: ["F-02"], examinationId: "exam_2" },
      { kind: "ruling", decisionIds: ["dec_a"], findingIds: ["F-01"], examinationId: "exam_1" },
      {
        kind: "integration_conflict",
        paths: ["src/z.js"],
        detail: expect.stringContaining("src/z.js"),
      },
    ]);
  });

  it("gives a strand round with one failure kind just that cause beside strand_landing", () => {
    expect(
      of({
        node: { status: "failed" },
        strandFailures: {
          failedChecks: [{ stepId: "test", command: "npm test", exitCode: 1, output: "" }],
          findings: [],
        },
      }).map((cause) => cause.kind),
    ).toEqual(["strand_landing", "verification_failed"]);
  });

  it("only ever yields causes the routing decision accepts", () => {
    const inputs: CausesOfRetryInput[] = [
      { node: { status: "failed", outcomeReason: "boom" }, examinations: [], fix: {} },
      { node: { status: "interrupted" }, examinations: [], fix: {} },
      { node: { status: "verification_failed" }, examinations: [], fix: {} },
    ];
    for (const input of inputs) {
      for (const cause of causesOfRetry(input)) {
        expect(AttemptCauseSchema.safeParse(cause).success).toBe(true);
      }
    }
  });
});
