/**
 * The gate audit against a real repository and real processes: what it runs,
 * how often, where, and what it concludes. Every command is `node -e`, so the
 * suite runs the same on both CI runners.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha, ProgramContract } from "@nightshift/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { auditGates, type GateAuditProgress, verdictOf } from "./gate-audit.js";
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

/** A forward-slashed path, safe inside a single-quoted JavaScript string on Windows too. */
const js = (path: string): string => path.replace(/\\/g, "/");

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

type Gates = Pick<ProgramContract, "setup" | "verification">;

const audit = async (
  program: Gates,
  options: { files?: Record<string, string>; unmet?: readonly string[] } = {},
) => {
  const { repo, base } = await repository(options.files);
  const progress: GateAuditProgress[] = [];
  const result = await auditGates({
    git: nodeGitRunner,
    repoPath: repo,
    base,
    program,
    unmet: new Set(options.unmet ?? []),
    workDir: await temporary("nightshift-audit-work-"),
    timeoutMs: TIMEOUT_MS,
    onStep: (step) => progress.push(step),
  });
  return { result, progress, repo };
};

describe("the gate audit", () => {
  it("runs setup and every check twice, and a base that passes is not red", async () => {
    const { result, progress } = await audit({
      setup: [{ id: "install", command: INSTALL }],
      verification: [{ id: "installed", command: NEEDS_INSTALL }],
    });

    expect(progress.map((step) => `${step.pass}:${step.result.stepId}`)).toEqual([
      "1:setup:install",
      "1:installed",
      "2:setup:install",
      "2:installed",
    ]);
    expect(result.gates.map((gate) => [gate.id, gate.verdict])).toEqual([
      ["setup:install", "passed"],
      ["installed", "passed"],
    ]);
    expect(result.red).toBe(false);
    expect(result.failing).toEqual([]);
  });

  it("calls a gate that fails every run red, and keeps what it said", async () => {
    const { result } = await audit({
      verification: [
        { id: "build", command: FAIL },
        { id: "lint", command: PASS },
      ],
    });

    expect(result.red).toBe(true);
    expect(result.failing).toEqual(["build"]);
    const build = result.gates.find((gate) => gate.id === "build");
    expect(build?.runs).toHaveLength(2);
    expect(new TextDecoder().decode(build?.runs[0]?.output)).toContain("the build is broken");
  });

  it("calls a gate that passes once and fails once flaky, not red", async () => {
    const counter = join(await temporary("nightshift-audit-counter-"), "count");
    // Fails the first time it runs, passes after: state outside the checkout.
    const ONCE = `node -e "const f='${js(counter)}';const fs=require('fs');const n=fs.existsSync(f)?1:0;fs.writeFileSync(f,'1');process.exit(n?0:1)"`;
    const { result } = await audit({ verification: [{ id: "e2e", command: ONCE }] });

    expect(result.flaky).toEqual(["e2e"]);
    expect(result.red).toBe(false);
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

  it("names a setup that fails every pass, and runs no check behind it", async () => {
    const { result } = await audit({
      setup: [{ id: "install", command: FAIL }],
      verification: [{ id: "test", command: PASS }],
    });

    expect(result.failing).toEqual(["setup:install"]);
    expect(result.gates.find((gate) => gate.id === "test")?.verdict).toBe("unrun");
    expect(result.red).toBe(true);
  });

  it("starts the second pass from a pristine checkout, as a re-verification does", async () => {
    // Fails when an ignored file from an earlier run is still there.
    const FRESH_ONLY = `node -e "const fs=require('fs');if(fs.existsSync('node_modules/left'))process.exit(1);fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/left','x')"`;
    const { result } = await audit({ verification: [{ id: "build", command: FRESH_ONLY }] });

    expect(result.gates[0]?.verdict).toBe("passed");
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

describe("a gate's verdict", () => {
  const run = (exitCode: number) => ({
    stepId: "x",
    command: "x",
    exitCode,
    durationMs: 1,
    output: new Uint8Array(),
    timedOut: false,
  });

  it("is passed, failed or flaky from its runs, and unrun without any", () => {
    expect(verdictOf([run(0), run(0)])).toBe("passed");
    expect(verdictOf([run(1), run(2)])).toBe("failed");
    expect(verdictOf([run(1), run(0)])).toBe("flaky");
    expect(verdictOf([])).toBe("unrun");
  });
});
