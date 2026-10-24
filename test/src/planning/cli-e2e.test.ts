/**
 * The planned fixture, end to end, through the real CLI (P7, T5; SC-P7-03 …
 * SC-P7-12): `gates --record`, `plan check`, `plan ratify`, `run` unattended,
 * `preflight`, `resume`. Three strands, one `dependsOn`, one human prerequisite a test can
 * flip, one decision.
 *
 * Real: the CLI, the API handler over a socket, the launcher binary, the MCP
 * server it starts, the engine and merge queue, the verification runner, git.
 * Scripted: the models.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliEnvironment, createProject, runCli } from "@nightshift/cli";
import type { ProgramContract, Strand } from "@nightshift/contracts";
import { sanitizeEnvironment } from "@nightshift/verification";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "../cli/operator.js";
import {
  addOrigin,
  programDirectory,
  ratifyFromFiles,
  writeConfigFor,
} from "../cli/plan-scratch.js";
import { scriptedHarnessModule } from "../slice/context.js";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
  PROGRAM_BRANCH,
} from "../slice/fixture-repo.js";

const PROGRAM = "p1-modules";
const ORCHESTRATE = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-orchestrate.js", import.meta.url),
);
/** `nightshift resume`'s landing runs here, where an examiner can be started (P8, D-P8-14). */
const RESUME = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-resume.js", import.meta.url),
);

let op: Operator;
let fixture: MaterialisedRepo;
let outside: string;
let environment: CliEnvironment;
let ratifiedIds: { projectId: string; programId: string };

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" }).trim();

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
    `Two small modules, \`${prefix}1\` and \`${prefix}2\`, each with its own test.`,
    "",
    `[orchestrate prefix=${prefix}]`,
  ].join("\n");

const PLAN = [
  "# Modules",
  "",
  "## Strands",
  "",
  section("S-01", "a"),
  "",
  section("S-02", "b"),
  "",
  section("S-03", "c"),
  "",
].join("\n");

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(environment, [...argv, "--repo", fixture.repo]);
};

