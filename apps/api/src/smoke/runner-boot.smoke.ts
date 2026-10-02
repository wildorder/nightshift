/**
 * Two runs of the fixture repository on real machines, cold and then warm
 * (P10, T3). Run by `npm run runner:boot`, never by `npm test`.
 *
 * The plane is the deployed one and the path is the customer's: a throwaway
 * org that records the Nightshift GitHub App's installation, a project, a
 * ratified program whose repository is `wildorder/nightshift-remote-fixture`,
 * a pending remote run, and `POST …/dispatch` with the branch's real head. The
 * API verifies the head with the App and invokes the dispatch Lambda; the
 * machine comes up on its own, clones from GitHub with the read token the
 * heartbeat carries, runs `npm ci --prefer-offline` and reports `ready` with
 * what setup took. Cancelled, the reconciler snapshots the volume into the
 * project's warm cache; the second run of the same project is provisioned from
 * that snapshot and its setup time is the warm number (SC-P10-08).
 *
 * Everything made is removed at the end: machines, volumes, snapshots, records.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ComputeUtilizationSchema,
  type Dispatch,
  DispatchSchema,
  PlanDocumentUploadResponseSchema,
  ProgramContractSchema,
  type RunId,
  UserIdSchema,
  WarmCacheSchema,
} from "@nightshift/contracts";
import {
  createUlidIdGenerator,
  type Fixtures,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nowIso,
  planHash,
  systemClock,
} from "@nightshift/core";
import { createAwsClients, createAwsStores, keys } from "@nightshift/persistence/aws";
import { afterAll, describe, expect, it } from "vitest";
import { deleteObjectsUnder, deletePartitions } from "./cleanup.js";
import { fetchMachineToken, loadSmokeContext, REGION, subjectOf } from "./context.js";
import { smokeApiClient } from "./http.js";

/** The fixture repository and the installation that grants it (H-P10-04, H-P10-05). */
const FIXTURE_REPOSITORY = "https://github.com/wildorder/nightshift-remote-fixture";
const FIXTURE_BRANCH = "program/fixture";
const INSTALLATION_ID = 166952409;
/** SC-P10-08: the warm setup against the cold one. Printed always, asserted softly. */
const WARM_RATIO_TARGET = 0.1;

const say = (line: string): void => {
  process.stdout.write(`[runner-boot] ${line}\n`);
};

const aws = (args: readonly string[]): string =>
  execFileSync("aws", [...args, "--region", REGION, "--output", "json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const context = await loadSmokeContext();
const stage = context.stage;
const clients = createAwsClients({ region: REGION });
const stores = createAwsStores({ tableName: context.tableName, table: clients.table });
const token = await fetchMachineToken(context);
const machineSubject = UserIdSchema.parse(subjectOf(token));
const endpoint = context.apiCustomEndpoint;
if (endpoint === undefined) {
  throw new Error("the API stack is zone-only; the runner needs the stable hostname as its issuer");
}
const api = smokeApiClient(endpoint, token);

/** The branch's head at GitHub, which is what the dispatch binds (D-P10-02). */
const remoteHead = (): string => {
  const listed = execFileSync(
    "git",
    ["ls-remote", FIXTURE_REPOSITORY, `refs/heads/${FIXTURE_BRANCH}`],
    { encoding: "utf8" },
  );
  const sha = listed.split(/\s+/)[0];
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`git ls-remote found no ${FIXTURE_BRANCH} at ${FIXTURE_REPOSITORY}`);
  }
  return sha;
};

// --- What this run writes ---------------------------------------------------------
const ids = createUlidIdGenerator();
const label = `runner-boot-${ids.next("evt").slice("evt_".length)}`;
const orgId = ids.next("org");
const f: Fixtures = {
  ids,
  scope: { projectId: ids.next("proj"), programId: ids.next("prog"), runId: ids.next("run") },
  rootNodeId: ids.next("node"),
};
const projectPath = `/projects/${f.scope.projectId}`;
const programPath = `${projectPath}/programs/${f.scope.programId}`;

