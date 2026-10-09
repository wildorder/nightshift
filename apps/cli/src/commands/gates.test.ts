import type { AuditedGate, GateAudit } from "@nightshift/execution";
import { describe, expect, it } from "vitest";
import type { CliEnvironment } from "../environment.js";
import { describeAudit, stepVerdict } from "./gates.js";

type Result = NonNullable<AuditedGate["result"]>;

const BASE = "0123456789abcdef0123456789abcdef01234567" as GateAudit["base"];

const resultOf = (stepId: string, exitCode: number, output = "", timedOut = false): Result =>
  ({
    stepId,
    command: "x",
    exitCode,
    timedOut,
    durationMs: 1000,
    output: new TextEncoder().encode(output),
  }) as unknown as Result;

const DEFER_OUTPUT =
  "NIGHTSHIFT_DEFER HP-07 a cloud login\nNIGHTSHIFT_REMEDIATION run aws sso login\n";
const DEFERRAL = {
  prerequisiteId: "HP-07",
  description: "a cloud login",
  remediation: "run aws sso login",
};

const said = (audit: GateAudit): { out: string; err: string } => {
  const out: string[] = [];
  const err: string[] = [];
  const environment = {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  } as unknown as CliEnvironment;
  describeAudit(environment, audit);
  return { out: out.join("\n"), err: err.join("\n") };
};

const auditOf = (gates: readonly AuditedGate[]): GateAudit => {
  const failing = gates.filter((gate) => gate.verdict === "failed").map((gate) => gate.id);
  return {
    base: BASE,
    gates,
    red: failing.length > 0,
    failing,
    deferred: gates.filter((gate) => gate.verdict === "deferred").map((gate) => gate.id),
    lockfilesWithoutSetup: [],
  };
};

describe("the gate audit's progress line", () => {
  it("says a step that exits 75 with a NIGHTSHIFT_DEFER line deferred, not failed", () => {
    expect(stepVerdict(resultOf("cloud", 75, DEFER_OUTPUT))).toBe("DEFERRED");
  });

  it("says a step that exits 75 without the line failed", () => {
    expect(stepVerdict(resultOf("cloud", 75, "tempfail"))).toBe("FAIL (exited 75)");
  });

  it("says a passing step ok and a timed-out one failed", () => {
    expect(stepVerdict(resultOf("ok", 0))).toBe("ok  ");
    expect(stepVerdict(resultOf("slow", 1, "", true))).toBe("FAIL (timed out)");
  });
});

describe("describeAudit", () => {
  it("says the gates pass when every gate passed", () => {
    const { out } = said(
      auditOf([{ id: "test", command: "t", kind: "check", verdict: "passed", waitingOn: [] }]),
    );
    expect(out).toMatch(/the gates pass on 01234567/);
  });

  it("names a deferred check with its reason, and does not say the gates pass", () => {
    const { out, err } = said(
      auditOf([
        {
          id: "cloud",
          command: "c",
          kind: "check",
          result: resultOf("cloud", 75, DEFER_OUTPUT),
          verdict: "deferred",
          deferral: DEFERRAL,
          waitingOn: [],
        },
        { id: "lint", command: "l", kind: "check", verdict: "passed", waitingOn: [] },
      ]),
    );
    expect(out).toContain("DEFERRED cloud: HP-07 a cloud login");
    expect(out).toContain("to fix: run aws sso login");
    expect(out).not.toMatch(/the gates pass/);
    expect(out).toContain("the gates do not pass yet: cloud is deferred");
    expect(err).not.toContain("RED");
  });

  it("says the checks behind a deferred setup did not run, and does not say the gates pass", () => {
    const { out, err } = said(
      auditOf([
        {
          id: "setup:login",
          command: "s",
          kind: "setup",
          result: resultOf("setup:login", 75, DEFER_OUTPUT),
          verdict: "deferred",
          deferral: DEFERRAL,
          waitingOn: [],
        },
        { id: "test", command: "t", kind: "check", verdict: "unrun", waitingOn: [] },
      ]),
    );
    expect(out).toContain("DEFERRED setup:login: HP-07 a cloud login");
    expect(out).toContain("not run: test, behind the deferred setup");
    expect(out).not.toMatch(/the gates pass/);
    expect(err).not.toContain("RED");
  });
});
