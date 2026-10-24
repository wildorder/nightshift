/**
 * A plan whose only home is the control plane, run end to end through the real
 * CLI (P21 S-02): put from a scratch outside the repository, run with
 * `nightshift run {name}`, and published into the program branch at finish; and
 * a program planned before P21, with only committed files, imported on its first run.
 *
 * Real: the CLI, the API handler over a socket, the launcher binary, the MCP
 * server it starts, the engine and merge queue, git with a bare origin.
 * Scripted: the models.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliEnvironment, createProject, runCli } from "@nightshift/cli";
import type { ProgramContract } from "@nightshift/contracts";
import { sanitizeEnvironment } from "@nightshift/verification";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "../cli/operator.js";
import { addOrigin, writeConfigFor } from "../cli/plan-scratch.js";
import { scriptedHarnessModule } from "../slice/context.js";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
  PROGRAM_BRANCH,
} from "../slice/fixture-repo.js";

const ORCHESTRATE = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-orchestrate.js", import.meta.url),
);
const RESUME = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-resume.js", import.meta.url),
);

const PLAN = [
  "# One strand",
  "",
  "## Strands",
  "",
  "### S-01 The a modules",
  "",
  "Two small modules, `a1` and `a2`, each with its own test.",
  "",
  "[orchestrate prefix=a]",
  "",
].join("\n");
const CONVERSATION = "Owner: one strand.\nPlanner: agreed.\n";

let op: Operator;
let fixture: MaterialisedRepo;
let origin: string;
let scratch: string;
let environment: CliEnvironment;
let contract: ProgramContract;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" }).trim();
const gitIdentity = ["-c", "user.name=t", "-c", "user.email=t@example.test"];

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(environment, [...argv, "--repo", fixture.repo]);
};
const said = (): string => `${op.out.join("\n")}\n${op.err.join("\n")}`;

beforeEach(async () => {
  op = await signIn({ realTime: true });
  scratch = await mkdtemp(join(tmpdir(), "nightshift-plane-only-"));
  const created = await createProject(op.environment, { name: "modules" });
  fixture = await materialiseFixtureRepo({
    projectId: created.projectId as never,
    delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
  });
  origin = await addOrigin(fixture.repo, join(fixture.stateDir, "..", "origin"));

  const base = await authoredProgram();
  contract = {
    ...base,
    projectId: created.projectId as never,
    delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
    status: "planning",
    strands: [
      {
        id: "S-01",
        name: "The a modules",
        scope: {
          summary: "modules whose names start with a",
          includes: ["src/a*.js", "test/a*.test.js"],
          excludes: [],
        },
        acceptance: ["the a modules exist and node --test passes"],
        successCriteria: base.successCriteria.map((criterion) => criterion.id),
        dependsOn: [],
        prerequisites: [],
      },
    ],
  };

  environment = {
    ...op.environment,
    assets: {
      skillsDir: "",
      mcpServerPath: "",
      orchestratePath: ORCHESTRATE,
      resumePath: RESUME,
    },
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
  await rm(scratch, { recursive: true, force: true });
});

describe("a plan whose home is the plane (P21 S-02)", () => {
  it("runs a plan that is only on the plane, creating and pushing the program branch and publishing at finish", async () => {
    const NAME = "p21-plane-only";
    // The repository holds no plan and no program branch; origin has only the base.
    git("checkout", "-q", "main");
    git("branch", "-D", PROGRAM_BRANCH);
    git("rm", "-q", "nightshift.program.json");
    await writeConfigFor(fixture.repo, contract);
    git("add", "-A");
    git(...gitIdentity, "commit", "-qm", "configure the project");
    git("push", "-q", "origin", "main");
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("docs/programs");
    expect(() => git("rev-parse", "--verify", `refs/heads/${PROGRAM_BRANCH}`)).toThrow();
    expect(git("ls-remote", "--heads", origin)).not.toContain(PROGRAM_BRANCH);
    const baseHead = git("rev-parse", "main");

    // The plan is put from a scratch outside the repository.
    const dir = join(scratch, "plan");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
    await writeFile(join(dir, "plan.md"), PLAN);
    await writeFile(join(dir, "conversation.md"), CONVERSATION);
    expect(await cli("plan", "put", NAME, "--dir", dir), said()).toBe(0);

    const ran = await cli("run", NAME);
    expect(ran, said()).toBe(0);

    // Made from the base and pushed.
    expect(git("ls-remote", "--heads", origin, PROGRAM_BRANCH)).toContain(
      `refs/heads/${PROGRAM_BRANCH}`,
    );
    // Pushed where it was made, at the base: landings are not pushed by the run.
    expect(git("ls-remote", "--heads", origin, PROGRAM_BRANCH).split(/\s+/)[0]).toBe(baseHead);
    expect(git("merge-base", "main", PROGRAM_BRANCH)).toBe(baseHead);

    // The strand's job landed.
    const landed = git("log", "--format=%s", `${baseHead}..${PROGRAM_BRANCH}`);
    expect(landed).toContain("a1");
    expect(landed).toContain("a2");

    // The last commit is the publication, and touches nothing but the published files.
    expect(git("log", "-1", "--format=%s", PROGRAM_BRANCH)).toMatch(/^Publish the plan/);
    const changed = git("show", "--name-only", "--format=", PROGRAM_BRANCH).split("\n").sort();
    expect(changed).toEqual(
      ["contract.json", "conversation.md", "plan.md", "report.md"].map(
        (file) => `docs/programs/${NAME}/${file}`,
      ),
    );
    expect(git("show", `${PROGRAM_BRANCH}:docs/programs/${NAME}/plan.md`)).toBe(PLAN.trim());
    expect(git("show", `${PROGRAM_BRANCH}:docs/programs/${NAME}/report.md`)).toContain(
      "1 of 1 strands succeeded",
    );

    // On a checkout with no docs/programs at all, `report` writes the report into a new directory.
    git("checkout", "-q", "main");
    expect(existsSync(join(fixture.repo, "docs", "programs"))).toBe(false);
    expect(await cli("report", NAME), said()).toBe(0);
    expect(
      await readFile(join(fixture.repo, "docs", "programs", NAME, "report.md"), "utf8"),
    ).toContain("1 of 1 strands succeeded");
  }, 240_000);

  it("imports a program with committed files and no draft as version 1 on its first run, and runs it", async () => {
    const NAME = "p20-old-program";
    // Planned before P21: its documents are committed on the program branch, and the plane has no draft.
    const directory = join(fixture.repo, "docs", "programs", NAME);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
    await writeFile(join(directory, "plan.md"), PLAN);
    git("rm", "-q", "nightshift.program.json");
    await writeConfigFor(fixture.repo, contract);
    git("add", "-A");
    git(...gitIdentity, "commit", "-qm", "plan the old program");

    expect(await cli("plan", "show", NAME, "--dir", join(scratch, "before"))).not.toBe(0);

    const ran = await cli("run", NAME);
    expect(ran, said()).toBe(0);
    expect(op.err.join("\n")).toContain(
      `importing docs/programs/${NAME}/ into the plane as version 1 of \`${NAME}\``,
    );

    // The draft is on the plane at version 1, named after the directory.
    const shown = join(scratch, "after");
    expect(await cli("plan", "show", NAME, "--dir", shown), said()).toBe(0);
    expect(said()).toContain(NAME);
    const drafts = await createdDraft(NAME);
    expect(drafts.name).toBe(NAME);
    expect(drafts.latestVersion).toBe(1);

    // The run started from it: it executed the plan that version holds, and landed the strand.
    const landed = git("log", "--format=%s", `${PROGRAM_BRANCH}`);
    expect(landed).toContain("a1");
    expect(git("show", `${PROGRAM_BRANCH}:docs/programs/${NAME}/report.md`)).toContain(
      "1 of 1 strands succeeded",
    );
  }, 240_000);
});

const createdDraft = async (name: string) => {
  const { createFetchTransport, createHttpStores, staticTokenProvider } = await import(
    "@nightshift/persistence/http"
  );
  const planDrafts = createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
    actingOrg: op.orgId,
  }).planDrafts;
  const page = await planDrafts.listByProject(contract.projectId, {});
  const found = page.items.find((draft) => draft.name === name);
  if (found === undefined) throw new Error(`no draft named ${name}`);
  return found;
};
