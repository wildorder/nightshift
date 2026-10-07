/**
 * The gate-health audit and `plan check`'s D-08 rule, end to end through the
 * real CLI (P15, S-01; D-P15-01, D-P15-02, D-P15-07, D-P15-08): `gates
 * --record`, the record read back over the control plane, `plan check` READY
 * or not, `gates --recorded`, a stale fingerprint after a machinery change, and
 * a repairing record answered by the plan.
 *
 * Real: the CLI, the API handler over a socket, a signed-in operator, git, the
 * gates themselves in a fresh checkout. Nothing is scripted.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, runCli } from "@nightshift/cli";
import type { PlannedDecision, ProgramContract, Strand } from "@nightshift/contracts";
import {
  createFetchTransport,
  createHttpStores,
  credentialsPath,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, SUBJECT, signIn } from "../cli/operator.js";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
  PROGRAM_BRANCH,
} from "../slice/fixture-repo.js";

const PROGRAM = "p1-modules";

let op: Operator;
let fixture: MaterialisedRepo;
let outside: string;
let contract: ProgramContract;

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
  }).trim();

const strand = (id: string, prefix: string, extra: Partial<Strand> = {}): Strand => ({
  id,
  name: `The ${prefix} modules`,
  scope: {
    summary: `modules whose names start with ${prefix}`,
    includes: [`src/${prefix}*.js`, `test/${prefix}*.test.js`],
    excludes: [],
  },
  acceptance: [`the ${prefix} modules exist and node --test passes`],
  successCriteria: [],
  dependsOn: [],
  prerequisites: [],
  ...extra,
});

const section = (id: string, prefix: string): string =>
  [
    `### ${id} The ${prefix} modules`,
    "",
    `Two small modules, \`${prefix}1\` and \`${prefix}2\`.`,
  ].join("\n");

const planOf = (strands: readonly Strand[]): string =>
  [
    "# Modules",
    "",
    "## Strands",
    "",
    ...strands.flatMap((s) => [section(s.id, s.name.split(" ")[1] ?? ""), ""]),
  ].join("\n");

const programPath = (...parts: string[]): string =>
  join(fixture.repo, "docs", "programs", PROGRAM, ...parts);

const writeProgram = async (patch: Partial<ProgramContract> = {}): Promise<void> => {
  const next = { ...contract, ...patch };
  await mkdir(programPath(), { recursive: true });
  await writeFile(programPath("contract.json"), `${JSON.stringify(next, null, 2)}\n`);
  await writeFile(programPath("plan.md"), planOf(next.strands ?? []));
};

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-qm", message);
};

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, [...argv, "--repo", fixture.repo]);
};

const said = (): string => `${op.out.join("\n")}\n${op.err.join("\n")}`;

const findingsFile = async (body: unknown): Promise<string> => {
  const path = join(outside, `findings-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

/** The record as the control plane holds it, read back over HTTP. */
const record = () =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
    actingOrg: op.orgId,
  }).gateHealth.get(contract.projectId);

