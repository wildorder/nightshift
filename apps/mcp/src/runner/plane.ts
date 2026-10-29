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
  LineBatch,
  LineSettleBody,
  LineView,
  ProgramContract,
  ProjectId,
  TakeLineBatchBody,
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

/**
 * A line owner's run: whose line it is, the run of the line program it is, and
 * the generation every call carries.
 */
export interface LineTarget {
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly scope: RunScope;
  readonly generation: number;
}

/**
 * What the line owner needs from the control plane, as a port (Pipkin M1b, S-04):
 * the line routes and the run's heartbeat, each already bound to the owner's
 * project, branch, run and generation. The adapter is in `compose.ts`; the tests use a fake.
 */
export interface LineRunnerPlane {
  /** The line's record, its program and latest run, the policy it routes under, and the programs that feed it. */
  line(): Promise<LineView>;
  /** The line run's own dispatch. */
  dispatch(): Promise<Dispatch | undefined>;
  /** The whole queue as one batch, or the batch already held; `undefined` when there is nothing. */
  takeBatch(release?: TakeLineBatchBody["release"]): Promise<LineBatch | undefined>;
  /** Settles the held batch, with its composition and push when there is one. */
  settle(body: LineSettleBody): Promise<void>;
  /** The run's dispatch heartbeat. */
  heartbeat(body: HeartbeatBody): Promise<HeartbeatResponse>;
  /** A presigned PUT for one bundle; `key` is what the push names. */
  bundleUploadUrl(id: string): Promise<{
    readonly uploadUrl: string;
    readonly key: string;
    readonly contentType: string;
  }>;
}

export type LinePlaneFactory = (
  endpoint: string,
  tokens: EngineTokens,
  target: LineTarget,
) => LineRunnerPlane;
