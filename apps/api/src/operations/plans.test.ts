/**
 * Planning through the handler (P7, T1): the gate, what ratifying checks, the
 * plan document, and who may say a prerequisite is met (SC-P7-04, SC-P7-05).
 */
import { createHash } from "node:crypto";
import type { Prerequisite, ProgramContract, Strand } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  emptyConversation,
  type Fixtures,
  keepMessages,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
  type PlanDocumentStore,
  planDocumentObjectKey,
  planHash,
  renderConversation,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiResponse } from "../http.js";

const NOW = "2026-09-21T10:00:00.000Z";
const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const PLAN =
  "# Fixture\n\n## Strands\n\n### S-01 The API\n\nA route.\n\n### S-02 The CLI\n\nA command.\n";

const strand = (id: string, includes: string[], overrides: Partial<Strand> = {}): Strand => ({
  id,
  name: `Strand ${id}`,
  scope: { summary: "somewhere", includes, excludes: [] },
  acceptance: ["green"],
  successCriteria: [],
  dependsOn: [],
  prerequisites: [],
  ...overrides,
});

interface World {
  readonly deps: ApiDeps;
  readonly f: Fixtures;
  readonly principal: RequestPrincipal;
  readonly objects: Map<string, Uint8Array>;
  readonly paths: { readonly project: string; readonly program: string; readonly run: string };
}

const setup = async (): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  await stores.memberships.put(makeMembership(subject, f.ids.next("org")));
  const objects = new Map<string, Uint8Array>();
  const plans: PlanDocumentStore = {
    signUpload: async (request) => {
      const key = planDocumentObjectKey(request.scope, request.sha256);
      return {
        uri: `s3://bucket/${key}`,
        uploadUrl: `https://signed.invalid/${key}`,
        key,
        contentType: request.contentType,
        expiresAt: NOW,
      };
    },
    get: async (scope, hash) => {
      const key = planDocumentObjectKey(scope, hash);
      const body = objects.get(key);
      return body === undefined ? undefined : { uri: `s3://bucket/${key}`, body };
    },
  };
  const project = `/projects/${f.scope.projectId}`;
  const program = `${project}/programs/${f.scope.programId}`;
  const w: World = {
    deps: { stores, clock: createFixedClock(Date.parse(NOW)), plans },
    f,
    principal: { kind: "user", userId: subject },
    objects,
    paths: { project, program, run: `${program}/runs/${f.scope.runId}` },
  };
  const { orgId: _orgId, ...projectBody } = makeProject(f);
  expect((await call(w, "PUT", project, projectBody)).status).toBe(201);
  return w;
};

const call = (
  w: World,
  method: string,
  path: string,
  body?: unknown,
  principal: RequestPrincipal = w.principal,
): Promise<ApiResponse> => handleRequest(w.deps, { method, path, query: {}, body, principal });

const planned = (w: World, overrides: Partial<ProgramContract> = {}): ProgramContract =>
  makeProgramContract(w.f, {
    status: "planning",
    strands: [
      strand("S-01", ["src/api/**"], { successCriteria: ["SC-01"], prerequisites: ["HP-01"] }),
      strand("S-02", ["src/cli/**"], { dependsOn: ["S-01"] }),
    ],
    prerequisites: [
      {
        id: "HP-01",
        description: "A key exists.",
        remediation: "Create it.",
        verifyCommand: "test -n x",
        status: "pending",
      },
    ],
    ...overrides,
  });

/** Stores the document as an upload would, and returns the ratification request for it. */
const ratification = (w: World, contract: ProgramContract, plan = PLAN) => {
  const hash = planHash(contract, plan, sha256);
  w.objects.set(planDocumentObjectKey(w.f.scope, hash.plan), new TextEncoder().encode(plan));
  return { contract, planHash: hash.hash, planSha256: hash.plan };
};

