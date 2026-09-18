/**
 * The mint route, through the handler (T2 deliverable 4).
 *
 * A local RSA key pair stands in for KMS, so the route's behaviour — which
 * records it reads, which statuses it accepts, what it answers with — is proved
 * without a deploy. Who may call it is T3's `enforce`, and the offline matrix
 * there is where that is asserted.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import { MintExecutionTokenResponseSchema } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  makeAgent,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiResponse } from "../http.js";
import { verifyExecutionToken } from "../tokens/verify.js";

const NOW = "2026-09-17T10:00:00.000Z";
const ISSUER = "https://api.dev.nightshift.wildorder.dev";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const setup = async () => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  await stores.memberships.put(makeMembership(subject, f.ids.next("org")));

  const root = makeRootNode(f);
  const node = makeNode(f, root.executionNodeId);
  const agent = makeAgent(f, node.executionNodeId, { status: "created" });
  const { orgId: _orgId, ...projectBody } = makeProject(f);

  const deps: ApiDeps = {
    stores,
    clock: createFixedClock(Date.parse(NOW)),
    tokens: {
      issuer: ISSUER,
      signer: { sign: async (input) => signWith("sha256", input, privateKey) },
    },
  };
  const claims = { sub: subject };
  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleRequest(deps, { method, path, query: {}, body, claims });

  const run = `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
  expect((await call("PUT", `/projects/${f.scope.projectId}`, projectBody)).status).toBe(201);
  expect(
    (
      await call(
        "PUT",
        `/projects/${f.scope.projectId}/programs/${f.scope.programId}`,
        makeProgramContract(f, { costPolicy: { maxWallClockSeconds: 3600 } }),
      )
    ).status,
  ).toBe(201);
  expect((await call("PUT", run, makeRun(f, { rootNodeId: root.executionNodeId }))).status).toBe(
    201,
  );
  expect((await call("PUT", `${run}/nodes/${root.executionNodeId}`, root)).status).toBe(201);
  expect((await call("PUT", `${run}/nodes/${node.executionNodeId}`, node)).status).toBe(201);
  expect((await call("PUT", `${run}/agents/${agent.agentId}`, agent)).status).toBe(201);

  return { stores, f, deps, call, run, node, agent, root };
};

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

describe("POST …/agents/{agentId}/token", () => {
  it("mints a token that verifies against the signing key", async () => {
    const w = await setup();
    const response = await w.call("POST", `${w.run}/agents/${w.agent.agentId}/token`);
    expect(response.status).toBe(201);

    const body = MintExecutionTokenResponseSchema.parse(response.body);
    expect(body.agentId).toBe(w.agent.agentId);
    expect(body.expiresAt).toBe(new Date(Date.parse(NOW) + 3_600_000).toISOString());

    const verified = verifyExecutionToken(body.token, {
      publicKey,
      issuer: ISSUER,
      now: Date.parse(NOW),
    });
    expect(verified).toMatchObject({ ok: true });
    if (!verified.ok) return;
    expect(verified.principal).toEqual({
      kind: "execution",
      projectId: w.f.scope.projectId,
      programId: w.f.scope.programId,
      runId: w.f.scope.runId,
      nodeId: w.node.executionNodeId,
      agentId: w.agent.agentId,
      role: "worker",
    });
  });

  it("mints for a started agent too", async () => {
    const w = await setup();
    const started = { ...w.agent, status: "started" as const, startedAt: NOW };
    expect((await w.call("PUT", `${w.run}/agents/${w.agent.agentId}`, started)).status).toBe(200);
    expect((await w.call("POST", `${w.run}/agents/${w.agent.agentId}/token`)).status).toBe(201);
  });

  it("refuses an agent that has already finished", async () => {
    const w = await setup();
    const started = { ...w.agent, status: "started" as const, startedAt: NOW };
    await w.call("PUT", `${w.run}/agents/${w.agent.agentId}`, started);
    const done = { ...started, status: "completed" as const, endedAt: NOW, exitCode: 0 };
    expect((await w.call("PUT", `${w.run}/agents/${w.agent.agentId}`, done)).status).toBe(200);

    const response = await w.call("POST", `${w.run}/agents/${w.agent.agentId}/token`);
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("conflict");
  });

  it("is a 404 for an agent that does not exist in this run", async () => {
    const w = await setup();
    const stranger = w.f.ids.next("agent");
    const response = await w.call("POST", `${w.run}/agents/${stranger}/token`);
    expect(response.status).toBe(404);
  });

  it("mints a new token each time, because none is stored", async () => {
    const w = await setup();
    const first = await w.call("POST", `${w.run}/agents/${w.agent.agentId}/token`);
    const second = await w.call("POST", `${w.run}/agents/${w.agent.agentId}/token`);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Same claims at a fixed clock, so the same bytes: the point is that the
    // second call is served rather than refused as a duplicate.
    expect(MintExecutionTokenResponseSchema.parse(second.body).token).toBeTruthy();
  });

  it("answers 501, not 500, when no signer is configured", async () => {
    const w = await setup();
    const { tokens: _tokens, ...withoutSigner } = w.deps;
    const response = await handleRequest(withoutSigner, {
      method: "POST",
      path: `${w.run}/agents/${w.agent.agentId}/token`,
      query: {},
      body: undefined,
      claims: {},
    });
    expect(response.status).toBe(501);
    expect(errorCode(response)).toBe("tokens_unavailable");
  });

  it("does not answer GET: a token is minted, never read back", async () => {
    const w = await setup();
    const response = await w.call("GET", `${w.run}/agents/${w.agent.agentId}/token`);
    expect(response.status).toBe(405);
  });
});
