/**
 * Minting an execution token (T2 deliverable 3, D-P4-03, A-35).
 *
 * The claims are built from the records, not from the request: the agent, its
 * node, its run and the Program Contract are read first, and the token says what
 * they say. A caller cannot ask for a token for a chain that does not exist,
 * because there is nothing in the request to ask with — the path names the run
 * and the agent, and everything else is looked up.
 *
 * ## Why RSA-2048 and RS256 (T2 deliverable 1)
 *
 * Both RSA-2048 and ECC P-256 are asymmetric sign/verify keys KMS offers and
 * Node handles natively, so library support decides nothing. Three things do:
 *
 * 1. **Verification is the hot path.** The authorizer verifies on every request;
 *    minting happens once per agent. RSA verification with the standard public
 *    exponent is markedly cheaper than ECDSA P-256 verification, and the
 *    asymmetry of the two operations is exactly the wrong way round for ECC
 *    here. The cost of signing is dominated by the KMS round trip regardless of
 *    key type.
 * 2. **No signature transcoding.** KMS returns an ECDSA signature DER-encoded, as
 *    a SEQUENCE of two INTEGERs; JOSE's ES256 wants fixed-width raw `r‖s`.
 *    Converting between them means handling leading zeros and short integers
 *    correctly — code that is wrong only in rare cases, which is the worst
 *    failure shape for a signature. RS256's signature is already the bytes JOSE
 *    wants.
 * 3. **The cost is a longer token.** 256 signature bytes rather than 64, so
 *    roughly 256 more base64url characters in an environment variable and a
 *    header. Immaterial.
 *
 * Rotation is not applicable: KMS does not rotate asymmetric key material, and a
 * token's eight-hour ceiling means replacing the key is a deploy plus a wait,
 * not a migration.
 */
import type {
  Agent,
  Dispatch,
  ExecutionNode,
  ExecutionRole,
  ExecutionTokenClaims,
  ProgramContract,
  Run,
} from "@nightshift/contracts";
import {
  EXECUTION_TOKEN_AUDIENCE,
  ExecutionTokenClaimsSchema,
  MAX_EXECUTION_TOKEN_SECONDS,
} from "@nightshift/contracts";
import { ENGINE_TOKEN_SECONDS } from "@nightshift/core";
import { compactToken, EXECUTION_TOKEN_HEADER, signingInputFor } from "./jwt.js";

/**
 * Whatever can produce an RS256 signature over the signing input.
 *
 * Injected so the offline tests exercise **this** code path with a local key
 * pair, rather than a second implementation that might agree with nothing.
 */
export interface ExecutionTokenSigner {
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}

export interface MintExecutionTokenInput {
  readonly agent: Agent;
  readonly node: ExecutionNode;
  readonly run: Run;
  readonly program: ProgramContract;
  /** `https://api.<stage>.nightshift.wildorder.dev`. */
  readonly issuer: string;
  /** Milliseconds since the epoch. */
  readonly now: number;
}

export interface MintedExecutionToken {
  readonly token: string;
  readonly claims: ExecutionTokenClaims;
  readonly expiresAt: string;
}

/** The records disagreed with each other; minting would produce a token for a chain that is not real. */
export class ExecutionTokenChainError extends Error {
  override readonly name = "ExecutionTokenChainError";
  constructor(detail: string) {
    super(`cannot mint an execution token: ${detail}`);
  }
}

/** The agent is past the point where a token could be of any use. */
export class ExecutionTokenStateError extends Error {
  override readonly name = "ExecutionTokenStateError";
  constructor(readonly status: string) {
    super(
      `cannot mint an execution token for an agent that is ${status}; ` +
        "a token is minted for an agent that is created or started",
    );
  }
}

/**
 * `min(costPolicy.maxWallClockSeconds, 8h)` (D-P4-03).
 *
 * A program with no wall clock gets the ceiling; a program with a tighter one
 * gets its own. Never the other way round, which is why this is a `min` and not
 * a default.
 */
export const executionTokenLifetimeSeconds = (program: ProgramContract): number =>
  Math.min(
    program.costPolicy.maxWallClockSeconds ?? MAX_EXECUTION_TOKEN_SECONDS,
    MAX_EXECUTION_TOKEN_SECONDS,
  );

/** Only these two statuses have a process that could still use a token (T2 deliverable 4). */
export const MINTABLE_AGENT_STATUSES = ["created", "started"] as const;