interface RunMade {
  readonly runId: RunId;
  readonly rootNodeId: string;
  readonly path: string;
  dispatch?: Dispatch;
}
const runs: RunMade[] = [];
const keep = process.env.NIGHTSHIFT_RUNNER_BOOT_KEEP === "1";
const findings: Record<string, unknown> = {};

const expectStatus = (result: { status: number; body: unknown }, status: number): void => {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
};

/** Polls the run's dispatch until `until` says so, or the time is up. */
const awaitDispatch = async (
  run: RunMade,
  what: string,
  timeoutMs: number,
  until: (dispatch: Dispatch) => boolean,
): Promise<Dispatch> => {
  const startedAt = Date.now();
  for (;;) {
    const current = DispatchSchema.parse((await api.get(`${run.path}/dispatch`)).body);
    run.dispatch = current;
    if (until(current)) return current;
    if (current.status === "failed") {
      throw new Error(
        `dispatch ${run.runId} failed while waiting for ${what}: ${JSON.stringify(current.failure)}`,
      );
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `dispatch ${run.runId} did not reach ${what} within ${Math.round(timeoutMs / 60_000)} minutes; it is ${current.status}`,
      );
    }
    await sleep(10_000);
  }
};

/** The runner's own journal, over SSM, for the record and for the failures. */
const journal = async (instanceId: string): Promise<string> => {
  const parameters = join(tmpdir(), `nightshift-runner-boot-${process.pid}.json`);
  writeFileSync(
    parameters,
    JSON.stringify({
      commands: ["journalctl -u nightshift-runner --no-pager -n 120 -o cat"],
      executionTimeout: ["60"],
    }),
  );
  try {
    const sent = JSON.parse(
      aws([
        "ssm",
        "send-command",
        "--instance-ids",
        instanceId,
        "--document-name",
        "AWS-RunShellScript",
        "--parameters",
        `file://${parameters.replaceAll("\\", "/")}`,
      ]),
    ) as { Command: { CommandId: string } };
    for (let waited = 0; waited < 90_000; waited += 5_000) {
      await sleep(5_000);
      const invocation = JSON.parse(
        aws([
          "ssm",
          "get-command-invocation",
          "--command-id",
          sent.Command.CommandId,
          "--instance-id",
          instanceId,
        ]),
      ) as { Status: string; StandardOutputContent: string };
      if (["Success", "Failed", "TimedOut", "Cancelled"].includes(invocation.Status)) {
        return invocation.StandardOutputContent;
      }
    }
    return "(no answer from SSM)";
  } catch (error) {
    return `(journal unavailable: ${error instanceof Error ? error.message : String(error)})`;
  } finally {
    rmSync(parameters, { force: true });
  }
};

interface RunOutcome {
  readonly run: RunMade;
  readonly secondsToReady: number;
  readonly setupSeconds: number;
}

