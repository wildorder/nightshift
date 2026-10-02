/**
 * What the runner needs from the control plane (P10, T3), as a port: the
 * composition root (`compose.ts`, AR-2) wires it over HTTP, the tests over
 * fakes. Nothing under `runner/` names the adapter.
 */
import type {
  Dispatch,
  HeartbeatBody,
  HeartbeatResponse,
  ProgramContract,
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
}

export type PlaneFactory = (endpoint: string, tokens: EngineTokens) => RunnerPlane;
