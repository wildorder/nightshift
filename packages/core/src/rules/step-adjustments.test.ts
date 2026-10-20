import { describe, expect, it } from "vitest";
import {
  type AdjustmentDecision,
  type AdjustmentNodeKind,
  adjustmentDecisionsOf,
  currentStepTime,
  effectiveSteps,
  formatStepSkippedContext,
  formatStepTimeoutContext,
  lastRunOf,
  raiseRefusal,
  STEP_TIMEOUT_CONTEXT,
  type StepCommandLike,
  type StepVerificationLike,
  skipEligibility,
  skipHonoured,
  stepAdjustmentOf,
  stepAdjustmentsOf,
} from "./step-adjustments.js";

let counter = 0;
const decision = (
  context: string,
  createdAt: string,
  rationale = "because",
): AdjustmentDecision => ({
  decisionId: `dec_${++counter}`,
  context,
  createdAt,
  rationale,
});
const raise = (
  stepId: string,
  at: string,
  values: { timeoutSeconds?: number; cleanupSeconds?: number },
) => decision(formatStepTimeoutContext(stepId, values), at);
const skip = (stepId: string, at: string) =>
  decision(formatStepSkippedContext(stepId), at, "too slow");

let sequence = 0;
const verification = (
  endedAt: string,
  commands: StepCommandLike[],
  commitSha = `sha${sequence}`,
): StepVerificationLike => ({
  verificationId: `ver_${++sequence}`,
  commitSha,
  endedAt,
  commands,
});
const ran = (stepId: string, exitCode: number): StepCommandLike => ({ stepId, exitCode });

const steps = [{ id: "unit" }, { id: "trial", timeoutSeconds: 1000, cleanupSeconds: 60 }];

describe("context format", () => {
  it("round-trips", () => {
    const d = decision(formatStepTimeoutContext("trial", { timeoutSeconds: 3000 }), "t");
    expect(d.context).toBe("STEP TIMEOUT: trial timeoutSeconds=3000");
    expect(stepAdjustmentOf(d)).toMatchObject({
      kind: "timeout",
      stepId: "trial",
      timeoutSeconds: 3000,
    });
    expect(stepAdjustmentOf(skip("trial", "t"))).toMatchObject({ kind: "skip", stepId: "trial" });
    expect(stepAdjustmentOf(decision("STRAND PLAN: x", "t"))).toBeUndefined();
    expect(stepAdjustmentOf(decision("STEP TIMEOUT: trial", "t"))).toBeUndefined();
  });
});

describe("lastRunOf and skipEligibility", () => {
  it("looks past deferred and skipped records", () => {
    const vs = [
      verification("2026-01-01T00:00:01Z", [ran("a", 124)]),
      verification("2026-01-01T00:00:02Z", [{ stepId: "a", skipped: { decisionId: "d" } }]),
      verification("2026-01-01T00:00:03Z", [{ stepId: "a", deferred: { prerequisiteId: "p" } }]),
    ];
    expect(lastRunOf("a", vs)?.exitCode).toBe(124);
    expect(lastRunOf("b", vs)).toBeUndefined();
  });

  it("orders by endedAt, then position", () => {
    const vs = [
      verification("2026-01-01T00:00:05Z", [ran("a", 0)]),
      verification("2026-01-01T00:00:01Z", [ran("a", 124)]),
    ];
    expect(lastRunOf("a", vs)?.exitCode).toBe(0);
  });

  it("is eligible only when the most recent record timed out", () => {
    const timedOut = verification("2026-01-01T00:00:01Z", [ran("a", 124)], "abc");
    expect(skipEligibility("a", [timedOut])).toEqual({
      eligible: true,
      timedOut: { verificationId: timedOut.verificationId, commitSha: "abc" },
    });
  });

  it("names what the record was otherwise", () => {
    const at = (n: number) => `2026-01-01T00:00:0${n}Z`;
    const reason = (c: StepCommandLike[]) => {
      const r = skipEligibility("a", [verification(at(1), c)]);
      return r.eligible ? undefined : r.reason;
    };
    expect(reason([ran("a", 1)])).toBe(
      "a ran and failed with exit 1; fix it, it cannot be skipped",
    );
    expect(reason([ran("a", 0)])).toBe("a passed on its most recent run; it cannot be skipped");
    expect(reason([{ stepId: "a", deferred: { prerequisiteId: "p" } }])).toBe(
      "a was deferred on its most recent run, waiting on p; it cannot be skipped",
    );
    expect(reason([{ stepId: "a", skipped: { decisionId: "dec_9" } }])).toBe(
      "a is already skipped, by decision dec_9",
    );
    expect(reason([])).toBe(
      "a has not run in this run; only a step whose most recent run timed out may be skipped (D-06)",
    );
  });

  it("a timed-out run followed by a skipped record is not eligible but stays honoured", () => {
    const vs = [
      verification("2026-01-01T00:00:01Z", [ran("a", 124)]),
      verification("2026-01-01T00:00:02Z", [{ stepId: "a", skipped: { decisionId: "d" } }]),
    ];
    expect(skipEligibility("a", vs).eligible).toBe(false);
    expect(skipHonoured("a", vs)).toEqual({ honoured: true });
  });

  it("does not honour a skip of a step that never ran", () => {
    expect(skipHonoured("a", [])).toMatchObject({ honoured: false });
  });
});