/** One run of the fixture: a pending remote run, its root, the dispatch, `ready`, the setup time. */
const runOnce = async (
  name: string,
  baseSha: string,
  planHashValue: string,
  planDocument: unknown,
): Promise<RunOutcome> => {
  const runId = runs.length === 0 ? f.scope.runId : ids.next("run");
  const rootNodeId = runs.length === 0 ? f.rootNodeId : ids.next("node");
  const run: RunMade = { runId, rootNodeId, path: `${programPath}/runs/${runId}` };
  runs.push(run);
  const fixtures: Fixtures = { ids, scope: { ...f.scope, runId }, rootNodeId };

  expectStatus(
    await api.put(run.path, makeRun(fixtures, { status: "pending", location: "remote" })),
    201,
  );
  expectStatus(
    await api.put(
      `${run.path}/nodes/${rootNodeId}`,
      makeRootNode(fixtures, {
        status: "validated",
        plan: { planHash: planHashValue, planDocument },
      }),
    ),
    201,
  );
  const dispatchedAt = Date.now();
  const dispatched = await api.post(`${run.path}/dispatch`, {
    tier: "good",
    idempotencyKey: `${runId}:${baseSha}:${planHashValue}`,
    input: {
      repositoryUrl: FIXTURE_REPOSITORY,
      branch: FIXTURE_BRANCH,
      baseSha,
      planHash: planHashValue,
    },
  });
  expectStatus(dispatched, 201);
  run.dispatch = DispatchSchema.parse(dispatched.body);
  say(
    `${name}: dispatch ${run.dispatch.status} on ${run.dispatch.tier} (${run.dispatch.instanceType})`,
  );

  const provisioned = await awaitDispatch(
    run,
    "a machine",
    5 * 60_000,
    (d) => d.instanceId !== undefined,
  );
  say(
    `${name}: machine ${provisioned.instanceId} in ${provisioned.availabilityZone}, volume ${provisioned.volumeId}, image ${provisioned.amiVersion}`,
  );
  let ready: Dispatch;
  try {
    ready = await awaitDispatch(
      run,
      "ready",
      12 * 60_000,
      (d) => d.status === "ready" || d.status === "running",
    );
  } catch (error) {
    if (provisioned.instanceId !== undefined) {
      say(`${name}: the runner's journal:\n${await journal(provisioned.instanceId)}`);
    }
    throw error;
  }
  const secondsToReady = Math.round((Date.now() - dispatchedAt) / 1000);
  const utilization = ComputeUtilizationSchema.parse((await api.get(`${run.path}/compute`)).body);
  expect(utilization.setupSeconds, "the runner reported no setup time").toBeDefined();
  const lockfiles = Object.keys(ready.lockfileHashes ?? {}).join(", ") || "none";
  say(
    `${name}: ready ${secondsToReady}s after the dispatch; setup took ${utilization.setupSeconds?.toFixed(1)}s; lockfiles ${lockfiles}`,
  );
  if (ready.instanceId !== undefined) {
    const lines = (await journal(ready.instanceId))
      .split("\n")
      .filter((line) => line.trim() !== "");
    say(`${name}: the runner said:\n  ${lines.slice(-25).join("\n  ")}`);
  }
  return { run, secondsToReady, setupSeconds: utilization.setupSeconds ?? Number.NaN };
};

/** Cancel, hear `stopped` from the runner, then watch the reconciler clean up and snapshot. */
const stopAndCleanUp = async (name: string, run: RunMade): Promise<Dispatch> => {
  expectStatus(await api.post(`${run.path}/dispatch/cancel`, undefined), 200);
  await awaitDispatch(run, "stopped", 3 * 60_000, (d) => d.status === "stopped");
  say(`${name}: stopped as told; waiting for the reconciler's snapshot and cleanup`);
  const cleaned = await awaitDispatch(run, "cleanup", 20 * 60_000, (d) => d.cleanup.volumeDeleted);
  const failures =
    cleaned.cleanup.failures.length === 0
      ? ""
      : `; failures ${JSON.stringify(cleaned.cleanup.failures)}`;
  say(`${name}: cleaned up; snapshot ${cleaned.cleanup.snapshotId ?? "none"}${failures}`);
  return cleaned;
};

