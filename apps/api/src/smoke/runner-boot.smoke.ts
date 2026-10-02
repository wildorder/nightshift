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
 * With `NIGHTSHIFT_SMOKE_ANTHROPIC_KEY` set (T4), the key is sealed for the
 * throwaway org and the cold run is left to **run the program to its end**:
 * the root orchestrator starts on the machine, the fixture's program branch at
 * GitHub must then hold the dispatch's published head, and the runner stops on
 * its own. Without the key the cold run is cancelled at `ready`, as T3 did.
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
  type ProgramContract,
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
/** T4: an Anthropic API key or a Claude Code subscription token (`claude setup-token`) for the throwaway org. */
const ANTHROPIC_KEY = process.env.NIGHTSHIFT_SMOKE_ANTHROPIC_KEY;

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
/** The installation claim as it stood before the proof borrowed it; put back at the end. */
let previousClaim: Record<string, unknown> | undefined;
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
  /** The runner's journal said the volume was warm: the mirror was fetched, not cloned. */
  readonly warmVolume: boolean;
}

/** One run of the fixture: a pending remote run, its root, the dispatch, `ready`, the setup time. */
const runOnce = async (
  name: string,
  baseSha: string,
  program: ProgramContract,
): Promise<RunOutcome> => {
  const planHashValue = program.planHash;
  const planDocument = program.planDocument;
  if (planHashValue === undefined) throw new Error("the program is not ratified");
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
      // The root node's authority is the program's, exactly: a strand that
      // needs test/** is delegated from a node that holds it.
      makeRootNode(fixtures, {
        status: "validated",
        scope: program.scope,
        plan: { planHash: planHashValue, planDocument },
      }),
    ),
    201,
  );
  // The checkpoint `nightshift run` creates at the base, so decisions have a state to point at.
  const checkpointId = ids.next("ckpt");
  expectStatus(
    await api.put(`${run.path}/checkpoints/${checkpointId}`, {
      schemaVersion: 1,
      ...fixtures.scope,
      checkpointId,
      executionNodeId: rootNodeId,
      commitSha: baseSha,
      ref: `refs/nightshift/checkpoints/${checkpointId}`,
      label: "run started",
      createdAt: nowIso(systemClock),
    }),
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
  let warmVolume = false;
  if (ready.instanceId !== undefined) {
    const lines = (await journal(ready.instanceId))
      .split("\n")
      .filter((line) => line.trim() !== "");
    warmVolume = lines.some((line) => line.includes("warm volume: fetching the mirror"));
    say(`${name}: the runner said:\n  ${lines.slice(-25).join("\n  ")}`);
  }
  return {
    run,
    secondsToReady,
    setupSeconds: utilization.setupSeconds ?? Number.NaN,
    warmVolume,
  };
};

/** How long the root is given after `running` before the proof cancels it, with no key to run on. */
const ROOT_GRACE_MS = 60_000;

/**
 * Cancel, hear `stopped` from the runner, then watch the reconciler clean up
 * and snapshot. First the root is let start: `running` is the runner's own
 * report that it is starting the root, and a minute is enough for the journal
 * to show what a root with no provider key does.
 */