describe("effectiveSteps", () => {
  const timedOut = [verification("2026-01-01T00:00:01Z", [ran("trial", 124)])];

  it("applies the latest raise per field, clamps, ignores unknown steps, keeps order", () => {
    const decisions = [
      raise("trial", "2026-01-01T00:00:02Z", { timeoutSeconds: 2000, cleanupSeconds: 100 }),
      raise("trial", "2026-01-01T00:00:03Z", { timeoutSeconds: 99999 }),
      raise("ghost", "2026-01-01T00:00:04Z", { timeoutSeconds: 5 }),
      raise("unit", "2026-01-01T00:00:01Z", { cleanupSeconds: 90 }),
    ];
    const result = effectiveSteps(steps, decisions, []);
    expect(result.map((s) => s.id)).toEqual(["unit", "trial"]);
    expect(result[0]).toEqual({ id: "unit", cleanupSeconds: 90 });
    expect(result[1]).toEqual({ id: "trial", timeoutSeconds: 7200, cleanupSeconds: 100 });
  });

  it("orders decisions by createdAt, then list position", () => {
    const a = raise("unit", "2026-01-01T00:00:02Z", { timeoutSeconds: 700 });
    const b = raise("unit", "2026-01-01T00:00:01Z", { timeoutSeconds: 900 });
    expect(effectiveSteps(steps, [a, b], [])[0]?.timeoutSeconds).toBe(700);
    const c = raise("unit", "2026-01-01T00:00:02Z", { timeoutSeconds: 800 });
    expect(effectiveSteps(steps, [a, c], [])[0]?.timeoutSeconds).toBe(800);
  });

  it("marks a skip honoured when the latest actual run timed out", () => {
    const s = skip("trial", "2026-01-01T00:00:02Z");
    const result = effectiveSteps(steps, [s], timedOut);
    expect(result[1]?.skipped).toEqual({ decisionId: s.decisionId });
    expect(result[1]?.skipNotHonoured).toBeUndefined();
  });

  it("stays honoured when later records show the step skipped", () => {
    const s = skip("trial", "2026-01-01T00:00:02Z");
    const vs = [
      ...timedOut,
      verification("2026-01-01T00:00:03Z", [
        { stepId: "trial", skipped: { decisionId: s.decisionId } },
      ]),
    ];
    expect(effectiveSteps(steps, [s], vs)[1]?.skipped).toBeDefined();
  });

  it("does not honour a skip when the latest run passed or failed", () => {
    const s = skip("trial", "2026-01-01T00:00:02Z");
    for (const [code, words] of [
      [0, "passed on its most recent run"],
      [1, "ran and failed with exit 1"],
    ] as const) {
      const vs = [...timedOut, verification("2026-01-01T00:00:05Z", [ran("trial", code)])];
      const result = effectiveSteps(steps, [s], vs)[1];
      expect(result?.skipped).toBeUndefined();
      expect(result?.skipNotHonoured?.decisionId).toBe(s.decisionId);
      expect(result?.skipNotHonoured?.reason).toContain(words);
    }
  });

  it("does not honour a skip of a step that never ran", () => {
    expect(effectiveSteps(steps, [skip("trial", "t")], [])[1]?.skipNotHonoured).toBeDefined();
  });

  it("lets a raise after a skip un-skip the step", () => {
    const decisions = [
      skip("trial", "2026-01-01T00:00:02Z"),
      raise("trial", "2026-01-01T00:00:03Z", { timeoutSeconds: 2000 }),
    ];
    const result = effectiveSteps(steps, decisions, timedOut)[1];
    expect(result?.skipped).toBeUndefined();
    expect(result?.skipNotHonoured).toBeUndefined();
    expect(result?.timeoutSeconds).toBe(2000);
  });
});

