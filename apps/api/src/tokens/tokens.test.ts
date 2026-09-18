/**
 * Minting and verifying, offline (T2 deliverables 3 and 5).
 *
 * A local RSA-2048 key pair stands in for KMS, and it drives **the same code
 * path**: `mintExecutionToken` takes a signer, so the only thing the deployed
 * function does differently is where the private key lives. The verifier is pure
 * over an injected key and an injected clock, so expiry is a number here rather
 * than a wait.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import { EXECUTION_TOKEN_AUDIENCE, MAX_EXECUTION_TOKEN_SECONDS } from "@nightshift/contracts";
import {
  createFixturePair,
  makeAgent,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { encodeSegment, splitToken } from "./jwt.js";
import {
  ExecutionTokenChainError,
  type ExecutionTokenSigner,
  ExecutionTokenStateError,
  executionTokenLifetimeSeconds,
  mintExecutionToken,
} from "./mint.js";
import { verifyExecutionToken } from "./verify.js";

const ISSUER = "https://api.dev.nightshift.wildorder.dev";
const OTHER_ISSUER = "https://api.prod.nightshift.wildorder.dev";
const NOW = Date.parse("2026-09-17T12:00:00.000Z");

const keyPairOf = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const nightshiftKeys = keyPairOf();
const attackerKeys = keyPairOf();

const signerFor = (
  privateKey: ReturnType<typeof keyPairOf>["privateKey"],
): ExecutionTokenSigner => ({
  async sign(signingInput) {
    return signWith("sha256", signingInput, privateKey);
  },
});

const signer = signerFor(nightshiftKeys.privateKey);

const [here, elsewhere] = createFixturePair();

const world = (f: typeof here) => {
  const root = makeRootNode(f);
  const node = makeNode(f, root.executionNodeId);
  return {
    run: makeRun(f, { rootNodeId: root.executionNodeId }),
    program: makeProgramContract(f),
    node,
    agent: makeAgent(f, node.executionNodeId, { status: "started" }),
  };
};

const own = world(here);
const other = world(elsewhere);

const mint = (overrides: Partial<Parameters<typeof mintExecutionToken>[1]> = {}) =>
  mintExecutionToken(signer, {
    agent: own.agent,
    node: own.node,
    run: own.run,
    program: own.program,
    issuer: ISSUER,
    now: NOW,
    ...overrides,
  });

const verify = (token: string, now = NOW, publicKey = nightshiftKeys.publicKey) =>
  verifyExecutionToken(token, { publicKey, issuer: ISSUER, now });

describe("the token's lifetime", () => {
  it("is the eight-hour ceiling when the program sets no wall clock", () => {
    const program = makeProgramContract(here, { costPolicy: {} });
    expect(executionTokenLifetimeSeconds(program)).toBe(MAX_EXECUTION_TOKEN_SECONDS);
  });

  it("is the program's wall clock when that is tighter", () => {
    const program = makeProgramContract(here, { costPolicy: { maxWallClockSeconds: 900 } });
    expect(executionTokenLifetimeSeconds(program)).toBe(900);
  });

  it("never exceeds the ceiling, however generous the program is", () => {
    const program = makeProgramContract(here, {
      costPolicy: { maxWallClockSeconds: 30 * 24 * 60 * 60 },
    });
    expect(executionTokenLifetimeSeconds(program)).toBe(MAX_EXECUTION_TOKEN_SECONDS);
  });
});

describe("minting", () => {
  it("produces a token that verifies, with the ownership chain in its claims", async () => {
    const minted = await mint();
    const result = verify(minted.token);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.principal).toEqual({
      kind: "execution",
      projectId: own.agent.projectId,
      programId: own.agent.programId,
      runId: own.agent.runId,
      nodeId: own.node.executionNodeId,
      agentId: own.agent.agentId,
      role: "worker",
    });
    expect(result.claims.iss).toBe(ISSUER);
    expect(result.claims.aud).toBe(EXECUTION_TOKEN_AUDIENCE);
    expect(result.claims.sub).toBe(own.agent.agentId);
  });

  it("expires at the program's wall clock, not at the ceiling", async () => {
    const program = makeProgramContract(here, { costPolicy: { maxWallClockSeconds: 3600 } });
    const minted = await mint({ program });
    expect(minted.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  it("refuses an agent that has already finished", async () => {
    const agent = makeAgent(here, own.node.executionNodeId, {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      exitCode: 0,
    });
    await expect(mint({ agent })).rejects.toBeInstanceOf(ExecutionTokenStateError);
  });

  it("refuses an agent whose node belongs to another run", async () => {
    await expect(mint({ node: other.node })).rejects.toBeInstanceOf(ExecutionTokenChainError);
  });

  it("refuses to mint for an orchestrator: P4 mints for workers only (D-P4-06)", async () => {
    const agent = makeAgent(here, own.node.executionNodeId, {
      role: "orchestrator",
      status: "started",
    });
    await expect(mint({ agent })).rejects.toBeInstanceOf(ExecutionTokenChainError);
  });

  it("signs with RS256 and says so in the header", async () => {
    const parts = splitToken((await mint()).token);
    expect(parts?.header).toEqual({ alg: "RS256", typ: "JWT" });
    // RSA-2048 produces a 256-byte signature. If this changes, the key spec did.
    expect(parts?.signature.length).toBe(256);
  });
});

describe("verifying", () => {
  it("refuses a token signed by another key", async () => {
    const forged = await mintExecutionToken(signerFor(attackerKeys.privateKey), {
      agent: own.agent,
      node: own.node,
      run: own.run,
      program: own.program,
      issuer: ISSUER,
      now: NOW,
    });
    expect(verify(forged.token)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an expired token", async () => {
    const program = makeProgramContract(here, { costPolicy: { maxWallClockSeconds: 60 } });
    const minted = await mint({ program });
    expect(verify(minted.token, NOW + 30_000)).toMatchObject({ ok: true });
    // Past the expiry and past the skew allowance.
    expect(verify(minted.token, NOW + 300_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a tampered claim", async () => {
    const minted = await mint();
    const parts = splitToken(minted.token);
    if (parts === undefined) throw new Error("unreachable");
    const claims = parts.payload as Record<string, unknown>;
    const tampered = {
      ...claims,
      nightshift: {
        ...(claims.nightshift as Record<string, unknown>),
        nodeId: other.node.executionNodeId,
      },
    };
    const [header, , signature] = minted.token.split(".") as [string, string, string];
    const forged = `${header}.${encodeSegment(tampered)}.${signature}`;
    expect(verify(forged)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a token minted for another stage's issuer", async () => {
    const minted = await mint({ issuer: OTHER_ISSUER });
    expect(verify(minted.token)).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("refuses a token whose header claims an algorithm we do not sign", async () => {
    const minted = await mint();
    const [, payload, signature] = minted.token.split(".") as [string, string, string];
    const none = `${encodeSegment({ alg: "none", typ: "JWT" })}.${payload}.${signature}`;
    expect(verify(none)).toEqual({ ok: false, reason: "wrong_algorithm" });
  });

  it("refuses anything that is not a compact JWS", () => {
    for (const rubbish of ["", "a.b", "a.b.c.d", "not a token", "..", "a..c"]) {
      expect(verify(rubbish)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a validly signed token whose claims are not an execution principal", async () => {
    // Signed by the Nightshift key, but shaped like something else entirely.
    const prefix = `${encodeSegment({ alg: "RS256", typ: "JWT" })}.${encodeSegment({
      iss: ISSUER,
      sub: "not-an-agent",
    })}`;
    const signature = signWith("sha256", Buffer.from(prefix, "ascii"), nightshiftKeys.privateKey);
    const token = `${prefix}.${signature.toString("base64url")}`;
    expect(verify(token)).toEqual({ ok: false, reason: "bad_claims" });
  });

  it("checks the signature before it reads any claim", async () => {
    // A token naming the right issuer, signed by the wrong key, is a bad
    // signature — never a wrong issuer. Nothing decides from an unverified claim.
    const forged = await mintExecutionToken(signerFor(attackerKeys.privateKey), {
      agent: own.agent,
      node: own.node,
      run: own.run,
      program: own.program,
      issuer: OTHER_ISSUER,
      now: NOW,
    });
    expect(verify(forged.token)).toEqual({ ok: false, reason: "bad_signature" });
  });
});
