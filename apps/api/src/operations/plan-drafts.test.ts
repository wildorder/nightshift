/**
 * Plan drafts through the handler (P21): versions that are immutable, hashed and
 * authored by the caller; one decision answered at a time; the owner's acts;
 * ratifying a version by its hash; and who may do any of it.
 */
import { createHash } from "node:crypto";
import type {
  ExecutionRole,
  PlanDraft,
  PlanDraftCheck,
  PlanDraftVersion,
  ProgramContract,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  makeDispatch,
  makeMembership,
  makeProgramContract,
  makeProject,
  nextUserId,
  type PlanDocumentStore,
  planDocumentObjectKey,
  planHash,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiResponse } from "../http.js";

const NOW = "2026-10-23T10:00:00.000Z";
const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const PLAN =
  "# Fixture\n\n## Strands\n\n### S-01 The API\n\nA route.\n\n### S-02 The CLI\n\nA command.\n";

interface World {
  readonly deps: ApiDeps;
  readonly f: Fixtures;
  readonly principal: RequestPrincipal;
  readonly userId: string;
  readonly objects: Map<string, Uint8Array>;
  readonly paths: { readonly project: string; readonly program: string; readonly draft: string };
}

const setup = async (f: Fixtures = createFixtures()): Promise<World> => {
  const stores = createInMemoryStores();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org");
  await stores.memberships.put(makeMembership(subject, orgId));
  const objects = new Map<string, Uint8Array>();
  const plans: PlanDocumentStore = {
    signUpload: async () => {
      throw new Error("not used");
    },
    get: async (scope, hash) => {
      const key = planDocumentObjectKey(scope, hash);
      const body = objects.get(key);
      return body === undefined ? undefined : { uri: `s3://bucket/${key}`, body };
    },
    put: async (scope, hash, body) => {
      const key = planDocumentObjectKey(scope, hash);
      objects.set(key, body);
      return { uri: `s3://bucket/${key}`, body };
    },
  };
  const project = `/projects/${f.scope.projectId}`;
  const program = `${project}/programs/${f.scope.programId}`;
  const w: World = {
    deps: { stores, clock: createFixedClock(Date.parse(NOW)), plans },
    f,
    principal: { kind: "user", userId: subject },
    userId: subject,
    objects,
    paths: { project, program, draft: `${program}/plan-draft` },
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

const decision = (id: string) => ({
  id,
  question: `Which for ${id}?`,
  options: ["a", "b"],
  touches: "all" as const,
});

const draftContract = (w: World, overrides: Partial<ProgramContract> = {}): ProgramContract =>
  makeProgramContract(w.f, {
    status: "planning",
    strands: [
      {
        id: "S-01",
        name: "Strand S-01",
        scope: { summary: "somewhere", includes: ["src/api/**"], excludes: [] },
        acceptance: ["green"],
        successCriteria: ["SC-01"],
        dependsOn: [],
        prerequisites: [],
      },
      {
        id: "S-02",
        name: "Strand S-02",
        scope: { summary: "somewhere", includes: ["src/cli/**"], excludes: [] },
        acceptance: ["green"],
        successCriteria: [],
        dependsOn: ["S-01"],
        prerequisites: [],
      },
    ],
    decisions: [decision("D-01"), decision("D-02")],
    ...overrides,
  });

/** Stores a document as an upload would, and names it. */
const upload = (w: World, text: string): string => {
  const hash = sha256(text);
  w.objects.set(planDocumentObjectKey(w.f.scope, hash), new TextEncoder().encode(text));
  return hash;
};

const putBody = (w: World, contract: ProgramContract | string, basedOn: number | null) => ({
  contractSha256: upload(w, typeof contract === "string" ? contract : JSON.stringify(contract)),
  planSha256: upload(w, PLAN),
  basedOn,
});

interface VersionBody {
  version: PlanDraftVersion;
  check: PlanDraftCheck;
}

const putVersion = async (
  w: World,
  contract: ProgramContract | string,
  basedOn: number | null,
  as?: RequestPrincipal,
): Promise<ApiResponse> =>
  call(w, "POST", `${w.paths.draft}/versions`, putBody(w, contract, basedOn), as);

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

const reasons = (check: PlanDraftCheck): string[] =>
  check.ready ? [] : check.reasons.map((reason) => reason.kind);

describe("writing versions", () => {
  it("stores an immutable, content-hashed version that names the caller as author", async () => {
    const w = await setup();
    const contract = draftContract(w);
    const response = await putVersion(w, contract, null);
    expect(response.status).toBe(201);
    const { version, check } = response.body as VersionBody;
    expect(version.version).toBe(1);
    expect(version.author).toMatchObject({ kind: "user", userId: w.userId });
    expect(version.act).toEqual({ kind: "write" });
    expect(version.contract.sha256).toBe(sha256(JSON.stringify(contract)));
    expect(version.plan.sha256).toBe(sha256(PLAN));
    expect(version.planHash).toBe(planHash(contract, PLAN, sha256).hash);
    expect(check.ready).toBe(false);
    expect(reasons(check)).toEqual(["unanswered_decision", "unanswered_decision"]);

    // The author is the caller's, whatever the body says.
    const forged = await call(w, "POST", `${w.paths.draft}/versions`, {
      ...putBody(w, contract, 1),
      author: { kind: "user", userId: "someone-else", orgId: "org_x" },
    });
    expect(forged.status).toBe(400);

    const second = await putVersion(w, draftContract(w, { outOfScope: ["a UI"] }), 1);
    expect(second.status).toBe(201);
    const first = await call(w, "GET", `${w.paths.draft}/versions/1`);
    expect((first.body as VersionBody).version).toEqual(version);

    const listed = await call(w, "GET", `${w.paths.draft}/versions`);
    expect((listed.body as { items: PlanDraftVersion[] }).items.map((v) => v.version)).toEqual([
      1, 2,
    ]);
    const latest = await call(w, "GET", `${w.paths.draft}/versions/latest`);
    expect((latest.body as VersionBody).version.version).toBe(2);
    const draft = await call(w, "GET", w.paths.draft);
    expect(draft.body).toMatchObject({ state: "draft", latestVersion: 2 });
    expect(
      (await call(w, "GET", `${w.paths.project}/plan-drafts`)).body as { items: PlanDraft[] },
    ).toMatchObject({ items: [{ latestVersion: 2 }] });
    expect((await call(w, "GET", `${w.paths.draft}/versions/9`)).status).toBe(404);
  });

  it("refuses a write based on anything but the latest version with a 409", async () => {
    const w = await setup();
    expect((await putVersion(w, draftContract(w), 1)).status).toBe(409);
    expect((await putVersion(w, draftContract(w), null)).status).toBe(201);
    expect((await putVersion(w, draftContract(w, { outOfScope: ["x"] }), 1)).status).toBe(201);
    for (const basedOn of [1, null]) {
      const stale = await putVersion(w, draftContract(w, { outOfScope: ["y"] }), basedOn);
      expect(stale.status).toBe(409);
      expect(errorCode(stale)).toBe("plan_draft");
    }
  });

  it("records a name, keeps it on a later put without one, and refuses another program's", async () => {
    const w = await setup();
    const named = (contract: ProgramContract, basedOn: number | null, name?: string) => ({
      ...putBody(w, contract, basedOn),
      ...(name === undefined ? {} : { name }),
    });
    expect(
      (await call(w, "POST", `${w.paths.draft}/versions`, named(draftContract(w), null, "p1-demo")))
        .status,
    ).toBe(201);
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).name).toBe("p1-demo");
    expect(
      (
        await call(
          w,
          "POST",
          `${w.paths.draft}/versions`,
          named(draftContract(w, { outOfScope: ["x"] }), 1),
        )
      ).status,
    ).toBe(201);
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).name).toBe("p1-demo");

    const otherId = w.f.ids.next("prog") as ProgramContract["programId"];
    const other = draftContract(w, { programId: otherId });
    const otherScope = { projectId: w.f.scope.projectId, programId: otherId };
    const otherUpload = (text: string): string => {
      const hash = sha256(text);
      w.objects.set(planDocumentObjectKey(otherScope, hash), new TextEncoder().encode(text));
      return hash;
    };
    const otherPut = (name: string) => ({
      contractSha256: otherUpload(JSON.stringify(other)),
      planSha256: otherUpload(PLAN),
      basedOn: null,
      name,
    });
    const otherDraft = `${w.paths.project}/programs/${otherId}/plan-draft/versions`;
    const refused = await call(w, "POST", otherDraft, otherPut("p1-demo"));
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe("plan_draft");
    expect((await call(w, "POST", otherDraft, otherPut("p2-other"))).status).toBe(201);
    // The holder may put its own name again.
    expect(
      (
        await call(
          w,
          "POST",
          `${w.paths.draft}/versions`,
          named(draftContract(w, { outOfScope: ["y"] }), 2, "p1-demo"),
        )
      ).status,
    ).toBe(201);
  });

  it("refuses a contract that is not JSON naming this program, and keeps one that fails the schema", async () => {
    const w = await setup();
    expect((await putVersion(w, "not json", null)).status).toBe(422);
    expect((await putVersion(w, "[1]", null)).status).toBe(422);
    const other = createFixtures();
    const foreign = makeProgramContract(other);
    expect((await putVersion(w, foreign, null)).status).toBe(403);
    const missing = await call(w, "POST", `${w.paths.draft}/versions`, {
      contractSha256: "a".repeat(64),
      planSha256: upload(w, PLAN),
      basedOn: null,
    });
    expect(missing.status).toBe(422);

    const broken = await putVersion(
      w,
      JSON.stringify({ projectId: w.f.scope.projectId, programId: w.f.scope.programId }),
      null,
    );
    expect(broken.status).toBe(201);
    const { version, check } = broken.body as VersionBody;
    expect(version.planHash).toBeUndefined();
    expect(check.ready).toBe(false);
    expect(new Set(reasons(check))).toEqual(new Set(["contract_invalid"]));
  });
});

