/**
 * A decision after the fact (P9, D-P9-01) and a correction's references
 * (D-P9-04), through the handler: a recorded decision gains `checkpointAfter`
 * and `produced` once, from the operator's session or the engine, never from an
 * execution token; a correction may name only a decision a human reversed.
 */
import { createHash } from "node:crypto";
import type { Decision, ProgramContract } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  makeDecision,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
  type PlanDocumentStore,
  planDocumentObjectKey,
  planHash,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiResponse } from "../http.js";

const NOW = "2026-09-27T10:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PLAN = "# Fix\n\n## Strands\n\n### S-01 The fix\n\nIt.\n";
const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const setup = async () => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  await stores.memberships.put(makeMembership(subject, f.ids.next("org")));
  const objects = new Map<string, Uint8Array>();
  const plans: PlanDocumentStore = {
    signUpload: async () => {
      throw new Error("not used");
    },
    get: async (scope, hash) => {
      const body = objects.get(planDocumentObjectKey(scope, hash));
      return body === undefined ? undefined : { uri: "s3://bucket/plan", body };
    },
  };
  const principal: RequestPrincipal = { kind: "user", userId: subject };
  const deps = { stores, clock: createFixedClock(Date.parse(NOW)), plans };
  const call = (method: string, path: string, body?: unknown, as = principal) =>
    handleRequest(deps, { method, path, query: {}, body, principal: as });
  const project = `/projects/${f.scope.projectId}`;
  const run = `${project}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
  const { orgId: _org, ...projectBody } = makeProject(f);
  expect((await call("PUT", project, projectBody)).status).toBe(201);
  await stores.programContracts.put(makeProgramContract(f));
  const root = makeRootNode(f);
  await stores.runs.put(makeRun(f, { rootNodeId: root.executionNodeId }));
  await stores.executionNodes.put(root);
  return { f, stores, call, run, root, objects };
};

type World = Awaited<ReturnType<typeof setup>>;

const recorded = async (w: World, patch: Partial<Decision> = {}): Promise<Decision> => {
  const decision = makeDecision(w.f, w.root.executionNodeId, patch);
  const response = await w.call("PUT", `${w.run}/decisions/${decision.decisionId}`, decision);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return decision;
};

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

describe("stamping a decision with what it produced (D-P9-01)", () => {
  it("takes checkpointAfter and produced once, and refuses a second stamp or any other change", async () => {
    const w = await setup();
    const decision = await recorded(w);
    const path = `${w.run}/decisions/${decision.decisionId}`;
    const stamped = {
      ...decision,
      checkpointAfter: decision.checkpointBefore,
      produced: { commits: [SHA] },
    };
    expect((await w.call("PUT", path, stamped)).status).toBe(200);
    // The same stamp again confirms it.
    expect((await w.call("PUT", path, stamped)).status).toBeLessThan(300);
    const again = await w.call("PUT", path, { ...stamped, produced: { commits: [] } });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const changed = await w.call("PUT", path, { ...stamped, rationale: "rewritten" });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(await w.stores.decisions.get(w.f.scope, decision.decisionId)).toEqual(stamped);
  });
});

describe("what a correction may name (D-P9-04)", () => {
  const correction = (w: World, corrects: ProgramContract["corrects"]): ProgramContract =>
    makeProgramContract(w.f, {
      programId: w.f.ids.next("prog"),
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The fix",
          scope: { summary: "all", includes: ["src/**"], excludes: [] },
          acceptance: ["green"],
          successCriteria: ["SC-01"],
          dependsOn: [],
          prerequisites: [],
        },
      ],
      ...(corrects === undefined ? {} : { corrects }),
    });

  const ratify = async (w: World, contract: ProgramContract): Promise<ApiResponse> => {
    const hash = planHash(contract, PLAN, sha256);
    const scope = { projectId: contract.projectId, programId: contract.programId };
    w.objects.set(planDocumentObjectKey(scope, hash.plan), new TextEncoder().encode(PLAN));
    return w.call(
      "POST",
      `/projects/${contract.projectId}/programs/${contract.programId}/ratifications`,
      { contract, planHash: hash.hash, planSha256: hash.plan },
    );
  };

  it("ratifies a correction of a decision a human reversed, and refuses one that was not reversed", async () => {
    const w = await setup();
    const original = await recorded(w, { authority: "agent" });
    const target = {
      programId: w.f.scope.programId,
      runId: w.f.scope.runId,
      decisionId: original.decisionId,
    };

    const unreversed = await ratify(
      w,
      correction(w, [{ ...target, reversedBy: w.f.ids.next("dec") }]),
    );
    expect(unreversed.status).toBe(422);
    expect(errorCode(unreversed)).toBe("correction_invalid");

    const reversal = makeDecision(w.f, w.root.executionNodeId, {
      authority: "human",
      agentId: null,
      supersedesDecisionId: original.decisionId,
    });
    await w.stores.decisions.put(reversal);
    const accepted = await ratify(
      w,
      correction(w, [{ ...target, reversedBy: reversal.decisionId }]),
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });
});
