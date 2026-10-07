/**
 * The planning commands through the real CLI, against the real handler, over a
 * real git repository (P7, T3): `plan check`, `plan ratify`, `preflight`, and
 * `run {id}` as far as T3 takes it (SC-P7-03, SC-P7-04, SC-P7-05).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, runCli } from "@nightshift/cli";
import type { ProgramContract, Strand } from "@nightshift/contracts";
import {
  createFetchTransport,
  createHttpPlanning,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
} from "../slice/fixture-repo.js";
import { recordHealthyGates } from "./gate-health.js";
import { type Operator, signIn } from "./operator.js";

const PROGRAM = "p1-demo";
const PLAN = [
  "# Demo",
  "",
  "## Strands",
  "",
  "### S-01 The module",
  "",
  "A module exists, with its test.",
  "",
].join("\n");

let op: Operator;
let fixture: MaterialisedRepo;
let contract: ProgramContract;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" });

const programPath = (...parts: string[]): string =>
  join(fixture.repo, "docs", "programs", PROGRAM, ...parts);

/**
 * Writes the program's two files. The contract on disk states no `projectId`,
 * `verification`, `modelPolicy`, `delegationLimits` or `costPolicy`: those come
 * from `nightshift.config.json`, which is the point of having one.
 */
const writeProgram = async (
  patch: Partial<ProgramContract> = {},
  plan: string = PLAN,
): Promise<void> => {
  const {
    projectId: _projectId,
    verification: _verification,
    modelPolicy: _modelPolicy,
    delegationLimits: _delegationLimits,
    costPolicy: _costPolicy,
    ...authored
  } = { ...contract, ...patch };
  await mkdir(programPath(), { recursive: true });
  await writeFile(programPath("contract.json"), `${JSON.stringify(authored, null, 2)}\n`);
  await writeFile(programPath("plan.md"), plan);
};

const commit = (message: string): void => {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", message);
};

/** Adds a gate that fails on every commit, through the config every program inherits. */
const breakAGate = async (): Promise<void> => {
  const path = join(fixture.repo, "nightshift.config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.verification = [
    ...config.verification,
    { id: "broken", command: `node -e "console.log('the base is broken');process.exit(1)"` },
  ];
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  commit("break a gate");
};

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, [...argv, "--repo", fixture.repo]);
};

const stores = () =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
    actingOrg: op.orgId,
  });

