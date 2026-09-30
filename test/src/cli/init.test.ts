/**
 * `nightshift init` against the real handler and a real repository (P7, T3,
 * SC-P7-13). `claude` is a recorded fake and the home directory is temporary, so
 * nothing here touches the operator's real Claude Code or `~/.claude`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliEnvironment,
  detectSetup,
  detectVerification,
  readConfig,
  runCli,
} from "@nightshift/cli";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MaterialisedRepo, materialiseFixtureRepo } from "../slice/fixture-repo.js";
import { type Operator, signIn } from "./operator.js";

let op: Operator;
let fixture: MaterialisedRepo;
let home: string;
let assets: string;
let calls: string[][];
/** Whether the fake `claude mcp get nightshift` finds a registration. */
let registered: boolean;

const environment = (overrides: Partial<CliEnvironment> = {}): CliEnvironment => ({
  ...op.environment,
  paths: { ...op.environment.paths, home },
  assets: {
    skillsDir: join(assets, "skills"),
    mcpServerPath: join(assets, "nightshift-mcp.js"),
  },
  exec: async (file, args) => {
    calls.push([file, ...args]);
    if (args[1] === "get") return { exitCode: registered ? 0 : 1, stdout: "", stderr: "" };
    registered = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  ...overrides,
});

const cli = async (env: CliEnvironment, ...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(env, ["init", "--repo", fixture.repo, ...argv]);
};

beforeEach(async () => {
  op = await signIn();
  fixture = await materialiseFixtureRepo({ projectId: op.ids.next("proj") as never });
  home = await mkdtemp(join(tmpdir(), "nightshift-init-home-"));
  assets = await mkdtemp(join(tmpdir(), "nightshift-init-assets-"));
  for (const skill of ["nightshift", "plan-program"]) {
    await mkdir(join(assets, "skills", skill), { recursive: true });
    await writeFile(join(assets, "skills", skill, "SKILL.md"), `# ${skill}\n`);
  }
  await writeFile(
    join(fixture.repo, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { test: "node --test", build: "node build.js", dev: "x" },
    }),
  );
  await writeFile(join(fixture.repo, "package-lock.json"), "{}");
  calls = [];
  registered = false;
});

afterEach(async () => {
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
  await rm(home, { recursive: true, force: true });
  await rm(assets, { recursive: true, force: true });
});

describe("nightshift init (SC-P7-13)", () => {
  it("detects verification from package.json, in the order it has to run", async () => {
    expect(await detectVerification(fixture.repo)).toEqual([
      { id: "build", command: "npm run build" },
      { id: "test", command: "npm run test" },
    ]);
  });

  it("makes installing dependencies setup, not a verification step", async () => {
    expect(await detectSetup(fixture.repo)).toEqual([{ id: "install", command: "npm ci" }]);
  });

  it("takes a repository from nothing to plannable: project, config, skills, MCP", async () => {
    expect(await cli(environment(), "--yes", "--name", "demo")).toBe(0);

    const config = await readConfig(fixture.repo);
    expect(config?.setup).toEqual([{ id: "install", command: "npm ci" }]);
    expect(config?.verification.map((step) => step.id)).toEqual(["build", "test"]);
    // The project it names exists in the control plane, in the operator's org.
    const stores = createHttpStores({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("ignored-by-the-local-plane"),
      }),
      actingOrg: op.orgId,
    });
    expect((await stores.projects.get(config?.projectId as never))?.name).toBe("demo");

    // Skills go to the operator's home, never into the repository.
    expect(
      await readFile(join(home, ".claude", "skills", "plan-program", "SKILL.md"), "utf8"),
    ).toBe("# plan-program\n");
    expect(calls).toEqual([
      ["claude", "mcp", "get", "nightshift"],
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "local",
        "nightshift",
        "--",
        "node",
        join(assets, "nightshift-mcp.js"),
      ],
    ]);
    expect(op.out.join("\n")).toContain("Next: plan a program with the plan-program skill");
  });

  it("is idempotent: a second run creates no project, rewrites nothing, registers nothing", async () => {
    await cli(environment(), "--yes");
    const first = await readFile(join(fixture.repo, "nightshift.config.json"), "utf8");
    calls = [];

    expect(await cli(environment(), "--yes")).toBe(0);
    expect(await readFile(join(fixture.repo, "nightshift.config.json"), "utf8")).toBe(first);
    expect(calls).toEqual([["claude", "mcp", "get", "nightshift"]]);
    expect(op.out.join("\n")).toContain("left as it is");
    expect(op.out.join("\n")).toContain("already registered");
  });

  it("uses a project it is given rather than creating one", async () => {
    const projectId = op.ids.next("proj");
    expect(await cli(environment(), "--yes", "--project", projectId)).toBe(0);
    expect((await readConfig(fixture.repo))?.projectId).toBe(projectId);
  });

  it("asks before writing, and writes nothing when the answer is no", async () => {
    const answering = (line: string) =>
      environment({ readPaste: () => ({ line: Promise.resolve(line), cancel: () => undefined }) });
    expect(await cli(answering("n"))).toBe(2);
    expect(await readConfig(fixture.repo)).toBeUndefined();
    expect(await cli(answering(""))).toBe(0);
    expect(await readConfig(fixture.repo)).toBeDefined();
  });

  it("says what to run when Claude Code is not there, and still does the rest", async () => {
    const missing = environment({
      exec: async () => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await cli(missing, "--yes")).toBe(0);
    expect(op.out.join("\n")).toContain("claude mcp add --scope local nightshift -- node");
    expect(await readConfig(fixture.repo)).toBeDefined();
  });

  it("refuses a directory that is not a repository, or has nothing to verify with", async () => {
    await rm(join(fixture.repo, "package.json"));
    expect(await cli(environment(), "--yes")).toBe(2);
    expect(op.err.join("\n")).toContain("no verification commands could be detected");

    const bare = await mkdtemp(join(tmpdir(), "nightshift-init-bare-"));
    try {
      expect(await runCli(environment(), ["init", "--repo", bare, "--yes"])).toBe(2);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
