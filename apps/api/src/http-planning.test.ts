/**
 * The http planning client against the production handler, over a real socket
 * and a real signed upload (P7, T1/T3): what `nightshift plan ratify` and
 * `nightshift preflight` will drive.
 */
import type { OrgId, ProgramContract } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
  planDocumentObjectKey,
  planHash,
  rejectionOf,
} from "@nightshift/core";
import {
  ControlPlaneError,
  createFetchTransport,
  createHttpPlanning,
  createHttpStores,
  type PlanningClient,
  sha256Hex,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LocalControlPlane, startLocalControlPlane } from "./testing/local-control-plane.js";

const NOW = "2026-09-21T12:00:00.000Z";
// CRLF on purpose: a Windows checkout ratifies the same document a Linux one does.
const PLAN = "# Fixture\r\n\r\n### S-01 The only strand\r\n\r\nA module exists.\r\n";
const PLAN_LF = PLAN.replace(/\r\n/g, "\n");

let plane: LocalControlPlane;
let planning: PlanningClient;
let f: Fixtures;
let orgId: OrgId;
let stores: ReturnType<typeof createHttpStores>;

const planned = (overrides: Partial<ProgramContract> = {}): ProgramContract =>
  makeProgramContract(f, {
    status: "planning",
    strands: [
      {
        id: "S-01",
        name: "The only strand",
        scope: { summary: "source", includes: ["src/**"], excludes: [] },
        acceptance: ["green"],
        successCriteria: ["SC-01"],
        dependsOn: [],
        prerequisites: ["HP-01"],
      },
    ],
    prerequisites: [
      {
        id: "HP-01",
        description: "A token exists.",
        remediation: "npm login",
        verifyCommand: "npm whoami",
        status: "pending",
      },
    ],
    ...overrides,
  });

beforeEach(async () => {
  const backing = createInMemoryStores();
  f = createFixtures();
  const subject = nextUserId(f);
  orgId = f.ids.next("org");
  await backing.memberships.put(makeMembership(subject, orgId));
  plane = await startLocalControlPlane({
    stores: backing,
    principal: { kind: "user", userId: subject, activeOrg: orgId },
    clock: createFixedClock(Date.parse(NOW)),
  });
  const transport = createFetchTransport({
    endpoint: plane.url,
    tokens: staticTokenProvider("ignored-by-the-local-plane"),
  });
  stores = createHttpStores({ transport, actingOrg: orgId });
  planning = createHttpPlanning({ transport });
  await stores.projects.put(makeProject(f, { orgId }));
});

afterEach(async () => {
  await plane.close();
});

describe("the http planning client", () => {
  it("uploads the plan with LF endings, ratifies, and reads it back byte for byte", async () => {
    const contract = planned();
    const ratified = await planning.ratify(contract, PLAN);
    const hash = planHash(contract, PLAN, sha256Hex);

    expect(ratified.status).toBe("ratified");
    expect(ratified.planHash).toBe(hash.hash);
    expect(ratified.planDocument?.sha256).toBe(sha256Hex(PLAN_LF));
    expect(plane.bodies.text(planDocumentObjectKey(f.scope, hash.plan))).toBe(PLAN_LF);

    const document = await planning.planDocument(f.scope, hash.plan);
    expect(document).toEqual({ planDocument: ratified.planDocument, text: PLAN_LF });
    expect(await planning.planDocument(f.scope, "0".repeat(64))).toBeUndefined();

    // Ratified, so a run is accepted; before, it was not.
    await stores.runs.put(makeRun(f));
  });

  it("refuses a run until the plan is ratified", async () => {
    await stores.programContracts.put(planned());
    const refused = await rejectionOf(stores.runs.put(makeRun(f)));
    expect(refused).toBeInstanceOf(ControlPlaneError);
    expect((refused as ControlPlaneError).code).toBe("plan_not_ratified");
  });

  it("ratifies nothing when the plan is not ready, and says every reason", async () => {
    const contract = planned({ prerequisites: [] });
    const refused = (await rejectionOf(planning.ratify(contract, PLAN))) as ControlPlaneError;
    expect(refused.code).toBe("plan_not_ready");
    expect(refused.message).toContain("HP-01");
    expect(await stores.programContracts.get(f.scope.projectId, f.scope.programId)).toBeUndefined();
  });

  it("ratifies nothing when the upload fails", async () => {
    const failing = createHttpPlanning({
      transport: createFetchTransport({
        endpoint: plane.url,
        tokens: staticTokenProvider("ignored"),
      }),
      fetch: async () => ({ status: 403, text: async () => "SignatureDoesNotMatch" }),
    });
    const refused = (await rejectionOf(failing.ratify(planned(), PLAN))) as ControlPlaneError;
    expect(refused.code).toBe("plan_upload_failed");
    expect(await stores.programContracts.get(f.scope.projectId, f.scope.programId)).toBeUndefined();
  });

  it("records a check by its exit code, and a hurdle a run discovered", async () => {
    await planning.ratify(planned(), PLAN);
    expect(await planning.recordCheck(f.scope, "HP-01", 2)).toMatchObject({ status: "pending" });
    expect(await planning.recordCheck(f.scope, "HP-01", 0)).toMatchObject({
      status: "satisfied",
      lastCheck: { exitCode: 0, checkedAt: NOW },
    });

    await stores.runs.put(makeRun(f));
    const hurdle = await planning.recordDiscovered(f.scope, "HP-02", {
      runId: f.scope.runId,
      description: "The registry wants a token.",
      remediation: "npm login",
      verifyCommand: "npm whoami",
    });
    expect(hurdle).toMatchObject({ status: "pending", discoveredInRunId: f.scope.runId });
    expect((await planning.prerequisites(f.scope)).map((p) => p.id)).toEqual(["HP-01", "HP-02"]);
  });
});
