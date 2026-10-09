/**
 * P16 S-01, D-03: `nightshift run --remote` reads the pins at the commit it
 * dispatches, measures the laptop's runtimes against them, and carries the
 * exact versions on the dispatch, or refuses before anything is written.
 *
 * Over a real git repository with a real `origin`, and a faked process runner
 * standing in for the laptop's `node --version` and the rest.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRemoteReady,
  type CliEnvironment,
  dispatchRun,
  type Exec,
  type Session,
  UsageError,
} from "@nightshift/cli";
import {
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
} from "@nightshift/contracts";
import {
  createFixtures,
  makeCheckpoint,
  makeDispatch,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import type { ControlPlaneRequest } from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "./operator.js";

const BRANCH = "program/fixture";
const PLAN_HASH = "0".repeat(64);

const operators: Operator[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(operators.splice(0).map((operator) => operator.cleanup()));
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await nodeGitRunner(args, { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const commitFiles = async (repo: string, files: Readonly<Record<string, string>>) => {
  for (const [file, text] of Object.entries(files)) await writeFile(join(repo, file), text);
  await git(repo, "add", "-A");
  await git(repo, "commit", "--no-verify", "-m", "pins");
};

/**
 * A checkout whose program branch, pushed to `origin`, commits `pinned`. With
 * `checkedOut`, the checkout then sits, clean, on another branch committing
 * those files instead: what the working tree says is not what is dispatched.
 */
const repositoryPinning = async (
  pinned: Readonly<Record<string, string>>,
  checkedOut?: Readonly<Record<string, string>>,
): Promise<{ repo: string; head: string }> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-pins-"));
  scratch.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(root, "init", "--bare", "-q", origin);
  await git(repo, "init", "-q", "-b", BRANCH);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await commitFiles(repo, pinned);
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-q", "-u", "origin", BRANCH);
  const head = await git(repo, "rev-parse", "HEAD");
  if (checkedOut !== undefined) {
    await git(repo, "checkout", "-q", "-b", "elsewhere");
    await commitFiles(repo, checkedOut);
  }
  return { repo, head };
};

/** The laptop: each runtime's version output, or absent when it is not installed. */
const laptop = (
  outputs: Readonly<Record<string, string>>,
): { exec: Exec; ran: { file: string; args: readonly string[]; cwd: string }[] } => {
  const ran: { file: string; args: readonly string[]; cwd: string }[] = [];
  const exec: Exec = async (file, args, options) => {
    ran.push({ file, args, cwd: options.cwd });
    const output = outputs[file];
    if (output === undefined) {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    }
    return file === "java"
      ? { exitCode: 0, stdout: "", stderr: output }
      : { exitCode: 0, stdout: output, stderr: "" };
  };
  return { exec, ran };
};

const ratified = () =>
  makeProgramContract(createFixtures(), {
    status: "ratified",
    planHash: PLAN_HASH,
    planDocument: { uri: "s3://plans/fixture.md", sha256: PLAN_HASH, sizeBytes: 12 },
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: BRANCH,
    },
    strands: [
      {
        id: "S-01",
        name: "The strand",
        scope: { summary: "The source", includes: ["src/**"], excludes: [] },
        acceptance: ["it works"],
        successCriteria: ["SC-01"],
        dependsOn: [],
        prerequisites: [],
      },
    ],
  });

const operatorWith = async (
  exec: Exec,
): Promise<{ operator: Operator; environment: CliEnvironment }> => {
  const operator = await signIn();
  operators.push(operator);
  return { operator, environment: { ...operator.environment, exec } };
};

const refusalOf = async (promise: Promise<unknown>): Promise<UsageError> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UsageError);
  return error as UsageError;
};