const ratify = async (w: World, contract = planned(w), plan = PLAN): Promise<ProgramContract> => {
  const response = await call(
    w,
    "POST",
    `${w.paths.program}/ratifications`,
    ratification(w, contract, plan),
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body as ProgramContract;
};

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

describe("ratification (D-P7-02)", () => {
  it("records the hash, the stored document and the first entry of the history", async () => {
    const w = await setup();
    const contract = planned(w);
    const request = ratification(w, contract);
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, request);
    expect(response.status).toBe(201);
    const ratified = response.body as ProgramContract;
    expect(ratified.status).toBe("ratified");
    expect(ratified.planHash).toBe(request.planHash);
    expect(ratified.planDocument).toEqual({
      uri: `s3://bucket/${planDocumentObjectKey(w.f.scope, request.planSha256)}`,
      sha256: request.planSha256,
      sizeBytes: Buffer.byteLength(PLAN),
    });
    expect(ratified.ratifications).toEqual([
      { planHash: request.planHash, planDocument: ratified.planDocument, ratifiedAt: NOW },
    ]);
    expect((await call(w, "GET", w.paths.program)).body).toEqual(ratified);

    // A retry is a confirmation, not a second ratification.
    const again = await call(w, "POST", `${w.paths.program}/ratifications`, request);
    expect(again.status).toBe(200);
    expect((again.body as ProgramContract).ratifications).toHaveLength(1);
  });

  it("serves the ratified document back byte for byte, by its hash (SC-P7-04)", async () => {
    const w = await setup();
    const ratified = await ratify(w);
    const response = await call(
      w,
      "GET",
      `${w.paths.program}/plan-documents/${ratified.planDocument?.sha256}`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ planDocument: ratified.planDocument, text: PLAN });
    expect(sha256((response.body as { text: string }).text)).toBe(ratified.planDocument?.sha256);
  });

  it("re-ratifies an edited plan, keeping the history and the checks still valid", async () => {
    const w = await setup();
    await ratify(w);
    await call(w, "PUT", `${w.paths.program}/prerequisites/HP-01`, { kind: "check", exitCode: 0 });

    const edited = planned(w, { outOfScope: ["a UI"] });
    const second = await ratify(w, edited, `${PLAN}\nMore.\n`);
    expect(second.ratifications).toHaveLength(2);
    expect(second.planHash).toBe(second.ratifications?.[1]?.planHash);
    // Same verifyCommand, so the check that passed still stands.
    expect(second.prerequisites?.[0]?.status).toBe("satisfied");

    const changedCommand = planned(w, {
      prerequisites: [
        { ...(edited.prerequisites?.[0] as Prerequisite), verifyCommand: "test -n y" },
      ],
    });
    const third = await ratify(w, changedCommand);
    expect(third.prerequisites?.[0]).toMatchObject({ status: "pending" });
    expect(third.prerequisites?.[0]?.lastCheck).toBeUndefined();
  });

  it("never lets a ratification say a prerequisite is satisfied", async () => {
    const w = await setup();
    const contract = planned(w);
    const claimed = planned(w, {
      prerequisites: [
        {
          ...(contract.prerequisites?.[0] as Prerequisite),
          status: "satisfied",
          lastCheck: { exitCode: 0, checkedAt: NOW },
        },
      ],
    });
    expect((await ratify(w, claimed)).prerequisites?.[0]).toMatchObject({ status: "pending" });
  });

  it("refuses a document that was never uploaded", async () => {
    const w = await setup();
    const request = ratification(w, planned(w));
    w.objects.clear();
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, request);
    expect(response.status).toBe(404);
  });

  it("refuses stored bytes that do not hash to their name", async () => {
    const w = await setup();
    const request = ratification(w, planned(w));
    w.objects.set(
      planDocumentObjectKey(w.f.scope, request.planSha256),
      new TextEncoder().encode("something else"),
    );
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, request);
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("plan_document_mismatch");
  });

  it("refuses a hash that is not the hash of this contract and this document", async () => {
    const w = await setup();
    const request = ratification(w, planned(w));
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, {
      ...request,
      contract: planned(w, { outOfScope: ["slipped in after hashing"] }),
    });
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("plan_hash_mismatch");
  });

  it("refuses a plan that is not ready, with every reason", async () => {
    const w = await setup();
    const contract = planned(w, {
      strands: [strand("S-01", ["src/api/**"], { dependsOn: ["S-09"] })],
      prerequisites: [],
    });
    const response = await call(
      w,
      "POST",
      `${w.paths.program}/ratifications`,
      ratification(w, contract),
    );
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("plan_not_ready");
    const issues = (response.body as { error: { issues: { kind: string }[] } }).error.issues;
    expect(issues.map((issue) => issue.kind)).toEqual([
      "unclaimed_criterion",
      "unknown_dependency",
    ]);
  });

  it("refuses a contract with no strands: there is no plan to ratify", async () => {
    const w = await setup();
    const response = await call(
      w,
      "POST",
      `${w.paths.program}/ratifications`,
      ratification(w, makeProgramContract(w.f)),
    );
    expect(response.status).toBe(422);
  });

  it("answers 501 when wired without a plan store", async () => {
    const w = await setup();
    const { plans: _plans, ...deps } = w.deps;
    const response = await handleRequest(deps, {
      method: "POST",
      path: `${w.paths.program}/ratifications`,
      query: {},
      body: ratification(w, planned(w)),
      principal: w.principal,
    });
    expect(response.status).toBe(501);
  });
});