describe("currentStepTime", () => {
  it("fills in defaults", () => {
    expect(currentStepTime({ id: "unit" }, [])).toEqual({
      timeoutSeconds: 600,
      cleanupSeconds: 30,
    });
    expect(currentStepTime({ id: "unit" }, [raise("unit", "t", { timeoutSeconds: 900 })])).toEqual({
      timeoutSeconds: 900,
      cleanupSeconds: 30,
    });
  });
});

describe("raiseRefusal", () => {
  const step = { id: "trial", timeoutSeconds: 1000 };
  it("refuses a call with neither field", () => {
    expect(raiseRefusal(step, [], {})).toContain("timeoutSeconds, cleanupSeconds, or both");
  });
  it("refuses a value over the maximum, naming it", () => {
    expect(raiseRefusal(step, [], { timeoutSeconds: 7201 })).toContain("maximum of 7200 seconds");
    expect(raiseRefusal(step, [], { cleanupSeconds: 3601 })).toContain("maximum of 3600 seconds");
  });
  it("refuses a value not above the current effective value", () => {
    expect(raiseRefusal(step, [], { timeoutSeconds: 1000 })).toContain(
      "not above its current 1000",
    );
    const decisions = [raise("trial", "t", { timeoutSeconds: 2000 })];
    expect(raiseRefusal(step, decisions, { timeoutSeconds: 1500 })).toContain("current 2000");
    expect(raiseRefusal(step, [], { cleanupSeconds: 30 })).toContain("current 30");
  });
  it("accepts a raise", () => {
    expect(raiseRefusal(step, [], { timeoutSeconds: 1001 })).toBeUndefined();
  });
  it("refuses a raise whose timeout plus cleanup exceeds the wall clock, with a defaulted counterpart", () => {
    const message = raiseRefusal(
      { id: "unit" },
      [],
      { timeoutSeconds: 3600 },
      { maxWallClockSeconds: 3600 },
    );
    expect(message).toContain("timeoutSeconds 3600");
    expect(message).toContain("cleanupSeconds 30 (the default)");
    expect(message).toContain("3630");
    expect(message).toContain("maxWallClockSeconds of 3600");
    expect(
      raiseRefusal({ id: "unit" }, [], { timeoutSeconds: 3570 }, { maxWallClockSeconds: 3600 }),
    ).toBeUndefined();
  });
  it("counts the unchanged field at its effective value", () => {
    const decisions = [raise("unit", "t", { cleanupSeconds: 1000 })];
    expect(
      raiseRefusal(
        { id: "unit" },
        decisions,
        { timeoutSeconds: 2700 },
        { maxWallClockSeconds: 3600 },
      ),
    ).toContain("3700 seconds together");
  });
});

