#!/usr/bin/env node
/**
 * `nightshift-runner` (P10, T2): the engine on a run's machine, started by
 * its systemd unit as `engine`. Reads the machine's tags, takes its first
 * token, mounts the workspace and heartbeats until told to stop.
 */
import { createRunnerPlane } from "../compose.js";
import { nodeMachine } from "../runner/machine.js";
import { runRunner } from "../runner/main.js";

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
})
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
