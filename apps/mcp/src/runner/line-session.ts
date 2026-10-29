/**
 * The composer's host on a line run (S-02, D-01): what a code orchestrator seat
 * needs to sit in the root of a run.
 *
 * A line is a run of the project's line program. Its seat is not a model: the
 * composer is code. It still gets what an orchestrator gets, built the way the
 * root builds it: the standard HTTP stores and outbox under the run's engine
 * token (`createRuntime`), the project environment (`buildEnvironment`), an
 * engine (`attachRun`), and a `RunSession` whose orchestrator is an `Agent`
 * record of role `orchestrator`, created for the composer itself and honest
 * about what it is (a code agent, not "anthropic").
 *
 * Nothing here pushes to GitHub. The environment never carries
 * `NIGHTSHIFT_PUBLISH_BASE`, so the engine installs no landing publisher: a
 * repair job's landing stays in the line's checkout, and the line's own push is
 * the composer's bundle upload.
 */
import type { AgentId, Run } from "@nightshift/contracts";
import { nowIso, transitionAgent } from "@nightshift/core";
import {
  type Engine,
  type EventOutbox,
  type ExecutionEnvironment,
  endProgramNode,
  type RunSession,
} from "@nightshift/execution";
import { createRuntime, PUBLISH_BASE_ENV, type Runtime } from "../compose.js";
import { type AttachedRun, attachRun, type OrchestratorSession } from "../session.js";
import type { LineRunnerContext } from "./main.js";
import { rootEnvironment } from "./root.js";

/** What the composer's Agent record says it is. */
export const LINE_COMPOSER_PROVIDER = "nightshift";
export const LINE_COMPOSER_MODEL = "line-composer";
export const LINE_COMPOSER_CLIENT = { name: "nightshift-line-composer", version: "1" } as const;

export interface LineSessionOptions {
  /** This process's environment, for PATH, HOME and the toolchain. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** The user project code runs as (D-P10-30); absent runs every agent as the engine. */
  readonly projectUser?: string;
  /** The provider keys, by their environment variable names. */
  readonly providerKeys?: Readonly<Record<string, string>>;
  /** The project's secrets, from the heartbeat. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Makes the runtime from the environment; `createRuntime` unless a test supplies a fake. */
  readonly makeRuntime?: (env: Record<string, string>) => Promise<Runtime>;
}

/** The part of the line's context the session is built from. */
export type LineSessionContext = Pick<
  LineRunnerContext,
  "identity" | "scope" | "layout" | "dispatch" | "program" | "projectEnv" | "projectEnvFile"
>;

export interface LineSession {
  readonly session: RunSession;
  readonly environment: ExecutionEnvironment;
  readonly runtime: Runtime;
  readonly engine: Engine;
  readonly outbox: EventOutbox;
  /** The composer's Agent record. */
  readonly composerAgentId: AgentId;
  /**
   * Ends the run when the line goes idle: the run `succeeded` (or `failed` with
   * a reason), its program node and the composer's agent with it, and `run.completed`
   * said. Refuses while the engine has work in flight; does nothing for a run
   * already ended.
   */
  complete(outcome?: {
    readonly status: "succeeded" | "failed";
    readonly reason?: string;
  }): Promise<void>;
}

/** The environment the line's runtime is made from: a run's root environment without the publication base. */
export const lineEnvironment = (
  context: LineSessionContext,
  options: LineSessionOptions,
): Record<string, string> => {
  const env = rootEnvironment({
    context,
    apiEndpoint: context.identity.apiEndpoint,
    parentEnv: options.parentEnv,
    ...(options.projectUser === undefined ? {} : { projectUser: options.projectUser }),
    ...(options.providerKeys === undefined ? {} : { providerKeys: options.providerKeys }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
  // Whatever the program's kind, a line run never publishes through the engine.
  delete env[PUBLISH_BASE_ENV];
  return env;
};

export const createLineSession = async (
  context: LineSessionContext,
  options: LineSessionOptions,
): Promise<LineSession> => {
  const env = lineEnvironment(context, options);
  const runtime = await (options.makeRuntime ?? ((made) => createRuntime(made, "orchestrator")))(
    env,
  );
  const state: OrchestratorSession = {
    runtime,
    repoPath: context.layout.checkout,
    contractFile: "nightshift.program.json",
    clientInfo: () => LINE_COMPOSER_CLIENT,
    workerLaunch: (identity) => runtime.workerLaunch(identity),
    pinnedRun: context.scope,
  };
  const attached: AttachedRun = await attachRun(state, {
    model: LINE_COMPOSER_MODEL,
    runId: context.scope.runId,
    provider: LINE_COMPOSER_PROVIDER,
    clientInfo: LINE_COMPOSER_CLIENT,
  });
  const { session, environment, outbox, engine } = attached;

  const complete: LineSession["complete"] = async (outcome = { status: "succeeded" }) => {
    const { stores, clock } = runtime;
    const run: Run | undefined = await stores.runs.get(session.scope, session.scope.runId);
    if (run === undefined) throw new Error("the line's run no longer exists");
    if (run.status !== "running" && run.status !== "pending") return;
    if (!engine.idle()) {
      const { running, queued } = engine.snapshot();
      throw new Error(
        `the line cannot end with ${running.length} jobs running and ${queued.length} queued`,
      );
    }
    const reason = outcome.status === "failed" ? (outcome.reason ?? "the line failed") : undefined;
    await stores.runs.put({
      ...run,
      status: outcome.status,
      endedAt: nowIso(clock),
      ...(reason === undefined ? {} : { outcomeReason: reason }),
    });
    await endProgramNode(environment, session, outcome.status, reason);
    const agent = await stores.agents.get(session.scope, session.orchestratorAgentId);
    if (agent?.status === "started") {
      await stores.agents.put(
        outcome.status === "succeeded"
          ? transitionAgent(agent, "complete", { at: nowIso(clock) })
          : transitionAgent(agent, "fail", {
              at: nowIso(clock),
              outcomeReason: reason ?? "the line failed",
            }),
      );
    }
    outbox.emit({
      type: outcome.status === "succeeded" ? "run.completed" : "run.failed",
      source: "control-plane",
      payload: reason === undefined ? {} : { reason },
      executionNodeId: session.rootNodeId,
    });
    await outbox.flush(5_000);
  };

  return {
    session,
    environment,
    runtime,
    engine,
    outbox,
    composerAgentId: session.orchestratorAgentId,
    complete,
  };
};