describe("stepAdjustmentsOf", () => {
  it("lists skips with commits and raises with old and new values", () => {
    const r1 = decision(
      formatStepTimeoutContext("trial", { timeoutSeconds: 2000 }),
      "2026-01-01T00:00:01Z",
      "slow",
    );
    const r2 = decision(
      formatStepTimeoutContext("trial", { timeoutSeconds: 3000, cleanupSeconds: 90 }),
      "2026-01-01T00:00:02Z",
      "slower",
    );
    const s = skip("trial", "2026-01-01T00:00:03Z");
    const vs = [
      verification("2026-01-01T00:00:02Z", [ran("trial", 124)], "c1"),
      verification(
        "2026-01-01T00:00:04Z",
        [{ stepId: "trial", skipped: { decisionId: s.decisionId } }],
        "c2",
      ),
      verification(
        "2026-01-01T00:00:05Z",
        [{ stepId: "trial", skipped: { decisionId: s.decisionId } }],
        "c2",
      ),
      verification(
        "2026-01-01T00:00:06Z",
        [{ stepId: "trial", skipped: { decisionId: s.decisionId } }],
        "c3",
      ),
    ];
    const result = stepAdjustmentsOf(steps, [s, r2, r1], vs);
    expect(result.raised).toEqual([
      {
        stepId: "trial",
        decisionId: r1.decisionId,
        field: "timeoutSeconds",
        from: 1000,
        to: 2000,
        reason: "slow",
      },
      {
        stepId: "trial",
        decisionId: r2.decisionId,
        field: "timeoutSeconds",
        from: 2000,
        to: 3000,
        reason: "slower",
      },
      {
        stepId: "trial",
        decisionId: r2.decisionId,
        field: "cleanupSeconds",
        from: 60,
        to: 90,
        reason: "slower",
      },
    ]);
    expect(result.skipped).toEqual([
      {
        stepId: "trial",
        decisionId: s.decisionId,
        reason: "too slow",
        commits: ["c2", "c3"],
        applied: true,
        inForce: true,
      },
    ]);
  });

  const skippedBy = (decisionId: string): StepCommandLike => ({
    stepId: "trial",
    skipped: { decisionId },
  });

  it("keeps a skip's commits after a later raise un-skips the step", () => {
    const t = decision(STEP_TIMEOUT_CONTEXT + " trial", "2026-01-01T00:00:01Z", "x");
    const timeout = decision(
      formatStepTimeoutContext("trial", { timeoutSeconds: 2000 }),
      "2026-01-01T00:00:05Z",
      "wait",
    );
    const s = skip("trial", "2026-01-01T00:00:02Z");
    const result = stepAdjustmentsOf(
      steps,
      [t, s, timeout],
      [
        verification("2026-01-01T00:00:01Z", [ran("trial", 124)], "a"),
        verification("2026-01-01T00:00:03Z", [skippedBy(s.decisionId)], "b"),
        verification("2026-01-01T00:00:07Z", [ran("trial", 0)], "c"),
      ],
    );
    expect(result.skipped).toEqual([
      {
        stepId: "trial",
        decisionId: s.decisionId,
        reason: "too slow",
        commits: ["b"],
        applied: true,
        inForce: false,
      },
    ]);
  });

  it("attributes each commit to the decision whose id the record carries", () => {
    const s1 = skip("trial", "2026-01-01T00:00:02Z");
    const s2 = skip("trial", "2026-01-01T00:00:06Z");
    const result = stepAdjustmentsOf(
      steps,
      [s1, s2],
      [
        verification("2026-01-01T00:00:01Z", [ran("trial", 124)], "a"),
        verification("2026-01-01T00:00:03Z", [skippedBy(s1.decisionId)], "b"),
        verification("2026-01-01T00:00:08Z", [skippedBy(s2.decisionId)], "c"),
      ],
    );
    expect(result.skipped.map((k) => [k.decisionId, k.commits, k.inForce])).toEqual([
      [s1.decisionId, ["b"], false],
      [s2.decisionId, ["c"], true],
    ]);
  });

  it("says why a skip never recorded did not apply when the step ran after it", () => {
    const s = skip("trial", "2026-01-01T00:00:02Z");
    const result = stepAdjustmentsOf(
      steps,
      [s],
      [
        verification("2026-01-01T00:00:01Z", [ran("trial", 1)]),
        verification("2026-01-01T00:00:03Z", [ran("trial", 1)]),
      ],
    );
    expect(result.skipped[0]).toMatchObject({ applied: false, commits: [], inForce: false });
    expect(result.skipped[0]?.notApplied).toContain("ran and failed with exit 1");
  });

  it("gives a never-recorded skip neither commits nor a reason when nothing ran since", () => {
    const s = skip("trial", "2026-01-01T00:00:02Z");
    const result = stepAdjustmentsOf(
      steps,
      [s],
      [verification("2026-01-01T00:00:01Z", [ran("trial", 124)])],
    );
    expect(result.skipped[0]).toEqual({
      stepId: "trial",
      decisionId: s.decisionId,
      reason: "too slow",
      commits: [],
      applied: false,
      inForce: true,
    });
  });
});

