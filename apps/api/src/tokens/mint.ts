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
 * Node 22 handles natively, so library support decides nothing. Three things do:
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
  ExecutionNode,
  ExecutionTokenClaims,
  ProgramContract,
  Run,
} from "@nightshift/contracts";
import {
  EXECUTION_TOKEN_AUDIENCE,
  ExecutionTokenClaimsSchema,
  MAX_EXECUTION_TOKEN_SECONDS,
} from "@nightshift/contracts";
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
  if (agent.role === "examiner") {
    throw new ExecutionTokenChainError(
      `agent ${agent.agentId} is an examiner, which has no runtime yet and gets no token`,
    );
  }
  // D-P4-06 keeps the **root** orchestrator on the human's session. The only
  // orchestrator that holds a token is a sub-program's (D-P6-04), and a worker
  // is only ever on a job: the role and the node's kind must agree, or a token
  // could carry delegation authority onto a node that has none.
  const expectedKind = agent.role === "orchestrator" ? "sub-program" : "job";
  if (node.kind !== expectedKind) {
    throw new ExecutionTokenChainError(
      `agent ${agent.agentId} is a ${agent.role} on a ${node.kind} node; a ${agent.role}'s token is minted only on a ${expectedKind} node`,
    );
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
      role: agent.role === "orchestrator" ? "orchestrator" : "worker",
    },
    iat: issuedAt,
    exp: expiresAt,
  } satisfies ExecutionTokenClaims);

  const { signingInput, prefix } = signingInputFor(EXECUTION_TOKEN_HEADER, claims);
  const signature = await signer.sign(signingInput);
  return {
    token: compactToken(prefix, signature),
    claims,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
};