describe("two runs of the fixture, cold then warm (P10, T3, SC-P10-08)", () => {
  it("dispatches through the API, reaches ready on both, and the second is provisioned from the first's snapshot", async () => {
    const baseSha = remoteHead();
    say(`${FIXTURE_REPOSITORY} ${FIXTURE_BRANCH} is at ${baseSha}`);

    // The org, its one member (the machine principal this suite calls as), and
    // its GitHub installation, recorded as `org github install` records it.
    await stores.memberships.put({
      schemaVersion: 1,
      userId: machineSubject,
      orgId,
      createdAt: nowIso(systemClock),
    });
    expectStatus(
      await api.put(projectPath, { ...makeProject(f, { orgId, name: label }), orgId: undefined }),
      201,
    );
    const recorded = await api.put(`/orgs/${orgId}/github`, { installationId: INSTALLATION_ID });
    expectStatus(recorded, 200);
    say(`installation ${INSTALLATION_ID} recorded: ${JSON.stringify(recorded.body)}`);

    // A planned program against the fixture, its document uploaded and ratified (D-P10-09).
    const plan = `# ${label}\n\n## Strands\n\n### S-01 The only strand\n\nA module exists.\n`;
    const contract = makeProgramContract(f, {
      status: "planning",
      repository: { url: FIXTURE_REPOSITORY, baseBranch: "main", programBranch: FIXTURE_BRANCH },
      setup: [{ id: "install", command: "npm ci --prefer-offline" }],
      strands: [
        {
          id: "S-01",
          name: "The only strand",
          scope: { summary: "the source tree", includes: ["src/**"], excludes: [] },
          acceptance: ["its tests pass"],
          successCriteria: ["SC-01"],
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });
    expectStatus(await api.put(programPath, contract), 201);
    const hash = planHash(contract, plan, sha256Hex);
    const signed = await api.post(`${programPath}/plan-documents/${hash.plan}/upload-url`, {
      sizeBytes: Buffer.byteLength(plan),
    });
    expectStatus(signed, 200);
    const target = PlanDocumentUploadResponseSchema.parse(signed.body);
    const uploaded = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": target.contentType,
        "content-length": String(Buffer.byteLength(plan)),
      },
      body: plan,
    });
    expect(uploaded.status, await uploaded.text()).toBe(200);
    const ratified = await api.post(`${programPath}/ratifications`, {
      contract,
      planHash: hash.hash,
      planSha256: hash.plan,
    });
    expectStatus(ratified, 200);
    const program = ProgramContractSchema.parse(ratified.body);
    if (program.planHash === undefined) throw new Error("ratification recorded no plan hash");

    // Cold: no warm cache yet, so the volume is empty and setup downloads everything.
    expect((await api.get(`${projectPath}/warm-cache`)).status).toBe(404);
    const cold = await runOnce("cold", baseSha, program.planHash, program.planDocument);
    findings.cold = { secondsToReady: cold.secondsToReady, setupSeconds: cold.setupSeconds };
    const coldCleaned = await stopAndCleanUp("cold", cold.run);
    expect(
      coldCleaned.cleanup.snapshotId,
      "no snapshot was taken of the cold volume",
    ).toBeDefined();
    const cache = WarmCacheSchema.parse((await api.get(`${projectPath}/warm-cache`)).body);
    expect(cache.current.snapshotId).toBe(coldCleaned.cleanup.snapshotId);
    expect(cache.current.fromRunId).toBe(cold.run.runId);
    say(`warm cache: ${cache.current.snapshotId} from ${cache.current.fromRunId}`);

    // Warm: provisioned from the snapshot; the mirror is fetched, the store answers npm.
    const warm = await runOnce("warm", baseSha, program.planHash, program.planDocument);
    findings.warm = { secondsToReady: warm.secondsToReady, setupSeconds: warm.setupSeconds };
    const ratio = warm.setupSeconds / cold.setupSeconds;
    findings.warmToColdSetupRatio = Number(ratio.toFixed(3));
    say(
      `setup cold ${cold.setupSeconds.toFixed(1)}s, warm ${warm.setupSeconds.toFixed(1)}s: ratio ${ratio.toFixed(3)} against SC-P10-08's ${WARM_RATIO_TARGET}`,
    );
    expect(warm.setupSeconds, "the warm setup was not faster than the cold one").toBeLessThan(
      cold.setupSeconds,
    );
    if (ratio >= WARM_RATIO_TARGET) {
      say("SC-P10-08 NOT MET at this ratio; the number is recorded in the findings for §15");
    }
    const warmCleaned = await stopAndCleanUp("warm", warm.run);
    expect(warmCleaned.cleanup.snapshotId).toBeDefined();
    const after = WarmCacheSchema.parse((await api.get(`${projectPath}/warm-cache`)).body);
    expect(after.current.fromRunId).toBe(warm.run.runId);
    expect(after.history.map((snapshot) => snapshot.snapshotId)).toContain(
      coldCleaned.cleanup.snapshotId,
    );
  });
});

