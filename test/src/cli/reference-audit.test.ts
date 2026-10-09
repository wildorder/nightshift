/**
 * P16 S-02, D-06: `nightshift run --remote` audits the gates on the laptop, at
 * exactly the base it dispatches, with every prerequisite checked on the
 * laptop, after the toolchain check; and the dispatch carries that reference.
 *
 * The real CLI, the real handler, real git with a real `origin`, and real gate
 * processes. Only the dispatch POST is answered here, so no machine is asked
 * for, and `node --version` is the laptop's as a faked process runner says it.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliEnvironment, createProject, type Exec, runCli } from "@nightshift/cli";
import type { DispatchInput, ProgramContract } from "@nightshift/contracts";
import { createFixtures, makeDispatch } from "@nightshift/core";
import type { GitRunner } from "@nightshift/execution";
import {
  createFetchTransport,
  createHttpStores,
  type FetchLike,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authoredProgram,
  type MaterialisedRepo,
  materialiseFixtureRepo,
  PROGRAM_BRANCH,
} from "../slice/fixture-repo.js";
import { recordHealthyGates } from "./gate-health.js";
import { type Operator, signIn } from "./operator.js";

const PROGRAM = "p16-reference";
const PLAN = [
  "# Reference",
  "",
  "## Strands",
  "",
  "### S-01 The module",
  "",
  "A module.",
  "",
  "### S-02 The second module",
  "",
  "Another, once the first is in.",
  "",
].join("\n");

let op: Operator;
let fixture: MaterialisedRepo;
let contract: ProgramContract;
let tokens: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" }).trim();

const commit = (message: string): void => {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", message);
};

/** A file outside the checkout, so the tree stays clean for a remote dispatch. */
const token = (name: string): string => join(tokens, name).replace(/\\/g, "/");
const present = (name: string): string => `node -e "require('fs').accessSync('${token(name)}')"`;

const stores = () =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
    actingOrg: op.orgId,
  });

/** The dispatch POSTs the CLI sent; answered here, so nothing is provisioned. */
let dispatched: DispatchInput[];

const remoteEnvironment = (git?: GitRunner): CliEnvironment => {
  const real = op.environment.fetch;
  const fetch: FetchLike = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/dispatch")) {
      dispatched.push((JSON.parse(init.body ?? "{}") as { input: DispatchInput }).input);
      const body = JSON.stringify(makeDispatch(createFixtures()));
      return { status: 201, text: async () => body };
    }
    return real(url, init);
  };
  const exec: Exec = async (file) => {
    if (file === "node") return { exitCode: 0, stdout: "v22.22.0\n", stderr: "" };
    throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
  };
  return { ...op.environment, fetch, exec, ...(git === undefined ? {} : { git }) };
};

const cli = async (environment: CliEnvironment, ...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(environment, [...argv, "--repo", fixture.repo]);
};

const runsOf = async () =>
  (
    await stores().runs.listByProgram(
      { projectId: contract.projectId, programId: contract.programId },
      {},
    )
  ).items;

