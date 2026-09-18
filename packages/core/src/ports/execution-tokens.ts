/**
 * Minting a worker's credential, as a port (P4, T4; D-P4-06, A-35).
 *
 * The execution layer creates an `Agent` and then needs a token bound to it. It
 * must not know how one is made: the control plane signs with KMS, and nothing
 * local holds that key or any AWS credential (A-28). So minting arrives as a
 * port, exactly as artifact bodies do, and the only implementation the local
 * machinery ever holds is the one over the HTTP API.
 *
 * The orchestrator's own session is what calls it. `agent.mintToken` is a user
 * operation (§4.4): a token cannot mint a token, so a worker could not obtain
 * another worker's credential even if it wanted one.
 */
import type { AgentId } from "@nightshift/contracts";
import type { RunScope } from "../rules/ownership.js";

export interface MintedExecutionToken {
  /** The compact JWT. Never persisted, never logged (contract §3). */
  readonly token: string;
  /** When it stops being accepted, so a caller can reason about a long job. */
  readonly expiresAt: string;
}

export interface ExecutionTokenMinter {
  mint(scope: RunScope, agentId: AgentId): Promise<MintedExecutionToken>;
}
