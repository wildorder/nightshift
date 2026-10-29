/**
 * The line owner's token (Pipkin M1b): minted for a line dispatch, verified as
 * a `line` principal, and refused by `enforce` for every operation until J3
 * opens the line routes.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import {
  ALL_OPERATIONS,
  createFixtures,
  createSteppingClock,
  makeLineDispatch,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { createProjectOrgCache, enforce } from "../auth/enforce.js";
import { HttpError } from "../http.js";
import { type ExecutionTokenSigner, mintLineToken } from "./mint.js";
import { verifyExecutionToken } from "./verify.js";

const ISSUER = "https://api.dev.nightshift.wildorder.dev";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer: ExecutionTokenSigner = {
  async sign(signingInput) {
    return signWith("sha256", signingInput, keys.privateKey);
  },
};
const f = createFixtures();
const NOW = Date.parse("2026-10-27T10:00:00.000Z");

describe("mintLineToken", () => {
  it("mints a token that verifies as a line principal bound to the generation", async () => {
    const dispatch = makeLineDispatch(f, { generation: 4, branch: "nightshift/develop" });
    const minted = await mintLineToken(signer, { dispatch, issuer: ISSUER, now: NOW });
    const verified = verifyExecutionToken(minted.token, {
      publicKey: keys.publicKey,
      issuer: ISSUER,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.principal).toEqual({
      kind: "line",
      projectId: f.scope.projectId,
      branch: "nightshift/develop",
      agentId: dispatch.engineAgentId,
      generation: 4,
    });
    expect(verified.claims.sub).toBe(dispatch.engineAgentId);
    // The engine token's life: an hour, renewed by the heartbeat.
    expect(verified.claims.exp - verified.claims.iat).toBe(3600);
    expect(minted.expiresAt).toBe(new Date(NOW + 3600 * 1000).toISOString());
  });

  it("is refused after it expires, and under another key or issuer", async () => {
    const minted = await mintLineToken(signer, {
      dispatch: makeLineDispatch(f),
      issuer: ISSUER,
      now: NOW,
    });
    const opts = { publicKey: keys.publicKey, issuer: ISSUER };
    expect(verifyExecutionToken(minted.token, { ...opts, now: NOW + 3 * 3600 * 1000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      verifyExecutionToken(minted.token, { ...opts, issuer: "https://api.other", now: NOW }),
    ).toMatchObject({ ok: false });
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      verifyExecutionToken(minted.token, { ...opts, publicKey: stranger.publicKey, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("enforce, for a line principal", () => {
  it("refuses every operation with a 403, and reads no store to do it", async () => {
    const stores = createInMemoryStores();
    const dispatch = makeLineDispatch(f);
    const minted = await mintLineToken(signer, { dispatch, issuer: ISSUER, now: NOW });
    const verified = verifyExecutionToken(minted.token, {
      publicKey: keys.publicKey,
      issuer: ISSUER,
      now: NOW,
    });
    if (!verified.ok || verified.principal.kind !== "line")
      throw new Error("expected a line principal");
    const principal = verified.principal;
    const projectOrgs = createProjectOrgCache({
      projects: stores.projects,
      clock: createSteppingClock(0, 0),
    });
    for (const operation of ALL_OPERATIONS) {
      const refusal = await enforce({
        principal,
        operation,
        params: { projectId: f.scope.projectId },
        body: undefined,
        memberships: stores.memberships,
        projectOrgs,
        nodes: stores.executionNodes,
        dispatches: stores.dispatches,
        lineDispatches: stores.lineDispatches,
        programContracts: stores.programContracts,
        runs: stores.runs,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal, operation).toBeInstanceOf(HttpError);
      expect((refusal as HttpError).status, operation).toBe(403);
    }
  });
});
