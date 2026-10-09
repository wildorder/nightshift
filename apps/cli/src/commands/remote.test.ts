/**
 * `nightshift run --remote`'s readiness checks and its dispatch (P10, T3,
 * SC-P10-02), over a fake git and the fake control plane.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPUTE_TIERS,
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type ProgramContract,
} from "@nightshift/contracts";
import {
  createFixtures,
  type Fixtures,
  makeCheckpoint,
  makeDispatch,
  makeEvent,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import type { GitRunner } from "@nightshift/execution";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../failures.js";
import { openSession } from "../session.js";
import {
  createFakeControlPlane,
  createTestEnvironment,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_EMAIL,
  TEST_SUBJECT,
  type TestEnvironment,
} from "../testing/harness.js";
import {
  assertRemoteReady,
  describeDispatch,
  dispatchRun,
  environmentFaultOfRun,
} from "./remote.js";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BEHIND = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PLAN_HASH = "0".repeat(64);

const live: TestEnvironment[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A git that answers status, rev-parse of the branch and of origin's, and the current branch. */
const gitAnswering = (answers: {
  readonly dirty?: boolean;
  readonly head?: string;
  readonly origin?: string;
  readonly current?: string;
}): GitRunner => {
  return async (args) => {
    const joined = args.join(" ");
    const ok = (stdout: string) => ({ stdout: `${stdout}\n`, stderr: "", exitCode: 0 });
    const missing = { stdout: "", stderr: "unknown revision", exitCode: 128 };
    if (joined.includes("status --porcelain"))
      return ok(answers.dirty === true ? " M src/a.ts" : "");
    if (joined.includes("rev-parse --abbrev-ref HEAD"))
      return ok(answers.current ?? "program/fixture");
    if (joined.includes("rev-parse refs/remotes/origin/")) {
      return answers.origin === undefined ? missing : ok(answers.origin);
    }
    if (joined.includes("rev-parse program/fixture")) {
      return answers.head === undefined ? missing : ok(answers.head);
    }
    if (joined.includes("rev-parse")) return ok(HEAD);
    return ok("");
  };
};

const ratified = (f: Fixtures, overrides: Record<string, unknown> = {}): ProgramContract =>
  makeProgramContract(f, {
    status: "ratified",
    planHash: PLAN_HASH,
    planDocument: { uri: "s3://plans/fixture.md", sha256: PLAN_HASH, sizeBytes: 12 },
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: "program/fixture",
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
    ...overrides,
  });

const environmentWith = async (git: GitRunner) => {
  const repoPath = await mkdtemp(join(tmpdir(), "nightshift-remote-"));
  scratch.push(repoPath);
  const created = await createTestEnvironment({
    fetch: async () => ({ status: 404, text: async () => "" }),
    cwd: repoPath,
    git,
  });
  live.push(created);
  return { created, repoPath };
};

