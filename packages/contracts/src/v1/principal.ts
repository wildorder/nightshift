/**
 * Who can be calling the control plane, and what a Nightshift-issued execution
 * token says (P4 §4.1, §4.3; D-P4-01, D-P4-03).
 *
 * Two kinds and no more. A **user** is a Cognito token — a human through the
 * interactive client, or a machine through the client-credentials grant. An
 * **execution** is a token Nightshift minted for one agent on one node of one
 * run. Naming the two is the whole point: P2 conflated "who is calling
 * Nightshift" with "what a running agent may do", and a single untyped claim bag
 * is what let that happen.
 *
 * The authorizer produces a `Principal`; `authorize` in `@nightshift/core`
 * consumes it; the handler threads it and verifies nothing. No JWT library
 * appears here — the claims are a zod object, and signing and verification live
 * in `apps/api` where the KMS client does.
 *
 * Note the deliberate name: `PrincipalKindSchema` in `./user.js` is something
 * else entirely (`human | machine`, a property of a stored `User`). This module
 * exports no enum of its own; the kind is the discriminator of the union below.
 */
import { z } from "zod";
import {
  AgentIdSchema,
  ExecutionNodeIdSchema,
  OrgIdSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "../ids.js";
import { UserIdSchema } from "./user.js";

/**
 * A human or machine caller, with the organisation it is acting for.
 *
 * `orgId` is the acting org P2 resolves (`custom:active_org`, else the caller's
 * only membership). It is resolved from the token, never from a path or a body.
 */
export const UserPrincipalSchema = z.strictObject({
  kind: z.literal("user"),
  userId: UserIdSchema,
  orgId: OrgIdSchema,
});
export type UserPrincipal = z.infer<typeof UserPrincipalSchema>;

/**
 * The only role P4 mints an execution token for.
 *
 * Not `AgentRoleSchema`. D-P4-06 keeps the **root** orchestrator on the human's
 * session, and an examiner has no runtime yet. P4 made this a literal `worker`
 * so that widening it would be a deliberate edit; P6 is that edit (D-P6-04):
 * `orchestrator` is a **sub-program's** orchestrator, whose token may delegate
 * within the subtree under its own node and do nothing else a worker cannot.
 */
export const ExecutionRoleSchema = z.enum(["worker", "orchestrator"]);
export type ExecutionRole = z.infer<typeof ExecutionRoleSchema>;

/**
 * One agent, on one node, of one run. The chain is carried in the token rather
 * than looked up, so the authorizer needs no database read to build it.
 */
export const ExecutionPrincipalSchema = z.strictObject({
  kind: z.literal("execution"),
  projectId: ProjectIdSchema,
  programId: ProgramIdSchema,
  runId: RunIdSchema,
  nodeId: ExecutionNodeIdSchema,
  agentId: AgentIdSchema,
  role: ExecutionRoleSchema,
});
export type ExecutionPrincipal = z.infer<typeof ExecutionPrincipalSchema>;

export const PrincipalSchema = z.discriminatedUnion("kind", [
  UserPrincipalSchema,
  ExecutionPrincipalSchema,
]);
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * The audience every execution token carries, and the only one the verifier
 * accepts. A Cognito token never has it, so the two kinds cannot be confused
 * even before the signature is checked.
 */
export const EXECUTION_TOKEN_AUDIENCE = "nightshift-api";

/** `https://api.<stage>.nightshift.wildorder.dev` — the issuer of an execution token. */
export const executionTokenIssuer = (apiHostname: string): string => `https://${apiHostname}`;

/**
 * The claims of an execution token (§4.3).
 *
 * `nightshift` holds the principal minus its discriminator duplication: it is
 * the principal, and the verifier parses it into one directly. The registered
 * claims around it are what a JWT verifier checks before it ever looks inside.
 *
 * Strict deliberately: Nightshift signs these itself, so an unexpected claim
 * means the token was not built by the code that is supposed to build it, and
 * that is worth a refusal rather than a shrug.
 */
export const ExecutionTokenClaimsSchema = z.strictObject({
  iss: z.string().min(1),
  /** The agent the token is bound to; the same value as `nightshift.agentId`. */
  sub: AgentIdSchema,
  aud: z.literal(EXECUTION_TOKEN_AUDIENCE),
  nightshift: ExecutionPrincipalSchema,
  /** Seconds since the epoch, as JWT defines them. */
  iat: z.int().min(0),
  exp: z.int().min(0),
});
export type ExecutionTokenClaims = z.infer<typeof ExecutionTokenClaimsSchema>;

/**
 * The ceiling on an execution token's life (D-P4-03). The actual expiry is
 * `min(costPolicy.maxWallClockSeconds, MAX_EXECUTION_TOKEN_SECONDS)`, so a job
 * with a tight wall clock gets a tighter token and never the other way round.
 */
export const MAX_EXECUTION_TOKEN_SECONDS = 8 * 60 * 60;

/**
 * `POST …/runs/{runId}/agents/{agentId}/token`.
 *
 * Returned once and never stored — there is no route that reads a token back,
 * because there is nothing to read it from. A second call mints a second token,
 * which is fine precisely because none is persisted.
 */
export const MintExecutionTokenResponseSchema = z.strictObject({
  token: z.string().min(1),
  agentId: AgentIdSchema,
  /** When the token stops being accepted, for a caller that wants to schedule around it. */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type MintExecutionTokenResponse = z.infer<typeof MintExecutionTokenResponseSchema>;
