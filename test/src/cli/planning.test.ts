/**
 * The planning commands through the real CLI, against the real handler, over a
 * real git repository (P7, T3): `plan check`, `plan ratify`, `preflight`, and
 * `run {id}` as far as T3 takes it (SC-P7-03, SC-P7-04, SC-P7-05).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, openSession, runCli } from "@nightshift/cli";
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
import { programDirectory, putFromFiles, ratifyFromFiles } from "./plan-scratch.js";

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

let origin: string;

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
  // A run makes sure the program branch is at origin too.
  origin = await mkdtemp(join(tmpdir(), "nightshift-origin-"));
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);
  // Audited and healthy (D-P15-08), so the plan's own readiness is what each test is about.
  await recordHealthyGates(op, fixture.repo, PROGRAM);
});

afterEach(async () => {
  await rm(origin, { recursive: true, force: true });
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
});

describe("nightshift plan check", () => {
  it("answers READY, inheriting what the contract does not state from the config", async () => {
    expect(
      await cli("plan", "check", PROGRAM, "--dir", programDirectory(fixture.repo, PROGRAM)),
    ).toBe(0);
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
    expect(
      await cli("plan", "check", PROGRAM, "--dir", programDirectory(fixture.repo, PROGRAM)),
    ).toBe(1);
    const said = op.err.join("\n");
    expect(op.err[0]).toMatch(/^NOT READY: \d+ reasons$/);
    expect(said).toContain("is claimed by no strand");
    expect(said).toContain("depends on S-02");
    expect(said).toContain("S-01 has no section in the plan document");
  });

  it("reports the plan's own reasons without requiring a fresh gate audit", async () => {
    await breakAGate();
    await writeProgram({ prerequisites: [] });
    expect(
      await cli("plan", "check", PROGRAM, "--dir", programDirectory(fixture.repo, PROGRAM)),
    ).toBe(1);
    const said = op.err.join("\n");
    expect(said).not.toContain("the gates changed since they were audited at");
    expect(said).toContain("HP-01");
  });

  it("refuses a scratch that is not there, and an id that is not a program id, as usage errors", async () => {
    expect(
      await cli(
        "plan",
        "check",
        "p9-nothing",
        "--dir",
        programDirectory(fixture.repo, "p9-nothing"),
      ),
    ).toBe(2);
    expect(op.err.join("\n")).toContain("contract.json does not exist");
    expect(
      await cli("plan", "check", "../escape", "--dir", programDirectory(fixture.repo, "../escape")),
    ).toBe(2);
  });
});

describe("nightshift plan ratify", () => {
  it("refuses a version that is not ready, and ratifies nothing", async () => {
    await writeProgram({ prerequisites: [] });
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    expect(await cli("plan", "ratify", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("Nothing was ratified");
    expect(
      await stores().programContracts.get(contract.projectId, contract.programId),
    ).toBeUndefined();
  });

  it("ratifies the latest version with the planHash the same files have, committed or not", async () => {
    await writeFile(programPath("plan.md"), `${PLAN}\nAn afterthought.\n`);
    expect(await ratifyFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    const uncommitted = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(uncommitted?.status).toBe("ratified");

    commit("commit the afterthought");
    expect(await ratifyFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    const committed = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(committed?.status).toBe("ratified");
    expect(committed?.planHash).toBe(uncommitted?.planHash);
    expect(committed?.planDocument).toEqual(uncommitted?.planDocument);
  });

  it("uploads the plan, records the hash, and the document reads back byte for byte", async () => {
    expect(await ratifyFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    expect(op.out[0]).toBe(`ratified ${PROGRAM} version 1`);

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

describe("nightshift plan put, show and check, from the plane", () => {
  let scratch: string;
  let outside: string;
  const planning = () =>
    createHttpPlanning({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("ignored-by-the-local-plane"),
      }),
    });
  const scope = () => ({ projectId: contract.projectId, programId: contract.programId });
  /** A command run from a directory in no repository, naming the project and nothing else. */
  const away = (...argv: string[]): Promise<number> => {
    op.out.length = 0;
    op.err.length = 0;
    return runCli({ ...op.environment, cwd: outside }, [...argv, "--project", contract.projectId]);
  };
  /** The scratch's contract states its project: nothing is read from a repository. */
  const writeScratch = async (patch: Partial<ProgramContract> = {}, plan = PLAN): Promise<void> => {
    await writeFile(
      join(scratch, "contract.json"),
      `${JSON.stringify({ ...contract, ...patch }, null, 2)}\n`,
    );
    await writeFile(join(scratch, "plan.md"), plan);
  };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
    outside = await mkdtemp(join(tmpdir(), "nightshift-outside-"));
    await rm(programPath(), { recursive: true, force: true });
    await writeScratch();
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("puts into --project over the directory's configuration, says so, and refuses a scratch that states another project (2026-10-29)", async () => {
    const other = await createProject(op.environment, { name: "planning-other" });
    // A scratch that states no project, put from the fixture repository, whose
    // configuration names the first project: the draft goes where --project says.
    const { projectId: _stated, ...unstated } = contract;
    await writeFile(join(scratch, "contract.json"), `${JSON.stringify(unstated, null, 2)}\n`);
    await writeFile(join(scratch, "plan.md"), PLAN);
    op.out.length = 0;
    op.err.length = 0;
    expect(
      await runCli({ ...op.environment, cwd: fixture.repo }, [
        "plan",
        "put",
        contract.programId,
        "--dir",
        scratch,
        "--project",
        other.projectId,
      ]),
    ).toBe(0);
    expect(op.out[0]).toContain(`in project ${other.projectId}`);
    const draft = await planning().getDraft({
      projectId: other.projectId as never,
      programId: contract.programId,
    });
    expect(draft?.latestVersion).toBe(1);
    expect(await planning().getDraft(scope())).toBeUndefined();

    // A scratch that states one project is refused for another, before anything is written.
    await writeScratch();
    op.out.length = 0;
    op.err.length = 0;
    expect(
      await runCli({ ...op.environment, cwd: outside }, [
        "plan",
        "put",
        contract.programId,
        "--dir",
        scratch,
        "--project",
        other.projectId,
      ]),
    ).not.toBe(0);
    expect(op.err.join("\n")).toContain(`is for project \`${contract.projectId}\``);
    expect(await planning().getDraft(scope())).toBeUndefined();
  });

  it("puts a scratch, shows it, checks it READY, and ratifies it, with no plan file in any repository", async () => {
    expect(await away("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    expect(op.out[0]).toContain("put version 1 of prog_");
    expect(await readFile(join(scratch, ".nightshift-plan-version"), "utf8")).toBe("1\n");

    expect(await away("plan", "show", contract.programId)).toBe(0);
    const shown = op.out.join("\n");
    expect(shown).toContain("version 1 of 1");
    expect(shown).toContain("author");
    expect(shown).toContain("act     write");
    expect(shown).toContain("state   draft");
    expect(shown).toContain("check   READY");

    expect(await away("plan", "check", contract.programId)).toBe(0);
    expect(op.out[0]).toBe("READY");

    expect(await away("plan", "ratify", contract.programId)).toBe(0);
    const ratified = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(ratified?.status).toBe("ratified");
    expect(ratified?.ratifications).toHaveLength(1);
    const draft = await planning().getDraft(scope());
    expect(draft?.state).toBe("ratified");
    expect(draft?.acts.at(-1)).toMatchObject({ kind: "ratified", planHash: ratified?.planHash });
    expect(
      await stores().programContracts.get(contract.projectId, contract.programId),
    ).toBeDefined();
  });

  it("answers NOT READY with every reason, and the exit code is the answer", async () => {
    await writeScratch({ prerequisites: [] });
    expect(await away("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    expect(await away("plan", "check", contract.programId)).toBe(1);
    expect(op.err[0]).toMatch(/^NOT READY: \d+ reasons?$/);
    expect(op.err.join("\n")).toContain("HP-01");
    expect(await away("plan", "ratify", contract.programId)).toBe(1);
    expect(op.err.join("\n")).toContain("Nothing was ratified");
  });

  it("refuses a put based on an older version than the latest, and names the latest", async () => {
    expect(await away("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    await writeFile(join(scratch, "plan.md"), `${PLAN}\nSecond.\n`);
    expect(await away("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    expect(await readFile(join(scratch, ".nightshift-plan-version"), "utf8")).toBe("2\n");

    await writeFile(join(scratch, "plan.md"), `${PLAN}\nThird, from a stale base.\n`);
    expect(await away("plan", "put", contract.programId, "--dir", scratch, "--based-on", "1")).toBe(
      1,
    );
    expect(op.err.join("\n")).toMatch(/latest version is 2/);
    expect((await planning().getDraft(scope()))?.latestVersion).toBe(2);
  });

  it("will not put over an existing draft without knowing the version it saw", async () => {
    expect(await away("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    const fresh = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
    try {
      await writeFile(join(fresh, "contract.json"), await readFile(join(scratch, "contract.json")));
      await writeFile(join(fresh, "plan.md"), PLAN);
      expect(await away("plan", "put", contract.programId, "--dir", fresh)).toBe(2);
      expect(op.err.join("\n")).toContain("version 1");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("shows a version into a scratch with its marker, so the next put is based on it", async () => {
    expect(await away("plan", "put", contract.programId, "--dir", scratch)).toBe(0);
    const other = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
    try {
      expect(await away("plan", "show", contract.programId, "--version", "1", "--dir", other)).toBe(
        0,
      );
      expect(await readFile(join(other, "plan.md"), "utf8")).toBe(PLAN);
      expect(JSON.parse(await readFile(join(other, "contract.json"), "utf8")).programId).toBe(
        contract.programId,
      );
      expect(await readFile(join(other, ".nightshift-plan-version"), "utf8")).toBe("1\n");
      await writeFile(join(other, "plan.md"), `${PLAN}\nEdited elsewhere.\n`);
      expect(await away("plan", "put", contract.programId, "--dir", other)).toBe(0);
      expect((await planning().getDraft(scope()))?.latestVersion).toBe(2);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("checks a scratch offline, with the same answers", async () => {
    expect(await away("plan", "check", contract.programId, "--dir", scratch)).toBe(0);
    expect(op.out[0]).toBe("READY");
    await writeScratch({}, "# Demo\n\nNo strand sections at all.\n");
    expect(await away("plan", "check", contract.programId, "--dir", scratch)).toBe(1);
    expect(op.err.join("\n")).toContain("S-01 has no section in the plan document");
  });
});

describe("nightshift preflight (SC-P7-05)", () => {
  it("refuses a program that is not ratified", async () => {
    expect(await cli("preflight", PROGRAM)).toBe(2);
    expect(op.err.join("\n")).toContain("has not been ratified");
  });

  it("prints the remediation for what is unmet, and marks only what passed", async () => {
    await ratifyFromFiles(cli, fixture.repo, PROGRAM);

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
  it("ratifies a READY, committed plan that was never ratified, then runs it (2026-10-16)", async () => {
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    expect(op.out.join("\n")).toContain("asking to run a plan approves it");
    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(recorded?.status).toBe("ratified");
    expect(recorded?.ratifications).toHaveLength(1);
  });

  it("ratifies an uncommitted plan, then runs it", async () => {
    await writeFile(programPath("plan.md"), `${PLAN}\nAn uncommitted thought.\n`);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    expect(op.err.join("\n")).not.toContain("uncommitted");
    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(recorded?.status).toBe("ratified");
  });

  it("stops at preflight when a first strand's prerequisite is unmet, and starts nothing", async () => {
    await ratifyFromFiles(cli, fixture.repo, PROGRAM);
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
    await ratifyFromFiles(cli, fixture.repo, PROGRAM);
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

  it("ratifies a version put after ratification again, by its hash, and runs the new one", async () => {
    await ratifyFromFiles(cli, fixture.repo, PROGRAM);
    await writeFile(programPath("plan.md"), `${PLAN}\nA quiet change of mind.\n`);
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(recorded?.ratifications).toHaveLength(2);
  });

  it("runs the plane's latest version of a program with no docs/programs directory, ratified by its hash", async () => {
    expect(await putFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    await rm(join(fixture.repo, "docs"), { recursive: true, force: true });
    commit("the plan lives on the plane");
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    const recorded = await stores().programContracts.get(contract.projectId, contract.programId);
    const latest = await createHttpPlanning({
      transport: (await openSession(op.environment)).transport,
    }).getVersion({ projectId: contract.projectId, programId: contract.programId });
    expect(recorded?.status).toBe("ratified");
    expect(recorded?.planHash).toBe(latest?.version.planHash);
  });

  it("still runs a contract by its path", async () => {
    expect(await cli("run", join(fixture.repo, "nightshift.program.json"))).toBe(0);
  });
  it("audits the gates first, on stderr, so the run id is still the first line out", async () => {
    await ratifyFromFiles(cli, fixture.repo, PROGRAM);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    expect(op.out[0]).toMatch(/^run_/);
    const said = op.err.join("\n");
    expect(said).toContain("auditing the gates on");
    expect(said).toMatch(/the gates pass on [0-9a-f]{8}/);
  });

  it("starts the run on a red base, records gate.red and keeps each red gate's output (D-P15-03)", async () => {
    await breakAGate();
    // Recorded healthy as it was ratified: the gate broke between ratification and the run.
    await recordHealthyGates(op, fixture.repo, PROGRAM);
    expect(await ratifyFromFiles(cli, fixture.repo, PROGRAM)).toBe(0);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    expect(op.out[0]).toMatch(/^run_/);
    const said = op.err.join("\n");
    expect(said).toContain("RED   broken failed on");
    expect(said).toContain("the base is broken");
    expect(said).toContain("The base has failing checks (broken)");
    expect(said).not.toContain("its first job is a repair");
    expect(said).not.toContain("Nothing was started");

    const runs = await stores().runs.listByProgram(
      { projectId: contract.projectId, programId: contract.programId },
      {},
    );
    expect(runs.items).toHaveLength(1);
    const run = runs.items[0];
    if (run === undefined) throw new Error("no run");
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const red = (await stores().events.listByRun(scope)).items.filter(
      (event) => event.type === "gate.red",
    );
    expect(red).toHaveLength(1);
    expect(red[0]?.executionNodeId).toBe(run.rootNodeId);
    expect(red[0]?.payload).toMatchObject({
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      failing: ["broken"],
    });
    const logs = (await stores().artifacts.listByRun(scope)).items.filter(
      (artifact) =>
        artifact.executionNodeId === run.rootNodeId && artifact.kind === "verification-log",
    );
    expect(logs).toHaveLength(1);
  });

  it("records no gate.red when the base is green", async () => {
    await ratifyFromFiles(cli, fixture.repo, PROGRAM);
    await writeFile(join(fixture.repo, "release-token"), "present");
    expect(await cli("run", PROGRAM, "--attended")).toBe(0);
    const runs = await stores().runs.listByProgram(
      { projectId: contract.projectId, programId: contract.programId },
      {},
    );
    const run = runs.items[0];
    if (run === undefined) throw new Error("no run");
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const events = (await stores().events.listByRun(scope)).items;
    expect(events.some((event) => event.type === "gate.red")).toBe(false);
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

  const latestConversation = async (): Promise<string | undefined> => {
    const planning = createHttpPlanning({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("ignored"),
      }),
    });
    const scope = { projectId: contract.projectId, programId: contract.programId };
    const latest = await planning.getVersion(scope);
    return latest?.version.conversation === undefined
      ? undefined
      : (await planning.planDocument(scope, latest.version.conversation.sha256))?.text;
  };
  const versions = async (): Promise<number> => {
    const planning = createHttpPlanning({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("ignored"),
      }),
    });
    return (
      await planning.listVersions({
        projectId: contract.projectId,
        programId: contract.programId,
      })
    ).length;
  };

  it("lists the session, stores the chosen messages word for word as the next version, checks the quotes, and ratifies it", async () => {
    await quoting(QUOTE);
    expect(await putFromFiles(say, fixture.repo, PROGRAM)).toBe(0);
    expect(await say("plan", "check", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("no planning conversation is kept");

    expect(await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT)).toBe(0);
    expect(op.out[0]).toMatch(/^\s+1\s+Human\s+let's plan tenant billing/);
    expect(op.out.at(-1)).toContain("5 messages in this session; 0 kept");
    expect(await versions()).toBe(1);

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
    expect(op.out.join("\n")).toContain("version 2 of p1-demo");
    expect(await versions()).toBe(2);
    const kept = (await latestConversation()) ?? "";
    expect(kept).toContain("The owner wants tenant isolation with no bypass.");
    expect(kept).toContain("and support staff get no bypass");
    expect(kept).not.toContain("weather");
    expect(kept).toContain("*Kept 3 of 5 messages; the rest led to nothing in the plan.*");
    // Nothing was written to the repository.
    await expect(readFile(programPath("conversation.md"), "utf8")).rejects.toThrow();
    expect(git("status", "--porcelain")).not.toContain("conversation");

    expect(await say("plan", "check", PROGRAM)).toBe(0);
    expect(await say("plan", "ratify", PROGRAM)).toBe(0);
    const ratified = await stores().programContracts.get(contract.projectId, contract.programId);
    expect(ratified?.conversation?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ratified?.ratifications?.at(-1)?.conversation).toEqual(ratified?.conversation);
    expect(op.out.join("\n")).toContain("conversation ");
  });

  it("refuses a paraphrase, and a quote only the assistant said", async () => {
    await quoting("admins should not see other companies' invoices");
    expect(await putFromFiles(say, fixture.repo, PROGRAM)).toBe(0);
    expect(
      await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT, "--keep", "1,2"),
    ).toBe(0);
    expect(await say("plan", "check", PROGRAM)).toBe(1);
    expect(op.err.join("\n")).toContain("is not in the human's kept messages word for word");
    await quoting("Invoices are read with no tenant filter.");
    expect(await putFromFiles(say, fixture.repo, PROGRAM)).toBe(0);
    expect(await say("plan", "check", PROGRAM)).toBe(1);
  });

  it("refuses a message number the session does not have, and stores nothing", async () => {
    expect(await putFromFiles(say, fixture.repo, PROGRAM)).toBe(0);
    expect(await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT, "--keep", "9")).toBe(
      2,
    );
    expect(op.err.join("\n")).toContain("outside this session's messages, 1 to 5");
    expect(await versions()).toBe(1);
  });

  it("reads and stores nothing when the program keeps no conversation", async () => {
    await writeProgram({ keepConversation: false });
    expect(await putFromFiles(say, fixture.repo, PROGRAM)).toBe(0);
    expect(await say("plan", "conversation", PROGRAM, "--session", TRANSCRIPT)).toBe(1);
    expect(op.err.join("\n")).toContain("keeps no planning conversation");
    expect(await versions()).toBe(1);
  });
});