describe("the kept conversation (P14, SC-P14-03, SC-P14-06)", () => {
  const CONVERSATION = renderConversation(
    keepMessages(
      emptyConversation("p1"),
      {
        harness: "claude",
        sessionId: "s-1",
        messages: [
          { index: 1, role: "human", text: "an admin must never see another company's invoices" },
          { index: 2, role: "assistant", text: "Understood: tenants are isolated." },
        ],
      },
      [1, 2],
      "The owner wants isolation.",
    ),
  );
  const quoting = (w: World, words: string): ProgramContract => {
    const base = planned(w);
    return planned(w, {
      stories: (base.stories ?? []).map((story) => ({ ...story, words: [words] })),
    });
  };
  const withConversation = (w: World, contract: ProgramContract, text = CONVERSATION) => {
    const conversationSha256 = sha256(text);
    w.objects.set(
      planDocumentObjectKey(w.f.scope, conversationSha256),
      new TextEncoder().encode(text),
    );
    return { ...ratification(w, contract), conversationSha256 };
  };

  it("records the conversation it holds, beside the plan document, and checks the quotes against it", async () => {
    const w = await setup();
    const request = withConversation(w, quoting(w, "never see another company's invoices"));
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, request);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const ratified = response.body as ProgramContract;
    const ref = {
      uri: `s3://bucket/${planDocumentObjectKey(w.f.scope, request.conversationSha256)}`,
      sha256: request.conversationSha256,
      sizeBytes: Buffer.byteLength(CONVERSATION),
    };
    expect(ratified.conversation).toEqual(ref);
    expect(ratified.ratifications?.at(-1)?.conversation).toEqual(ref);
    // Served back like the plan document, to a member of the program's org.
    const served = await call(
      w,
      "GET",
      `${w.paths.program}/plan-documents/${request.conversationSha256}`,
    );
    expect((served.body as { text: string }).text).toBe(CONVERSATION);
  });

  it("refuses a quote the stored conversation does not hold, whatever the client checked", async () => {
    const w = await setup();
    const paraphrase = withConversation(w, quoting(w, "admins must not see other invoices"));
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, paraphrase);
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("plan_not_ready");
    const assistant = withConversation(w, quoting(w, "tenants are isolated"));
    expect((await call(w, "POST", `${w.paths.program}/ratifications`, assistant)).status).toBe(422);
  });

  it("refuses quotes with no conversation, unless the program keeps none", async () => {
    const w = await setup();
    const bare = ratification(w, quoting(w, "anything"));
    const response = await call(w, "POST", `${w.paths.program}/ratifications`, bare);
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("conversation_missing");
    const off = { ...quoting(w, "anything"), keepConversation: false };
    expect(
      (await call(w, "POST", `${w.paths.program}/ratifications`, ratification(w, off))).status,
    ).toBe(201);
  });

  it("never takes the conversation reference from the client", async () => {
    const w = await setup();
    const forged = planned(w, {
      conversation: { uri: "s3://elsewhere/x", sha256: "d".repeat(64), sizeBytes: 1 },
    });
    const ratified = (
      await call(w, "POST", `${w.paths.program}/ratifications`, ratification(w, forged))
    ).body as ProgramContract;
    expect(ratified.conversation).toBeUndefined();
  });
});

describe("the plan document upload", () => {
  it("signs a program-scoped upload named by the document's hash", async () => {
    const w = await setup();
    const hash = sha256(PLAN);
    const response = await call(w, "POST", `${w.paths.program}/plan-documents/${hash}/upload-url`, {
      sizeBytes: Buffer.byteLength(PLAN),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sha256: hash,
      key: `plans/${w.f.scope.projectId}/${w.f.scope.programId}/${hash}.md`,
      contentType: "text/markdown; charset=utf-8",
    });
  });

  it("refuses a name that is not a SHA-256, and a document too large to be one", async () => {
    const w = await setup();
    const bad = await call(w, "POST", `${w.paths.program}/plan-documents/nope/upload-url`, {
      sizeBytes: 1,
    });
    expect(bad.status).toBe(400);
    const large = await call(
      w,
      "POST",
      `${w.paths.program}/plan-documents/${sha256(PLAN)}/upload-url`,
      { sizeBytes: 1024 * 1024 + 1 },
    );
    expect(large.status).toBe(400);
  });
});