describe("answering a decision", () => {
  it("makes a new version with the answer and the answerer, READY when it was the last open one", async () => {
    const w = await setup();
    await putVersion(w, draftContract(w), null);

    const unknown = await call(w, "POST", `${w.paths.draft}/answers`, {
      decisionId: "D-99",
      answer: "a",
    });
    expect(unknown.status).toBe(404);

    const first = await call(w, "POST", `${w.paths.draft}/answers`, {
      decisionId: "D-01",
      answer: "a",
      rationale: "simplest",
      basedOn: 1,
    });
    expect(first.status).toBe(201);
    const one = first.body as VersionBody;
    expect(one.version.version).toBe(2);
    expect(one.version.act).toEqual({
      kind: "answer",
      decisionId: "D-01",
      answer: "a",
      rationale: "simplest",
    });
    expect(one.version.author).toMatchObject({ kind: "user", userId: w.userId });
    expect(reasons(one.check)).toEqual(["unanswered_decision"]);

    const stale = await call(w, "POST", `${w.paths.draft}/answers`, {
      decisionId: "D-02",
      answer: "b",
      basedOn: 1,
    });
    expect(stale.status).toBe(409);

    const last = await call(w, "POST", `${w.paths.draft}/answers`, {
      decisionId: "D-02",
      answer: "b",
    });
    const two = last.body as VersionBody;
    expect(two.version.version).toBe(3);
    expect(two.check).toEqual({ ready: true });

    // The plane stored the new contract itself; it holds both answers.
    const stored = JSON.parse(
      new TextDecoder().decode(
        w.objects.get(planDocumentObjectKey(w.f.scope, two.version.contract.sha256)),
      ),
    ) as ProgramContract;
    expect(stored.decisions).toMatchObject([
      { id: "D-01", answer: "a", rationale: "simplest" },
      { id: "D-02", answer: "b" },
    ]);
    expect(two.version.planHash).toBe(planHash(stored, PLAN, sha256).hash);
    // Version 2 is as it was.
    const v2 = await call(w, "GET", `${w.paths.draft}/versions/2`);
    expect((v2.body as VersionBody).version).toEqual(one.version);
  });
});

