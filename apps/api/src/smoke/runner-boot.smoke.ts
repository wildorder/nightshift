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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import {
  COMPUTE_TIERS,
  ComputeUtilizationSchema,
  type Dispatch,
  DispatchSchema,
  type DispatchWorkspace,
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
  makeDispatch,
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

/**
 * Heavy benchmark: the program runs against the nightshift monorepo itself
 * (`program/bench`, pushed by hand from the branch under test), whose
 * verification is the real typecheck and test suite, minutes not seconds.
 * The same installation grants it. Needs the bench types and the key.
 */
const HEAVY = process.env.NIGHTSHIFT_SMOKE_BENCH_HEAVY === "1";
/** The fixture repository and the installation that grants it (H-P10-04, H-P10-05). */
const FIXTURE_REPOSITORY = HEAVY
  ? "https://github.com/wildorder/nightshift"
  : "https://github.com/wildorder/nightshift-remote-fixture";
const FIXTURE_BRANCH = HEAVY ? "program/bench" : "program/fixture";
const INSTALLATION_ID = 166952409;
/** A heavy run is tens of minutes of real verification; a light one, a few. */
const RUN_END_TIMEOUT_MS = (HEAVY ? 120 : 40) * 60_000;
/**
 * The fault (T6): with `NIGHTSHIFT_SMOKE_BENCH_KILL=1`, the machine is
 * terminated behind the runner's back two minutes into `running`. The lease
 * lapses, the reconciler replaces the machine on the same volume at the next
 * generation, the runner restores the sidecar's copy, and the run must still
 * end published; the record must show both attempts.
 */
const KILL = process.env.NIGHTSHIFT_SMOKE_BENCH_KILL === "1";
const KILL_AFTER_RUNNING_MS =
  (Number.parseInt(process.env.NIGHTSHIFT_SMOKE_KILL_AFTER_SECONDS ?? "", 10) || 120) * 1000;
/** SC-P10-08: the warm setup against the cold one. Printed always, asserted softly. */
const WARM_RATIO_TARGET = 0.1;
/** T4: an Anthropic API key or a Claude Code subscription token (`claude setup-token`) for the throwaway org. */
const ANTHROPIC_KEY = process.env.NIGHTSHIFT_SMOKE_ANTHROPIC_KEY;
/**
 * A Codex login file (`~/.codex/auth.json`) to seal as the org's `openai`
 * credential. With it, the program's examination policy requires an examiner
 * from another provider at every risk, so each job is examined by Codex
 * running as a worker user: the path FoodFly's first three runs died on
 * (2026-10-05) and no proof had walked.
 */
const OPENAI_AUTH_FILE = process.env.NIGHTSHIFT_SMOKE_OPENAI_AUTH_FILE;
const EXAMINED_BY_CODEX = OPENAI_AUTH_FILE !== undefined;
const strict = {
  required: true,
  mustDifferModel: true,
  mustDifferProvider: true,
  blockOnMaterialFindings: true,
};
/**
 * Benchmark mode: a comma-separated list of EC2 instance types. Each gets one
 * cold run of the program to its end, dispatched straight to the dispatch
 * Lambda with that type on the record, and a table of how long every phase
 * took, from the records and the machine's journal. Needs the key.
 */
const BENCH_TYPES = (process.env.NIGHTSHIFT_SMOKE_BENCH_TYPES ?? "")
  .split(",")
  .map((type) => type.trim())
  .filter((type) => type !== "");
/**
 * Where the benchmark puts the workspace: `default` (what the runner does
 * unasked: the local disk with the sidecar, D-P10-27), `volume` (gp3
 * baseline), `volume-max` (gp3 at 16,000 IOPS and 1,000 MiB/s), or `local`.
 * The dispatch record carries it; the runner obeys it.
 */
const BENCH_WORKSPACE_NAME = process.env.NIGHTSHIFT_SMOKE_BENCH_WORKSPACE ?? "default";
const BENCH_WORKSPACE: DispatchWorkspace | undefined =
  BENCH_WORKSPACE_NAME === "volume-max"
    ? { disk: "volume", iops: 16_000, throughputMiBps: 1_000 }
    : BENCH_WORKSPACE_NAME === "volume"
      ? { disk: "volume" }
      : BENCH_WORKSPACE_NAME === "local"
        ? { disk: "local" }
        : undefined;

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
const api = smokeApiClient(endpoint, token, () => fetchMachineToken(context));

const JOURNAL = "journalctl -u nightshift-runner --no-pager";

/**
 * The runner's own journal, for the record and for the failures: its own lines
 * and sudo's first lines, without sudo's command text, the last `tail` of them.
 * A `grep` keeps only matching lines, on the machine, before the tail.
 */
const journal = async (
  instanceId: string,
  options: { format?: "cat" | "short-iso-precise"; grep?: string; tail?: number } = {},
): Promise<string> => {
  const keep =
    options.grep === undefined
      ? "grep -v 'COMMAND=' | grep -v 'command continued'"
      : `grep -E '${options.grep}'`;
  return onMachine(
    instanceId,
    `${JOURNAL} -o ${options.format ?? "cat"} | ${keep} | tail -n ${options.tail ?? 150}`,
  );
};

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

/**
 * A command on the machine over SSM, its standard output back. SSM returns at
 * most 24,000 characters of it, so anything long is filtered on the machine.
 */
const onMachine = async (instanceId: string, command: string): Promise<string> => {
  const parameters = join(tmpdir(), `nightshift-runner-boot-${process.pid}.json`);
  writeFileSync(parameters, JSON.stringify({ commands: [command], executionTimeout: ["60"] }));
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
    return `(unavailable: ${error instanceof Error ? error.message : String(error)})`;
  } finally {
    rmSync(parameters, { force: true });
  }
};