beforeEach(async () => {
  dispatched = [];
  tokens = await mkdtemp(join(tmpdir(), "nightshift-tokens-"));
  op = await signIn();
  const created = await createProject(op.environment, { name: "reference-demo" });
  fixture = await materialiseFixtureRepo({ projectId: created.projectId as never });
  const base = await authoredProgram();
  const strand = (id: string, dependsOn: string[], prerequisites: string[]) => ({
    id,
    name: `The ${id} module`,
    scope: { summary: "the source tree", includes: base.scope.includes, excludes: [] },
    acceptance: ["its tests pass"],
    successCriteria: id === "S-01" ? base.successCriteria.map((criterion) => criterion.id) : [],
    dependsOn,
    prerequisites,
  });
  const prerequisite = (id: string) => ({
    id,
    description: `${id} is in place.`,
    remediation: `Create ${token(id)}.`,
    verifyCommand: present(id),
    status: "pending" as const,
  });
  contract = {
    ...base,
    projectId: created.projectId as never,
    status: "planning",
    strands: [strand("S-01", [], ["HP-01"]), strand("S-02", ["S-01"], ["HP-02", "HP-03"])],
    prerequisites: [prerequisite("HP-01"), prerequisite("HP-02"), prerequisite("HP-03")],
  };
  const {
    projectId: _p,
    verification: _v,
    modelPolicy: _m,
    delegationLimits: _d,
    costPolicy: _c,
    ...authored
  } = contract;
  const directory = join(fixture.repo, "docs", "programs", PROGRAM);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "contract.json"), `${JSON.stringify(authored, null, 2)}\n`);
  await writeFile(join(directory, "plan.md"), PLAN);
  await writeFile(
    join(fixture.repo, "nightshift.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: created.projectId,
        contextDocs: [],
        verification: [
          ...base.verification,
          { id: "broken", command: `node -e "console.log('the base is broken');process.exit(1)"` },
          { id: "needs-first", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
          { id: "needs-later", command: 'node -e "process.exit(0)"', requires: ["HP-02"] },
          { id: "needs-unmet", command: 'node -e "process.exit(0)"', requires: ["HP-03"] },
        ],
        modelPolicy: base.modelPolicy,
        delegationLimits: base.delegationLimits,
        costPolicy: base.costPolicy,
      },
      null,
      2,
    )}\n`,
  );
  commit("plan the reference program");
  const origin = join(fixture.root, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", PROGRAM_BRANCH);
  await recordHealthyGates(op, fixture.repo, PROGRAM);
  expect(
    await cli(op.environment, "plan", "ratify", PROGRAM),
    [...op.out, ...op.err].join("\n"),
  ).toBe(0);
  // The human has done the first strand's, and one of the later strand's; the
  // control plane has recorded neither as satisfied.
  await writeFile(token("HP-01"), "present");
  await writeFile(token("HP-02"), "present");
});

afterEach(async () => {
  await op.cleanup();
  await fixture.remove();
  await op.plane.close();
  await rm(tokens, { recursive: true, force: true });
});

describe("run --remote audits on the laptop, at the base it dispatches (P16 D-06)", () => {
  it("carries every gate's verdict, the Node it ran on, and the output of each gate that ran", async () => {
    const head = git("rev-parse", PROGRAM_BRANCH);
    expect(await cli(remoteEnvironment(), "run", PROGRAM, "--remote")).toBe(0);

    expect(op.out[0]).toMatch(/^run_/);
    const said = op.err.join("\n");
    expect(said).toContain(`auditing the gates on ${PROGRAM_BRANCH} at ${head.slice(0, 8)}`);
    expect(said).toContain("RED   broken failed on");
    expect(said).toContain("the run is dispatched anyway");
    expect(said).toContain("the machine audits the same base");
    expect(said).not.toContain("its first job is a repair");

    expect(dispatched).toHaveLength(1);
    const input = dispatched[0];
    expect(input?.baseSha).toBe(head);
    const reference = input?.reference;
    expect(reference?.base).toBe(head);
    expect(reference?.node).toBe("22.22.0");
    const verdicts = Object.fromEntries(
      (reference?.gates ?? []).map((gate) => [gate.id, gate.verdict]),
    );
    expect(verdicts).toMatchObject({
      broken: "failed",
      // Satisfied by preflight on this laptop just now, and by the laptop's own
      // check of a later strand's prerequisite: both ran (F-01).
      "needs-first": "passed",
      "needs-later": "passed",
      "needs-unmet": "waiting",
    });

    const [run] = await runsOf();
    if (run === undefined) throw new Error("no run");
    expect(run.location).toBe("remote");
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const events = (await stores().events.listByRun(scope)).items;
    // The machine decides red; the laptop writes none.
    expect(events.some((event) => event.type === "gate.red")).toBe(false);
    expect(events.find((event) => event.type === "run.created")?.payload).toMatchObject({
      baseCommit: head,
    });

    const broken = reference?.gates.find((gate) => gate.id === "broken");
    expect(broken?.outputArtifactId).toMatch(/^art_/);
    // Passed ones too (P16 D-07): a fault on the machine shows the laptop's output beside its own.
    for (const gate of reference?.gates ?? []) {
      if (gate.verdict === "waiting" || gate.verdict === "unrun") {
        expect(gate.outputArtifactId, gate.id).toBeUndefined();
      } else {
        expect(gate.outputArtifactId, gate.id).toMatch(/^art_/);
      }
    }
    const passed = reference?.gates.find((gate) => gate.id === "needs-first");
    expect(await stores().artifacts.get(scope, passed?.outputArtifactId as never)).toMatchObject({
      executionNodeId: run.rootNodeId,
      kind: "verification-log",
    });
    const artifact = await stores().artifacts.get(scope, broken?.outputArtifactId as never);
    expect(artifact).toMatchObject({
      executionNodeId: run.rootNodeId,
      kind: "verification-log",
    });
  });

  it("refuses a branch that moved during the audit, and starts nothing", async () => {
    const head = git("rev-parse", PROGRAM_BRANCH);
    const moved = git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit-tree",
      `${head}^{tree}`,
      "-p",
      head,
      "-m",
      "moved",
    );
    // The audit's checkout is removed at its end: the branch moves then, here and at origin.
    const moving: GitRunner = async (args, options) => {
      const result = await op.environment.git(args, options);
      if (args[0] === "worktree" && args[1] === "remove") {
        git("update-ref", `refs/heads/${PROGRAM_BRANCH}`, moved);
        git("update-ref", `refs/remotes/origin/${PROGRAM_BRANCH}`, moved);
      }
      return result;
    };

    expect(await cli(remoteEnvironment(moving), "run", PROGRAM, "--remote")).not.toBe(0);

    expect(op.err.join("\n")).toContain("moved from");
    expect(await runsOf()).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("starts the run at the audited base even when the branch moves as the run is made", async () => {
    const head = git("rev-parse", PROGRAM_BRANCH);
    const moved = git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit-tree",
      `${head}^{tree}`,
      "-p",
      head,
      "-m",
      "moved",
    );
    // After the last check that the branch has not moved: the next read is `startRun`'s.
    let originReads = 0;
    const moving: GitRunner = async (args, options) => {
      const result = await op.environment.git(args, options);
      if (args[0] === "rev-parse" && args[1] === `refs/remotes/origin/${PROGRAM_BRANCH}`) {
        originReads += 1;
        if (originReads === 2) git("update-ref", `refs/heads/${PROGRAM_BRANCH}`, moved);
      }
      return result;
    };

    expect(await cli(remoteEnvironment(moving), "run", PROGRAM, "--remote")).toBe(0);

    const [run] = await runsOf();
    if (run === undefined) throw new Error("no run");
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const events = (await stores().events.listByRun(scope)).items;
    expect(events.find((event) => event.type === "run.created")?.payload).toMatchObject({
      baseCommit: head,
    });
    expect(events.find((event) => event.type === "checkpoint.created")?.payload).toMatchObject({
      commitSha: head,
    });
    // The branch did move, after the last check and before the run was made.
    expect(git("rev-parse", PROGRAM_BRANCH)).toBe(moved);
    expect(dispatched[0]?.baseSha).toBe(head);
    expect(dispatched[0]?.reference?.base).toBe(head);
  });

  it("refuses a laptop whose Node violates its pin before the audit runs", async () => {
    await writeFile(join(fixture.repo, ".nvmrc"), "24\n");
    commit("pin node 24");
    git("push", "-q", "origin", PROGRAM_BRANCH);
    await recordHealthyGates(op, fixture.repo, PROGRAM);

    expect(await cli(remoteEnvironment(), "run", PROGRAM, "--remote")).not.toBe(0);

    const said = op.err.join("\n");
    expect(said).toContain("this project pins 24");
    expect(said).not.toContain("auditing the gates");
    expect(await runsOf()).toEqual([]);
  });
});

describe("a local run is unchanged", () => {
  it("records gate.red itself, and carries no reference anywhere", async () => {
    expect(await cli(remoteEnvironment(), "run", PROGRAM, "--attended")).toBe(0);
    const said = op.err.join("\n");
    expect(said).toContain("its first job is a repair of broken");
    expect(said).not.toContain("the reference audit");
    const [run] = await runsOf();
    if (run === undefined) throw new Error("no run");
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const events = (await stores().events.listByRun(scope)).items;
    expect(events.filter((event) => event.type === "gate.red")).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });
});
