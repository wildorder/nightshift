/**
 * The engine's table and the generation fence (P10, D-P10-18, D-P10-20).
 */
import type { OrgId, Principal } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixturePair } from "../testing/factories.js";
import {
  ALL_OPERATIONS,
  type AuthorizationTarget,
  authorize,
  ENGINE_ACCESS,
  type Operation,
  READ_OPERATIONS,
} from "./authorize.js";
import { EXECUTION_NODE_STATUSES } from "./transitions.js";

const [here, elsewhere] = createFixturePair();
const OWN_NODE = here.ids.next("node");
const OTHER_NODE = here.ids.next("node");
const OWN_AGENT = here.ids.next("agent");

/** `null` is a token that carries no generation at all. */
const engine = (generation: number | null = 2): Principal => ({
  kind: "execution",
  ...here.scope,
  nodeId: OWN_NODE,
  agentId: OWN_AGENT,
  role: "engine",
  ...(generation === null ? {} : { generation }),
});

const target = (overrides: Partial<AuthorizationTarget> = {}): AuthorizationTarget => ({
  orgId: "org_00000000000000000000000001" as OrgId,
  ...here.scope,
  nodeId: OTHER_NODE,
  agentId: here.ids.next("agent"),
  requestedNodeStatus: "verified",
  currentGeneration: 2,
  ...overrides,
});

/** Exactly what the engine may never do, whatever the target. */
const FORBIDDEN: readonly Operation[] = [
  "project.list",
  "project.put",
  "program.list",
  "program.put",
  "program.ratify",
  "program.createPlanUploadUrl",
  "run.list",
  "artifact.createDownloadUrl",
  "orgConfig.get",
  "orgConfig.put",
  "dispatch.create",
  "dispatch.cancel",
  "dispatch.resume",
  "computeRecommendation.get",
  "warmCache.get",
  "orgCredential.put",
  "orgCredential.list",
  "orgGithub.put",
  "orgGithub.get",
  "githubApp.get",
];

describe("the engine's table (D-P10-20)", () => {
  it("forbids exactly the human's operations: planning, the org, other runs, and keys", () => {
    const forbidden = ALL_OPERATIONS.filter(
      (operation) => ENGINE_ACCESS[operation] === "forbidden",
    );
    expect(forbidden.sort()).toEqual([...FORBIDDEN].sort());
  });

  it("reaches the project and the program only for what the run needs to read or record", () => {
    expect(ENGINE_ACCESS["project.get"]).toBe("own_project");
    for (const operation of [
      "program.get",
      "program.getPlanDocument",
      "prerequisite.list",
      "prerequisite.put",
    ] as const) {
      expect(ENGINE_ACCESS[operation], operation).toBe("own_program");
    }
  });

  it("reaches every record of its own run, and never narrows to a node or an agent", () => {
    for (const operation of ALL_OPERATIONS) {
      const access = ENGINE_ACCESS[operation];
      expect(["forbidden", "own_project", "own_program", "own_run"], operation).toContain(access);
    }
  });

  it.each(ALL_OPERATIONS)("decides %s within its own run as the table says", (operation) => {
    const result = authorize(engine(), operation, target());
    if (ENGINE_ACCESS[operation] === "forbidden") {
      expect(result).toMatchObject({ allowed: false, reason: "execution_forbidden_operation" });
    } else {
      expect(result).toEqual({ allowed: true });
    }
  });

  it.each(ALL_OPERATIONS)("refuses %s against another run", (operation) => {
    const result = authorize(
      engine(),
      operation,
      target({ ...elsewhere.scope, nodeId: OTHER_NODE }),
    );
    expect(result.allowed).toBe(false);
  });

  it("may ask a node to take any status: it is what asserts verified", () => {
    for (const status of EXECUTION_NODE_STATUSES) {
      expect(authorize(engine(), "node.put", target({ requestedNodeStatus: status }))).toEqual({
        allowed: true,
      });
    }
    const { requestedNodeStatus: _status, ...noStatus } = target();
    expect(authorize(engine(), "node.put", noStatus)).toMatchObject({ allowed: false });
  });

  it("mints its workers' tokens within its run, which no other execution may", () => {
    expect(authorize(engine(), "agent.mintToken", target())).toEqual({ allowed: true });
  });
});

describe("the generation fence (D-P10-18)", () => {
  const writes = ALL_OPERATIONS.filter(
    (operation) => !READ_OPERATIONS.has(operation) && ENGINE_ACCESS[operation] === "own_run",
  );

  it("names a write for every operation that is not a read", () => {
    expect(writes).toContain("node.put");
    expect(writes).toContain("dispatch.heartbeat");
    expect(writes).toContain("publication.request");
    expect(writes).not.toContain("dispatch.get");
  });

  it.each(writes)("refuses %s under a stale generation", (operation) => {
    expect(authorize(engine(1), operation, target({ currentGeneration: 2 }))).toMatchObject({
      allowed: false,
      reason: "stale_generation",
    });
    // A token from the future is as wrong as one from the past.
    expect(authorize(engine(3), operation, target({ currentGeneration: 2 }))).toMatchObject({
      allowed: false,
      reason: "stale_generation",
    });
  });

  it.each(writes)("fails closed on %s when the generation is unresolved", (operation) => {
    const { currentGeneration: _generation, ...unresolved } = target();
    expect(authorize(engine(), operation, unresolved)).toMatchObject({
      allowed: false,
      reason: "stale_generation",
    });
    expect(authorize(engine(null), operation, target())).toMatchObject({
      allowed: false,
      reason: "stale_generation",
    });
  });

  it("lets a superseded engine read, so it can learn it is superseded", () => {
    for (const operation of ["dispatch.get", "run.get", "node.list"] as const) {
      expect(authorize(engine(1), operation, target({ currentGeneration: 2 }))).toEqual({
        allowed: true,
      });
    }
  });

  it("does not apply to any other role", () => {
    const worker: Principal = {
      kind: "execution",
      ...here.scope,
      nodeId: OTHER_NODE,
      agentId: OWN_AGENT,
      role: "worker",
      generation: 1,
    };
    expect(
      authorize(worker, "event.append", target({ currentGeneration: 2, nodeId: OTHER_NODE })),
    ).toEqual({ allowed: true });
  });

  it("never carries a credential in a refusal detail", () => {
    const refusal = authorize(engine(1), "node.put", target());
    expect(refusal.allowed).toBe(false);
    if (!refusal.allowed) expect(refusal.detail).not.toMatch(/token:|bearer|eyJ/i);
  });
});
