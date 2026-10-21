import type { ProgramContract, Verification } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { verificationTimeOf } from "./verification-time.js";

const program = {
  verification: [{ id: "build", command: "npm run build" }],
} as unknown as ProgramContract;

type Command = Verification["commands"][number];
const verificationOf = (commands: Command[], phase?: "queue" | "candidate" | "run"): Verification =>
  ({ commands, ...(phase === undefined ? {} : { phase }) }) as unknown as Verification;
const step = (commands: Command[], phase?: "queue" | "candidate" | "run") => {
  const report = verificationTimeOf(program, [verificationOf(commands, phase)], 1, undefined);
  const found = report.steps.find((candidate) => candidate.id === "build");
  if (found === undefined) throw new Error("no build step");
  return { report, found };
};

describe("verificationTimeOf", () => {
  it("counts a flaky command's failed first run as an extra run", () => {
    const { found, report } = step([
      {
        stepId: "build",
        command: "x",
        exitCode: 0,
        durationMs: 300,
        flaky: { firstExitCode: 1, firstDurationMs: 500 },
      },
    ]);
    expect(found.runs).toBe(2);
    expect(found.totalMs).toBe(800);
    expect(found.byPhase.queue).toEqual({ runs: 2, totalMs: 800 });
    expect(report.totalMs).toBe(800);
  });

  it("counts a failed rerun's duration as an extra run", () => {
    const { found } = step(
      [
        {
          stepId: "build",
          command: "x",
          exitCode: 1,
          durationMs: 400,
          rerun: { exitCode: 1, durationMs: 450 },
        },
      ],
      "candidate",
    );
    expect(found.runs).toBe(2);
    expect(found.totalMs).toBe(850);
    expect(found.byPhase.candidate).toEqual({ runs: 2, totalMs: 850 });
    expect(found.byPhase.queue).toEqual({ runs: 0, totalMs: 0 });
  });

  it("adds nothing for deferred and skipped commands", () => {
    const { found } = step([
      {
        stepId: "build",
        command: "x",
        durationMs: 900,
        deferred: { prerequisiteId: "pre_x" },
      } as unknown as Command,
      {
        stepId: "build",
        command: "x",
        durationMs: 700,
        skipped: { decisionId: "dec_x" },
      } as unknown as Command,
    ]);
    expect(found.runs).toBe(0);
    expect(found.totalMs).toBe(0);
  });

  it("keeps phase buckets in agreement with the step total", () => {
    const run = (durationMs: number): Command => ({
      stepId: "build",
      command: "x",
      exitCode: 0,
      durationMs,
    });
    const report = verificationTimeOf(
      program,
      [
        verificationOf([run(100)], "queue"),
        verificationOf(
          [
            {
              ...run(300),
              flaky: { firstExitCode: 1, firstDurationMs: 500 },
            },
          ],
          "run",
        ),
      ],
      2,
      undefined,
    );
    const found = report.steps[0];
    if (found === undefined) throw new Error("no step");
    const phases = Object.values(found.byPhase);
    expect(phases.reduce((n, p) => n + p.totalMs, 0)).toBe(found.totalMs);
    expect(phases.reduce((n, p) => n + p.runs, 0)).toBe(found.runs);
    expect(found.totalMs).toBe(900);
    expect(found.runs).toBe(3);
  });
});
