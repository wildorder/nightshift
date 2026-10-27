/**
 * What the runner needs from the control plane (P10, T3), as a port: the
 * composition root (`compose.ts`, AR-2) wires it over HTTP, the tests over
 * fakes. Nothing under `runner/` names the adapter.
 */
import type {
  Dispatch,
  ExecutionNode,
  HeartbeatBody,
  HeartbeatResponse,
  JobContract,
  LineAgentBody,
  LineBatch,
  LineDecisionBody,
  LineSettleBody,
  LineView,
  ProgramContract,
  ProjectId,
} from "@nightshift/contracts";
import type { ProgramScope, RunScope } from "@nightshift/core";

/** The engine token the plane renews on every heartbeat; held in memory only. */
export interface EngineTokens {
  idToken(): Promise<string>;
}

export interface RunnerPlane {
  dispatch(scope: RunScope): Promise<Dispatch | undefined>;
  program(scope: ProgramScope): Promise<ProgramContract | undefined>;
  /** The ratified plan's text, by its document hash. */
  planDocument(scope: ProgramScope, sha256: string): Promise<{ readonly text: string } | undefined>;
  heartbeat(scope: RunScope, body: HeartbeatBody): Promise<HeartbeatResponse>;
  /** Every node of the run, as the engine has written them, for the runner to say where the work stands (2026-10-21). */
  nodes(scope: RunScope): Promise<readonly ExecutionNode[]>;
  /** Every job contract of the run, which name the strands the nodes belong to. */
  jobs(scope: RunScope): Promise<readonly JobContract[]>;
}

export type PlaneFactory = (endpoint: string, tokens: EngineTokens) => RunnerPlane;

/** A line owner's dispatch: whose line it is, and the generation every call carries. */
export interface LineTarget {
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly generation: number;
}

/**
 * What the line owner needs from the control plane, as a port (Pipkin M1b, S-04):
 * the line routes, each already bound to the owner's project, branch and
 * generation. The adapter is in `compose.ts`; the tests use a fake.
 */
export interface LineRunnerPlane {
  /** The line's record, its dispatch, the policy its agents route under, and the programs that feed it. */
  line(): Promise<LineView>;
  /** The whole queue as one batch, or the batch already held; `undefined` when there is nothing. */
  takeBatch(): Promise<LineBatch | undefined>;
  /** Settles the held batch, with its composition and push when there is one. */
  settle(body: LineSettleBody): Promise<void>;
  heartbeat(body: HeartbeatBody): Promise<HeartbeatResponse>;
  /** A presigned PUT for one bundle; `key` is what the push names. */
  bundleUploadUrl(id: string): Promise<{
    readonly uploadUrl: string;
    readonly key: string;
    readonly contentType: string;
  }>;
  /** A resolver's decision, recorded for review. */
  decide(decision: Omit<LineDecisionBody, "generation">): Promise<void>;
  /** An agent announced before it runs. */
  announce(agent: LineAgentBody["agent"]): Promise<void>;
}

export type LinePlaneFactory = (
  endpoint: string,
  tokens: EngineTokens,
  target: LineTarget,
) => LineRunnerPlane;
