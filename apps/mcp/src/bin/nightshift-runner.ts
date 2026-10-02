#!/usr/bin/env node
/**
 * `nightshift-runner` (P10, T2, T4): the engine on a run's machine, started by
 * its systemd unit as `engine`. Reads the machine's tags, takes its first
 * token, mounts the workspace, prepares it, heartbeats, and runs the headless
 * root until it finishes or the plane says stop.
 */
import { createRunnerPlane, createRuntime } from "../compose.js";
import { describeHeadlessEnding, runHeadless } from "../headless.js";
import { nodeMachine } from "../runner/machine.js";
import { runRunner } from "../runner/main.js";
import { installTokenFile, rootEnvironment } from "../runner/root.js";

const say = (line: string): void => {
  process.stderr.write(`[nightshift-runner] ${line}\n`);
};

runRunner({
  machine: nodeMachine,
  log: say,
  plane: createRunnerPlane,
  workspace: process.env.NIGHTSHIFT_WORKSPACE ?? "/workspace",
  device: process.env.NIGHTSHIFT_WORKSPACE_DEVICE ?? "/dev/xvdf",
  engineUser: process.env.NIGHTSHIFT_ENGINE_USER ?? "engine",
  // The engine's token, first and renewed, where the root's processes read it (D-P10-20).
  onToken: (token, scope) => installTokenFile(scope.runId, token),
  work: async (context) => {
    const env = rootEnvironment({
      context,
      apiEndpoint: context.identity.apiEndpoint,
      parentEnv: process.env,
    });
    const runtime = await createRuntime(env, "orchestrator");
    context.heartbeat.report("running");
    say(`root starting in ${context.layout.checkout}`);
    const result = await runHeadless(runtime, env, {
      scope: context.scope,
      repoPath: context.layout.checkout,
    });
    say(describeHeadlessEnding(result));
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
