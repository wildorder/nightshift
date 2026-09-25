/**
 * P8 through the handler: an org's configuration, an examiner's verdict held to
 * the agents the control plane stores, an orchestrator that may only dispute,
 * and an arbiter's ruling held to the dispute it rules on (D-P8-02, D-P8-10,
 * D-P8-13, SC-P8-10).
 */
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Examination,
  type ExecutionPrincipal,
  type OrgId,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  makeAgent,
  makeDecision,
  makeJobContract,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiResponse } from "../http.js";

const NOW = "2026-09-25T10:00:00.000Z";

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

const setup = async (risk: "medium" | "high" = "high") => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org") as OrgId;
  await stores.memberships.put(makeMembership(subject, orgId));

  const root = makeRootNode(f);
  const job = makeJobContract(f, { risk });
  const node = makeNode(f, root.executionNodeId, {
    jobContractId: job.jobContractId,
    status: "implemented",
    commitSha: "1111111111111111111111111111111111111111",
  });
  const worker = makeAgent(f, node.executionNodeId, { status: "created" });
  const deps: ApiDeps = { stores, clock: createFixedClock(Date.parse(NOW)) };
  const user: RequestPrincipal = { kind: "user", userId: subject };
  const call = (method: string, path: string, body?: unknown, as: RequestPrincipal = user) =>
    handleRequest(deps, { method, path, query: {}, body, principal: as });

  const run = `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
  const { orgId: _o, ...projectBody } = makeProject(f);
  expect((await call("PUT", `/projects/${f.scope.projectId}`, projectBody)).status).toBe(201);
  expect(
    (
      await call(
        "PUT",
        `/projects/${f.scope.projectId}/programs/${f.scope.programId}`,
        makeProgramContract(f),
      )
    ).status,
  ).toBe(201);
  const policy = {
    routingPolicy: DEFAULT_ROUTING_POLICY,
    examinationPolicy: DEFAULT_EXAMINATION_POLICY,
    orgConfigVersion: 0,
  };
  expect(
    (await call("PUT", run, makeRun(f, { rootNodeId: root.executionNodeId, policy }))).status,
  ).toBe(201);
  for (const record of [root, node]) {
    const put = await call("PUT", `${run}/nodes/${record.executionNodeId}`, record);
    expect(put.status, JSON.stringify(put.body)).toBe(201);
  }
  expect((await call("PUT", `${run}/jobs/${job.jobContractId}`, job)).status).toBe(201);
  expect((await call("PUT", `${run}/agents/${worker.agentId}`, worker)).status).toBe(201);
  const verification = makeVerification(f, node);
  expect(
    (await call("PUT", `${run}/verifications/${verification.verificationId}`, verification)).status,
  ).toBe(201);

  const agent = async (
    role: "examiner" | "arbiter",
    harness: string,
    provider: string,
    model: string,
  ) => {
    const record = makeAgent(f, node.executionNodeId, {
      role,
      harness,
      provider,
      model,
      status: "created",
    });
    expect((await call("PUT", `${run}/agents/${record.agentId}`, record)).status).toBe(201);
    const principal: ExecutionPrincipal = {
      kind: "execution",
      ...f.scope,
      nodeId: node.executionNodeId,
      agentId: record.agentId,
      role,
    };
    return { record, principal };
  };

  const examination = (
    examinerAgentId: string,
    route: Examination["examinerRoute"],
  ): Examination => ({
    schemaVersion: 1,
    ...f.scope,
    examinationId: f.ids.next("exam"),
    executionNodeId: node.executionNodeId,
    verificationId: verification.verificationId,
    commitSha: verification.commitSha,
    patchId: "0".repeat(40),
    implementerAgentId: worker.agentId,
    examinerAgentId: examinerAgentId as never,
    examinerRoute: route,
    requiredByRisk: risk,
    blocking: risk === "high",
    fixAttempt: 0,
    questions: [],
    outcome: "findings_raised",
    findings: [
      {
        id: "F-01",
        severity: "material",
        summary: "The retry loop never ends.",
        evidence: [{ kind: "location", path: "src/retry.ts", startLine: 3, endLine: 9 }],
        resolution: "unresolved",
      },
    ],
    createdAt: NOW,
  });

  return { f, orgId, call, run, node, worker, agent, examination };
};

describe("an org's configuration (D-P8-02)", () => {
  it("answers the seeded default at version 0 until someone writes one", async () => {
    const w = await setup();
    const response = await w.call("GET", `/orgs/${w.orgId}/config`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      orgId: w.orgId,
      version: 0,
      routingPolicy: DEFAULT_ROUTING_POLICY,
    });
  });

  it("writes against the version read, and refuses a stale write", async () => {
    const w = await setup();
    const body = {
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      replacesVersion: 0,
    };
    const written = await w.call("PUT", `/orgs/${w.orgId}/config`, body);
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ version: 1 });
    const stale = await w.call("PUT", `/orgs/${w.orgId}/config`, body);
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe("stale_write");
  });

  it("refuses an invalid policy with every reason", async () => {
    const w = await setup();
    const response = await w.call("PUT", `/orgs/${w.orgId}/config`, {
      routingPolicy: {
        ...DEFAULT_ROUTING_POLICY,
        rules: [{ id: "R", when: { risk: ["low"] }, start: { ladder: "nope", tier: "cheap" } }],
      },
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      replacesVersion: 0,
    });
    expect(response.status).toBe(400);
  });
});

describe("an examiner's verdict (D-P8-10, SC-P8-10)", () => {
  it("is recorded when the examiner is independent as the run's policy requires", async () => {
    const w = await setup("high");
    const { principal } = await w.agent("examiner", "codex", "openai", "gpt-6-astra");
    const verdict = w.examination(principal.agentId, {
      harness: "codex",
      provider: "openai",
      model: "gpt-6-astra",
    });
    const response = await w.call(
      "PUT",
      `${w.run}/examinations/${verdict.examinationId}`,
      verdict,
      principal,
    );
    expect(response.status).toBe(201);
  });

  it("is refused from an examiner on the implementer's provider at high risk", async () => {
    const w = await setup("high");
    const { principal } = await w.agent("examiner", "claude", "anthropic", "claude-opus-5-5");
    const verdict = w.examination(principal.agentId, {
      harness: "claude",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    const response = await w.call(
      "PUT",
      `${w.run}/examinations/${verdict.examinationId}`,
      verdict,
      principal,
    );
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("examiner_not_independent");
  });

  it("is refused when it names another examiner, or a route it did not run", async () => {
    const w = await setup("medium");
    const { principal } = await w.agent("examiner", "codex", "openai", "gpt-6-sol");
    const other = w.examination(
      w.worker.agentId === principal.agentId ? "agent_x" : w.f.ids.next("agent"),
      {
        harness: "codex",
        provider: "openai",
        model: "gpt-6-sol",
      },
    );
    expect(
      (await w.call("PUT", `${w.run}/examinations/${other.examinationId}`, other, principal))
        .status,
    ).toBe(403);
    const lying = w.examination(principal.agentId, {
      harness: "codex",
      provider: "openai",
      model: "gpt-6-astra",
    });
    expect(
      (await w.call("PUT", `${w.run}/examinations/${lying.examinationId}`, lying, principal))
        .status,
    ).toBe(409);
  });

  it("is written once: an examiner may not revise its verdict", async () => {
    const w = await setup("high");
    const { principal } = await w.agent("examiner", "codex", "openai", "gpt-6-astra");
    const verdict = w.examination(principal.agentId, {
      harness: "codex",
      provider: "openai",
      model: "gpt-6-astra",
    });
    await w.call("PUT", `${w.run}/examinations/${verdict.examinationId}`, verdict, principal);
    const softened = { ...verdict, findings: [], outcome: "passed" };
    expect(
      (await w.call("PUT", `${w.run}/examinations/${verdict.examinationId}`, softened, principal))
        .status,
    ).toBe(403);
  });
});

describe("resolving a finding (D-P8-13)", () => {
  const recorded = async () => {
    const w = await setup("high");
    const { principal } = await w.agent("examiner", "codex", "openai", "gpt-6-astra");
    const verdict = w.examination(principal.agentId, {
      harness: "codex",
      provider: "openai",
      model: "gpt-6-astra",
    });
    expect(
      (await w.call("PUT", `${w.run}/examinations/${verdict.examinationId}`, verdict, principal))
        .status,
    ).toBe(201);
    return { w, verdict };
  };

  const moved = (
    verdict: Examination,
    resolution: string,
    resolvedBy: Record<string, unknown>,
  ) => ({
    ...verdict,
    findings: verdict.findings.map((finding) => ({
      ...finding,
      resolution,
      resolvedBy: { at: NOW, ...resolvedBy },
    })),
  });

  it("lets a delegating orchestrator dispute a finding, and do nothing else", async () => {
    const { w, verdict } = await recorded();
    const orchestrator: ExecutionPrincipal = {
      kind: "execution",
      ...w.f.scope,
      nodeId: w.node.parentNodeId as never,
      agentId: w.f.ids.next("agent") as never,
      role: "orchestrator",
    };
    const path = `${w.run}/examinations/${verdict.examinationId}`;
    const accepted = moved(verdict, "risk_accepted", { authority: "agent" });
    expect((await w.call("PUT", path, accepted, orchestrator)).status).toBe(409);
    const disputed = moved(verdict, "disputed", { authority: "agent", reason: "deliberate" });
    expect((await w.call("PUT", path, disputed, orchestrator)).status).toBe(200);
  });

  it("accepts an arbiter's ruling only from an arbiter neither side's model", async () => {
    const { w, verdict } = await recorded();
    const path = `${w.run}/examinations/${verdict.examinationId}`;
    expect(
      (
        await w.call(
          "PUT",
          path,
          moved(verdict, "disputed", { authority: "agent", reason: "deliberate" }),
        )
      ).status,
    ).toBe(200);

    const bad = await w.agent("arbiter", "codex", "openai", "gpt-6-astra");
    const badRuling = makeDecision(w.f, w.node.executionNodeId, { agentId: bad.record.agentId });
    const refused = await w.call(
      "PUT",
      `${w.run}/decisions/${badRuling.decisionId}`,
      badRuling,
      bad.principal,
    );
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe("arbiter_not_independent");

    const good = await w.agent("arbiter", "claude", "anthropic", "claude-opus-5-5");
    const ruling = makeDecision(w.f, w.node.executionNodeId, { agentId: good.record.agentId });
    expect(
      (await w.call("PUT", `${w.run}/decisions/${ruling.decisionId}`, ruling, good.principal))
        .status,
    ).toBe(201);

    const overturned = moved(verdict, "overturned", {
      authority: "agent",
      decisionId: ruling.decisionId,
    });
    expect((await w.call("PUT", path, overturned)).status).toBe(200);
  });

  it("refuses an arbiter's ruling where nothing is disputed", async () => {
    const { w } = await recorded();
    const arbiter = await w.agent("arbiter", "claude", "anthropic", "claude-opus-5-5");
    const ruling = makeDecision(w.f, w.node.executionNodeId, { agentId: arbiter.record.agentId });
    expect(
      (await w.call("PUT", `${w.run}/decisions/${ruling.decisionId}`, ruling, arbiter.principal))
        .status,
    ).toBe(409);
  });
});