describe("the owner's acts", () => {
  it("records awaiting_owner, requested changes and a decline on the draft", async () => {
    const w = await setup();
    await putVersion(w, draftContract(w), null);

    const waiting = await call(w, "POST", `${w.paths.draft}/awaiting-owner`, { version: 1 });
    expect(waiting.body).toMatchObject({ state: "awaiting_owner" });
    expect((await call(w, "POST", `${w.paths.draft}/awaiting-owner`, { version: 2 })).status).toBe(
      409,
    );

    const changes = await call(w, "POST", `${w.paths.draft}/change-requests`, {
      version: 1,
      note: "split S-02",
    });
    expect(changes.body).toMatchObject({
      state: "draft",
      acts: [
        { kind: "awaiting_owner", version: 1, by: { kind: "user", userId: w.userId } },
        { kind: "changes_requested", version: 1, note: "split S-02" },
      ],
    });

    const declined = await call(w, "POST", `${w.paths.draft}/decline`, { version: 1, note: "no" });
    expect(declined.body).toMatchObject({ state: "declined" });
    expect((declined.body as PlanDraft).acts.at(-1)).toMatchObject({
      kind: "declined",
      note: "no",
      by: { kind: "user" },
    });
    expect((await putVersion(w, draftContract(w), 1)).status).toBe(409);
    expect((await call(w, "POST", `${w.paths.draft}/decline`, { version: 1 })).status).toBe(409);
    expect((await call(w, "GET", w.paths.draft)).body).toEqual(declined.body);
  });

  it("answers 404 for an act on a program with no draft", async () => {
    const w = await setup();
    expect((await call(w, "POST", `${w.paths.draft}/decline`, { version: 1 })).status).toBe(404);
    expect((await call(w, "GET", w.paths.draft)).status).toBe(404);
  });
});

