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
  "orgGithub.delete",
  "githubApp.get",
];

describe("the engine's table (D-P10-20)", () => {
  it("forbids exactly the human's operations: planning, the org, and keys", () => {
    const forbidden = ALL_OPERATIONS.filter(
      (operation) => ENGINE_ACCESS[operation] === "forbidden",
    );
    expect(forbidden.sort()).toEqual([...FORBIDDEN].sort());
  });

  it("reaches the project and the program only for what the run needs to read or record", () => {
    for (const operation of ["project.get", "gateHealth.get", "gateHealth.put"] as const) {
      expect(ENGINE_ACCESS[operation], operation).toBe("own_project");
    }
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

  it.each(ALL_OPERATIONS)("refuses %s in another program", (operation) => {
    const result = authorize(
      engine(),
      operation,
      target({ ...elsewhere.scope, nodeId: OTHER_NODE }),
    );
    expect(result.allowed).toBe(false);
  });

  // D-P10-29: an earlier run of the same program is the program's memory (its
  // rulings, the strands it finished). The engine reads it; it never writes it.
  const siblingRun = { ...here.scope, runId: here.ids.next("run") };
  // The run-scoped writes. Its program's prerequisites and its project's gate
  // health are the program's and the project's records, not a run's.
  const writes = ALL_OPERATIONS.filter(
    (operation) => !READ_OPERATIONS.has(operation) && ENGINE_ACCESS[operation] === "own_run",
  );

  it.each(
    ALL_OPERATIONS.filter(
      (operation) => READ_OPERATIONS.has(operation) && ENGINE_ACCESS[operation] !== "forbidden",
    ),
  )("reads %s in another run of its own program (D-P10-29)", (operation) => {
    expect(authorize(engine(), operation, target({ ...siblingRun }))).toEqual({ allowed: true });
  });

  it.each(writes)("refuses %s in another run of its own program (D-P10-29)", (operation) => {
    expect(authorize(engine(), operation, target({ ...siblingRun })).allowed).toBe(false);
  });

  it("reads no record narrower than its program, and writes none wider than its run", () => {
    for (const operation of ALL_OPERATIONS) {
      if (READ_OPERATIONS.has(operation)) {
        expect(ENGINE_ACCESS[operation], operation).not.toBe("own_run");
      }
    }
    expect(writes).toContain("node.put");
    expect(writes).toContain("decision.put");
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

  it("reads and writes its own project's gate health, from any run of it (D-P15-07)", () => {
    for (const operation of ["gateHealth.get", "gateHealth.put"] as const) {
      expect(
        authorize(engine(), operation, { projectId: here.scope.projectId, currentGeneration: 2 }),
      ).toEqual({
        allowed: true,
      });
      expect(
        authorize(engine(), operation, {
          projectId: elsewhere.scope.projectId,
          currentGeneration: 2,
        }),
      ).toMatchObject({ allowed: false, reason: "execution_out_of_scope" });
    }
  });

  it("mints its workers' tokens within its run, which no other execution may", () => {
    expect(authorize(engine(), "agent.mintToken", target())).toEqual({ allowed: true });
  });
});

describe("the generation fence (D-P10-18)", () => {
  const writes = ALL_OPERATIONS.filter(
    (operation) =>
      !READ_OPERATIONS.has(operation) &&
      (ENGINE_ACCESS[operation] === "own_run" || ENGINE_ACCESS[operation] === "own_project"),
  );

  it("names a write for every operation that is not a read", () => {
    expect(writes).toContain("node.put");
    expect(writes).toContain("gateHealth.put");
    expect(writes).not.toContain("gateHealth.get");
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
    for (const operation of ["dispatch.get", "run.get", "node.list", "gateHealth.get"] as const) {
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
