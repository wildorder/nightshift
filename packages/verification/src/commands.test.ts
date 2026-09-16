import type { ArtifactId } from "@nightshift/contracts";
import { VerificationCommandResultSchema } from "@nightshift/contracts";
import { createCountingIdGenerator } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { outcomeOf, toVerificationCommands } from "./commands.js";
import type { StepResult } from "./run.js";

const ids = createCountingIdGenerator();
const artifact = (): ArtifactId => ids.next("art");

const result = (stepId: string, exitCode: number): StepResult => ({
  stepId,
  command: `run ${stepId}`,
  exitCode,
  durationMs: 12,
  output: new TextEncoder().encode("log"),
  timedOut: false,
});

describe("toVerificationCommands", () => {
  it("produces one command per step, in order, with its log artifact", () => {
    const lintLog = artifact();
    const testLog = artifact();
    const commands = toVerificationCommands(
      [result("lint", 0), result("test", 1)],
      new Map([
        ["lint", lintLog],
        ["test", testLog],
      ]),
    );

    expect(commands).toEqual([
      { stepId: "lint", command: "run lint", exitCode: 0, durationMs: 12, logArtifactId: lintLog },
      { stepId: "test", command: "run test", exitCode: 1, durationMs: 12, logArtifactId: testLog },
    ]);
  });

  it("omits the key entirely for a step with no artifact", () => {
    const commands = toVerificationCommands([result("lint", 0)], new Map());

    // Omitted, not set to undefined: the schema is a strictObject and the repo
    // compiles with exactOptionalPropertyTypes.
    expect(commands[0] && "logArtifactId" in commands[0]).toBe(false);
  });

  it("produces what the contract schema accepts", () => {
    const commands = toVerificationCommands(
      [result("lint", 0), result("test", 2)],
      new Map([["lint", artifact()]]),
    );

    for (const command of commands) {
      expect(VerificationCommandResultSchema.safeParse(command).success).toBe(true);
    }
  });

  it("carries the output nowhere: bytes stay out of the record (A-08)", () => {
    const commands = toVerificationCommands([result("lint", 0)], new Map());
    expect(Object.keys(commands[0] ?? {})).toEqual(["stepId", "command", "exitCode", "durationMs"]);
  });
});

describe("outcomeOf", () => {
  it("passes only when every exit code is zero", () => {
    expect(outcomeOf([result("a", 0), result("b", 0)])).toBe("passed");
    expect(outcomeOf([result("a", 0), result("b", 1)])).toBe("failed");
    expect(outcomeOf([result("a", 255), result("b", 0)])).toBe("failed");
  });

  it("fails an empty result set rather than passing vacuously", () => {
    expect(outcomeOf([])).toBe("failed");
  });

  it("agrees with the cross-check the Verification schema applies", () => {
    // The schema refuses `passed` unless every exit code is zero. Computing the
    // outcome here means the execution layer cannot contradict its own
    // evidence and find out at the persistence boundary.
    for (const codes of [[0], [0, 0], [1], [0, 1], [124, 0]]) {
      const results = codes.map((code, index) => result(`s${index}`, code));
      const outcome = outcomeOf(results);
      const commands = toVerificationCommands(results, new Map());
      const consistent =
        outcome === "passed"
          ? commands.every((command) => command.exitCode === 0)
          : commands.some((command) => command.exitCode !== 0);
      expect(consistent, `codes ${codes.join(",")} gave ${outcome}`).toBe(true);
    }
  });
});