describe("run --remote measures the laptop's runtimes against the pins (P16 S-01)", () => {
  it("reads the pins at the dispatched commit, not the working tree, and carries the exact version", async () => {
    // keki: `.nvmrc` says 22; the checkout, on another branch, says 24.
    const { repo, head } = await repositoryPinning({ ".nvmrc": "22\n" }, { ".nvmrc": "24\n" });
    const { exec, ran } = laptop({ node: "v22.22.0\n" });
    const { operator, environment } = await operatorWith(exec);

    const readiness = await assertRemoteReady(environment, ratified(), repo, undefined);

    expect(readiness.baseSha).toBe(head);
    expect(readiness.toolchain).toEqual([
      { runtime: "node", version: "22.22.0", source: { kind: "pin", file: ".nvmrc", spec: "22" } },
    ]);
    expect(ran).toEqual([{ file: "node", args: ["--version"], cwd: repo }]);
    // Nothing on stdout before the run exists: the run id is its first line.
    expect(operator.out).toEqual([]);
  });

  it("carries no toolchain, and runs nothing, when the project pins nothing", async () => {
    const { repo } = await repositoryPinning({ "package.json": '{"name":"fixture"}\n' });
    const { exec, ran } = laptop({});
    const { environment } = await operatorWith(exec);

    const readiness = await assertRemoteReady(environment, ratified(), repo, undefined);

    expect(readiness.toolchain).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it("refuses a laptop whose runtime violates its pin, naming both versions", async () => {
    const { repo } = await repositoryPinning({ ".node-version": "24\n" });
    const { exec } = laptop({ node: "v22.22.0\n" });
    const { operator, environment } = await operatorWith(exec);

    const refusal = await refusalOf(assertRemoteReady(environment, ratified(), repo, undefined));

    expect(refusal.message).toBe(
      "your audit ran on node 22.22.0; this project pins 24 (.node-version)",
    );
    expect(refusal.usage).toMatch(/version manager/);
    expect(refusal.usage).toMatch(/change the pin/);
    expect(operator.out).toEqual([]);
  });

  it("refuses a pinned runtime that is not installed on the laptop", async () => {
    const { repo } = await repositoryPinning({ ".nvmrc": "22\n", ".python-version": "3.12.4\n" });
    const { exec } = laptop({ node: "v22.22.0\n" });
    const { environment } = await operatorWith(exec);

    const refusal = await refusalOf(assertRemoteReady(environment, ratified(), repo, undefined));

    expect(refusal.message).toBe(
      "this project pins python 3.12.4 (.python-version) but python was not found on this machine",
    );
  });

  it("refuses a version command that fails, or prints no exact version", async () => {
    const { repo } = await repositoryPinning({ ".nvmrc": "22\n", ".ruby-version": "3.3.0\n" });
    const exec: Exec = async (file) =>
      file === "node"
        ? { exitCode: 0, stdout: "v22\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "rbenv: version `3.3.0' is not installed\n" };
    const { environment } = await operatorWith(exec);

    const refusal = await refusalOf(assertRemoteReady(environment, ratified(), repo, undefined));

    expect(refusal.message).toContain("`node --version` printed no exact node version");
    expect(refusal.message).toContain(
      "this project pins ruby 3.3.0 (.ruby-version) but `ruby --version` failed with exit code 1: " +
        "rbenv: version `3.3.0' is not installed",
    );
  });

  it("refuses pin files that disagree, naming both, before running anything", async () => {
    const { repo } = await repositoryPinning({
      ".nvmrc": "22\n",
      ".tool-versions": "nodejs 24.1.0\n",
    });
    const { exec, ran } = laptop({ node: "v22.22.0\n" });
    const { environment } = await operatorWith(exec);

    const refusal = await refusalOf(assertRemoteReady(environment, ratified(), repo, undefined));

    expect(refusal.message).toContain(".nvmrc pins node 22");
    expect(refusal.message).toContain(".tool-versions pins 24.1.0");
    expect(refusal.usage).toMatch(/agree/);
    expect(ran).toEqual([]);
  });

  it("measures every pinned runtime, java from stderr", async () => {
    const { repo } = await repositoryPinning({
      ".tool-versions": "nodejs 22.22.0\npython 3.12\njava 21\nterraform 1.9.0\n",
    });
    const { exec } = laptop({
      node: "v22.22.0\n",
      python: "Python 3.12.4\n",
      java: 'openjdk version "21.0.4" 2024-07-16\n',
    });
    const { operator, environment } = await operatorWith(exec);

    const readiness = await assertRemoteReady(environment, ratified(), repo, undefined);

    expect(readiness.toolchain?.map(({ runtime, version }) => `${runtime} ${version}`)).toEqual([
      "node 22.22.0",
      "python 3.12.4",
      "java 21.0.4",
    ]);
    // A tool Nightshift cannot measure is said, on stderr, and left to the image.
    expect(operator.err.join("\n")).toMatch(/\.tool-versions pins terraform 1\.9\.0/);
  });
});

describe("dispatchRun carries the toolchain (P16 D-03)", () => {
  it("sends input.toolchain and says what the machine runs", async () => {
    const f = createFixtures();
    const project = makeProject(f);
    const contract = ratified();
    const posted: ControlPlaneRequest[] = [];
    const session = {
      profile: undefined as never,
      stores: undefined as never,
      transport: async (request: ControlPlaneRequest) => {
        if (request.path.startsWith("/projects/") && request.path.endsWith("/dispatch")) {
          posted.push(request);
          return { status: 201, body: makeDispatch(f) };
        }
        if (request.path.endsWith("/config")) {
          return {
            status: 200,
            body: {
              schemaVersion: 1,
              orgId: project.orgId,
              routingPolicy: DEFAULT_ROUTING_POLICY,
              examinationPolicy: DEFAULT_EXAMINATION_POLICY,
              installations: [],
              compute: DEFAULT_COMPUTE_CEILINGS,
              version: 0,
              updatedAt: "2026-10-01T12:00:00.000Z",
            },
          };
        }
        return { status: 200, body: project };
      },
    } as Session;
    const { operator, environment } = await operatorWith(laptop({}).exec);
    const rootNode = makeRootNode(f);
    const toolchain = [
      {
        runtime: "node",
        version: "22.22.0",
        source: { kind: "pin" as const, file: ".nvmrc", spec: "22" },
      },
    ];

    await dispatchRun(
      environment,
      session,
      {
        program: contract,
        run: makeRun(f, { status: "pending", location: "remote" }),
        rootNode,
        checkpoint: makeCheckpoint(f, rootNode.executionNodeId),
        baseCommit: "a".repeat(40),
      },
      {
        repositoryUrl: contract.repository.url,
        branch: BRANCH,
        baseSha: "a".repeat(40),
        tier: "good",
        source: "default",
        toolchain,
      },
    );

    expect(posted).toHaveLength(1);
    const body = posted[0]?.body as { input: { toolchain: unknown } } | undefined;
    expect(body?.input.toolchain).toEqual(toolchain);
    const said = operator.out.join("\n");
    expect(said).toContain("node 22.22.0 (.nvmrc)");
    expect(said).toContain("the image's");
  });
});