beforeEach(async () => {
  op = await signIn();
  const created = await createProject(op.environment, { name: "planning-demo" });
  fixture = await materialiseFixtureRepo({ projectId: created.projectId as never });
  const base = await authoredProgram();
  contract = {
    ...base,
    projectId: created.projectId as never,
    status: "planning",
    strands: [
      {
        id: "S-01",
        name: "The module",
        scope: { summary: "the source tree", includes: base.scope.includes, excludes: [] },
        acceptance: ["its tests pass"],
        successCriteria: base.successCriteria.map((criterion) => criterion.id),
        dependsOn: [],
        prerequisites: ["HP-01"],
      },
    ],
    prerequisites: [
      {
        id: "HP-01",
        description: "The release token is in place.",
        remediation: "Create the file `release-token` at the repository root.",
        // Flipped by the test: present or absent, the same on Windows and Linux.
        verifyCommand: `node -e "require('fs').accessSync('release-token')"`,
        status: "pending",
      },
    ],
  };
  await writeFile(
    join(fixture.repo, "nightshift.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: created.projectId,
        contextDocs: [],
        verification: base.verification,
        modelPolicy: base.modelPolicy,
        delegationLimits: base.delegationLimits,
        costPolicy: base.costPolicy,
      },
      null,
      2,
    )}\n`,
  );
  await writeProgram();
  commit("plan the demo program");
  // Audited and healthy (D-P15-08), so the plan's own readiness is what each test is about.
  await recordHealthyGates(op, fixture.repo, PROGRAM);
});

afterEach(async () => {
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
});

describe("nightshift plan check", () => {
  it("answers READY, inheriting what the contract does not state from the config", async () => {
    expect(await cli("plan", "check", PROGRAM)).toBe(0);
    expect(op.out[0]).toBe("READY");
    expect(op.out[1]).toContain("1 strands, 1 prerequisites");
  });

  it("answers every reason, and the exit code is the answer", async () => {
    await writeProgram(
      {
        strands: [
          { ...(contract.strands?.[0] as Strand), successCriteria: [], dependsOn: ["S-02"] },
        ],
      },
      "# Demo\n\nNo strand sections at all.\n",
    );
    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    const said = op.err.join("\n");
    expect(op.err[0]).toMatch(/^NOT READY: \d+ reasons$/);
    expect(said).toContain("is claimed by no strand");
    expect(said).toContain("depends on S-02");
    expect(said).toContain("S-01 has no section in the plan document");
  });

  it("is NOT READY when the gates changed since they were audited, alongside the plan's own reasons", async () => {
    await breakAGate();
    await writeProgram({ prerequisites: [] });
    expect(await cli("plan", "check", PROGRAM)).toBe(1);
    const said = op.err.join("\n");
    expect(said).toContain("the gates changed since they were audited at");
    expect(said).toContain("HP-01");
  });

  it("refuses an id that is not a program here, as a usage error", async () => {
    expect(await cli("plan", "check", "p9-nothing")).toBe(2);
    expect(op.err.join("\n")).toContain("there is no program `p9-nothing` here");
    expect(await cli("plan", "check", "../escape")).toBe(2);
  });
});

describe("nightshift plan ratify", () => {
  it("refuses a plan that is not ready, and ratifies nothing", async () => {
    await writeProgram({ prerequisites: [] });
    commit("break the plan");
    expect(await cli("plan", "ratify", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("Nothing was ratified");
    expect(
      await stores().programContracts.get(contract.projectId, contract.programId),
    ).toBeUndefined();
  });

  it("refuses uncommitted changes: the hash must name something git can reproduce", async () => {
    await writeFile(programPath("plan.md"), `${PLAN}\nAn afterthought.\n`);
    expect(await cli("plan", "ratify", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain(`docs/programs/${PROGRAM}/plan.md`);
    expect(
      await stores().programContracts.get(contract.projectId, contract.programId),
    ).toBeUndefined();
  });

  it("uploads the plan, records the hash, and the document reads back byte for byte", async () => {
    expect(await cli("plan", "ratify", PROGRAM)).toBe(0);
    expect(op.out[0]).toBe(`ratified docs/programs/${PROGRAM}`);

    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(recorded?.status).toBe("ratified");
    // The merged contract is what was ratified: the control plane depends on no file.
    expect(recorded?.verification).toEqual(contract.verification);
    expect(op.out.join("\n")).toContain(recorded?.planHash ?? "(no hash)");

    const planning = createHttpPlanning({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("ignored"),
      }),
    });
    const document = await planning.planDocument(
      { projectId: contract.projectId, programId: contract.programId },
      recorded?.planDocument?.sha256 ?? "",
    );
    expect(document?.text).toBe(PLAN);
  });
});

describe("nightshift preflight (SC-P7-05)", () => {
  it("refuses a program that is not ratified", async () => {
    expect(await cli("preflight", PROGRAM)).toBe(2);
    expect(op.err.join("\n")).toContain("is not ratified");
  });

  it("prints the remediation for what is unmet, and marks only what passed", async () => {
    await cli("plan", "ratify", PROGRAM);

    expect(await cli("preflight", PROGRAM)).toBe(1);
    const said = op.err.join("\n");
    expect(said).toContain("UNMET HP-01");
    expect(said).toContain("Create the file `release-token` at the repository root.");
    const before = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(before?.prerequisites?.[0]).toMatchObject({ status: "pending" });
    expect(before?.prerequisites?.[0]?.lastCheck?.exitCode).not.toBe(0);

    // The human does it. Untracked, so the plan is unchanged.
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("preflight", PROGRAM)).toBe(0);
    expect(op.out.at(-1)).toBe("all prerequisites satisfied");
    const after = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(after?.prerequisites?.[0]).toMatchObject({
      status: "satisfied",
      lastCheck: { exitCode: 0 },
    });
    // Checking a prerequisite is not an edit: the plan is still the ratified one.
    expect(after?.planHash).toBe(before?.planHash);

    // Satisfied is what the last check said.
    await rm(join(fixture.repo, "release-token"));
    expect(await cli("preflight", PROGRAM)).toBe(0);
    expect(await cli("preflight", PROGRAM, "--recheck")).toBe(1);
  });
});

describe("nightshift run {id} (SC-P7-04)", () => {
  it("refuses a planned program that is not ratified, before writing anything", async () => {
    expect(await cli("run", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("has not been ratified");
    expect(
      await stores().programContracts.get(contract.projectId, contract.programId),
    ).toBeUndefined();
  });

  it("stops at preflight when a first strand's prerequisite is unmet, and starts nothing", async () => {
    await cli("plan", "ratify", PROGRAM);
    expect(await cli("run", PROGRAM)).toBe(1);
    const said = op.err.join("\n");
    expect(said).toContain("UNMET HP-01");
    expect(said).toContain("Create the file `release-token` at the repository root.");
    expect(said).toContain("nothing was started");
    const runs = await stores().runs.listByProgram(
      { projectId: contract.projectId, programId: contract.programId },
      {},
    );
    expect(runs.items).toEqual([]);
  });

  it("starts a run of the ratified plan, whose program node carries it", async () => {
    await cli("plan", "ratify", PROGRAM);
    await writeFile(join(fixture.repo, "release-token"), "present");
    // This suite's environment can start no process, so the run is left for an
    // orchestrator to attach to, as `--attended` asks for. T5 runs it to a report.
    expect(await cli("run", PROGRAM)).toBe(0);
    const runId = op.out[0] as never;
    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    const scope = { projectId: contract.projectId, programId: contract.programId, runId };
    const run = await stores().runs.get(scope, runId);
    const root = await stores().executionNodes.get(scope, run?.rootNodeId as never);
    expect(root?.plan).toEqual({
      planHash: recorded?.planHash,
      planDocument: recorded?.planDocument,
    });
  });

  it("refuses a plan edited after ratification until it is ratified again", async () => {
    await cli("plan", "ratify", PROGRAM);
    await writeFile(programPath("plan.md"), `${PLAN}\nA quiet change of mind.\n`);
    expect(await cli("run", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("has changed since it was ratified");

    commit("change the plan");
    expect(await cli("plan", "ratify", PROGRAM)).toBe(0);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(recorded?.ratifications).toHaveLength(2);
  });

  it("still runs a contract by its path", async () => {
    expect(await cli("run", join(fixture.repo, "nightshift.program.json"))).toBe(0);
  });
  it("audits the gates first, on stderr, so the run id is still the first line out", async () => {
    await cli("plan", "ratify", PROGRAM);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    expect(op.out[0]).toMatch(/^run_/);
    const said = op.err.join("\n");
    expect(said).toContain("auditing the gates on");
    expect(said).toMatch(/the gates pass on [0-9a-f]{8}/);
  });

  it("stops before creating anything when a gate fails on the base", async () => {
    await breakAGate();
    // Recorded healthy as it was ratified: the gate broke between ratification and the run.
    await recordHealthyGates(op, fixture.repo, PROGRAM);
    expect(await cli("plan", "ratify", PROGRAM)).toBe(0);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(1);
    const said = op.err.join("\n");
    expect(said).toContain("RED   broken failed on");
    expect(said).toContain("the base is broken");
    expect(said).toContain("Nothing was started");
    const runs = await stores().runs.listByProgram(
      { projectId: contract.projectId, programId: contract.programId },
      {},
    );
    expect(runs.items).toEqual([]);
  });
});

describe("nightshift gates", () => {
  it("answers 0 when the gates pass, and says the program declares no setup", async () => {
    await writeFile(join(fixture.repo, "package-lock.json"), "{}\n");
    commit("a lockfile");
    expect(await cli("gates", PROGRAM)).toBe(0);
    const said = op.out.join("\n");
    expect(said).toMatch(/the gates pass on [0-9a-f]{8}/);
    expect(said).toContain("package-lock.json is committed and the program declares no setup");
  });

  it("answers 1 when a gate is red, with what it said", async () => {
    await breakAGate();
    expect(await cli("gates", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("the base is broken");
  });
});

describe("nightshift plan conversation (P14, SC-P14-03, SC-P14-05, SC-P14-06)", () => {
  const TRANSCRIPT = fileURLToPath(
    new URL(
      "../../../packages/harness-claude/src/__fixtures__/claude-planning-session.jsonl",
      import.meta.url,
    ),
  );
  const BINARY = fileURLToPath(
    new URL("../../../apps/mcp/dist/bin/nightshift-transcript.js", import.meta.url),
  );
  const QUOTE = "an admin must never see another company's invoices";

  /** The operator's environment, able to start `nightshift-transcript` as the CLI does. */
  const withTranscripts = () => ({
    ...op.environment,
    exec: (file: string, args: readonly string[], options: { readonly cwd: string }) =>
      new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(file, [...args], { cwd: options.cwd });
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
    assets: { skillsDir: "", mcpServerPath: "", transcriptPath: BINARY },
  });
  const say = async (...argv: string[]): Promise<number> => {
    op.out.length = 0;
    op.err.length = 0;
    return runCli(withTranscripts(), [...argv, "--repo", fixture.repo]);
  };
  const quoting = async (words: string): Promise<void> =>
    writeProgram({
      stories: (contract.stories ?? []).map((story) =>
        story.id === "US-01" ? { ...story, words: [words] } : story,
      ),
    });

  it("lists the session, keeps the chosen messages word for word, checks the quotes, and ratifies it", async () => {
    await quoting(QUOTE);
    expect(await say("plan", "check", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("no planning conversation is kept");

    expect(await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT)).toBe(0);
    expect(op.out[0]).toMatch(/^\s+1\s+Human\s+let's plan tenant billing/);
    expect(op.out.at(-1)).toContain("5 messages in this session; 0 kept");

    const summary = join(fixture.repo, "..", "summary.md");
    await writeFile(summary, "The owner wants tenant isolation with no bypass.\n");
    expect(
      await say(
        "plan",
        "conversation",
        PROGRAM,
        "--session",
        TRANSCRIPT,
        "--keep",
        "1-3",
        "--summary",
        summary,
      ),
    ).toBe(0);
    const kept = await readFile(programPath("conversation.md"), "utf8");
    expect(kept).toContain("The owner wants tenant isolation with no bypass.");
    expect(kept).toContain("and support staff get no bypass");
    expect(kept).not.toContain("weather");
    expect(kept).toContain("*Kept 3 of 5 messages; the rest led to nothing in the plan.*");

    expect(await say("plan", "check", PROGRAM)).toBe(0);
    commit("keep the conversation");
    expect(await say("plan", "ratify", PROGRAM)).toBe(0);
    const ratified = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(ratified?.conversation?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ratified?.ratifications?.at(-1)?.conversation).toEqual(ratified?.conversation);
    expect(op.out.join("\n")).toContain("conversation ");
  });

  it("refuses a paraphrase, and a quote only the assistant said", async () => {
    await writeFile(join(fixture.repo, "..", "s.md"), "summary\n");
    await mkdir(programPath(), { recursive: true });
    expect(
      await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT, "--keep", "1,2"),
    ).toBe(0);
    await quoting("admins should not see other companies' invoices");
    expect(await say("plan", "check", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("is not in the human's kept messages word for word");
    await quoting("Invoices are read with no tenant filter.");
    expect(await say("plan", "check", PROGRAM)).toBe(1);
  });

  it("refuses a message number the session does not have, and writes nothing", async () => {
    expect(await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT, "--keep", "9")).toBe(
      2,
    );
    expect(op.err.join("\n")).toContain("outside this session's messages, 1 to 5");
  });

  it("reads and writes nothing when the program keeps no conversation", async () => {
    await writeProgram({ keepConversation: false });
    expect(await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT)).toBe(1);
    expect(op.err.join("\n")).toContain("keeps no planning conversation");
  });
});