beforeEach(async () => {
  op = await signIn({ realTime: true });
  outside = await mkdtemp(join(tmpdir(), "nightshift-e2e-outside-"));
  const created = await createProject(op.environment, { name: "modules" });
  fixture = await materialiseFixtureRepo({
    projectId: created.projectId as never,
    delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
  });
  await addOrigin(fixture.repo, join(fixture.stateDir, "..", "origin"));

  // Outside the repository, so doing it leaves the checkout clean: an untracked
  // file would make integration refuse, correctly, and confusingly.
  const token = join(outside, "release-token").replace(/\\/g, "/");
  const base = await authoredProgram();
  const contract: ProgramContract = {
    ...base,
    projectId: created.projectId as never,
    delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
    status: "planning",
    verification: [
      ...base.verification,
      // Cannot run without the human's token; passes once it can.
      { id: "release-check", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
    ],
    strands: [
      strand("S-01", "a", { successCriteria: base.successCriteria.map((c) => c.id) }),
      strand("S-02", "b", { dependsOn: ["S-01"], prerequisites: ["HP-01"] }),
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
  ratifiedIds = { projectId: created.projectId, programId: contract.programId };
  const directory = join(fixture.repo, "docs", "programs", PROGRAM);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(join(directory, "plan.md"), PLAN);
  // A planned repository has no single root contract file: its contracts are
  // under docs/programs. The first real planned run found that run.attach looked
  // only for the old file, and the headless root wrote one by hand to get past it.
  git("rm", "-q", "nightshift.program.json");
  // The plan is on the plane; the repository names its project for run.attach to find it.
  await writeConfigFor(fixture.repo, contract);
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "plan the modules");

  environment = {
    ...op.environment,
    assets: {
      skillsDir: "",
      mcpServerPath: "",
      orchestratePath: ORCHESTRATE,
      resumePath: RESUME,
    },
    // The launcher reaches the control plane with a machine token, as a script
    // would: this suite's operator has no real identity provider to refresh with.
    exec: (file, args, options) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, [...args], {
          cwd: options.cwd,
          env: {
            ...sanitizeEnvironment({
              platform: process.platform,
              parentEnv: process.env,
              extra: undefined,
            }),
            NIGHTSHIFT_API_ENDPOINT: op.plane.url,
            NIGHTSHIFT_API_TOKEN: "ignored-by-the-local-plane",
            NIGHTSHIFT_STATE_DIR: fixture.stateDir,
            NIGHTSHIFT_HARNESS_MODULE: scriptedHarnessModule(),
            NIGHTSHIFT_JOB_WAIT_CAP_SECONDS: "20",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      }),
    paths: {
      ...op.environment.paths,
      env: { ...op.environment.paths.env, NIGHTSHIFT_STATE_DIR: fixture.stateDir },
    },
  };
});

afterEach(async () => {
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
  await rm(outside, { recursive: true, force: true });
});

describe("a planned program, from a plan on disk to a landed program, through the CLI", () => {
  it("checks, ratifies, runs unattended past a hurdle, and lands it when the human is back", async () => {
    const before = git("rev-parse", PROGRAM_BRANCH);

    // Planning audits the gates and records them healthy (D-P15-01, D-P15-07).
    expect(await cli("gates", PROGRAM, "--record"), op.err.join("\n")).toBe(0);
    expect(op.out.join("\n")).toContain("recorded the gates as healthy");
    expect(
      await cli("plan", "check", PROGRAM, "--dir", programDirectory(fixture.repo, PROGRAM)),
      op.err.join("\n"),
    ).toBe(0);
    expect(op.out[0]).toBe("READY");
    expect(await ratifyFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);

    // The hurdle is only a later strand's, so the run starts, and says so.
    const ran = await cli("run", PROGRAM);
    const said = op.out.join("\n");
    expect(said).toContain("note: HP-01 is not yet satisfied; only later strands need it");
    // Deferred, and nothing worse: its own exit code.
    expect(ran, `${said}\n${op.err.join("\n")}`).toBe(3);
    expect(said).toContain(
      "deferred: S-01, S-02, S-03 are done on the provisional line, waiting on HP-01",
    );

    // The program branch received none of the work (A-05) — only the one publication
    // commit at finish, which touches docs/programs/{id}/ and nothing else (P21);
    // the provisional line has all six.
    const published = git("rev-parse", PROGRAM_BRANCH);
    expect(git("rev-list", "--count", `${before}..${published}`)).toBe("1");
    for (const file of git("diff", "--name-only", before, published).split("\n")) {
      expect(file.startsWith(`docs/programs/${PROGRAM}/`), file).toBe(true);
    }
    const runId = op.out.find((line) => /^run_[0-9A-Z]+$/.test(line)) ?? "";
    expect(runId).not.toBe("");
    const provisional = git(
      "log",
      "--format=%s",
      `${PROGRAM_BRANCH}..refs/nightshift/provisional/${runId}`,
    );
    for (const name of ["a1", "a2", "b1", "b2", "c1", "c2"]) expect(provisional).toContain(name);
    // S-02 depends on S-01, and was built on S-01's provisional work.
    expect(provisional.indexOf("b1")).toBeLessThan(provisional.indexOf("a1"));

    const reportPath = join(fixture.repo, "docs", "programs", PROGRAM, "report.md");
    const deferredReport = await readFile(reportPath, "utf8");
    expect(deferredReport).toContain("0 of 3 strands succeeded; 3 deferred; 0 parked.");
    expect(deferredReport).toContain("### S-02 The b modules: PROVISIONAL");
    expect(deferredReport).toContain("Waiting on: HP-01");
    expect(deferredReport).toContain("- **HP-01** The release token is in place.");
    expect(deferredReport).toContain(`nightshift resume <program>`);

    // Resuming before the human has done it resumes nothing, and says what is unmet.
    expect(await cli("resume", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("UNMET HP-01");
    expect(git("rev-parse", PROGRAM_BRANCH)).toBe(published);

    // The human is back.
    await writeFile(join(outside, "release-token"), "present");
    expect(await cli("preflight", PROGRAM)).toBe(0);
    const resumed = await cli("resume", PROGRAM);
    expect(resumed, `${op.out.join("\n")}\n${op.err.join("\n")}`).toBe(0);
    // Each strand lands once, whole, with both its jobs (P18, D-P18-04).
    expect(op.out[0]).toContain("3 landed on the program branch");

    const landed = git("log", "--format=%s", `${before}..${PROGRAM_BRANCH}`);
    for (const name of ["a1", "a2", "b1", "b2", "c1", "c2"]) expect(landed).toContain(name);
    expect(() => git("rev-parse", "--verify", `refs/nightshift/provisional/${runId}`)).toThrow();

    const finalReport = await readFile(reportPath, "utf8");
    expect(finalReport).toContain("3 of 3 strands succeeded; 0 deferred; 0 parked.");
    expect(finalReport).toContain("Nothing was deferred.");
    expect(finalReport).toContain("| met |");
    expect(finalReport).not.toContain("NOT met");
    // The run ended again, so the program branch got the updated report as a
    // second publication commit (P21, D-03); the checkout is left clean.
    const republished = git("rev-parse", PROGRAM_BRANCH);
    const publishedReport = git("show", `${PROGRAM_BRANCH}:docs/programs/${PROGRAM}/report.md`);
    expect(publishedReport).toContain("3 of 3 strands succeeded; 0 deferred; 0 parked.");
    expect(publishedReport).toContain("Nothing was deferred.");
    expect(publishedReport).not.toContain("NOT met");
    const publications = git(
      "log",
      "--format=%H",
      "--grep=^Publish the plan",
      `${before}..${PROGRAM_BRANCH}`,
    ).split("\n");
    expect(publications).toHaveLength(2);
    for (const commit of publications) {
      for (const file of git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).split(
        "\n",
      )) {
        expect(file.startsWith(`docs/programs/${PROGRAM}/`), file).toBe(true);
      }
    }
    expect(git("status", "--porcelain")).toBe("");

    // Ending again with nothing changed publishes nothing: the resume process
    // run once more finds nothing deferred and commits no second time.
    const again = await environment.exec?.(
      process.execPath,
      [
        RESUME,
        "--project",
        ratifiedIds.projectId,
        "--program",
        ratifiedIds.programId,
        "--run",
        runId,
        "--repo",
        fixture.repo,
      ],
      { cwd: fixture.repo },
    );
    expect(again?.exitCode, again?.stderr).toBe(0);
    expect(git("rev-parse", PROGRAM_BRANCH)).toBe(republished);
  }, 240_000);
});

describe("a remote run whose final documents never left its machine (P21, F-01)", () => {
  it("nightshift resume rebuilds them from the control plane and pushes them to GitHub", async () => {
    const base = git("rev-parse", PROGRAM_BRANCH);
    // No hurdle this time: the run lands everything and publishes its documents.
    await writeFile(join(outside, "release-token"), "present");
    expect(await ratifyFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    const ran = await cli("run", PROGRAM);
    expect(ran, `${op.out.join("\n")}\n${op.err.join("\n")}`).toBe(0);
    const runId = op.out.find((line) => /^run_[0-9A-Z]+$/.test(line)) ?? "";
    expect(runId).not.toBe("");

    // As a machine leaves it when its last upload fails: GitHub has every
    // landing and not the documentation commit on top, the run ended
    // interrupted saying so, and the operator's checkout is behind GitHub.
    const docsHead = git("rev-parse", PROGRAM_BRANCH);
    const work = git("rev-parse", `${docsHead}^`);
    for (const file of git("diff", "--name-only", work, docsHead).split("\n")) {
      expect(file.startsWith(`docs/programs/${PROGRAM}/`), file).toBe(true);
    }
    git("push", "-q", "origin", `${work}:refs/heads/${PROGRAM_BRANCH}`);
    git("reset", "-q", "--hard", base);
    const scope = { ...ratifiedIds, runId } as never;
    const recorded = await op.stores.runs.get(scope, runId as never);
    if (recorded === undefined) throw new Error("the run is not recorded");
    await op.stores.runs.put({
      ...recorded,
      location: "remote",
      status: "interrupted",
      outcomeReason: `GitHub does not have this run's final documentation commit ${docsHead.slice(0, 12)}.`,
    });

    const resumed = await cli("resume", PROGRAM);
    const said = `${op.out.join("\n")}\n${op.err.join("\n")}`;
    expect(resumed, said).toBe(0);
    expect(said).not.toContain("nothing to resume");

    // GitHub now has the documents, in one commit on top of its landings that
    // touches only the program's directory, and the checkout is where GitHub is.
    git("fetch", "-q", "origin");
    const atGitHub = git("rev-parse", `origin/${PROGRAM_BRANCH}`);
    expect(git("rev-parse", PROGRAM_BRANCH)).toBe(atGitHub);
    expect(git("rev-list", "--count", `${work}..${atGitHub}`)).toBe("1");
    const changed = git("diff", "--name-only", work, atGitHub).split("\n");
    for (const file of changed)
      expect(file.startsWith(`docs/programs/${PROGRAM}/`), file).toBe(true);
    expect(changed).toContain(`docs/programs/${PROGRAM}/report.md`);
    expect(git("show", `${atGitHub}:docs/programs/${PROGRAM}/report.md`)).toContain(runId);

    // Again, with GitHub holding everything: nothing is committed or pushed.
    expect(await cli("resume", PROGRAM)).toBe(0);
    git("fetch", "-q", "origin");
    expect(git("rev-parse", `origin/${PROGRAM_BRANCH}`)).toBe(atGitHub);
    expect(git("rev-parse", PROGRAM_BRANCH)).toBe(atGitHub);
  }, 240_000);
});
