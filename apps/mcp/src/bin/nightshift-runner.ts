#!/usr/bin/env node
/**
 * `nightshift-runner` (P10, T2, T4): the engine on a run's machine, started by
 * its systemd unit as `engine`. Reads the machine's tags, takes its first
 * token, mounts the workspace, prepares it, heartbeats, and runs the headless
 * root until it finishes or the plane says stop.
 */
import { readFile } from "node:fs/promises";
import { createEventOutbox, recordArtifact } from "@nightshift/execution";
import { createRunnerPlane, createRuntime } from "../compose.js";
import { describeHeadlessEnding, runHeadless } from "../headless.js";
import { workerUserName } from "../run-as.js";
import { nodeMachine } from "../runner/machine.js";
import { runRunner } from "../runner/main.js";
import {
  awaitProviderCredentials,
  installTokenFile,
  placeProviderCredentials,
  rootEnvironment,
} from "../runner/root.js";

const say = (line: string): void => {
  process.stderr.write(`[nightshift-runner] ${line}\n`);
};

runRunner({
  machine: nodeMachine,
  log: say,
  plane: createRunnerPlane,
  workspace: process.env.NIGHTSHIFT_WORKSPACE ?? "/workspace",
  device: process.env.NIGHTSHIFT_WORKSPACE_DEVICE ?? "/dev/xvdf",
  sidecar: process.env.NIGHTSHIFT_SIDECAR ?? "/workspace-sidecar",
  engineUser: process.env.NIGHTSHIFT_ENGINE_USER ?? "engine",
  // The engine's token, first and renewed, where the root's processes read it (D-P10-20).
  onToken: (token, scope) => installTokenFile(scope.runId, token),
  work: async (context) => {
    // `running` first: the plane hands the org's provider keys to a running
    // engine and to nothing else (D-P10-23), on the next beat.
    context.heartbeat.report("running");
    const credentials = await awaitProviderCredentials(
      context.heartbeat,
      context.machine,
      3 * 60_000,
    );
    const workerUsers = Number.parseInt(process.env.NIGHTSHIFT_WORKER_USERS ?? "0", 10) || 0;
    const providerKeys = await placeProviderCredentials(context.scope.runId, credentials, {
      users: Array.from({ length: workerUsers }, (_, index) => workerUserName(index)),
      grant: async (user, path) => {
        const owned = await context.machine.exec("sudo", ["chown", "-R", `${user}:${user}`, path]);
        if (owned.exitCode !== 0) throw new Error(`chown ${path} to ${user}: ${owned.stderr}`);
      },
    });
    say(
      Object.keys(providerKeys).length === 0
        ? "the org set no provider credential; the root starts with none"
        : `provider credentials placed: ${Object.keys(providerKeys).join(", ")}`,
    );
    const env = rootEnvironment({
      context,
      apiEndpoint: context.identity.apiEndpoint,
      providerKeys,
      workerUsers,
      parentEnv: process.env,
    });
    const runtime = await createRuntime(env, "orchestrator");
    say(`root starting in ${context.layout.checkout}`);
    const result = await runHeadless(runtime, env, {
      scope: context.scope,
      repoPath: context.layout.checkout,
    });
    say(describeHeadlessEnding(result));
    // The root's transcript, as an artifact on its node: the one durable
    // record of what the orchestrator did, when the machine is long gone.
    try {
      const bytes = await readFile(result.transcript);
      if (bytes.byteLength > 0) {
        const outbox = createEventOutbox({
          events: runtime.stores.events,
          scope: context.scope,
          clock: runtime.clock,
          ids: runtime.ids,
          writerId: `${result.agentId}-runner`,
        });
        const artifactId = await recordArtifact(
          { ...runtime, outbox },
          {
            scope: context.scope,
            nodeId: result.run.rootNodeId,
            kind: "transcript",
            contentType: "application/x-ndjson",
            bytes: new Uint8Array(bytes),
          },
        );
        await outbox.flush(5_000).catch(() => undefined);
        say(`root transcript recorded as ${artifactId}`);
      }
    } catch (error) {
      say(
        `the root's transcript could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.exit.kind !== "completed") {
      throw new Error(
        `the root ended ${result.exit.kind}; run ${result.run.runId} is ${result.run.status}`,
      );
    }
  },
})
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
