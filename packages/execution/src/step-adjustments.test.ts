import type { Decision, Verification } from "@nightshift/contracts";
import { STEP_TIMED_OUT_EXIT_CODE } from "@nightshift/core";
import type { WorkerDecisionInput } from "@nightshift/harness";
import { TIMEOUT_EXIT_CODE } from "@nightshift/verification";
import { describe, expect, it } from "vitest";
import {
  recordStepSkip,
  recordStepTimeout,
  resolveSteps,
  StepAdjustmentRefusedError,
} from "./step-adjustments.js";

const recorder = () => {
  const inputs: WorkerDecisionInput[] = [];
  const record = async (input: WorkerDecisionInput): Promise<Decision> => {
    inputs.push(input);
    return { decisionId: `dec_${inputs.length}`, ...input } as unknown as Decision;
  };
  return { record, inputs };
};

const steps = [{ id: "unit" }, { id: "trial", timeoutSeconds: 1000 }];
const verificationOf = (...commands: Array<{ stepId: string; exitCode?: number }>) =>
  ({
    verificationId: "ver_1",
    commitSha: "abc",
    endedAt: "2026-01-01T00:00:00Z",
    commands,
  }) as unknown as Verification;
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StepAdjustmentRefusedError);
  return (error as Error).message;
};

describe("recordStepTimeout", () => {
  const base = { steps, decisions: [], reason: "the trial is real work" };

  it("records one decision carrying the new value", async () => {
    const { record, inputs } = recorder();
    await recordStepTimeout(record, { ...base, stepId: "trial", timeoutSeconds: 3000 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.context).toBe("STEP TIMEOUT: trial timeoutSeconds=3000");
    expect(inputs[0]?.choice).toContain("3000");
    expect(inputs[0]?.rationale).toBe("the trial is real work");
    expect(inputs[0]?.reversibility).toBe("reversible");
    expect(inputs[0]?.alternatives.map((a) => a.summary)).toEqual([
      "wait with the current timeout",
      "skip the step",
    ]);
  });

  it("refuses past the maximum, past the wall clock, and not above the current value", async () => {
    const { record, inputs } = recorder();
    expect(
      await refusal(recordStepTimeout(record, { ...base, stepId: "trial", timeoutSeconds: 9000 })),
    ).toContain("maximum of 7200");
    expect(
      await refusal(
        recordStepTimeout(record, {
          ...base,
          stepId: "unit",
          timeoutSeconds: 3600,
          maxWallClockSeconds: 3600,
        }),
      ),
    ).toContain("maxWallClockSeconds");
    expect(
      await refusal(recordStepTimeout(record, { ...base, stepId: "trial", timeoutSeconds: 1000 })),
    ).toContain("not above");
    expect(inputs).toHaveLength(0);
  });

  it("refuses an unknown step, an empty reason, and no field", async () => {
    const { record } = recorder();
    await refusal(recordStepTimeout(record, { ...base, stepId: "ghost", timeoutSeconds: 900 }));
    await refusal(
      recordStepTimeout(record, { ...base, stepId: "unit", timeoutSeconds: 900, reason: " " }),
    );
    await refusal(recordStepTimeout(record, { ...base, stepId: "unit" }));
  });
});

describe("recordStepSkip", () => {
  const base = { steps, decisions: [], reason: "waiting longer did not help" };

  it("records a skip of a timed-out step", async () => {
    const { record, inputs } = recorder();
    await recordStepSkip(record, {
      ...base,
      stepId: "trial",
      verifications: [verificationOf({ stepId: "trial", exitCode: 124 })],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.context.startsWith("STEP SKIPPED:")).toBe(true);
    expect(inputs[0]?.context).toContain("trial");
    expect(inputs[0]?.rationale).toBe("waiting longer did not help");
    expect(inputs[0]?.alternatives.map((a) => a.summary)).toEqual([
      "raise the timeout again",
      "fix the step so it finishes in time",
    ]);
  });

  it("refuses a step that failed, passed or never ran", async () => {
    const { record, inputs } = recorder();
    const skip = (verifications: Verification[]) =>
      refusal(recordStepSkip(record, { ...base, stepId: "unit", verifications }));
    expect(await skip([verificationOf({ stepId: "unit", exitCode: 1 })])).toBe(
      "unit ran and failed with exit 1; fix it, it cannot be skipped",
    );
    expect(await skip([verificationOf({ stepId: "unit", exitCode: 0 })])).toBe(
      "unit passed on its most recent run; it cannot be skipped",
    );
    expect(await skip([])).toContain("has not run in this run");
    expect(inputs).toHaveLength(0);
  });
});

it("STEP_TIMED_OUT_EXIT_CODE equals the verification runner's TIMEOUT_EXIT_CODE", () => {
  expect(STEP_TIMED_OUT_EXIT_CODE).toBe(TIMEOUT_EXIT_CODE);
});

describe("resolveSteps", () => {
  const page =
    <T>(items: T[]) =>
    async () => ({ items, cursor: undefined });
  const storesOf = (decisions: unknown[], verifications: unknown[]) =>
    ({
      decisions: { listByRun: page(decisions) },
      executionNodes: { listByRun: page([{ executionNodeId: "node_1" }]) },
      verifications: { listByNode: async () => verifications },
    }) as never;
  const scope = {} as never;
  const decision = (decisionId: string, context: string, createdAt: string) => ({
    decisionId,
    context,
    createdAt,
    rationale: "because",
  });

  it("hands the runner the raised timeout and cleanup time", async () => {
    const resolved = await resolveSteps(
      storesOf(
        [decision("dec_1", "STEP TIMEOUT: trial timeoutSeconds=900 cleanupSeconds=60", "1")],
        [],
      ),
      scope,
      [
        { id: "unit", command: "u" },
        { id: "trial", command: "t" },
      ] as never,
    );
    expect(resolved.runnable.map((step) => step.id)).toEqual(["unit", "trial"]);
    expect(resolved.runnable[1]).toMatchObject({ timeoutSeconds: 900, cleanupSeconds: 60 });
    expect(resolved.runnable[0]).not.toHaveProperty("timeoutSeconds");
  });

  it("excludes an honoured skip and keeps a refused one running", async () => {
    const stores = (exitCode: number) =>
      storesOf(
        [decision("dec_1", "STEP SKIPPED: trial", "1")],
        [
          {
            verificationId: "ver_1",
            commitSha: "abc",
            endedAt: "2",
            commands: [{ stepId: "trial", exitCode }],
          },
        ],
      );
    const steps = [{ id: "trial", command: "t" }] as never;
    const honoured = await resolveSteps(stores(STEP_TIMED_OUT_EXIT_CODE), scope, steps);
    expect(honoured.runnable).toEqual([]);
    expect(honoured.skipped.get("trial")).toBe("dec_1");
    const refused = await resolveSteps(stores(1), scope, steps);
    expect(refused.runnable.map((step) => step.id)).toEqual(["trial"]);
    expect(refused.runnable[0]).not.toHaveProperty("skipNotHonoured");
    expect(refused.notApplied[0]).toMatchObject({ stepId: "trial", decisionId: "dec_1" });
  });
});