/** The runner stack's outputs: the dispatch function to invoke directly, the image version. */
const runnerOutputs = (): Record<string, string> => {
  const described = JSON.parse(
    aws([
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      `nightshift-${stage}-runner`,
      "--query",
      "Stacks[0].Outputs",
    ]),
  ) as { OutputKey: string; OutputValue: string }[];
  return Object.fromEntries(described.map((output) => [output.OutputKey, output.OutputValue]));
};

/** The fixture branch back at `sha`, from a scratch clone that holds the object. */
const resetFixtureBranch = (sha: string): void => {
  const scratch = mkdtempSync(join(tmpdir(), "nightshift-fixture-reset-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    execFileSync("git", ["fetch", "-q", FIXTURE_REPOSITORY, FIXTURE_BRANCH], { cwd: scratch });
    execFileSync(
      "git",
      ["push", "-q", "-f", FIXTURE_REPOSITORY, `${sha}:refs/heads/${FIXTURE_BRANCH}`],
      {
        cwd: scratch,
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** When the proof saw each state, for the phase table; polling is every ten seconds. */
interface Marks {
  killedAt?: number;
  dispatchedAt: number;
  machineAt?: number;
  readyAt?: number;
  stoppedAt?: number;
}

interface RunOutcome {
  readonly run: RunMade;
  readonly secondsToReady: number;
  readonly setupSeconds: number;
  /** The runner's journal said the volume was warm: the mirror was fetched, not cloned. */
  readonly warmVolume: boolean;
  readonly marks: Marks;
}

/** One run of the fixture: a pending remote run, its root, the dispatch, `ready`, the setup time. */
const runOnce = async (
  name: string,
  baseSha: string,
  program: ProgramContract,
  bench?: { readonly instanceType: string; readonly outputs: Record<string, string> },
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
  const marks: Marks = { dispatchedAt };
  if (bench === undefined) {
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
  } else {
    // The benchmark names the machine: the record is written with that type
    // and the dispatch Lambda is invoked as the API would invoke it.
    const now = nowIso(systemClock);
    const record = makeDispatch(fixtures, {
      status: "requested",
      tier: "good",
      instanceType: bench.instanceType,
      usdPerHour: COMPUTE_TIERS.good.usdPerHour,
      ...(BENCH_WORKSPACE === undefined ? {} : { workspace: BENCH_WORKSPACE }),
      amiVersion: bench.outputs.ImageVersion ?? "0.0.0",
      idempotencyKey: `${runId}:${baseSha}:${planHashValue}:${bench.instanceType}`,
      engineAgentId: ids.next("agent"),
      input: {
        repositoryUrl: FIXTURE_REPOSITORY,
        branch: FIXTURE_BRANCH,
        baseSha,
        planHash: planHashValue,
      },
      attempts: [{ generation: 1, reason: "dispatch", startedAt: now }],
      spend: { estimatedUsd: 1, meteredUsd: 0, meteredSeconds: 0 },
      requestedAt: now,
      updatedAt: now,
    });
    await stores.dispatches.put(record);
    run.dispatch = record;
    const payload = join(tmpdir(), `nightshift-bench-${process.pid}.json`);
    writeFileSync(payload, JSON.stringify(fixtures.scope));
    const fn = bench.outputs.DispatchFunctionName;
    if (fn === undefined) throw new Error("the runner stack has no DispatchFunctionName output");
    aws([
      "lambda",
      "invoke",
      "--function-name",
      fn,
      "--invocation-type",
      "Event",
      "--cli-binary-format",
      "raw-in-base64-out",
      "--payload",
      `file://${payload.replaceAll("\\", "/")}`,
      join(tmpdir(), `nightshift-bench-${process.pid}-out.json`),
    ]);
    rmSync(payload, { force: true });
  }
  say(
    `${name}: dispatch ${run.dispatch.status} on ${run.dispatch.tier} (${run.dispatch.instanceType})`,
  );

  const provisioned = await awaitDispatch(
    run,
    "a machine",
    5 * 60_000,
    (d) => d.instanceId !== undefined,
  );
  marks.machineAt = Date.now();
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
  marks.readyAt = Date.now();
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
    marks,
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

/** Seconds between two instants, one decimal, or a dash. */
const seconds = (from: number | undefined, to: number | undefined): string =>
  from === undefined || to === undefined || Number.isNaN(from) || Number.isNaN(to)
    ? "-"
    : ((to - from) / 1000).toFixed(1);

/**
 * Where every second went, from the records and the machine: the instance's
 * launch time, the runner's journal (with timestamps), the run's events and
 * the publication intent. The proof's own observations are to ten seconds.
 */
const phaseTable = async (
  name: string,
  run: RunMade,
  outcome: RunOutcome,
  ended: Dispatch,
): Promise<Record<string, string>> => {
  const instanceId = ended.instanceId;
  let launchedAt: number | undefined;
  let journalAt: Record<string, number> = {};
  if (instanceId !== undefined) {
    try {
      const described = JSON.parse(
        aws([
          "ec2",
          "describe-instances",
          "--instance-ids",
          instanceId,
          "--query",
          "Reservations[0].Instances[0].LaunchTime",
        ]),
      ) as string;
      launchedAt = Date.parse(described);
    } catch {
      // Gone already; the boot phase is then unknown.
    }
    const lines = (
      await journal(instanceId, {
        format: "short-iso-precise",
        grep: "nightshift-runner\\]|Started nightshift-runner|sidecar",
        tail: 400,
      })
    ).split("\n");
    const at = (needle: string): number | undefined => {
      const line = lines.find((candidate) => candidate.includes(needle));
      const stamp = line?.split(" ")[0];
      return stamp === undefined ? undefined : Date.parse(stamp);
    };
    journalAt = Object.fromEntries(
      Object.entries({
        runnerStart: at("generation 1, on"),
        mounted: at("workspace mounted"),
        setupStart: at("setup install:"),
        setupDone: at("setup took"),
        rootStart: at("root starting"),
        rootDone: at("the worker process completed"),
      }).filter(([, value]) => value !== undefined) as [string, number][],
    );
  }
  const events = (await api.get(`${run.path}/events?limit=500`)).body as {
    items?: { type: string; occurredAt?: string; payload?: Record<string, unknown> }[];
  };
  const items = events.items ?? [];
  const first = (type: string): number | undefined => {
    const found = items.find((event) => event.type === type && event.occurredAt !== undefined);
    return found?.occurredAt === undefined ? undefined : Date.parse(found.occurredAt);
  };
  const published = ended.publication.intents.find((intent) => intent.status === "published");
  const publishedAt =
    published?.resolvedAt === undefined ? undefined : Date.parse(published.resolvedAt);
  const m = outcome.marks;
  const rows: [string, string][] = [
    ["dispatch accepted → machine recorded (observed)", seconds(m.dispatchedAt, m.machineAt)],
    ["instance launch → runner process up (boot)", seconds(launchedAt, journalAt.runnerStart)],
    ["runner up → volume mounted", seconds(journalAt.runnerStart, journalAt.mounted)],
    ["mounted → clone done, setup starting", seconds(journalAt.mounted, journalAt.setupStart)],
    ["setup (npm ci)", outcome.setupSeconds.toFixed(1)],
    [
      "setup done → root starting (credentials wait)",
      seconds(journalAt.setupDone, journalAt.rootStart),
    ],
    ["dispatch accepted → ready (observed)", seconds(m.dispatchedAt, m.readyAt)],
    ["root starting → root agent up", seconds(journalAt.rootStart, first("agent.started"))],
    ["root agent up → strand delegated", seconds(first("agent.started"), first("node.delegated"))],
    [
      "delegated → worker started (worktree, seed)",
      seconds(first("node.delegated"), first("node.started")),
    ],
    ["worker started → implemented", seconds(first("node.started"), first("node.implemented"))],
    [
      "implemented → verification completed",
      seconds(first("node.implemented"), first("verification.completed")),
    ],
    [
      "implemented → examination completed",
      seconds(first("node.implemented"), first("examination.completed")),
    ],
    ["implemented → integrated", seconds(first("node.implemented"), first("node.integrated"))],
    ["integrated → published at GitHub", seconds(first("node.integrated"), publishedAt)],
    [
      "integrated → run finished by the root",
      seconds(first("node.integrated"), first("run.completed") ?? first("run.failed")),
    ],
    [
      "run finished → runner stopped (observed)",
      seconds(first("run.completed") ?? first("run.failed"), m.stoppedAt),
    ],
    ["total: dispatch accepted → runner stopped (observed)", seconds(m.dispatchedAt, m.stoppedAt)],
  ];
  say(
    `${name}: phases\n  ${rows.map(([phase, value]) => `${value.padStart(7)} s  ${phase}`).join("\n  ")}`,
  );
  return Object.fromEntries(rows);
};

/**
 * T4: the root runs the program; the runner stops on its own when it ends; the
 * fixture's program branch at GitHub holds the published head (D-P10-22).
 */
const runToTheEnd = async (
  name: string,
  run: RunMade,
  baseSha: string,
  outcome?: RunOutcome,
  fault: boolean = KILL,
): Promise<Dispatch> => {
  const startedAt = Date.now();
  if (fault) {
    const running = await awaitDispatch(run, "running", 20 * 60_000, (d) => d.status === "running");
    await sleep(KILL_AFTER_RUNNING_MS);
    const victim = running.instanceId;
    if (victim === undefined) throw new Error("the running dispatch names no machine to kill");
    aws(["ec2", "terminate-instances", "--instance-ids", victim]);
    say(`${name}: FAULT: terminated ${victim} behind the runner's back; the lease will lapse`);
    if (outcome !== undefined) outcome.marks.killedAt = Date.now();
    const replaced = await awaitDispatch(
      run,
      "a replacement machine",
      15 * 60_000,
      (d) => d.generation >= 2 && d.instanceId !== undefined && d.instanceId !== victim,
    );
    say(
      `${name}: replaced by ${replaced.instanceId} at generation ${replaced.generation}, ${Math.round((Date.now() - (outcome?.marks.killedAt ?? Date.now())) / 1000)}s after the kill`,
    );
  }
  const stopped = await awaitDispatch(
    run,
    "the run's end",
    RUN_END_TIMEOUT_MS,
    (d) => d.status === "stopped",
  );
  if (fault) {
    expect(
      stopped.generation,
      "the run did not move to a second generation",
    ).toBeGreaterThanOrEqual(2);
    expect(stopped.attempts.map((a) => a.reason)).toEqual(
      expect.arrayContaining(["dispatch", "lease_lost"]),
    );
  }
  if (outcome !== undefined) outcome.marks.stoppedAt = Date.now();
  findings.runSeconds = Math.round((Date.now() - startedAt) / 1000);
  const runSeconds = findings.runSeconds;
  say(`${name}: the runner stopped on its own after ${runSeconds} seconds`);
  if (stopped.instanceId !== undefined) {
    const lines = (await journal(stopped.instanceId))
      .split("\n")
      .filter((line) => line.trim() !== "");
    // D-P10-25: every job's agent ran as a worker user. Each agent's start
    // event says which user it ran as; the record, not the machine.
    const startedEvents = (await api.get(`${run.path}/events?limit=500`)).body as {
      items?: { type: string; payload?: { user?: string } }[];
    };
    const asWorkers = (startedEvents.items ?? []).filter(
      (event) => event.type === "agent.started" && /^worker-\d+$/.test(event.payload?.user ?? ""),
    ).length;
    findings.processesAsWorkers = asWorkers;
    say(`${name}: ${asWorkers} processes started as worker users`);
    expect(asWorkers, "no process ran as a worker user").toBeGreaterThan(0);
    say(
      `${name}: the runner said:\n  ${lines
        .filter((line) => !line.includes("COMMAND="))
        .slice(-40)
        .join("\n  ")}`,
    );
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
  if (EXAMINED_BY_CODEX) {
    // The examiner ran as a worker user and gave a verdict: its agent completed,
    // and an examination completed, rather than the agent failing at start.
    const examiners = (events.items ?? []).filter(
      (event) =>
        event.type === "agent.created" &&
        (event.payload as { role?: string; harness?: string } | undefined)?.role === "examiner",
    );
    const examinerHarnesses = examiners.map(
      (event) => (event.payload as { harness?: string } | undefined)?.harness,
    );
    const examined = (events.items ?? []).filter((event) => event.type === "examination.completed");
    const examinerFailures = (events.items ?? []).filter(
      (event) =>
        event.type === "agent.failed" &&
        /PATH aliases|CODEX_HOME|Permission denied/.test(JSON.stringify(event.payload ?? {})),
    );
    say(
      `${name}: ${examiners.length} examiner(s) (${examinerHarnesses.join(", ")}), ${examined.length} examination(s) completed, ${examinerFailures.length} died at start`,
    );
    expect(examinerHarnesses, "no examination was routed to Codex").toContain("codex");
    expect(examinerFailures, "a Codex examiner died at start").toHaveLength(0);
    expect(examined.length, "no examination completed").toBeGreaterThan(0);
  }
  const remote = remoteHead();
  findings.publication = {
    head: ended.publication.head,
    remote,
    blocked: ended.publication.blocked,
  };
  // The phases first: a run that failed still timed its machine.
  if (outcome !== undefined) {
    const phases = (findings.phases as Record<string, unknown> | undefined) ?? {};
    phases[name] = await phaseTable(name, run, outcome, ended);
    findings.phases = phases;
  }
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
    // The heavy program's change is trivial on purpose: a docs file, so that
    // what the benchmark times is the machine running the monorepo's own
    // install, typecheck and test suite, not an agent's luck with a task.
    const strand = HEAVY
      ? {
          heading: "### S-01 A benchmark note",
          lines: [
            "Create `docs/benchmarks/remote-runner.md` containing one heading and one short paragraph",
            "saying this file was written by a remote runner benchmark. Change nothing else; do not",
            "edit any other file.",
          ],
          name: "A benchmark note",
          summary: "one new file under docs/benchmarks",
          includes: ["docs/**"],
          acceptance: ["docs/benchmarks/remote-runner.md exists and the repository's checks pass"],
        }
      : {
          heading: "### S-01 A median helper",
          lines: [
            "Add `median(values)` to `src/math.js`, exported from `src/index.js`, returning the middle",
            "value of an odd-length list and the mean of the two middle values of an even-length one,",
            "throwing `RangeError` on an empty list. Cover it in `test/math.test.js`. Change nothing else.",
          ],
          name: "A median helper",
          summary: "the math module and its tests",
          includes: ["src/**", "test/**"],
          acceptance: ["median is exported and its tests pass alongside the existing ones"],
        };
    const plan = [`# ${label}`, "", "## Strands", "", strand.heading, "", ...strand.lines, ""].join(
      "\n",
    );
    const contract = makeProgramContract(f, {
      status: "planning",
      ...(EXAMINED_BY_CODEX
        ? { examinationPolicy: { low: strict, medium: strict, high: strict } }
        : {}),
      repository: { url: FIXTURE_REPOSITORY, baseBranch: "main", programBranch: FIXTURE_BRANCH },
      // The monorepo's typecheck resolves workspaces through their dist, so
      // its setup builds. Its local end-to-end test starts a nightshift inside
      // this one and inherits the runner's environment, so it is left out.
      setup: HEAVY
        ? [
            { id: "install", command: "npm ci --prefer-offline" },
            { id: "build", command: "npm run build" },
          ]
        : [{ id: "install", command: "npm ci --prefer-offline" }],
      verification: HEAVY
        ? [
            { id: "typecheck", command: "npm run typecheck" },
            { id: "test", command: "npx vitest run --exclude '**/src/local/**'" },
          ]
        : [{ id: "test", command: "npm test" }],
      scope: {
        // The root node the proof makes carries the fixture scope; the program
        // may only be at least as wide and forbid exactly what the node does.
        includes: strand.includes,
        excludes: HEAVY ? [] : ["src/generated/**"],
        permissions: ["fs.read", "fs.write", "shell.exec"],
        forbiddenActions: ["deploy to production"],
      },
      strands: [
        {
          id: "S-01",
          name: strand.name,
          scope: { summary: strand.summary, includes: strand.includes, excludes: [] },
          acceptance: strand.acceptance,
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
    if (OPENAI_AUTH_FILE !== undefined) {
      const login = readFileSync(OPENAI_AUTH_FILE, "utf8").trim();
      expectStatus(await api.put(`/orgs/${orgId}/credentials/openai`, { key: login }), 200);
      say(
        "a Codex login is sealed for the org: every job is examined by Codex, as another provider",
      );
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

    if (BENCH_TYPES.length > 0) {
      if (ANTHROPIC_KEY === undefined)
        throw new Error("the benchmark needs the key: the program must run");
      const outputs = runnerOutputs();
      say(
        `benchmark on ${BENCH_TYPES.join(", ")} (image ${outputs.ImageVersion}, ${HEAVY ? "heavy: the monorepo" : "the fixture"})`,
      );
      for (const [index, instanceType] of BENCH_TYPES.entries()) {
        if (index > 0) {
          resetFixtureBranch(baseSha);
          say(`${FIXTURE_BRANCH} reset to ${baseSha.slice(0, 12)} for the next type`);
        }
        const name = `${instanceType} ${BENCH_WORKSPACE_NAME}`;
        const outcome = await runOnce(name, baseSha, program, { instanceType, outputs });
        await runToTheEnd(name, outcome.run, baseSha, outcome);
      }
      return;
    }

    // Cold: no warm cache yet, so the volume is empty and setup downloads everything.
    expect((await api.get(`${projectPath}/warm-cache`)).status).toBe(404);
    const cold = await runOnce("cold", baseSha, program);
    findings.cold = { secondsToReady: cold.secondsToReady, setupSeconds: cold.setupSeconds };
    // The walk-away fixture (`npm run remote`): the cold run is also the one
    // whose machine is killed, and it must still end published (T6, T8).
    const coldCleaned =
      ANTHROPIC_KEY === undefined
        ? await stopAndCleanUp("cold", cold.run)
        : await runToTheEnd("cold", cold.run, baseSha, cold, KILL);
    expect(
      coldCleaned.cleanup.snapshotId,
      "no snapshot was taken of the cold volume",
    ).toBeDefined();
    const cache = WarmCacheSchema.parse((await api.get(`${projectPath}/warm-cache`)).body);
    expect(cache.current.snapshotId).toBe(coldCleaned.cleanup.snapshotId);
    expect(cache.current.fromRunId).toBe(cold.run.runId);
    say(`warm cache: ${cache.current.snapshotId} from ${cache.current.fromRunId}`);

    // Warm: provisioned from the snapshot; the mirror is fetched, the store answers npm.
    // After a published run the branch has moved; the warm run dispatches what
    // is at GitHub now, as a customer's second `nightshift run --remote` would.
    const warm = await runOnce("warm", remoteHead(), program);
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
  for (const architecture of ["arm64", "x86_64"] as const) {
    const cache = await stores.warmCaches
      .get(f.scope.projectId, architecture)
      .catch(() => undefined);
    if (cache !== undefined) {
      for (const snapshot of [cache.current, ...cache.history]) snapshots.add(snapshot.snapshotId);
    }
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
      await step(`reset ${FIXTURE_BRANCH} to ${before.slice(0, 12)}`, () =>
        resetFixtureBranch(before),
      );
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
  // The org's sealed provider key lives in the credentials table (D-P10-23),
  // which the main table's partitions never reach; left behind, every run of
  // this proof would keep a sealed copy of the owner's token under a dead org.
  await step("delete the org's sealed credentials", () =>
    deletePartitions(clients.table, context.credentialsTableName, [
      keys.credentialPartition(orgId).PK,
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