describe("assertRemoteReady (SC-P10-02, the CLI's half)", () => {
  const f = createFixtures();

  it("refuses an unratified plan, a dirty tree, an unpushed branch and a moved head, in that order", async () => {
    const planning = ratified(f, {
      status: "planning",
      planHash: undefined,
      planDocument: undefined,
    });
    const { created, repoPath } = await environmentWith(gitAnswering({ head: HEAD, origin: HEAD }));
    await expect(
      assertRemoteReady(created.environment, planning, repoPath, undefined),
    ).rejects.toThrow(/not ratified/);

    const dirty = await environmentWith(gitAnswering({ dirty: true, head: HEAD, origin: HEAD }));
    await expect(
      assertRemoteReady(dirty.created.environment, ratified(f), dirty.repoPath, undefined),
    ).rejects.toThrow(/uncommitted changes/);

    const unpushed = await environmentWith(gitAnswering({ head: HEAD }));
    await expect(
      assertRemoteReady(unpushed.created.environment, ratified(f), unpushed.repoPath, undefined),
    ).rejects.toThrow(/has not been pushed/);

    const moved = await environmentWith(gitAnswering({ head: HEAD, origin: BEHIND }));
    await expect(
      assertRemoteReady(moved.created.environment, ratified(f), moved.repoPath, undefined),
    ).rejects.toThrow(/at origin/);
  });

  it("answers the pushed head and the tier in D-P10-14's order, and refuses a tier it does not know", async () => {
    const { created, repoPath } = await environmentWith(gitAnswering({ head: HEAD, origin: HEAD }));
    const plain = await assertRemoteReady(created.environment, ratified(f), repoPath, undefined);
    expect(plain).toEqual({
      repositoryUrl: "https://github.com/wildorder/fixture",
      branch: "program/fixture",
      baseSha: HEAD,
      tier: "good",
      source: "default",
    });
    const stated = await assertRemoteReady(
      created.environment,
      ratified(f, { compute: { tier: "better" } }),
      repoPath,
      undefined,
    );
    expect(stated).toMatchObject({ tier: "better", source: "contract" });
    const flagged = await assertRemoteReady(created.environment, ratified(f), repoPath, "best");
    expect(flagged).toMatchObject({ tier: "best", source: "flag" });
    await expect(
      assertRemoteReady(created.environment, ratified(f), repoPath, "huge"),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("dispatchRun", () => {
  it("posts the dispatch bound to repository, branch, head and plan hash, and prints the price", async () => {
    const f = createFixtures();
    const project = makeProject(f);
    const contract = ratified(f);
    const dispatch = makeDispatch(f, {
      tier: "better",
      instanceType: "c8id.4xlarge",
      usdPerHour: 0.88704,
    });
    const plane = createFakeControlPlane({
      apiEndpoint: TEST_API,
      authDomain: TEST_AUTH_DOMAIN,
      claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
      orgId: project.orgId,
      stored: [project],
      overrides: [
        {
          path: `/orgs/${project.orgId}/config`,
          response: {
            status: 200,
            body: JSON.stringify({
              schemaVersion: 1,
              orgId: project.orgId,
              routingPolicy: DEFAULT_ROUTING_POLICY,
              examinationPolicy: DEFAULT_EXAMINATION_POLICY,
              installations: [],
              compute: DEFAULT_COMPUTE_CEILINGS,
              version: 0,
              updatedAt: "2026-10-01T12:00:00.000Z",
            }),
          },
        },
        {
          path: `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}/dispatch`,
          response: { status: 201, body: JSON.stringify(dispatch) },
        },
      ],
    });
    const created = await createTestEnvironment({ fetch: plane.fetch, cwd: process.cwd() });
    live.push(created);
    await signIn(created.environment);
    const session = await openSession(created.environment);
    const rootNode = makeRootNode(f);
    const started = {
      program: contract,
      run: makeRun(f, { status: "pending", location: "remote" }),
      rootNode,
      checkpoint: makeCheckpoint(f, rootNode.executionNodeId),
      baseCommit: HEAD,
    };
    const result = await dispatchRun(created.environment, session, started, {
      repositoryUrl: contract.repository.url,
      branch: "program/fixture",
      baseSha: HEAD,
      tier: "better",
      source: "flag",
    });
    expect(result.tier).toBe("better");
    const posted = plane.call(
      "POST",
      `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}/dispatch`,
    );
    expect(posted?.body).toEqual({
      tier: "better",
      idempotencyKey: `${f.scope.runId}:${HEAD}:${PLAN_HASH}`,
      input: {
        repositoryUrl: contract.repository.url,
        branch: "program/fixture",
        baseSha: HEAD,
        planHash: PLAN_HASH,
      },
    });
    const printed = created.out.join("\n");
    expect(printed).toContain(`c8id.4xlarge`);
    expect(printed).toContain(`$${COMPUTE_TIERS.better.usdPerHour.toFixed(4)}/h`);
    expect(printed).toContain("chosen by flag");
    expect(printed).toContain("the machine is being provisioned");
    expect(printed).toContain("Ctrl-C detaches");
    expect(printed).not.toContain("close the laptop");
  });

  it("refuses, before posting, a tier above the org's ceiling", async () => {
    const f = createFixtures();
    const project = makeProject(f);
    const plane = createFakeControlPlane({
      apiEndpoint: TEST_API,
      authDomain: TEST_AUTH_DOMAIN,
      claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
      orgId: project.orgId,
      stored: [project],
      overrides: [
        {
          path: `/orgs/${project.orgId}/config`,
          response: {
            status: 200,
            body: JSON.stringify({
              schemaVersion: 1,
              orgId: project.orgId,
              routingPolicy: DEFAULT_ROUTING_POLICY,
              examinationPolicy: DEFAULT_EXAMINATION_POLICY,
              installations: [],
              compute: { ...DEFAULT_COMPUTE_CEILINGS, maxTier: "good" },
              version: 1,
              updatedAt: "2026-10-01T12:00:00.000Z",
            }),
          },
        },
      ],
    });
    const created = await createTestEnvironment({ fetch: plane.fetch, cwd: process.cwd() });
    live.push(created);
    await signIn(created.environment);
    const session = await openSession(created.environment);
    const contract = ratified(f);
    const rootNode = makeRootNode(f);
    await expect(
      dispatchRun(
        created.environment,
        session,
        {
          program: contract,
          run: makeRun(f, { status: "pending", location: "remote" }),
          rootNode,
          checkpoint: makeCheckpoint(f, rootNode.executionNodeId),
          baseCommit: HEAD,
        },
        {
          repositoryUrl: contract.repository.url,
          branch: "program/fixture",
          baseSha: HEAD,
          tier: "best",
          source: "flag",
        },
      ),
    ).rejects.toThrow(/ceiling is good/);
    expect(plane.calls.some((call) => call.path.endsWith("/dispatch"))).toBe(false);
  });
});

describe("remote status (P16 SC-07)", () => {
  it("shows a failed dispatch's code and message", () => {
    const f = createFixtures();
    const lines = describeDispatch(
      makeDispatch(f, {
        status: "failed",
        failure: {
          code: "setup_failed",
          message: "the workspace could not be prepared: setup install exited 1",
        },
      }),
    );
    expect(lines[0]).toContain(": failed,");
    expect(lines).toContain(
      "  failure setup_failed: the workspace could not be prepared: setup install exited 1",
    );
  });

  it("says nothing of a failure when there is none", () => {
    const lines = describeDispatch(makeDispatch(createFixtures(), { status: "running" }));
    expect(lines.some((line) => line.includes("failure"))).toBe(false);
  });

  const fault = {
    baseCommit: "c".repeat(40),
    referenceNode: "24.4.1",
    machineNode: "18.20.4",
    gates: [
      {
        id: "unit",
        command: "npm test",
        kind: "check" as const,
        reference: "passed" as const,
        machine: "failed" as const,
        referenceTail: "Tests  12 passed (12)",
        machineTail: "TypeError: fetch is not a function",
      },
    ],
  };
  const faulted = (f: Fixtures) =>
    makeDispatch(f, {
      status: "failed",
      failure: {
        code: "environment_fault",
        message:
          "environment fault: unit (`npm test`) passed in the reference audit of cccccccc and failed " +
          "on this machine (Node 24.4.1 on the reference, 18.20.4 on the machine).",
      },
    });

  it("says an environment fault's cause, and shows it side by side from the run's events", () => {
    const lines = describeDispatch(faulted(createFixtures()), fault as never);
    expect(lines).toContain(
      "  failure environment_fault: environment fault: unit (`npm test`) passed in the reference audit " +
        "of cccccccc and failed on this machine (Node 24.4.1 on the reference, 18.20.4 on the machine).",
    );
    expect(lines.some((line) => line.startsWith("  cause: the machine, not the project."))).toBe(
      true,
    );
    const text = lines.join("\n");
    expect(text).toContain(
      "    | Gate | Command | Reference (Node 24.4.1) | Machine (Node 18.20.4) |",
    );
    expect(text).toContain("    | `unit` | `npm test` | passed | failed |");
    expect(text).toContain("    Tests  12 passed (12)");
    expect(text).toContain("    TypeError: fetch is not a function");
  });

  it("still says the cause when the run's events cannot be read", () => {
    const lines = describeDispatch(faulted(createFixtures()));
    expect(lines.some((line) => line.startsWith("  failure environment_fault: "))).toBe(true);
    expect(lines.some((line) => line.startsWith("  cause: the machine, not the project."))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("| Gate |"))).toBe(false);
  });

  it("reads the fault from every part of the run's environment.fault events", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    const second = { ...fault.gates[0], id: "lint", command: "npm run lint" };
    await stores.events.append(
      makeEvent(f, {
        type: "environment.fault",
        source: "control-plane",
        payload: { ...fault, part: 1, parts: 2 },
      }),
    );
    await stores.events.append(
      makeEvent(f, {
        type: "environment.fault",
        source: "control-plane",
        payload: { ...fault, gates: [second], part: 2, parts: 2 },
      }),
    );
    const read = await environmentFaultOfRun({ stores }, f.scope);
    expect(read?.gates.map((gate) => gate.id)).toEqual(["unit", "lint"]);
    expect(read).not.toHaveProperty("part");

    const failing = {
      ...stores,
      events: {
        ...stores.events,
        listByRun: async () => {
          throw new Error("the control plane is unreachable");
        },
      },
    };
    expect(await environmentFaultOfRun({ stores: failing }, f.scope)).toBeUndefined();
  });
});
