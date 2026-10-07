/**
 * Making a checkout Nightshift created usable before an agent works in it.
 *
 * `git worktree add` gives a checkout of what is committed and nothing else: no
 * installed dependencies, no generated code. A worker, an examiner or an arbiter
 * started in one would first have to discover that and repair it, and might
 * not. So each checkout Nightshift creates for an agent is prepared with the
 * program's `setup` steps before the agent starts.
 *
 * This is preparation, not evidence. Its output is kept as a `build-log`
 * artifact, a failure is reported on the node's activity, and the agent starts
 * anyway: an agent in a half-prepared checkout can still read, edit and repair
 * it, and what reaches the program branch is decided by verification, which
 * runs setup again and fails on it (see `verify.ts`).
 */
import type { ExecutionNodeId } from "@nightshift/contracts";
import { runSetupSteps, setupFailed } from "@nightshift/verification";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExecutionEnvironment,
  type RunSession,
} from "./environment.js";
import { recordArtifact } from "./runner.js";
import { freshScratch, scratchEnv } from "./scratch.js";

export interface PrepareCheckoutInput {
  readonly session: RunSession;
  readonly nodeId: ExecutionNodeId;
  readonly checkout: string;
  /** Who the checkout is for, in the activity line a failure writes. */
  readonly purpose: string;
}

/**
 * Runs the program's setup in `checkout`, and gives the checkout its scratch
 * (scratch.ts), which the agent started there then uses as its temp directory.
 * True when there was no setup, or it all passed.
 */
export const prepareCheckout = async (
  environment: ExecutionEnvironment,
  input: PrepareCheckoutInput,
): Promise<boolean> => {
  const scratch = await freshScratch(input.checkout);
  const setup = input.session.program.setup ?? [];
  if (setup.length === 0) return true;
  const results = await runSetupSteps({
    setup,
    cwd: input.checkout,
    // The program checkout's installed tree seeds this one when the lockfiles
    // match (D-P10-24); the install runs only when they do not.
    reference: input.session.repoPath,
    timeoutMs: environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
    env: scratchEnv(scratch),
  });
  const encoder = new TextEncoder();
  const log = results.flatMap((result) => [
    encoder.encode(`$ ${result.command}\n`),
    result.output,
    encoder.encode(`\n[exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}]\n`),
  ]);
  const artifactId = await recordArtifact(environment, {
    scope: input.session.scope,
    nodeId: input.nodeId,
    kind: "build-log",
    contentType: "text/plain; charset=utf-8",
    bytes: concat(log),
  });
  if (!setupFailed(results)) return true;
  const failed = results.at(-1);
  environment.outbox.emit({
    type: "node.progress",
    source: "control-plane",
    payload: {
      message: `setup failed before the ${input.purpose} started: ${failed?.stepId} exited ${failed?.exitCode}; verification will run it again`,
      setupLogArtifactId: artifactId,
    },
    executionNodeId: input.nodeId,
  });
  return false;
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};
