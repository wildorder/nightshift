import type { AuditedGate, GateAudit, GitRunner } from "@nightshift/execution";
import { describe, expect, it } from "vitest";
import type { CliEnvironment, Exec } from "../environment.js";
import {
  auditProgramRuntimes,
  describeAudit,
  describeRuntimeFindings,
  stepVerdict,
} from "./gates.js";

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

describe("rule 8, declares its runtimes (P16 S-02, SC-08)", () => {
  const AUDITED = "fedcba9876543210fedcba9876543210fedcba98";

  /** A git whose commit `AUDITED` holds `committed`; the working tree, `HEAD`, holds nothing. */
  const gitAt =
    (committed: Record<string, string>): GitRunner =>
    async (args) => {
      const [verb, spec] = args;
      const [sha, file] = (spec ?? "").split(":");
      const text = verb === "show" && sha === AUDITED ? committed[file ?? ""] : undefined;
      return text === undefined
        ? { stdout: "", stderr: `fatal: path '${file}' does not exist`, exitCode: 128 }
        : { stdout: text, stderr: "", exitCode: 0 };
    };

  /** An exec where each runtime answers `--version` as `versions` says, and the rest are not installed. */
  const execWith =
    (versions: Record<string, string>): Exec =>
    async (file) => {
      const said = versions[file];
      if (said === undefined)
        throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
      return { exitCode: 0, stdout: `${said}\n`, stderr: "" };
    };

  const printed = (findings: Parameters<typeof describeRuntimeFindings>[1]): string => {
    const lines: string[] = [];
    describeRuntimeFindings((line) => lines.push(line), findings, AUDITED);
    return lines.join("\n");
  };

  it("reads the files at the audited commit, measures each pinned runtime, and prints every finding", async () => {
    const findings = await auditProgramRuntimes(
      {
        git: gitAt({
          "package.json": "{}",
          ".nvmrc": "24\n",
          ".python-version": "3.12\n",
          ".ruby-version": "3.3.0\n",
          ".tool-versions": "ruby 3.2.0\nterraform 1.9.0\nterraform 1.10.0\n",
          "Cargo.toml": "[package]\n",
        }),
        exec: execWith({ node: "v22.22.0", python: "Python 3.12.4" }),
      },
      "/repo",
      AUDITED,
    );
    expect(findings).toEqual([
      { kind: "unpinned", runtime: "rust", marker: "Cargo.toml" },
      {
        kind: "conflicting",
        runtime: "ruby",
        a: { spec: "3.3.0", source: ".ruby-version" },
        b: { spec: "3.2.0", source: ".tool-versions" },
      },
      { kind: "unmet", runtime: "node", spec: "24", source: ".nvmrc", measured: "22.22.0" },
    ]);
    const out = printed(findings);
    expect(out).toContain("rule 8, declares its runtimes: 3 findings on fedcba98");
    expect(out).toContain(
      "Cargo.toml says this repository uses rust, and no file pins its version",
    );
    expect(out).toContain(".ruby-version pins ruby 3.3.0 but .tool-versions pins 3.2.0");
    expect(out).toContain(".nvmrc pins node 24, but this machine runs node 22.22.0");
    expect(out).not.toContain("terraform");
  });

  it("says a pinned runtime the machine lacks was not found", async () => {
    const findings = await auditProgramRuntimes(
      { git: gitAt({ ".python-version": "3.12\n" }), exec: execWith({}) },
      "/repo",
      AUDITED,
    );
    expect(printed(findings)).toContain(
      ".python-version pins python 3.12, and python was not found on this machine",
    );
  });

  it("finds nothing in a commit that pins what it uses on a machine that meets it", async () => {
    const findings = await auditProgramRuntimes(
      {
        git: gitAt({ "package.json": "{}", ".node-version": "24.1.0\n" }),
        exec: execWith({ node: "v24.1.0" }),
      },
      "/repo",
      AUDITED,
    );
    expect(findings).toEqual([]);
    expect(printed(findings)).toBe(
      "rule 8, declares its runtimes: every runtime used on fedcba98 is pinned and met",
    );
  });

  it("never reads the working tree: files only at the audited commit count", async () => {
    const findings = await auditProgramRuntimes(
      { git: gitAt({}), exec: execWith({ node: "v24.1.0" }) },
      "/repo",
      "0".repeat(40),
    );
    expect(findings).toEqual([]);
  });
});
