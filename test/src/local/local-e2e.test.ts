/**
 * The local instance, end to end, as a stranger would use it (P12, T5;
 * SC-P12-01, SC-P12-02, SC-P12-05, SC-P12-09).
 *
 * Real: `nightshift local` starting the `nightshift-local` bin over SQLite and
 * files; the CLI signed in by the profile it wrote; `project create`, a planned
 * program checked, ratified and run by the headless root and its MCP server,
 * workers holding execution tokens the local plane minted and verified; the
 * report; a decision reversed; the plane stopped and started again and every
 * record read back. Scripted: the models.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type CliEnvironment, createProject, type Launch, runCli } from "@nightshift/cli";
import type { ProgramContract } from "@nightshift/contracts";
import { createUlidIdGenerator, systemClock } from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import { currentStage, type FetchLike } from "@nightshift/persistence/http";
import { sanitizeEnvironment } from "@nightshift/verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedHarnessModule } from "../slice/context.js";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
} from "../slice/fixture-repo.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOCAL_BIN = join(REPO_ROOT, "apps", "api", "dist", "bin", "nightshift-local.js");
const STUDIO_DIST = join(REPO_ROOT, "apps", "studio", "dist");
const ORCHESTRATE = join(REPO_ROOT, "apps", "mcp", "dist", "bin", "nightshift-orchestrate.js");
const PROGRAM = "modules";

let root = "";
let fixture: MaterialisedRepo;
let environment: CliEnvironment;
let plane: ChildProcess | undefined;
let planeExit: Promise<number> | undefined;
const out: string[] = [];
const err: string[] = [];

const configDir = () => join(root, "config");
const planeState = () => join(root, "plane");

/** `nightshift local`'s launcher, keeping the child so the suite can stop it. */
const launch: Launch = (file, args, onLine) => {
  planeExit = new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "inherit"] });
    plane = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => void onLine(line));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return planeExit;
};

