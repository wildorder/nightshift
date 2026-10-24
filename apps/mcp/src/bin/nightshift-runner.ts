#!/usr/bin/env node
/**
 * `nightshift-runner` (P10, T2, T4): the engine on a run's machine, started by
 * its systemd unit as `engine`. Reads the machine's tags, takes its first
 * token, mounts the workspace, prepares it, heartbeats, and runs the headless
 * root until it finishes or the plane says stop.
 */
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { createEventOutbox, recordArtifact } from "@nightshift/execution";
import { createRunnerPlane, createRuntime } from "../compose.js";
import { describeHeadlessEnding, runHeadless } from "../headless.js";
import { createReclaim } from "../run-as.js";
import { nodeMachine } from "../runner/machine.js";
import { runRunner } from "../runner/main.js";
import {
  awaitProviderCredentials,
  installTokenFile,
  placeProviderCredentials,
  rootEnvironment,
  startCodexWatch,
  tokenFile,
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
  ...(process.env.PATH === undefined ? {} : { inheritedPath: process.env.PATH }),
  ...(process.env.NIGHTSHIFT_PROJECT_USER === undefined ||
  process.env.NIGHTSHIFT_PROJECT_USER === ""
    ? {}
    : { projectUser: process.env.NIGHTSHIFT_PROJECT_USER }),
  // The engine's token, first and renewed, where the root's processes read it (D-P10-20).
  onToken: (token, scope) => installTokenFile(scope.runId, token),
  readCachedToken: async (scope) => {
    try {
      return await readFile(tokenFile(scope.runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  work: async (context) => {
    // `running` first: the plane hands the org's provider keys to a running
    // engine and to nothing else (D-P10-23), on the next beat.
    context.heartbeat.report("running");
    const credentials = await awaitProviderCredentials(
      context.heartbeat,
      context.machine,
      3 * 60_000,
    );
    const projectUser = process.env.NIGHTSHIFT_PROJECT_USER;
    const providerKeys = await placeProviderCredentials(context.scope.runId, credentials, {
      ...(projectUser === undefined || projectUser === "" ? {} : { user: projectUser }),
      grant: async (user, path) => {
        const owned = await context.machine.exec("sudo", ["chown", "-R", `${user}:${user}`, path]);
        if (owned.exitCode !== 0) throw new Error(`chown ${path} to ${user}: ${owned.stderr}`);
      },
      // A restart on this machine owns the project user's copies again before
      // writing them (2026-10-21): P20's first run restarted into EACCES here
      // every five seconds for thirteen hours.
      reclaim: createReclaim(userInfo().username),
    });
    say(
      Object.keys(providerKeys).length === 0
        ? "the org set no provider credential; the root starts with none"
        : `provider credentials placed: ${Object.keys(providerKeys).join(", ")}`,
    );
    // A Codex login the agents refresh goes back to the org, so the next run
    // starts from a live one (2026-10-13).
    const codexWatch = startCodexWatch({ context, credentials, projectUser, log: say });
    const env = rootEnvironment({
      context,
      apiEndpoint: context.identity.apiEndpoint,
      providerKeys,
      ...(projectUser === undefined || projectUser === "" ? {} : { projectUser }),
      parentEnv: process.env,
      // A-62: on the beat that carried the provider keys.
      secrets: context.heartbeat.last?.secrets ?? {},
    });
    const secretNames = Object.keys(context.heartbeat.last?.secrets ?? {});
    if (secretNames.length > 0) say(`project secrets received: ${secretNames.join(", ")}`);
    const runtime = await createRuntime(env, "orchestrator");
    // Start intelligence before project setup; the root can inspect, repair and retry it.
    say(`root starting in ${context.layout.checkout}`);
    const result = await runHeadless(runtime, env, {
      scope: context.scope,
      repoPath: context.layout.checkout,
      // A replacement machine resumes the run the lost one was running (T6).
      recovering: { generation: context.dispatch.generation },
    }).finally(() => codexWatch.stop());
    say(describeHeadlessEnding(result));
    // Each root's transcript, as an artifact on its node: the one durable
    // record of what the orchestrator did, when the machine is long gone. More
    // than one when a usage limit replaced a root (D-P8-06, as amended 2026-10-12).
    for (const { agentId, path } of result.transcripts) {
      try {
        const bytes = await readFile(path);
        if (bytes.byteLength > 0) {
          const outbox = createEventOutbox({
            events: runtime.stores.events,
            scope: context.scope,
            clock: runtime.clock,
            ids: runtime.ids,
            writerId: `${agentId}-runner`,
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
          say(`root ${agentId}'s transcript recorded as ${artifactId}`);
        }
      } catch (error) {
        say(
          `root ${agentId}'s transcript could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      result.exit.kind !== "completed" ||
      result.run.status === "running" ||
      result.run.status === "pending"
    ) {
      throw new Error(
        `the root ended ${result.exit.kind}; run ${result.run.runId} is ${result.run.status}`,
      );
    }
    return undefined;
  },
})
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
