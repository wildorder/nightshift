/**
 * The engine's token (P10, D-P10-20): bound to the dispatch's generation, on
 * the root node, for an hour or the run's remaining wall clock.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import { createFixtures, makeDispatch, makeProgramContract, makeRun } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { EngineTokenExpiredError, type ExecutionTokenSigner, mintEngineToken } from "./mint.js";
import { verifyExecutionToken } from "./verify.js";

const ISSUER = "https://api.dev.nightshift.wildorder.dev";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer: ExecutionTokenSigner = {
  async sign(signingInput) {
    return signWith("sha256", signingInput, keys.privateKey);
  },
};
const f = createFixtures();
const STARTED = "2026-10-01T12:00:00.000Z";
const NOW = Date.parse(STARTED) + 10 * 60 * 1000;

describe("mintEngineToken", () => {
  it("mints a verifying engine token carrying the generation, on the run's root node", async () => {
    const dispatch = makeDispatch(f, { generation: 3 });
    const run = makeRun(f, { startedAt: STARTED });
    const minted = await mintEngineToken(signer, {
      dispatch,
      run,
      program: makeProgramContract(f),
      issuer: ISSUER,
      now: NOW,
    });
    const verified = verifyExecutionToken(minted.token, {
      publicKey: keys.publicKey,
      issuer: ISSUER,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.principal).toEqual({
        kind: "execution",
        ...f.scope,
        nodeId: run.rootNodeId,
        agentId: dispatch.engineAgentId,
        role: "engine",
        generation: 3,
      });
      expect(verified.claims.exp - verified.claims.iat).toBe(3600);
    }
  });

  it("expires at the run's remaining wall clock when that is sooner than an hour", async () => {
    const minted = await mintEngineToken(signer, {
      dispatch: makeDispatch(f),
      run: makeRun(f, { startedAt: STARTED }),
      program: makeProgramContract(f, { costPolicy: { maxWallClockSeconds: 30 * 60 } }),
      issuer: ISSUER,
      now: NOW,
    });
    expect(Date.parse(minted.expiresAt)).toBe(Date.parse(STARTED) + 30 * 60 * 1000);
  });

  it("refuses to mint once the wall clock has passed", async () => {
    await expect(
      mintEngineToken(signer, {
        dispatch: makeDispatch(f),
        run: makeRun(f, { startedAt: STARTED }),
        program: makeProgramContract(f, { costPolicy: { maxWallClockSeconds: 5 * 60 } }),
        issuer: ISSUER,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(EngineTokenExpiredError);
  });
});