describe("ratifying a version by its hash", () => {
  const ready = async (w: World): Promise<VersionBody> => {
    await putVersion(w, draftContract(w), null);
    await call(w, "POST", `${w.paths.draft}/answers`, { decisionId: "D-01", answer: "a" });
    const last = await call(w, "POST", `${w.paths.draft}/answers`, {
      decisionId: "D-02",
      answer: "b",
    });
    return last.body as VersionBody;
  };

  it("records the ProgramContract program.ratify records for the same documents, and the draft's act", async () => {
    const f = createFixtures();
    const w = await setup(f);
    const latest = await ready(w);
    const hash = latest.version.planHash as string;

    const ratified = await call(w, "POST", `${w.paths.program}/ratifications`, { planHash: hash });
    expect(ratified.status).toBe(201);
    expect(ratified.body).toMatchObject({ status: "ratified", planHash: hash });

    // The same documents through the contract-in-body form, on a plane of its own.
    const stored = JSON.parse(
      new TextDecoder().decode(
        w.objects.get(planDocumentObjectKey(f.scope, latest.version.contract.sha256)),
      ),
    ) as ProgramContract;
    const twin = await setup(f);
    const body = planHash(stored, PLAN, sha256);
    upload(twin, PLAN);
    const viaBody = await call(twin, "POST", `${twin.paths.program}/ratifications`, {
      contract: stored,
      planHash: body.hash,
      planSha256: body.plan,
    });
    expect(viaBody.status).toBe(201);
    expect(ratified.body).toEqual(viaBody.body);

    const draft = (await call(w, "GET", w.paths.draft)).body as PlanDraft;
    expect(draft.state).toBe("ratified");
    expect(draft.acts).toEqual([
      {
        kind: "ratified",
        version: 3,
        by: { kind: "user", userId: w.userId, orgId: expect.any(String) },
        planHash: hash,
        at: NOW,
      },
    ]);

    // A retry confirms; it does not record a second act or ratification.
    const again = await call(w, "POST", `${w.paths.program}/ratifications`, { planHash: hash });
    expect(again.status).toBe(200);
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).acts).toHaveLength(1);
    expect((again.body as ProgramContract).ratifications).toHaveLength(1);
  });

  it("refuses a version that is not the latest (409), an unknown hash (404) and a plan not ready (422)", async () => {
    const w = await setup();
    const first = (await putVersion(w, draftContract(w), null)).body as VersionBody;
    const notReady = await call(w, "POST", `${w.paths.program}/ratifications`, {
      planHash: first.version.planHash,
    });
    expect(notReady.status).toBe(422);
    expect(errorCode(notReady)).toBe("plan_not_ready");

    await putVersion(w, draftContract(w, { outOfScope: ["x"] }), 1);
    const stale = await call(w, "POST", `${w.paths.program}/ratifications`, {
      planHash: first.version.planHash,
    });
    expect(stale.status).toBe(409);
    const unknown = await call(w, "POST", `${w.paths.program}/ratifications`, {
      planHash: "f".repeat(64),
    });
    expect(unknown.status).toBe(404);
    expect(await w.deps.stores.programContracts.get(w.f.scope.projectId, w.f.scope.programId)).toBe(
      undefined,
    );
  });

  it("serves a draft's documents before the program record exists", async () => {
    const w = await setup();
    const planDocument = `${w.paths.program}/plan-documents/${sha256(PLAN)}`;
    upload(w, PLAN);
    expect((await call(w, "GET", planDocument)).status).toBe(404);
    await putVersion(w, draftContract(w), null);
    const served = await call(w, "GET", planDocument);
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ text: PLAN });
  });
});