const assertChain = (input: MintExecutionTokenInput): void => {
  const { agent, node, run, program } = input;
  if (agent.executionNodeId !== node.executionNodeId) {
    throw new ExecutionTokenChainError(
      `agent ${agent.agentId} belongs to node ${agent.executionNodeId}, not ${node.executionNodeId}`,
    );
  }
  for (const [field, a, b] of [
    ["projectId", agent.projectId, run.projectId],
    ["programId", agent.programId, run.programId],
    ["runId", agent.runId, run.runId],
  ] as const) {
    if (a !== b) {
      throw new ExecutionTokenChainError(`${field} on the agent is ${a}, but the run says ${b}`);
    }
  }
  if (node.runId !== run.runId) {
    throw new ExecutionTokenChainError(
      `node ${node.executionNodeId} belongs to run ${node.runId}, not ${run.runId}`,
    );
  }
  if (program.programId !== run.programId) {
    throw new ExecutionTokenChainError(
      `program ${program.programId} is not the program run ${run.runId} belongs to`,
    );
  }
  // P8 (D-P8-15): a builder's session resumed to answer an examiner's
  // questions reaches nothing in Nightshift, so it is given nothing to reach it with.
  if (agent.role === "answerer") {
    throw new ExecutionTokenChainError(
      `agent ${agent.agentId} is an answerer, which calls no Nightshift tool and gets no token`,
    );
  }
  // D-P4-06 keeps the **root** orchestrator on the human's session. The only
  // orchestrator that holds a token is a sub-program's (D-P6-04), and a worker,
  // an examiner and an arbiter are only ever on a job (P8): the role and the
  // node's kind must agree, or a token could carry delegation authority onto a
  // node that has none.
  const expectedKind = agent.role === "orchestrator" ? "sub-program" : "job";
  if (node.kind !== expectedKind) {
    throw new ExecutionTokenChainError(
      `agent ${agent.agentId} is a ${agent.role} on a ${node.kind} node; a ${agent.role}'s token is minted only on a ${expectedKind} node`,
    );
  }
};

/** The token's role for an agent's role. An answerer has none (`assertChain`). */
const executionRoleOf = (role: Agent["role"]): ExecutionRole => {
  switch (role) {
    case "orchestrator":
      return "orchestrator";
    case "examiner":
      return "examiner";
    case "arbiter":
      return "arbiter";
    default:
      return "worker";
  }
};

/**
 * Builds the claims, signs them through the injected signer, and returns the
 * compact JWT — once. Nothing here stores it and nothing logs it.
 */
export const mintExecutionToken = async (
  signer: ExecutionTokenSigner,
  input: MintExecutionTokenInput,
): Promise<MintedExecutionToken> => {
  assertChain(input);
  const { agent, node, program, issuer, now } = input;
  if (!(MINTABLE_AGENT_STATUSES as readonly string[]).includes(agent.status)) {
    throw new ExecutionTokenStateError(agent.status);
  }

  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + executionTokenLifetimeSeconds(program);
  const claims = ExecutionTokenClaimsSchema.parse({
    iss: issuer,
    sub: agent.agentId,
    aud: EXECUTION_TOKEN_AUDIENCE,
    nightshift: {
      kind: "execution",
      projectId: agent.projectId,
      programId: agent.programId,
      runId: agent.runId,
      nodeId: node.executionNodeId,
      agentId: agent.agentId,
      role: executionRoleOf(agent.role),
    },
    iat: issuedAt,
    exp: expiresAt,
  } satisfies ExecutionTokenClaims);

  return signClaims(signer, claims);
};

const signClaims = async (
  signer: ExecutionTokenSigner,
  claims: ExecutionTokenClaims,
): Promise<MintedExecutionToken> => {
  const { signingInput, prefix } = signingInputFor(EXECUTION_TOKEN_HEADER, claims);
  const signature = await signer.sign(signingInput);
  return {
    token: compactToken(prefix, signature),
    claims,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
};

export interface MintEngineTokenInput {
  readonly dispatch: Dispatch;
  readonly run: Run;
  readonly program: ProgramContract;
  readonly issuer: string;
  readonly now: number;
}

/** The run's wall clock has passed: there is no engine token short enough to be honest. */
export class EngineTokenExpiredError extends Error {
  override readonly name = "EngineTokenExpiredError";
  constructor() {
    super("the run's wall clock has passed; no engine token can be minted");
  }
}

/**
 * The engine's token (P10, D-P10-20): bound to the dispatch's generation, on
 * the run's root node, under the dispatch's engine identity, for an hour or the
 * run's remaining wall clock, whichever is shorter. Minted by the dispatch
 * Lambda at boot and renewed by every heartbeat; never by `agent.mintToken`.
 */
export const mintEngineToken = async (
  signer: ExecutionTokenSigner,
  input: MintEngineTokenInput,
): Promise<MintedExecutionToken> => {
  const { dispatch, run, program, issuer, now } = input;
  const issuedAt = Math.floor(now / 1000);
  const wallClock = program.costPolicy.maxWallClockSeconds;
  const remaining =
    wallClock === undefined
      ? ENGINE_TOKEN_SECONDS
      : Math.floor(Date.parse(run.startedAt) / 1000) + wallClock - issuedAt;
  const lifetime = Math.min(ENGINE_TOKEN_SECONDS, remaining);
  if (lifetime <= 0) throw new EngineTokenExpiredError();
  const claims = ExecutionTokenClaimsSchema.parse({
    iss: issuer,
    sub: dispatch.engineAgentId,
    aud: EXECUTION_TOKEN_AUDIENCE,
    nightshift: {
      kind: "execution",
      projectId: run.projectId,
      programId: run.programId,
      runId: run.runId,
      nodeId: run.rootNodeId,
      agentId: dispatch.engineAgentId,
      role: "engine",
      generation: dispatch.generation,
    },
    iat: issuedAt,
    exp: issuedAt + lifetime,
  } satisfies ExecutionTokenClaims);
  return signClaims(signer, claims);
};