describe("PUT program", () => {
  it("replaces a draft with a draft", async () => {
    const w = await setup();
    expect((await call(w, "PUT", w.paths.program, planned(w))).status).toBe(201);
    const next = planned(w, { outOfScope: ["a UI"] });
    expect((await call(w, "PUT", w.paths.program, next)).status).toBe(200);
    expect((await call(w, "GET", w.paths.program)).body).toEqual(next);
  });

  it("never accepts a ratification: not the status, the hash, the document or the history", async () => {
    const w = await setup();
    const ratified = await ratify(w);
    const fresh = await setup();
    for (const claim of [
      { status: "ratified", planHash: ratified.planHash, planDocument: ratified.planDocument },
      { planHash: ratified.planHash },
      { planDocument: ratified.planDocument },
      { ratifications: ratified.ratifications },
    ] as Partial<ProgramContract>[]) {
      const response = await call(fresh, "PUT", fresh.paths.program, planned(fresh, claim));
      expect(response.status, JSON.stringify(claim)).toBe(409);
    }
  });

  it("confirms a ratified contract exactly, and refuses to change one", async () => {
    const w = await setup();
    const ratified = await ratify(w);
    expect((await call(w, "PUT", w.paths.program, ratified)).status).toBe(200);
    expect((await call(w, "PUT", w.paths.program, planned(w))).status).toBe(409);
    expect((await call(w, "GET", w.paths.program)).body).toEqual(ratified);
  });

  it("leaves a contract that was never planned create-or-confirm, as it was", async () => {
    const w = await setup();
    const plain = makeProgramContract(w.f);
    expect((await call(w, "PUT", w.paths.program, plain)).status).toBe(201);
    expect((await call(w, "PUT", w.paths.program, plain)).status).toBe(200);
    const changed = { ...plain, objective: "Something else." };
    expect((await call(w, "PUT", w.paths.program, changed)).status).toBe(409);
    expect((await call(w, "PUT", w.paths.program, planned(w))).status).toBe(409);
  });
});

describe("the gate on a run (SC-P7-04)", () => {
  it("refuses a run of a planned program that is not ratified", async () => {
    const w = await setup();
    await call(w, "PUT", w.paths.program, planned(w));
    const response = await call(w, "PUT", w.paths.run, makeRun(w.f));
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("plan_not_ratified");
  });

  it("runs a ratified one, whose program node must carry the plan it runs", async () => {
    const w = await setup();
    const ratified = await ratify(w);
    expect((await call(w, "PUT", w.paths.run, makeRun(w.f))).status).toBe(201);

    const root = makeRootNode(w.f);
    const nodePath = `${w.paths.run}/nodes/${root.executionNodeId}`;
    const bare = await call(w, "PUT", nodePath, root);
    expect(bare.status).toBe(422);
    expect(errorCode(bare)).toBe("plan_reference");

    const wrong = { planHash: "0".repeat(64), planDocument: ratified.planDocument };
    expect((await call(w, "PUT", nodePath, { ...root, plan: wrong })).status).toBe(422);

    const plan = { planHash: ratified.planHash, planDocument: ratified.planDocument };
    expect((await call(w, "PUT", nodePath, { ...root, plan })).status).toBe(201);

    // The reference is the run's record of what it ran: it never changes, and
    // only the program node has one.
    const moved = { ...root, plan: wrong, status: "running" };
    expect((await call(w, "PUT", nodePath, moved)).status).toBe(409);
    const child = makeNode(w.f, root.executionNodeId, { kind: "sub-program" });
    const childPath = `${w.paths.run}/nodes/${child.executionNodeId}`;
    expect((await call(w, "PUT", childPath, { ...child, plan })).status).toBe(422);
  });

  it("runs a contract with no strands exactly as before, and its node carries no plan", async () => {
    const w = await setup();
    const plain = makeProgramContract(w.f);
    await call(w, "PUT", w.paths.program, plain);
    expect((await call(w, "PUT", w.paths.run, makeRun(w.f))).status).toBe(201);
    const root = makeRootNode(w.f);
    const nodePath = `${w.paths.run}/nodes/${root.executionNodeId}`;
    const plan = {
      planHash: "0".repeat(64),
      planDocument: { uri: "s3://b/k", sha256: "0".repeat(64), sizeBytes: 1 },
    };
    expect((await call(w, "PUT", nodePath, { ...root, plan })).status).toBe(422);
    expect((await call(w, "PUT", nodePath, root)).status).toBe(201);
  });
});