describe("adjustmentDecisionsOf", () => {
  const authored = (executionNodeId: string, authority = "agent") => ({
    ...skip("trial", "2026-01-01T00:00:00Z"),
    executionNodeId,
    authority,
  });
  const kinds: Record<string, AdjustmentNodeKind> = {
    root: "program",
    strand: "sub-program",
    worker: "job",
  };
  const kindOf = (nodeId: string) => kinds[nodeId];

  it("drops a decision recorded on a job node, or on an unknown node", () => {
    expect(adjustmentDecisionsOf([authored("worker"), authored("nowhere")], kindOf)).toEqual([]);
  });

  it("keeps one on a sub-program node and one on the program node", () => {
    const decisions = [authored("strand"), authored("root")];
    expect(adjustmentDecisionsOf(decisions, kindOf)).toEqual(decisions);
  });

  it("drops a human's decision on a job node, and keeps one on the root node", () => {
    const onJob = authored("worker", "human");
    const onRoot = authored("root", "human");
    expect(adjustmentDecisionsOf([onJob, onRoot, authored("worker")], kindOf)).toEqual([onRoot]);
  });
});

describe("a raise against the run's wall clock", () => {
  const steps: { id: string; timeoutSeconds?: number; cleanupSeconds?: number }[] = [
    { id: "trial" },
  ];
  const sequence = [
    raise("trial", "2026-01-01T00:00:01Z", { cleanupSeconds: 1000 }),
    raise("trial", "2026-01-01T00:00:02Z", { timeoutSeconds: 3000 }),
  ];

  it("applies the first raise of the examiner's sequence and not the second", () => {
    const [step] = effectiveSteps(steps, sequence, [], { maxWallClockSeconds: 3600 });
    expect(step).toMatchObject({ cleanupSeconds: 1000 });
    expect(step?.timeoutSeconds).toBeUndefined();
    expect(step?.raisesNotApplied).toEqual([
      expect.objectContaining({
        decisionId: sequence[1]?.decisionId,
        field: "timeoutSeconds",
        to: 3000,
        reason: expect.stringContaining("4000 seconds together"),
      }),
    ]);
    expect(currentStepTime(steps[0] as never, sequence, { maxWallClockSeconds: 3600 })).toEqual({
      timeoutSeconds: 600,
      cleanupSeconds: 1000,
    });
    const adjustments = stepAdjustmentsOf(steps, sequence, [], { maxWallClockSeconds: 3600 });
    expect(adjustments.raised[0]?.notApplied).toBeUndefined();
    expect(adjustments.raised[1]?.notApplied).toContain("4000 seconds together");
  });

  it("applies both when the run has no wall clock", () => {
    const [step] = effectiveSteps(steps, sequence, []);
    expect(step).toMatchObject({ cleanupSeconds: 1000, timeoutSeconds: 3000 });
    expect(step?.raisesNotApplied).toBeUndefined();
  });
});