describe("publishing a ratification is a compare-and-swap (P21)", () => {
  /** The plane's stores with a gate in front of publication: calls wait there until released. */
  const gated = (w: World) => {
    const inner = w.deps.stores.programContracts;
    let arrived = 0;
    let release: () => void = () => {};
    let open = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    const wait = async () => {
      if (!armed) return;
      arrived += 1;
      await open;
    };
    const programContracts = {
      ...inner,
      create: async (contract: ProgramContract) => {
        await wait();
        return inner.create(contract);
      },
      update: async (...args: Parameters<typeof inner.update>) => {
        await wait();
        return inner.update(...args);
      },
    };
    const world: World = {
      ...w,
      deps: { ...w.deps, stores: { ...w.deps.stores, programContracts } },
    };
    return {
      world,
      arrivals: async (count: number) => {
        while (arrived < count) await new Promise((resolve) => setTimeout(resolve, 1));
      },
      disarm: () => {
        armed = false;
      },
      release: () => {
        release();
        open = Promise.resolve();
      },
    };
  };

  const answered = async (w: World, overrides: Partial<ProgramContract> = {}) => {
    await putVersion(w, draftContract(w, overrides), null);
    await call(w, "POST", `${w.paths.draft}/answers`, { decisionId: "D-01", answer: "a" });
    return (await call(w, "POST", `${w.paths.draft}/answers`, { decisionId: "D-02", answer: "b" }))
      .body as VersionBody;
  };

  /** A new ready version: the latest one's contract with a change. */
  const edited = async (w: World, latest: VersionBody, change: Partial<ProgramContract>) => {
    const text = new TextDecoder().decode(
      w.objects.get(planDocumentObjectKey(w.f.scope, latest.version.contract.sha256)),
    );
    const contract = { ...(JSON.parse(text) as ProgramContract), ...change };
    return (await putVersion(w, contract, latest.version.version)).body as VersionBody;
  };

  const stored = (w: World) =>
    w.deps.stores.programContracts.get(w.f.scope.projectId, w.f.scope.programId);

  const ratifyBy = (w: World, hash: string) =>
    call(w, "POST", `${w.paths.program}/ratifications`, { planHash: hash });

  it("refuses an older ratification resumed after a newer one completed, and writes nothing", async () => {
    const gate = gated(await setup());
    const w = gate.world;
    const v1 = await answered(w);
    // v1's ratification, paused before it publishes; its act is already recorded.
    const paused = ratifyBy(w, v1.version.planHash as string);
    await gate.arrivals(1);
    const v2 = await edited(w, v1, { outOfScope: ["a UI"] });
    expect(v2.version.planHash).not.toBe(v1.version.planHash);
    gate.disarm();
    expect((await ratifyBy(w, v2.version.planHash as string)).status).toBe(201);
    const before = await stored(w);
    gate.release();
    const resumed = await paused;
    expect(resumed.status).toBe(409);
    expect(errorCode(resumed)).toBe("ratification_superseded");
    expect(await stored(w)).toEqual(before);
    expect(before?.planHash).toBe(v2.version.planHash);
    expect(before?.ratifications?.map((entry) => entry.planHash)).toEqual([v2.version.planHash]);
  });

  it("lets exactly one of two first ratifications create; the other confirms it", async () => {
    const gate = gated(await setup());
    const w = gate.world;
    const v1 = await answered(w);
    const hash = v1.version.planHash as string;
    const both = [ratifyBy(w, hash), ratifyBy(w, hash)];
    await gate.arrivals(2);
    gate.disarm();
    gate.release();
    const statuses = (await Promise.all(both)).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 201]);
    const contract = await stored(w);
    expect(contract?.ratifications).toHaveLength(1);
    expect(contract?.planHash).toBe(hash);
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).acts).toHaveLength(1);
  });

  it("answers 409 to a first ratification of another plan when one already created the contract", async () => {
    const base = await setup();
    const inner = base.deps.stores.programContracts;
    const gate = gated(base);
    const w = gate.world;
    const v1 = await answered(w);
    const paused = ratifyBy(w, v1.version.planHash as string);
    await gate.arrivals(1);
    // Another plane-side writer creates the program's contract meanwhile.
    await inner.create(makeProgramContract(w.f, { status: "planning", planHash: undefined }));
    gate.disarm();
    gate.release();
    const response = await paused;
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("ratification_superseded");
    expect((await stored(w))?.status).toBe("planning");
  });

  it("carries a prerequisite check that landed between preparing and publishing", async () => {
    const gate = gated(await setup());
    const w = gate.world;
    const withPrerequisite: Partial<ProgramContract> = {
      strands: (draftContract(w).strands ?? []).map((strand) =>
        strand.id === "S-01" ? { ...strand, prerequisites: ["HP-01"] } : strand,
      ),
      prerequisites: [
        {
          id: "HP-01",
          description: "A key exists.",
          remediation: "Create it.",
          verifyCommand: "test -n x",
          status: "pending",
        },
      ],
    };
    const v1 = await answered(w, withPrerequisite);
    gate.disarm();
    expect((await ratifyBy(w, v1.version.planHash as string)).status).toBe(201);
    const v2 = await edited(w, v1, { outOfScope: ["a UI"] });

    const gate2 = gated(w);
    const paused = ratifyBy(gate2.world, v2.version.planHash as string);
    await gate2.arrivals(1);
    await w.deps.stores.programContracts.update(
      w.f.scope.projectId,
      w.f.scope.programId,
      (current) => ({
        ...current,
        prerequisites: (current.prerequisites ?? []).map((prerequisite) => ({
          ...prerequisite,
          status: "satisfied" as const,
          lastCheck: { exitCode: 0, checkedAt: NOW, where: "laptop" as const },
        })),
      }),
    );
    gate2.release();
    expect((await paused).status).toBe(200);
    const contract = await stored(w);
    expect(contract?.planHash).toBe(v2.version.planHash);
    expect(contract?.prerequisites?.[0]?.status).toBe("satisfied");
    expect(contract?.ratifications).toHaveLength(2);
  });

  it("heals a retry whose act was recorded but whose contract was not published", async () => {
    const w = await setup();
    const v1 = await answered(w);
    const hash = v1.version.planHash as string;
    const inner = w.deps.stores.programContracts;
    let fail = true;
    const flaky: World = {
      ...w,
      deps: {
        ...w.deps,
        stores: {
          ...w.deps.stores,
          programContracts: {
            ...inner,
            create: async (contract) => {
              if (fail) throw new Error("unavailable");
              return inner.create(contract);
            },
          },
        },
      },
    };
    expect((await ratifyBy(flaky, hash)).status).toBe(500);
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).state).toBe("ratified");
    expect(await stored(w)).toBeUndefined();
    fail = false;
    expect((await ratifyBy(flaky, hash)).status).toBe(201);
    expect((await stored(w))?.planHash).toBe(hash);
  });
});