describe("prerequisites (D-P7-05, D-P7-10)", () => {
  const execution = (w: World, role: "worker" | "orchestrator"): RequestPrincipal => ({
    kind: "execution",
    projectId: w.f.scope.projectId,
    programId: w.f.scope.programId,
    runId: w.f.scope.runId,
    nodeId: w.f.ids.next("node"),
    agentId: w.f.ids.next("agent"),
    role,
  });

  it("is satisfied by a zero exit code and by nothing else, without moving the plan hash", async () => {
    const w = await setup();
    const ratified = await ratify(w);
    const path = `${w.paths.program}/prerequisites/HP-01`;

    const failed = await call(w, "PUT", path, { kind: "check", exitCode: 3 });
    expect(failed.body).toMatchObject({
      status: "pending",
      lastCheck: { exitCode: 3, checkedAt: NOW },
    });
    const passed = await call(w, "PUT", path, { kind: "check", exitCode: 0 });
    expect(passed.body).toMatchObject({ status: "satisfied", lastCheck: { exitCode: 0 } });
    // A later failure takes it back: satisfied is what the last check said.
    const regressed = await call(w, "PUT", path, { kind: "check", exitCode: 1 });
    expect(regressed.body).toMatchObject({ status: "pending" });

    expect((await call(w, "PUT", path, { kind: "check" })).status).toBe(400);
    expect((await call(w, "PUT", path, { status: "satisfied" })).status).toBe(400);
    expect(
      (
        await call(w, "PUT", `${w.paths.program}/prerequisites/HP-09`, {
          kind: "check",
          exitCode: 0,
        })
      ).status,
    ).toBe(404);

    const after = (await call(w, "GET", w.paths.program)).body as ProgramContract;
    expect(after.status).toBe("ratified");
    expect(after.planHash).toBe(ratified.planHash);
    expect(planHash(after, PLAN, sha256).hash).toBe(ratified.planHash);
  });

  it("records a hurdle the engine discovered mid-run, outside what was ratified", async () => {
    const w = await setup();
    const ratified = await ratify(w);
    await call(w, "PUT", w.paths.run, makeRun(w.f));
    const path = `${w.paths.program}/prerequisites/HP-02`;
    const body = {
      kind: "discovered",
      runId: w.f.scope.runId,
      description: "The registry wants a token.",
      remediation: "npm login",
      verifyCommand: "npm whoami",
    };
    expect((await call(w, "PUT", path, body)).status).toBe(201);
    expect((await call(w, "PUT", path, body)).status).toBe(200);
    // A run never overwrites what a human planned.
    expect((await call(w, "PUT", `${w.paths.program}/prerequisites/HP-01`, body)).status).toBe(409);

    const listed = await call(w, "GET", `${w.paths.program}/prerequisites`);
    expect((listed.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      "HP-01",
      "HP-02",
    ]);
    const after = (await call(w, "GET", w.paths.program)).body as ProgramContract;
    expect(planHash(after, PLAN, sha256).hash).toBe(ratified.planHash);
  });

  it.each(["worker", "orchestrator"] as const)(
    "lets a %s's token read its program's prerequisites and write none",
    async (role) => {
      const w = await setup();
      await ratify(w);
      const token = execution(w, role);
      const path = `${w.paths.program}/prerequisites`;
      expect((await call(w, "GET", path, undefined, token)).status).toBe(200);
      const write = await call(w, "PUT", `${path}/HP-01`, { kind: "check", exitCode: 0 }, token);
      expect(write.status).toBe(403);
      for (const [method, route] of [
        ["POST", `${w.paths.program}/ratifications`],
        ["POST", `${w.paths.program}/plan-documents/${sha256(PLAN)}/upload-url`],
        ["GET", `${w.paths.program}/plan-documents/${sha256(PLAN)}`],
      ] as const) {
        expect((await call(w, method, route, {}, token)).status, route).toBe(403);
      }
    },
  );
});
