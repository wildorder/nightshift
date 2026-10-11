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
    // P16 S-03: the attached display reads the dispatch until the machine agrees.
    if (init.method === "GET" && url.endsWith("/dispatch")) {
      const body = JSON.stringify(
        makeDispatch(createFixtures(), {
          status: "running",
          progress: {
            stage: "audit",
            verdict: "agrees",
            generation: 1,
            stageStartedAt: "2026-09-15T12:00:00.000Z",
            updatedAt: "2026-09-15T12:00:00.000Z",
          },
        }),
      );
      return { status: 200, text: async () => body };
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

describe("remote runs establish their baseline on the remote machine", () => {
  it("dispatches without laptop gates, prerequisite checks, runtime probes, or reference artifacts", async () => {
    await rm(token("HP-01"));
    await writeFile(join(fixture.repo, ".nvmrc"), "24\n");
    commit("pin remote runtime");
    git("push", "-q", "origin", PROGRAM_BRANCH);
    const head = git("rev-parse", PROGRAM_BRANCH);
    const invoked: string[] = [];
    const environment = remoteEnvironment();
    expect(
      await cli(
        {
          ...environment,
          exec: async (file) => {
            invoked.push(file);
            throw new Error("no local tools");
          },
        },
        "run",
        PROGRAM,
        "--remote",
      ),
    ).toBe(0);
    expect(invoked).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.baseSha).toBe(head);
    expect(dispatched[0]?.reference).toBeUndefined();
    expect(dispatched[0]?.toolchain).toBeUndefined();
    expect(op.err.join("\n")).not.toContain("auditing the gates");
    const [run] = await runsOf();
    expect(run?.location).toBe("remote");
    if (run === undefined) throw new Error("no run");
    const events = (
      await stores().events.listByRun({
        projectId: run.projectId,
        programId: run.programId,
        runId: run.runId,
      })
    ).items;
    expect(events.some((event) => event.type === "gate.red")).toBe(false);
  });
});

describe("a local run is unchanged", () => {
  it("records gate.red itself, and carries no reference anywhere", async () => {
    expect(await cli(remoteEnvironment(), "run", PROGRAM, "--attended")).toBe(0);
    const said = op.err.join("\n");
    expect(said).toContain("The base has failing checks (broken)");
    expect(said).not.toContain("the reference audit");
    const [run] = await runsOf();
    if (run === undefined) throw new Error("no run");
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const events = (await stores().events.listByRun(scope)).items;
    expect(events.filter((event) => event.type === "gate.red")).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });
});