afterAll(async () => {
  const problems: string[] = [];
  const step = (label: string, work: () => unknown) =>
    Promise.resolve()
      .then(work)
      .then(() => say(`cleanup: ${label}`))
      .catch((error: unknown) => {
        problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      });

  // Whatever the reconciler did not get to: machines, volumes, and every snapshot.
  const snapshots = new Set<string>();
  for (const run of runs) {
    const dispatch = run.dispatch;
    if (dispatch === undefined) continue;
    if (dispatch.cleanup.snapshotId !== undefined) snapshots.add(dispatch.cleanup.snapshotId);
    if (keep) {
      say(
        `--keep: leaving ${dispatch.instanceId ?? "no instance"} and ${dispatch.volumeId ?? "no volume"}`,
      );
      continue;
    }
    if (dispatch.instanceId !== undefined && dispatch.status !== "stopped") {
      const instanceId = dispatch.instanceId;
      await step(`terminate ${instanceId}`, () => {
        aws(["ec2", "terminate-instances", "--instance-ids", instanceId]);
        aws(["ec2", "wait", "instance-terminated", "--instance-ids", instanceId]);
      });
    }
    if (dispatch.volumeId !== undefined && !dispatch.cleanup.volumeDeleted) {
      const volumeId = dispatch.volumeId;
      await step(`delete ${volumeId}`, () => {
        aws(["ec2", "delete-volume", "--volume-id", volumeId]);
      });
    }
    for (const generation of [1, 2, 3]) {
      const name = `/nightshift/${stage}/dispatch/${run.runId}/${generation}`;
      try {
        aws(["ssm", "delete-parameter", "--name", name]);
        say(`cleanup: a first token was still in ${name}`);
      } catch {
        // Taken by the runner, which is the point.
      }
    }
  }
  const cache = await stores.warmCaches.get(f.scope.projectId, "arm64").catch(() => undefined);
  if (cache !== undefined) {
    for (const snapshot of [cache.current, ...cache.history]) snapshots.add(snapshot.snapshotId);
  }
  for (const snapshotId of snapshots) {
    if (keep) {
      say(`--keep: leaving ${snapshotId}`);
      continue;
    }
    await step(`delete ${snapshotId}`, () => {
      aws(["ec2", "delete-snapshot", "--snapshot-id", snapshotId]);
    });
  }

  await step("delete the records", () =>
    deletePartitions(clients.table, context.tableName, [
      // The org's partition: its project listing, config (with the installation), ledger.
      keys.orgProject(orgId, f.scope.projectId).PK,
      // The project's: the program, the utilization records, the warm cache.
      keys.project(f.scope.projectId).PK,
      ...runs.flatMap((run) => {
        const scope = { ...f.scope, runId: run.runId };
        return [
          keys.run(f.scope, run.runId).PK,
          keys.runRecord(scope, "NODE", run.rootNodeId).PK,
          keys.event(scope, run.rootNodeId).PK,
        ];
      }),
    ]),
  );
  await step("delete the membership", () =>
    clients.table.delete({
      TableName: context.tableName,
      Key: keys.membership(machineSubject, orgId),
    }),
  );
  await step("delete the plan document", () =>
    deleteObjectsUnder(
      new S3Client({ region: REGION }),
      context.bucketName,
      `plans/${f.scope.projectId}/`,
    ),
  );
  say(`findings ${JSON.stringify(findings)}`);
  if (problems.length > 0) {
    console.error(`cleanup problems:\n  ${problems.join("\n  ")}`);
    throw new Error("cleanup left something behind; see above");
  }
});