beforeEach(async () => {
  op = await signIn();
  outside = await mkdtemp(join(tmpdir(), "nightshift-gate-health-"));
  const created = await createProject(op.environment, { name: "modules" });
  fixture = await materialiseFixtureRepo({ projectId: created.projectId as never });
  const token = join(outside, "release-token").replace(/\\/g, "/");
  const base = await authoredProgram();
  contract = {
    ...base,
    projectId: created.projectId as never,
    status: "planning",
    verification: [
      ...base.verification,
      { id: "release-check", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
    ],
    strands: [
      strand("S-01", "a", { successCriteria: base.successCriteria.map((c) => c.id) }),
      strand("S-02", "b", { dependsOn: ["S-01"] }),
      strand("S-03", "c"),
    ],
    prerequisites: [
      {
        id: "HP-01",
        description: "The release token is in place.",
        remediation: `Create ${token}.`,
        verifyCommand: `node -e "require('fs').accessSync('${token}')"`,
        status: "pending",
      },
    ],
    decisions: [
      {
        id: "D-01",
        question: "One file per module?",
        options: ["yes", "no"],
        answer: "yes",
        touches: "all",
      },
    ],
  };
  await writeProgram();
  git("rm", "-q", "nightshift.program.json");
  commit("plan the modules");
});

afterEach(async () => {
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
  await rm(outside, { recursive: true, force: true });
});

describe("the gate-health audit through the CLI (D-P15-07, D-P15-08)", () => {
  it("is NOT READY with no record, READY once a healthy audit is recorded, and stale after a machinery change", async () => {
    // Not ready for two reasons, said together: one the files', one the gates'.
    const { answer: _answer, ...open } = (contract.decisions ?? [])[0] as PlannedDecision;
    await writeProgram({ decisions: [open] });
    commit("an open question");
    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    expect(op.err[0]).toBe("NOT READY: 2 reasons");
    expect(said()).toContain("decision D-01 has no answer");
    expect(said()).toContain("the project's gates have never been audited");
    expect(said()).toContain(`\`nightshift gates ${PROGRAM} --record\``);
    expect(await cli("gates", PROGRAM, "--recorded")).toBe(1);
    expect(said()).toContain("no gate-health record");
    // Ratify applies the same readiness, and ratifies nothing.
    expect(await cli("plan", "ratify", PROGRAM)).toBe(1);
    expect(said()).toContain("the project's gates have never been audited");

    await writeProgram();
    commit("answer it");
    const head = git("rev-parse", PROGRAM_BRANCH);
    expect(await cli("gates", PROGRAM, "--record"), said()).toBe(0);
    expect(said()).toContain("auditing the gates on");
    expect(said()).toContain("recorded the gates as healthy");
    expect(said()).toContain(`commit      ${head}`);

    // Read back over the control plane, as the operator who recorded it.
    const recorded = await record();
    expect(recorded).toMatchObject({
      verdict: "healthy",
      commit: head,
      findings: [],
      machinery: [],
      auditedBy: { kind: "user", userId: SUBJECT, orgId: op.orgId },
    });
    expect(said()).toContain(`fingerprint ${recorded?.fingerprint.slice(0, 12)}`);

    expect(await cli("plan", "check", PROGRAM), said()).toBe(0);
    expect(op.out[0]).toBe("READY");
    expect(await cli("gates", PROGRAM, "--recorded"), said()).toBe(0);
    expect(said()).toContain("verdict     healthy");
    expect(said()).toContain("matches");

    // Name package.json as machinery; then change it on the program branch.
    const review = await findingsFile({ machinery: ["package.json"], findings: [] });
    expect(await cli("gates", PROGRAM, "--record", "--findings", review), said()).toBe(0);
    expect((await record())?.machinery).toEqual(["package.json"]);
    expect(await cli("gates", PROGRAM, "--recorded")).toBe(0);
    // A commit that touches nothing the gates depend on keeps the record.
    await writeFile(join(fixture.repo, "README.md"), "a note\n");
    commit("a note");
    expect(await cli("plan", "check", PROGRAM), said()).toBe(0);

    const pkg = JSON.parse(await readFile(join(fixture.repo, "package.json"), "utf8"));
    await writeFile(
      join(fixture.repo, "package.json"),
      `${JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, pretest: "echo hi" } }, null, 2)}\n`,
    );
    commit("a pre-hook");
    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    expect(op.err[0]).toBe("NOT READY: 1 reason");
    expect(said()).toContain(`the gates changed since they were audited at ${head.slice(0, 8)}`);
    expect(await cli("gates", PROGRAM, "--recorded")).toBe(1);
    expect(said()).toContain("does not match");
    expect(said()).toContain("stale");
  }, 120_000);

  it("records a review's findings as repairing, READY only once each is answered and S-00 comes first", async () => {
    await writeProgram({
      decisions: [
        ...(contract.decisions ?? []),
        {
          id: "D-02",
          question: "The tests reinstall in a pre-hook: move the install to setup?",
          options: ["move it", "leave it"],
          touches: "all",
        },
      ],
    });
    commit("a finding to decide");
    const review = await findingsFile({
      machinery: ["package.json"],
      findings: [
        {
          id: "F-01",
          rule: 1,
          found: "an install folded into a gate",
          decisionId: "D-02",
          paths: ["package.json", "test/math.test.js"],
        },
      ],
    });
    expect(await cli("gates", PROGRAM, "--record", "--findings", review), said()).toBe(0);
    expect(said()).toContain("recorded the gates as repairing");
    expect(await record()).toMatchObject({
      verdict: "repairing",
      machinery: ["package.json", "test/math.test.js"],
      findings: [{ id: "F-01", decisionId: "D-02" }],
    });
    expect(await cli("gates", PROGRAM, "--recorded")).toBe(1);
    expect(said()).toContain("repairing: 1 finding is being fixed (F-01 → D-02)");

    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    const reasons = said();
    expect(reasons).toContain("decision D-02 has no answer");
    expect(reasons).toContain("gate finding F-01 (rule 1) waits on decision D-02");
    expect(reasons).toContain("there is no gate-health strand S-00");
    for (const id of ["S-01", "S-02", "S-03"]) {
      expect(reasons).toContain(`${id} does not depend on S-00`);
    }

    // Answered, with S-00 every other strand depends on.
    const answered = (contract.decisions ?? []).concat({
      id: "D-02",
      question: "The tests reinstall in a pre-hook: move the install to setup?",
      options: ["move it", "leave it"],
      answer: "move it",
      touches: "all",
    });
    const s00 = strand("S-00", "z", {
      name: "The gate health",
      scope: { summary: "the gate helpers", includes: ["test/gate/**"], excludes: [] },
    });
    const rest = (contract.strands ?? []).map((s) => ({
      ...s,
      dependsOn: [...s.dependsOn, "S-00"],
    }));
    await writeProgram({
      decisions: answered,
      strands: [s00, ...rest.slice(0, 2), contract.strands?.[2] as Strand],
    });
    commit("answer it, but forget a strand");
    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    expect(op.err[0]).toBe("NOT READY: 1 reason");
    expect(said()).toContain("S-03 does not depend on S-00");
    expect(said()).not.toContain("S-01 does not depend");

    await writeProgram({ decisions: answered, strands: [s00, ...rest] });
    commit("answer it");
    expect(await cli("plan", "check", PROGRAM), said()).toBe(0);
    expect(op.out[0]).toBe("READY");
    expect(await cli("plan", "ratify", PROGRAM), said()).toBe(0);
  }, 120_000);

  it("refuses a findings file with problems, listing every one, and records nothing", async () => {
    const cases: [unknown, string[]][] = [
      ["{ not json", ["is not valid JSON"]],
      [{ machinery: ["package.json"] }, ["findings"]],
      [
        {
          machinery: ["..\\outside.js", "/etc/passwd"],
          findings: [{ id: "F-1", rule: 9, found: "", decisionId: "D-01", paths: [] }],
        },
        ["machinery.0", "machinery.1", "findings.0.id", "findings.0.rule", "findings.0.found"],
      ],
      [
        {
          machinery: ["package.json", "scripts/gone.mjs", "src"],
          findings: [
            { id: "F-01", rule: 3, found: "x", decisionId: "D-07", paths: ["nope.config.js"] },
            { id: "F-01", rule: 3, found: "y", decisionId: "D-01", paths: [] },
          ],
        },
        ["finding F-01 appears more than once"],
      ],
      [
        {
          machinery: ["package.json", "scripts/gone.mjs", "src"],
          findings: [
            { id: "F-01", rule: 3, found: "x", decisionId: "D-07", paths: ["nope.config.js"] },
          ],
        },
        [
          "finding F-01 is answered by D-07, which is not a decision",
          "machinery names scripts/gone.mjs, which is not a file at",
          "machinery names src, which is not a file at",
          "finding F-01 names nope.config.js, which is not a file at",
        ],
      ],
    ];
    for (const [body, expected] of cases) {
      const path = await findingsFile(body);
      expect(await cli("gates", PROGRAM, "--record", "--findings", path), said()).toBe(1);
      for (const fragment of expected) expect(said()).toContain(fragment);
      expect(said()).toContain("Nothing was recorded.");
      // Refused before any gate ran.
      expect(said()).not.toContain("auditing the gates on");
    }
    expect(await record()).toBeUndefined();
  }, 120_000);

  it("refuses a red audit with no findings, and records it repairing with one", async () => {
    await writeProgram({
      verification: [
        ...contract.verification,
        { id: "broken", command: `node -e "console.log('the base is broken');process.exit(1)"` },
      ],
      decisions: [
        ...(contract.decisions ?? []),
        {
          id: "D-02",
          question: "Fix the broken gate?",
          options: ["fix it", "drop it"],
          touches: "all",
        },
      ],
    });
    commit("a broken gate");
    expect(await cli("gates", PROGRAM, "--record")).toBe(1);
    expect(said()).toContain("RED   broken failed on");
    expect(said()).toContain("A red gate needs a finding that answers it");
    expect(await record()).toBeUndefined();

    const review = await findingsFile({
      machinery: [],
      findings: [
        { id: "F-01", rule: 2, found: "broken fails", decisionId: "D-02", paths: ["package.json"] },
      ],
    });
    expect(await cli("gates", PROGRAM, "--record", "--findings", review), said()).toBe(0);
    expect((await record())?.verdict).toBe("repairing");
  }, 120_000);

  it("audits what plain `gates` audits: a prerequisite satisfied on the control plane runs its check", async () => {
    // A check that can only run once HP-01 is satisfied, and then fails.
    await writeProgram({
      verification: [
        ...contract.verification.filter((step) => step.id !== "release-check"),
        { id: "release-check", command: 'node -e "process.exit(1)"', requires: ["HP-01"] },
      ],
    });
    commit("a release check that fails");
    // While planning, HP-01 is pending, so the check waits and the audit is green.
    expect(await cli("gates", PROGRAM, "--record"), said()).toBe(0);
    expect(said()).toContain("not run: release-check waits on HP-01");
    const healthy = await record();
    expect(await cli("plan", "ratify", PROGRAM), said()).toBe(0);

    // Satisfied on the control plane; the file on disk still says pending.
    await writeFile(join(outside, "release-token"), "present");
    expect(await cli("preflight", PROGRAM), said()).toBe(0);
    expect(await readFile(programPath("contract.json"), "utf8")).toContain('"status": "pending"');

    expect(await cli("gates", PROGRAM)).toBe(1);
    expect(said()).toContain("RED   release-check failed on");
    // --record runs that same audit: red, with no finding, so it is refused.
    expect(await cli("gates", PROGRAM, "--record")).toBe(1);
    expect(said()).toContain("RED   release-check failed on");
    expect(said()).toContain("A red gate needs a finding that answers it");
    expect(await record()).toEqual(healthy);
  }, 120_000);

  it("says plainly when nobody is signed in, and plan check counts it as a reason", async () => {
    await rm(credentialsPath(op.environment.paths));
    expect(await cli("gates", PROGRAM, "--record")).toBe(1);
    expect(said()).toContain("you are not signed in: run `nightshift login`");
    expect(said()).toContain("Nothing was recorded.");
    expect(said()).not.toContain("auditing the gates on");

    expect(await cli("gates", PROGRAM, "--recorded")).toBe(1);
    expect(said()).toContain("cannot read the project's gate-health record");

    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    expect(said()).toContain("could not read the project's gate-health record");
    expect(await record()).toBeUndefined();
  }, 60_000);
});
