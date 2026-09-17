/**
 * The harness adapter contract, version 0 (contract §4.6, D-P3-03).
 *
 * ## What this is for
 *
 * The execution layer drives a worker through this interface and nothing else.
 * It never learns which provider it has, what that provider's command line looks
 * like, how it is authenticated, how its output is framed, or how its tool
 * permissions are expressed. Every one of those lives behind `start`.
 *
 * P5 finalizes this contract against three adapters. Version 0 exists so that
 * the execution layer (T5) is written against an interface rather than a
 * process, and so that the Claude Code adapter (T8) is written against a
 * specification rather than an example.
 *
 * ## Rules for anyone implementing this
 *
 * 1. **The identity is given to you, never invented.** `input.agent` already
 *    exists in the control plane before `start` is called (A-04). Put its
 *    `agentId` on the handle; do not mint one.
 * 2. **Emit the lifecycle without the worker's help** (D-P3-09). `agent.started`
 *    and exactly one of `agent.completed` / `agent.failed` / `agent.cancelled` /
 *    `agent.interrupted` must reach the sink for every run, including a worker
 *    that calls no tool and exits non-zero. If the provider's output stream
 *    cannot tell you something, configure a provider hook and read that; do not
 *    ask the worker to report it, and do not skip the event.
 * 3. **`exit` settles exactly once.** It never rejects: a failure to launch is
 *    `failed` with an exit code, not a rejected promise, because the execution
 *    layer has a node to move to a durable status either way.
 * 4. **Nothing provider-specific escapes.** Not in a type, not in an event name,
 *    not in a payload key that only means something to one provider.
 * 5. **The worker never gets git write access** (D-P3-15, A-29). Nightshift owns
 *    every commit; an adapter that granted a `git commit` tool would let a worker
 *    author history Nightshift did not.
 */
import type {
  Agent,
  AgentId,
  AgentStatus,
  ExecutionNode,
  JobContract,
  ProgramContract,
  RouteTarget,
} from "@nightshift/contracts";
import type { HookSink } from "./hooks.js";

/** A span of time. Milliseconds, named so a call site cannot mistake the unit. */
export interface Duration {
  readonly ms: number;
}

export const millis = (ms: number): Duration => ({ ms });

/**
 * How to launch the worker's own Nightshift MCP server.
 *
 * The execution layer builds this: the command is the `nightshift-mcp` binary,
 * and `env` carries the seven identity variables of contract §4.2 plus
 * `NIGHTSHIFT_ROLE=worker`. An adapter translates it into whatever configuration
 * format its provider expects and passes it through unchanged. It must not add,
 * remove or rewrite an entry: the identity a worker carries is fixed by the party
 * that spawned it, which is the whole of D-P3-01.
 */
export interface McpLaunch {
  /** A server name for the provider's configuration file. Cosmetic. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface HarnessStartInput {
  /** The execution identity, already persisted as `created` before this call (A-04). */
  readonly agent: Agent;
  /** The node the work belongs to. Its `scope` is the effective authority. */
  readonly node: ExecutionNode;
  /** What to do. The objective, requested scope and acceptance criteria. */
  readonly job: JobContract;
  /** For the brief: the program's constraints and the verification it will face. */
  readonly program: ProgramContract;
  /** Absolute path to the isolated worktree. The worker's working directory. */
  readonly worktree: string;
  /** Harness, provider and model, as routing chose them (D-P3-08). */
  readonly model: RouteTarget;
  /** The worker's Nightshift MCP server. Passed through unchanged. */
  readonly mcp: McpLaunch;
  /** Where lifecycle observations go, in order (D-P3-09). */
  readonly sink: HookSink;
  /**
   * Where the adapter should write the raw provider stream, if it keeps one.
   * Under the state directory, never in the program checkout (D-P3-10). The
   * execution layer uploads it as a `transcript` artifact after exit.
   */
  readonly transcriptPath?: string;
}

/** Why a worker process stopped. Exactly one of these settles `HarnessHandle.exit`. */
export type HarnessExit =
  /** The process ended cleanly and the provider reported a final result. */
  | { readonly kind: "completed" }
  /**
   * The process ended without completing: a non-zero exit, a stream that ended
   * with no result, or a launch that never got off the ground.
   */
  | { readonly kind: "failed"; readonly exitCode: number }
  /**
   * The process was killed by a signal. Windows reports no signal for a killed
   * process, so an adapter on Windows returns `failed` with the exit code
   * instead; the proof SC-P3-11 wants is durable state, not the label.
   */
  | { readonly kind: "interrupted"; readonly signal: string }
  /** `cancel` was called and the process stopped because of it. */
  | { readonly kind: "cancelled" };

export interface HarnessHandle {
  /** Always `input.agent.agentId`. */
  readonly agentId: AgentId;
  /** The operating-system process, where the adapter has one. */
  readonly pid?: number;
  /**
   * Settles exactly once, and never rejects. A launch failure is
   * `failed`, not a rejection: the caller has a node to move either way.
   */
  readonly exit: Promise<HarnessExit>;
  /** Path to the raw provider stream, when the adapter wrote one. */
  readonly transcript?: string;
}

export interface Harness {
  /** Adapter identifier, matching `RouteTarget.harness`: `claude`, `codex`, `agentcore`. */
  readonly id: string;

  /**
   * Starts a worker and returns as soon as the process exists. Does not wait for
   * the work: the caller awaits `handle.exit`.
   *
   * Rejects only when the adapter could not even attempt a launch (a missing
   * binary, an unwritable worktree). Anything that happens after the process
   * exists is reported through `exit`.
   */
  start(input: HarnessStartInput): Promise<HarnessHandle>;

  /**
   * Stops a running worker: a cooperative stop first, then a hard kill after
   * `grace`. Resolves once `exit` has settled. Settles `exit` as `cancelled`
   * when the cancel is what stopped it; a worker that finished on its own in the
   * meantime keeps the outcome it already had.
   *
   * Idempotent: cancelling a settled handle is a no-op.
   */
  cancel(handle: HarnessHandle, grace: Duration): Promise<void>;

  /**
   * The agent's current status.
   *
   * In P3 this is answered from the handle, which is why it looks redundant. It
   * exists because P9 asks a remote runner about an agent this process did not
   * spawn, and adding the method later would mean changing every adapter. It
   * must agree with `exit`: once `exit` settles, `status` reports the matching
   * terminal status forever.
   */
  status(handle: HarnessHandle): Promise<AgentStatus>;
}

/** The `AgentStatus` an exit implies. One place, so no adapter maps it differently. */
export const agentStatusForExit = (exit: HarnessExit): AgentStatus => {
  switch (exit.kind) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
  }
};

/** The hook event an exit implies, so every adapter reports an ending the same way. */
export const hookTypeForExit = (
  exit: HarnessExit,
): "agent.completed" | "agent.failed" | "agent.cancelled" | "agent.interrupted" => {
  switch (exit.kind) {
    case "completed":
      return "agent.completed";
    case "failed":
      return "agent.failed";
    case "interrupted":
      return "agent.interrupted";
    case "cancelled":
      return "agent.cancelled";
  }
};

/** A one-line human description of an exit, for an `outcomeReason`. */
export const describeExit = (exit: HarnessExit): string => {
  switch (exit.kind) {
    case "completed":
      return "the worker process completed";
    case "failed":
      return `the worker process exited ${exit.exitCode}`;
    case "interrupted":
      return `the worker process was killed by ${exit.signal}`;
    case "cancelled":
      return "the worker process was cancelled";
  }
};
