/**
 * The gate audit against a real repository and real processes: what it runs,
 * how often, where, and what it concludes. Every command is `node -e`, so the
 * suite runs the same on both CI runners.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha, ProgramContract } from "@nightshift/contracts";
import type { StepResult } from "@nightshift/verification";
import { afterEach, describe, expect, it } from "vitest";
import { auditGates } from "./gate-audit.js";
import { git, nodeGitRunner, revParse } from "./git/index.js";

const AT = Date.parse("2026-10-06T12:00:00.000Z");
const TIMEOUT_MS = 60_000;

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const temporary = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const repository = async (
  files: Readonly<Record<string, string>> = {},
): Promise<{ readonly repo: string; readonly base: CommitSha }> => {
  const repo = join(await temporary("nightshift-audit-"), "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
  for (const [path, text] of Object.entries(files)) await writeFile(join(repo, path), text, "utf8");
  const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: repo, atMs: AT });
  await run(["init", "--initial-branch=main"]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "initial"]);
  return { repo, base: await revParse(nodeGitRunner, repo, "HEAD") };
};

const INSTALL = `node -e "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ready','ok')"`;
const NEEDS_INSTALL = `node -e "process.exit(require('fs').existsSync('node_modules/ready') ? 0 : 1)"`;
const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "console.log('the build is broken');process.exit(1)"`;

const DEFER = `node -e "console.log('NIGHTSHIFT_DEFER HP-07 a cloud login');console.log('NIGHTSHIFT_REMEDIATION run aws sso login');process.exit(75)"`;
const EXIT_75 = `node -e "console.log('just a tempfail');process.exit(75)"`;

type Gates = Pick<ProgramContract, "setup" | "verification">;

const audit = async (
  program: Gates,
  options: {
    files?: Record<string, string>;
    unmet?: readonly string[];
    env?: Readonly<Record<string, string>>;
  } = {},
) => {
  const { repo, base } = await repository(options.files);
  const progress: StepResult[] = [];
  const result = await auditGates({
    git: nodeGitRunner,
    repoPath: repo,
    base,
    program,
    unmet: new Set(options.unmet ?? []),
    workDir: await temporary("nightshift-audit-work-"),
    paths: { scratch: (checkout: string) => `${checkout}-scratch` },
    timeoutMs: TIMEOUT_MS,
    ...(options.env === undefined ? {} : { env: options.env }),
    onStep: (step) => progress.push(step),
  });
  return { result, progress, repo };
};

describe("the gate audit", () => {
  it("gives setup and every check the project environment whole, under the scratch, and adopts none of it (P16, D-10)", async () => {
    const before = { ...process.env };
    const projectEnv: Record<string, string> = {
      NS_PROJECT_ONLY: "from-project",
      DOCKER_HOST: "unix:///run/ns-audit-test/docker.sock",
      npm_config_cache: "/ns-audit-test/stores/npm",
      JAVA_HOME: "/ns-audit-test/runtimes/java",
      TMPDIR: "/not-the-scratch",
    };
    const probe = `node -e "const e=process.env;process.exit(e.NS_PROJECT_ONLY==='from-project'&&e.DOCKER_HOST==='unix:///run/ns-audit-test/docker.sock'&&e.npm_config_cache==='/ns-audit-test/stores/npm'&&e.JAVA_HOME==='/ns-audit-test/runtimes/java'&&e.TMPDIR!=='/not-the-scratch'?0:1)"`;
    const { result } = await audit(
      {
        setup: [{ id: "install", command: probe }],
        verification: [{ id: "probe", command: probe }],
      },
      { env: projectEnv },
    );
    expect(result.gates.map((gate) => [gate.id, gate.verdict])).toEqual([
      ["setup:install", "passed"],
      ["probe", "passed"],
    ]);
    expect({ ...process.env }).toEqual(before);

    // Without it, as on a laptop, the same probe fails: nothing else supplied them.
    const { result: laptop } = await audit({ verification: [{ id: "probe", command: probe }] });
    expect(laptop.failing).toEqual(["probe"]);
  });

  it("runs setup and every check once, in order, and a base that passes is not red", async () => {
    const { result, progress } = await audit({
      setup: [{ id: "install", command: INSTALL }],
      verification: [{ id: "installed", command: NEEDS_INSTALL }],
    });

    expect(progress.map((step) => step.stepId)).toEqual(["setup:install", "installed"]);
    expect(result.gates.map((gate) => [gate.id, gate.verdict])).toEqual([
      ["setup:install", "passed"],
      ["installed", "passed"],
    ]);
    expect(result.red).toBe(false);
    expect(result.failing).toEqual([]);
  });

  it("calls a base with a failing gate red, runs the rest, and keeps what it said", async () => {
    const { result, progress } = await audit({
      verification: [
        { id: "build", command: FAIL },
        { id: "lint", command: PASS },
      ],
    });

    expect(result.red).toBe(true);
    expect(result.failing).toEqual(["build"]);
    expect(progress.map((step) => step.stepId)).toEqual(["build", "lint"]);
    const build = result.gates.find((gate) => gate.id === "build");
    expect(new TextDecoder().decode(build?.result?.output)).toContain("the build is broken");
  });

  it("does not run a check whose prerequisite is unmet, and says what it waits on", async () => {
    const { result, progress } = await audit(
      { verification: [{ id: "db-test", command: FAIL, requires: ["HP-01"] }] },
      { unmet: ["HP-01"] },
    );

    expect(progress).toEqual([]);
    expect(result.gates[0]).toMatchObject({ verdict: "waiting", waitingOn: ["HP-01"] });
    expect(result.red).toBe(false);
  });

  it("names a setup that fails, and runs no check behind it", async () => {
    const { result } = await audit({
      setup: [{ id: "install", command: FAIL }],
      verification: [{ id: "test", command: PASS }],
    });

    expect(result.failing).toEqual(["setup:install"]);
    expect(result.gates.find((gate) => gate.id === "test")?.verdict).toBe("unrun");
    expect(result.red).toBe(true);
  });

  it("calls a check that exits 75 with a NIGHTSHIFT_DEFER line deferred, not failed, and not red", async () => {
    const { result } = await audit({
      verification: [
        { id: "cloud", command: DEFER },
        { id: "lint", command: PASS },
      ],
    });

    const cloud = result.gates.find((gate) => gate.id === "cloud");
    expect(cloud?.verdict).toBe("deferred");
    expect(cloud?.deferral).toEqual({
      prerequisiteId: "HP-07",
      description: "a cloud login",
      remediation: "run aws sso login",
    });
    expect(result.gates.find((gate) => gate.id === "lint")?.verdict).toBe("passed");
    expect(result.red).toBe(false);
    expect(result.failing).toEqual([]);
    expect(result.deferred).toEqual(["cloud"]);
  });

  it("calls a check that exits 75 without the line failed", async () => {
    const { result } = await audit({ verification: [{ id: "flaky", command: EXIT_75 }] });

    const flaky = result.gates.find((gate) => gate.id === "flaky");
    expect(flaky?.verdict).toBe("failed");
    expect(flaky?.deferral).toBeUndefined();
    expect(result.red).toBe(true);
    expect(result.failing).toEqual(["flaky"]);
    expect(result.deferred).toEqual([]);
  });

  it("calls a check that exits 0 passed, with no deferral", async () => {
    const { result } = await audit({ verification: [{ id: "ok", command: PASS }] });

    expect(result.gates[0]).toMatchObject({ id: "ok", verdict: "passed" });
    expect(result.gates[0]?.deferral).toBeUndefined();
    expect(result.red).toBe(false);
    expect(result.deferred).toEqual([]);
  });

  it("leaves the checks behind a deferred setup unrun, and the base not red", async () => {
    const { result, progress } = await audit({
      setup: [{ id: "login", command: DEFER }],
      verification: [{ id: "test", command: PASS }],
    });

    expect(progress.map((step) => step.stepId)).toEqual(["setup:login"]);
    expect(result.gates.map((gate) => [gate.id, gate.verdict])).toEqual([
      ["setup:login", "deferred"],
      ["test", "unrun"],
    ]);
    expect(result.gates[0]?.deferral?.prerequisiteId).toBe("HP-07");
    expect(result.red).toBe(false);
    expect(result.failing).toEqual([]);
    expect(result.deferred).toEqual(["setup:login"]);
  });

  it("names the lockfiles a program with no setup leaves uninstalled", async () => {
    const { result } = await audit(
      { verification: [{ id: "test", command: PASS }] },
      { files: { "package-lock.json": "{}\n" } },
    );
    expect(result.lockfilesWithoutSetup).toEqual(["package-lock.json"]);

    const declared = await audit(
      {
        setup: [{ id: "install", command: INSTALL }],
        verification: [{ id: "test", command: PASS }],
      },
      { files: { "package-lock.json": "{}\n" } },
    );
    expect(declared.result.lockfilesWithoutSetup).toEqual([]);
  });

  it("leaves no checkout and no worktree behind", async () => {
    const { repo } = await audit({ verification: [{ id: "build", command: FAIL }] });
    const worktrees = await git(nodeGitRunner, ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    const work = made.find((dir) => dir.includes("nightshift-audit-work-"));
    expect(work === undefined ? [] : await readdir(work)).toEqual([]);
  });
});