const stopAndCleanUp = async (name: string, run: RunMade): Promise<Dispatch> => {
  await awaitDispatch(run, "running", 3 * 60_000, (d) => d.status === "running").catch(
    (error: unknown) =>
      say(
        `${name}: the root did not report running: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  await sleep(ROOT_GRACE_MS);
  // The journal now, while the machine is certainly still there: what the
  // root did between `ready` and this cancel is the record T4 wants.
  if (run.dispatch?.instanceId !== undefined) {
    const lines = (await journal(run.dispatch.instanceId))
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.includes("COMMAND="));
    say(`${name}: the runner said after ready:\n  ${lines.slice(-30).join("\n  ")}`);
  }
  expectStatus(await api.post(`${run.path}/dispatch/cancel`, undefined), 200);
  await awaitDispatch(run, "stopped", 3 * 60_000, (d) => d.status === "stopped");
  say(`${name}: stopped as told; waiting for the reconciler's snapshot and cleanup`);
  const cleaned = await awaitDispatch(run, "cleanup", 20 * 60_000, (d) => d.cleanup.volumeDeleted);
  const failures =
    cleaned.cleanup.failures.length === 0
      ? ""
      : `; failures ${JSON.stringify(cleaned.cleanup.failures)}`;
  const snapshot = cleaned.cleanup.snapshotId ?? "none";
  say(`${name}: cleaned up; snapshot ${snapshot}${failures}`);
  return cleaned;
};

/**
 * T4: the root runs the program; the runner stops on its own when it ends; the
 * fixture's program branch at GitHub holds the published head (D-P10-22).
 */
const runToTheEnd = async (name: string, run: RunMade, baseSha: string): Promise<Dispatch> => {
  const startedAt = Date.now();
  const stopped = await awaitDispatch(
    run,
    "the run's end",
    40 * 60_000,
    (d) => d.status === "stopped",
  );
  findings.runSeconds = Math.round((Date.now() - startedAt) / 1000);
  const runSeconds = findings.runSeconds;
  say(`${name}: the runner stopped on its own after ${runSeconds} seconds`);
  if (stopped.instanceId !== undefined) {
    const lines = (await journal(stopped.instanceId))
      .split("\n")
      .filter((line) => line.trim() !== "");
    say(`${name}: the runner said:\n  ${lines.slice(-40).join("\n  ")}`);
  }
  const ended = DispatchSchema.parse((await api.get(`${run.path}/dispatch`)).body);
  say(`${name}: publication ${JSON.stringify(ended.publication)}`);
  // What the root did, from the record rather than the machine: every tool it
  // called and how each answered, and how the agent ended.
  const events = (await api.get(`${run.path}/events?limit=500`)).body as {
    items?: { type: string; payload?: Record<string, unknown> }[];
  };
  const told = (events.items ?? [])
    .filter((event) => /^(tool|agent|run|node)[.]/.test(event.type))
    .map((event) => `${event.type} ${JSON.stringify(event.payload ?? {}).slice(0, 300)}`);
  say(`${name}: the run's events (${told.length}):\n  ${told.slice(-60).join("\n  ")}`);
  const remote = remoteHead();
  findings.publication = {
    head: ended.publication.head,
    remote,
    blocked: ended.publication.blocked,
  };
  expect(ended.publication.blocked, "publication was blocked").toBeUndefined();
  expect(ended.publication.head, "nothing was published").toBeDefined();
  expect(remote).toBe(ended.publication.head);
  expect(remote).not.toBe(baseSha);
  const cleaned = await awaitDispatch(run, "cleanup", 20 * 60_000, (d) => d.cleanup.volumeDeleted);
  say(`${name}: cleaned up; snapshot ${cleaned.cleanup.snapshotId ?? "none"}`);
  return cleaned;
};

describe("two runs of the fixture, cold then warm (P10, T3, SC-P10-08)", () => {
  it("dispatches through the API, reaches ready on both, and the second is provisioned from the first's snapshot", async () => {
    const baseSha = remoteHead();
    (findings as { baseShaAtStart?: string }).baseShaAtStart = baseSha;
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
    // One installation is one customer's (D-P10-02), and the dev stage's one
    // installation is the owner's. The throwaway org borrows the claim for the
    // proof, directly in the table, and cleanup hands it back.
    const claimKey = keys.installationClaim(INSTALLATION_ID);
    previousClaim = (await clients.table.get({ TableName: context.tableName, Key: claimKey })).Item;
    const borrowed = await stores.installationClaims.claim(
      INSTALLATION_ID,
      orgId,
      nowIso(systemClock),
    );
    if (!borrowed.ok) {
      await clients.table.delete({ TableName: context.tableName, Key: claimKey });
      const again = await stores.installationClaims.claim(
        INSTALLATION_ID,
        orgId,
        nowIso(systemClock),
      );
      expect(again.ok).toBe(true);
    }
    const recorded = await api.put(`/orgs/${orgId}/github`, { installationId: INSTALLATION_ID });
    expectStatus(recorded, 200);
    say(`installation ${INSTALLATION_ID} recorded: ${JSON.stringify(recorded.body)}`);

    // A planned program against the fixture, its document uploaded and ratified (D-P10-09).
    const plan = [
      `# ${label}`,
      "",
      "## Strands",
      "",
      "### S-01 A median helper",
      "",
      "Add `median(values)` to `src/math.js`, exported from `src/index.js`, returning the middle",
      "value of an odd-length list and the mean of the two middle values of an even-length one,",
      "throwing `RangeError` on an empty list. Cover it in `test/math.test.js`. Change nothing else.",
      "",
    ].join("\n");
    const contract = makeProgramContract(f, {
      status: "planning",
      repository: { url: FIXTURE_REPOSITORY, baseBranch: "main", programBranch: FIXTURE_BRANCH },
      setup: [{ id: "install", command: "npm ci --prefer-offline" }],
      verification: [{ id: "test", command: "npm test" }],
      scope: {
        // The root node the proof makes carries the fixture scope; the program
        // may only be at least as wide and forbid exactly what the node does.
        includes: ["src/**", "test/**"],
        excludes: ["src/generated/**"],
        permissions: ["fs.read", "fs.write", "shell.exec"],
        forbiddenActions: ["deploy to production"],
      },
      strands: [
        {
          id: "S-01",
          name: "A median helper",
          scope: {
            summary: "the math module and its tests",
            includes: ["src/**", "test/**"],
            excludes: [],
          },
          acceptance: ["median is exported and its tests pass alongside the existing ones"],
          successCriteria: ["SC-01"],
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });
    expectStatus(await api.put(programPath, contract), 201);
    if (ANTHROPIC_KEY !== undefined) {
      // Sealed for this org as `org providers set` seals it (D-P10-23); never printed.
      expectStatus(
        await api.put(`/orgs/${orgId}/credentials/anthropic`, { key: ANTHROPIC_KEY }),
        200,
      );
      say("an Anthropic key is sealed for the org: the cold run will run the program to its end");
    }
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
    const cold = await runOnce("cold", baseSha, program);
    findings.cold = { secondsToReady: cold.secondsToReady, setupSeconds: cold.setupSeconds };
    const coldCleaned =
      ANTHROPIC_KEY === undefined
        ? await stopAndCleanUp("cold", cold.run)
        : await runToTheEnd("cold", cold.run, baseSha);
    expect(
      coldCleaned.cleanup.snapshotId,
      "no snapshot was taken of the cold volume",
    ).toBeDefined();
    const cache = WarmCacheSchema.parse((await api.get(`${projectPath}/warm-cache`)).body);
    expect(cache.current.snapshotId).toBe(coldCleaned.cleanup.snapshotId);
    expect(cache.current.fromRunId).toBe(cold.run.runId);
    say(`warm cache: ${cache.current.snapshotId} from ${cache.current.fromRunId}`);

    // Warm: provisioned from the snapshot; the mirror is fetched, the store answers npm.
    const warm = await runOnce("warm", baseSha, program);
    findings.warm = {
      secondsToReady: warm.secondsToReady,
      setupSeconds: warm.setupSeconds,
      warmVolume: warm.warmVolume,
    };
    const ratio = warm.setupSeconds / cold.setupSeconds;
    findings.warmToColdSetupRatio = Number(ratio.toFixed(3));
    say(
      `setup cold ${cold.setupSeconds.toFixed(1)}s, warm ${warm.setupSeconds.toFixed(1)}s: ratio ${ratio.toFixed(3)} against SC-P10-08's ${WARM_RATIO_TARGET}`,
    );
    // SC-P10-08 as restated with D-P10-24: the second run came up on the
    // project's snapshot and fetched the mirror rather than cloning it. The
    // install's duration is reported, not asserted: it is the same `npm ci`
    // on both, and the seed saves its work in the worktrees, not here.
    expect(warm.warmVolume, "the warm run did not come up on the project's snapshot").toBe(true);
    if (ratio >= WARM_RATIO_TARGET) {
      say(`setup ratio ${ratio.toFixed(2)}: npm ci re-extracts regardless, as D-P10-24 records`);
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
    // A machine the reconciler has not yet taken, whatever the status: the
    // records go next, and after that nothing would ever terminate it.
    if (dispatch.instanceId !== undefined && !dispatch.cleanup.volumeDeleted) {
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

  if (findings.publication !== undefined && !keep) {
    const before = (findings as { baseShaAtStart?: string }).baseShaAtStart;
    if (before !== undefined) {
      await step(`reset ${FIXTURE_BRANCH} to ${before.slice(0, 12)}`, () => {
        execFileSync("git", [
          "push",
          "-q",
          "-f",
          FIXTURE_REPOSITORY,
          `${before}:refs/heads/${FIXTURE_BRANCH}`,
        ]);
      });
    }
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
  await step("hand the installation claim back", async () => {
    const claimKey = keys.installationClaim(INSTALLATION_ID);
    if (previousClaim === undefined) {
      await clients.table.delete({ TableName: context.tableName, Key: claimKey });
    } else {
      await clients.table.put({ TableName: context.tableName, Item: previousClaim });
    }
  });
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
