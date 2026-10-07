/**
 * A decision reversed and corrected, end to end, through the real CLI (P9,
 * SC-P9-08, SC-P9-05 … SC-P9-07). A planned program runs; one strand's
 * orchestrator departs from the plan and records it, a decision the owner then
 * reverses. The brief is written, a correction planned from it (scripted here,
 * as `plan-program` would with the owner) that rewrites what the decision
 * produced and adds work it never touched, checked, flagged because the
 * decision said its effects reach outside the repository, refused by `run`
 * until confirmed, run, and verified; the two reports name each other.
 *
 * Real: the CLI, the API handler over a socket, the launcher binary, the MCP
 * server, the engine and merge queue, verification, git. Scripted: the models.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliEnvironment, createProject, runCli } from "@nightshift/cli";
import type { ProgramContract, Strand } from "@nightshift/contracts";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { sanitizeEnvironment } from "@nightshift/verification";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "../cli/operator.js";
import { scriptedHarnessModule } from "../slice/context.js";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
} from "../slice/fixture-repo.js";

const ORCHESTRATE = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-orchestrate.js", import.meta.url),
);
const RESUME = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-resume.js", import.meta.url),
);

let op: Operator;
let fixture: MaterialisedRepo;
let environment: CliEnvironment;

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

const plan = (title: string, sections: readonly [string, string, string][]): string =>
  [
    `# ${title}`,
    "",
    "## Strands",
    "",
    ...sections.flatMap(([id, prefix, tag]) => [
      `### ${id} The ${prefix} modules`,
      "",
      `Two small modules, \`${prefix}1\` and \`${prefix}2\`, each with its own test.`,
      "",
      `[orchestrate prefix=${prefix}${tag}]`,
      "",
    ]),
  ].join("\n");

const writeProgram = async (id: string, contract: ProgramContract, text: string) => {
  const directory = join(fixture.repo, "docs", "programs", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(join(directory, "plan.md"), text);
};

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(environment, [...argv, "--repo", fixture.repo]);
};

beforeEach(async () => {
  op = await signIn({ realTime: true });
  const created = await createProject(op.environment, { name: "corrections" });
  fixture = await materialiseFixtureRepo({
    projectId: created.projectId as never,
    delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
  });
  git("rm", "-q", "nightshift.program.json");
  git("commit", "-qm", "planned programs live under docs/programs");
  environment = {
    ...op.environment,
    assets: { skillsDir: "", mcpServerPath: "", orchestratePath: ORCHESTRATE, resumePath: RESUME },
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
});

describe("a reversed decision, corrected by a plan (SC-P9-08)", () => {
  it("runs, reverses, briefs, plans, confirms, corrects, and links the two reports", async () => {
    const base = await authoredProgram();
    const original: ProgramContract = {
      ...base,
      projectId: fixture.program.projectId,
      delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
      status: "planning",
      strands: [
        strand("S-01", "a", { successCriteria: base.successCriteria.map((c) => c.id) }),
        strand("S-02", "b"),
      ],
    };
    await writeProgram(
      "modules",
      original,
      plan("Modules", [
        ["S-01", "a", ""],
        ["S-02", "b", " depart=1 class=irreversible"],
      ]),
    );
    git("add", "-A");
    git("commit", "-qm", "plan the modules");

    // The project's gates, audited once (D-P15-07): the correction below is
    // checked against the same record, because its gates are the same.
    expect(await cli("gates", "modules", "--record"), op.err.join("\n")).toBe(0);
    expect(await cli("plan", "check", "modules"), op.err.join("\n")).toBe(0);
    expect(await cli("plan", "ratify", "modules"), op.err.join("\n")).toBe(0);
    expect(await cli("run", "modules"), `${op.out.join("\n")}\n${op.err.join("\n")}`).toBe(0);
    const runId = op.out.find((line) => /^run_[0-9A-Z]+$/.test(line)) ?? "";

    // The strand's departure is a decision, stamped with what its strand landed.
    const stores = createHttpStores({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("unused"),
      }),
    });
    const scope = {
      projectId: original.projectId,
      programId: original.programId,
      runId: runId as never,
    };
    const departure = (await stores.decisions.listByRun(scope)).items.find((decision) =>
      decision.context.startsWith("DEPARTURE:"),
    );
    expect(departure?.produced?.commits.length).toBe(2);
    const decisionId = departure?.decisionId ?? "";

    // The owner reverses it, and the brief is written.
    expect(
      await cli(
        "decision",
        "reverse",
        "modules",
        decisionId,
        "--choice",
        "One module, as planned",
        "--reason",
        "the b modules belong together",
      ),
      op.err.join("\n"),
    ).toBe(0);
    const reversedBy = /Recorded (dec_[0-9A-Z]+)/.exec(op.out.join("\n"))?.[1] ?? "";
    expect(
      await cli("decision", "brief", "modules", decisionId, "--out", "docs/programs/fix/brief.md"),
      op.err.join("\n"),
    ).toBe(0);
    const brief = await readFile(join(fixture.repo, "docs", "programs", "fix", "brief.md"), "utf8");
    expect(brief).toContain("IRREVERSIBLE");
    expect(brief).toContain("src/b1.js");

    // The correction, planned from it: rewrites what the decision produced, and
    // adds what it never touched.
    const correction: ProgramContract = {
      ...original,
      programId: op.ids.next("prog") as never,
      strands: [
        strand("S-01", "b", { successCriteria: base.successCriteria.map((c) => c.id) }),
        strand("S-02", "d"),
      ],
      corrects: [
        {
          programId: original.programId,
          runId: runId as never,
          decisionId: decisionId as never,
          reversedBy: reversedBy as never,
        },
      ],
    };
    await writeProgram(
      "fix",
      correction,
      plan("Fix", [
        ["S-01", "b", " value=together"],
        ["S-02", "d", ""],
      ]),
    );
    git("add", "-A");
    git("commit", "-qm", "plan the correction");

    expect(await cli("plan", "check", "fix"), op.err.join("\n")).toBe(0);
    expect(op.out.join("\n")).toContain(`FLAG ${decisionId} is irreversible`);
    expect(await cli("plan", "ratify", "fix"), op.err.join("\n")).toBe(0);

    // Refused until the owner confirms; nothing started.
    expect(await cli("run", "fix")).not.toBe(0);
    expect(op.err.join("\n")).toContain(`--confirm-irreversible ${decisionId}`);
    const confirmed = await cli("run", "fix", "--confirm-irreversible", decisionId);
    expect(confirmed, `${op.out.join("\n")}\n${op.err.join("\n")}`).toBe(0);
    expect(op.out.join("\n")).toContain(`recorded your confirmation to correct ${decisionId}`);

    // Inside what the decision produced, and outside it.
    const b1 = await readFile(join(fixture.repo, "src", "b1.js"), "utf8");
    expect(b1).toContain('"together"');
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toContain("src/d1.js");

    // Each report names the other.
    const fixReport = await readFile(
      join(fixture.repo, "docs", "programs", "fix", "report.md"),
      "utf8",
    );
    expect(fixReport).toContain("## What this program corrects");
    expect(fixReport).toContain(decisionId);
    expect(await cli("report", "modules"), op.err.join("\n")).toBe(0);
    const originalReport = await readFile(
      join(fixture.repo, "docs", "programs", "modules", "report.md"),
      "utf8",
    );
    expect(originalReport).toContain("**Reversed by you**");
    expect(originalReport).toContain(`Corrected by \`${correction.programId}\``);
  }, 240_000);
});