/** Starts the plane through the CLI and waits until it has written the local profile. */
const startPlane = async (): Promise<void> => {
  void runCli(environment, ["local", "--port", "0", "--state", planeState(), "--no-open"]);
  const deadline = Date.now() + 20_000;
  while (!out.some((line) => line.startsWith("Studio"))) {
    if (Date.now() > deadline)
      throw new Error(`the plane did not start:\n${out.join("\n")}\n${err.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const stopPlane = async (): Promise<void> => {
  plane?.kill("SIGTERM");
  const code = await planeExit;
  // On POSIX, SIGTERM reaches the plane's handler and it closes cleanly. Windows
  // has no signals to deliver: Node terminates the child outright, so there is
  // no clean exit to see, and the restart below then proves the harder thing,
  // that everything survives a hard stop. (A console Ctrl-C, the product path,
  // is still a SIGINT on Windows.)
  if (process.platform !== "win32") expect(code).toBe(0);
  plane = undefined;
  out.length = 0;
};

const cli = async (...argv: string[]): Promise<number> => {
  out.length = 0;
  err.length = 0;
  return runCli(environment, argv);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nightshift-local-e2e-"));
  const paths = {
    env: { NIGHTSHIFT_CONFIG_DIR: configDir(), NIGHTSHIFT_STATE_DIR: join(root, "state") },
    platform: process.platform,
    home: root,
  };
  environment = {
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    cwd: root,
    paths,
    fetch: globalThis.fetch as unknown as FetchLike,
    openBrowser: async () => false,
    readPaste: () => ({ line: new Promise<undefined>(() => undefined), cancel: () => undefined }),
    clock: systemClock,
    ids: createUlidIdGenerator(),
    git: nodeGitRunner,
    startLoopback: async () => {
      throw new Error("a local instance has no sign-in");
    },
    launch,
    assets: {
      skillsDir: "",
      mcpServerPath: "",
      orchestratePath: ORCHESTRATE,
      localPath: LOCAL_BIN,
      studioDir: STUDIO_DIST,
    },
    // The headless root finds the local profile as any process on this machine
    // would: through the config directory. No token is handed to it.
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
            NIGHTSHIFT_CONFIG_DIR: configDir(),
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
  };
  await startPlane();
});

afterAll(async () => {
  plane?.kill("SIGTERM");
  await planeExit?.catch(() => undefined);
  await fixture?.remove();
  await rm(root, { recursive: true, force: true });
});

describe("a stranger's first run, on a local instance", () => {
  it("starts, plans, runs, reports, reverses, and keeps it all across a restart", async () => {
    // SC-P12-01: the plane is up, the local profile is current, the Studio is served.
    expect(currentStage(environment.paths)).toBe("local");
    const studioLine = out.find((line) => line.startsWith("Studio")) ?? "";
    const studioUrl = studioLine.replace(/^Studio\s+/, "");
    expect(studioUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    const origin = new URL(studioUrl).origin;
    const config = (await (await fetch(`${origin}/config.json`)).json()) as {
      auth?: { kind?: string };
    };
    expect(config.auth?.kind).toBe("token");
    expect(await (await fetch(`${origin}/projects/anything`)).text()).toContain(
      "Nightshift Studio",
    );

    expect(await cli("whoami")).toBe(0);
    expect(out.join("\n")).toContain("local-operator");

    // SC-P12-02: a project and a planned program, through the CLI alone.
    const created = await createProject(environment, { name: "modules" });
    fixture = await materialiseFixtureRepo({
      projectId: created.projectId as never,
      delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" }).trim();
    const base = await authoredProgram();
    const contract: ProgramContract = {
      ...base,
      projectId: created.projectId as never,
      delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The a modules",
          scope: {
            summary: "modules starting with a",
            includes: ["src/a*.js", "test/a*.test.js"],
            excludes: [],
          },
          acceptance: ["the a modules exist and node --test passes"],
          successCriteria: base.successCriteria.map((c) => c.id),
          dependsOn: [],
          prerequisites: [],
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
    const directory = join(fixture.repo, "docs", "programs", PROGRAM);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
    await writeFile(
      join(directory, "plan.md"),
      [
        "# Modules",
        "",
        "## Strands",
        "",
        "### S-01 The a modules",
        "",
        "Two small modules.",
        "",
        "[orchestrate prefix=a]",
        "",
      ].join("\n"),
    );
    git("rm", "-q", "nightshift.program.json");
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "plan the modules",
    );

    // The gates' audit is kept in the local plane, like every other record (D-P15-07).
    expect(await cli("gates", PROGRAM, "--record", "--repo", fixture.repo)).toBe(0);
    expect(await cli("plan", "check", PROGRAM, "--repo", fixture.repo)).toBe(0);
    expect(await cli("plan", "ratify", PROGRAM, "--repo", fixture.repo)).toBe(0);
    const ran = await cli("run", PROGRAM, "--repo", fixture.repo);
    expect(ran, `${out.join("\n")}\n${err.join("\n")}`).toBe(0);
    const reportPath = join(directory, "report.md");
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("1 of 1 strands succeeded");

    // The report again, from the plane alone.
    await rm(reportPath);
    expect(await cli("report", PROGRAM, "--repo", fixture.repo)).toBe(0);
    const regenerated = await readFile(reportPath, "utf8");
    expect(regenerated).toContain("1 of 1 strands succeeded");

    // The owner's plan decision, reversed through the CLI.
    const decisionId = /`(dec_[0-9A-Z]{26})`/.exec(regenerated)?.[1];
    expect(decisionId, regenerated).toBeDefined();
    expect(
      await cli(
        "decision",
        "reverse",
        PROGRAM,
        String(decisionId),
        "--choice",
        "no",
        "--reason",
        "one file is enough",
        "--repo",
        fixture.repo,
      ),
    ).toBe(0);

    // SC-P12-05: stop the plane, start it again; everything is there.
    await stopPlane();
    await startPlane();
    await rm(reportPath);
    expect(await cli("report", PROGRAM, "--repo", fixture.repo)).toBe(0);
    const afterRestart = await readFile(reportPath, "utf8");
    expect(afterRestart).toContain("1 of 1 strands succeeded");
    expect(afterRestart).toContain("one file is enough");
    // The plan document the plane held, read back through its own route, and
    // the gate-health record, still there and still holding.
    expect(await cli("gates", PROGRAM, "--recorded", "--repo", fixture.repo)).toBe(0);
    expect(await cli("plan", "check", PROGRAM, "--repo", fixture.repo)).toBe(0);
  });
});