describe("who may do what", () => {
  const ROLES: readonly ExecutionRole[] = [
    "worker",
    "orchestrator",
    "examiner",
    "arbiter",
    "engine",
  ];

  const executionIn = (f: Fixtures, role: ExecutionRole): RequestPrincipal => ({
    kind: "execution",
    ...f.scope,
    nodeId: f.rootNodeId,
    agentId: f.ids.next("agent"),
    role,
    ...(role === "engine" ? { generation: 1 } : {}),
  });

  it("lets an execution of every role read, write a version and mark awaiting_owner in its own project only", async () => {
    const w = await setup();
    await w.deps.stores.dispatches.put(makeDispatch(w.f, { generation: 1 }));
    await putVersion(w, draftContract(w), null);
    const elsewhere = createFixtures();

    for (const role of ROLES) {
      const me = executionIn(w.f, role);
      const stranger = executionIn(elsewhere, role);
      for (const path of [
        w.paths.draft,
        `${w.paths.draft}/versions`,
        `${w.paths.draft}/versions/latest`,
        `${w.paths.draft}/versions/1`,
        `${w.paths.project}/plan-drafts`,
      ]) {
        expect((await call(w, "GET", path, undefined, me)).status, `${role} ${path}`).toBe(200);
        const refused = await call(w, "GET", path, undefined, stranger);
        expect(refused.status, `${role} ${path}`).toBe(403);
      }

      const latest = ((await call(w, "GET", w.paths.draft)).body as PlanDraft).latestVersion;
      const written = await putVersion(w, draftContract(w, { outOfScope: [role] }), latest, me);
      expect(written.status, role).toBe(201);
      expect((written.body as VersionBody).version.author).toEqual(me);
      expect((await putVersion(w, draftContract(w), latest + 1, stranger)).status, role).toBe(403);

      const marked = await call(
        w,
        "POST",
        `${w.paths.draft}/awaiting-owner`,
        { version: latest + 1 },
        me,
      );
      expect(marked.status, role).toBe(200);
      expect((marked.body as PlanDraft).acts.at(-1)?.by).toEqual(me);
      expect(
        (
          await call(
            w,
            "POST",
            `${w.paths.draft}/awaiting-owner`,
            { version: latest + 1 },
            stranger,
          )
        ).status,
        role,
      ).toBe(403);

      for (const [path, body] of [
        [`${w.paths.draft}/answers`, { decisionId: "D-01", answer: "a" }],
        [`${w.paths.draft}/change-requests`, { version: latest + 1, note: "n" }],
        [`${w.paths.draft}/decline`, { version: latest + 1 }],
        [`${w.paths.program}/ratifications`, { planHash: "a".repeat(64) }],
      ] as const) {
        const refused = await call(w, "POST", path, body, me);
        expect(refused.status, `${role} ${path}`).toBe(403);
        expect(errorCode(refused)).toBe("execution_forbidden_operation");
      }
    }
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).state).toBe("awaiting_owner");
  });

  it("refuses a user outside the project's organisation everything", async () => {
    const w = await setup();
    await putVersion(w, draftContract(w), null);
    const outsider = nextUserId(w.f);
    const otherOrg = w.f.ids.next("org");
    await w.deps.stores.memberships.put(makeMembership(outsider, otherOrg));
    const them: RequestPrincipal = { kind: "user", userId: outsider, activeOrg: otherOrg };

    for (const [method, path, body] of [
      ["GET", w.paths.draft],
      ["GET", `${w.paths.draft}/versions`],
      ["GET", `${w.paths.draft}/versions/latest`],
      ["GET", `${w.paths.draft}/versions/1`],
      ["GET", `${w.paths.project}/plan-drafts`],
      ["POST", `${w.paths.draft}/versions`, putBody(w, draftContract(w), 1)],
      ["POST", `${w.paths.draft}/answers`, { decisionId: "D-01", answer: "a" }],
      ["POST", `${w.paths.draft}/change-requests`, { version: 1, note: "n" }],
      ["POST", `${w.paths.draft}/awaiting-owner`, { version: 1 }],
      ["POST", `${w.paths.draft}/decline`, { version: 1 }],
      ["POST", `${w.paths.program}/ratifications`, { planHash: "a".repeat(64) }],
    ] as const) {
      expect((await call(w, method, path, body, them)).status, `${method} ${path}`).toBe(403);
    }
    expect(((await call(w, "GET", w.paths.draft)).body as PlanDraft).latestVersion).toBe(1);
  });
});
