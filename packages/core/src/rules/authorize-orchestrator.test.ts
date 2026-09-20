/**
 * A sub-program orchestrator's token (P6, D-P6-04, SC-P6-13).
 *
 * The same shape as the worker's matrix in `authorize.test.ts`: the table is
 * restated here cell for cell, then walked over every operation against every
 * place a target can stand. "Sub-program agents receive delegation authority"
 * and nothing more is only true if the *nothing more* is enumerated.
 */
import type { OrgId, Principal } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixturePair } from "../testing/factories.js";
import {
  ACCESS_BY_ROLE,
  type AuthorizationTarget,
  authorize,
  EXECUTION_ACCESS,
  type ExecutionAccess,
  type NodeRelation,
  type Operation,
  ORCHESTRATOR_ACCESS,
  ORCHESTRATOR_WRITABLE_NODE_STATUSES,
} from "./authorize.js";
import { EXECUTION_NODE_STATUSES } from "./transitions.js";

const [here, elsewhere] = createFixturePair();
const OWN_NODE = here.ids.next("node");
const OTHER_NODE = here.ids.next("node");
const OWN_AGENT = here.ids.next("agent");
const OTHER_AGENT = here.ids.next("agent");

const orchestrator: Principal = {
  kind: "execution",
  ...here.scope,
  nodeId: OWN_NODE,
  agentId: OWN_AGENT,
  role: "orchestrator",
};

const EXPECTED: Readonly<Record<Operation, ExecutionAccess>> = {
  "project.list": "forbidden",
  "project.put": "forbidden",
  "project.get": "forbidden",
  "program.list": "forbidden",
  "program.put": "forbidden",
  "program.get": "forbidden",
  "run.list": "forbidden",
  "run.put": "forbidden",
  "run.get": "own_run",
  "run.getState": "forbidden",
  "node.list": "forbidden",
  "node.put": "own_subtree",
  "node.get": "own_subtree",
  "node.listChildren": "own_subtree",
  "job.list": "forbidden",
  "job.put": "own_run",
  "job.get": "own_run",
  "agent.put": "forbidden",
  "agent.get": "own_agent",
  "agent.listByNode": "own_subtree",
  "agent.mintToken": "forbidden",
  "event.append": "own_subtree",
  "event.list": "own_run",
  "decision.list": "own_run",
  "decision.put": "own_node",
  "decision.get": "own_run",
  "checkpoint.list": "own_run",
  "checkpoint.put": "forbidden",
  "checkpoint.get": "own_run",
  "verification.put": "forbidden",
  "verification.get": "own_run",
  "verification.listByNode": "own_subtree",
  "examination.put": "forbidden",
  "examination.get": "own_run",
  "examination.listByNode": "own_subtree",
  "routingDecision.put": "forbidden",
  "routingDecision.listByNode": "own_subtree",
  "artifact.list": "own_run",
  "artifact.put": "forbidden",
  "artifact.get": "own_run",
  "artifact.createUploadUrl": "forbidden",
};
const ALL_OPERATIONS = Object.keys(EXPECTED) as Operation[];

/** A target in its own run, standing where `relation` says. */
const at = (relation: NodeRelation, status: string): AuthorizationTarget => ({
  orgId: "org_00000000000000000000000001" as OrgId,
  ...here.scope,
  nodeId: relation === "self" ? OWN_NODE : OTHER_NODE,
  agentId: relation === "self" ? OWN_AGENT : OTHER_AGENT,
  nodeRelation: relation,
  requestedNodeStatus: status,
});

/** The status a legitimate `node.put` asks for from each place. */
const LEGITIMATE: Readonly<Record<NodeRelation, string>> = {
  self: "succeeded",
  descendant: "cancelled",
  new_child: "validated",
  outside: "validated",
};

describe("an orchestrator execution principal (D-P6-04)", () => {
  it("matches the table restated in this test, cell for cell", () => {
    expect(ORCHESTRATOR_ACCESS).toEqual(EXPECTED);
    expect(ACCESS_BY_ROLE).toEqual({ worker: EXECUTION_ACCESS, orchestrator: ORCHESTRATOR_ACCESS });
  });

  it.each(ALL_OPERATIONS)("decides %s on its own node as the table says", (operation) => {
    const result = authorize(orchestrator, operation, at("self", LEGITIMATE.self));
    if (EXPECTED[operation] === "forbidden") {
      expect(result).toMatchObject({ allowed: false, reason: "execution_forbidden_operation" });
    } else {
      expect(result).toEqual({ allowed: true });
    }
  });

  it.each(ALL_OPERATIONS)(
    "decides %s under its own node: a descendant, and a new child",
    (operation) => {
      for (const relation of ["descendant", "new_child"] as const) {
        const result = authorize(orchestrator, operation, at(relation, LEGITIMATE[relation]));
        const access = EXPECTED[operation];
        if (access === "own_subtree" || access === "own_run") {
          expect(result, relation).toEqual({ allowed: true });
        } else {
          expect(result, relation).toMatchObject({ allowed: false });
        }
      }
    },
  );

  it.each(ALL_OPERATIONS)(
    "refuses %s on a sibling's subtree wherever it is scoped to a node",
    (operation) => {
      const result = authorize(orchestrator, operation, at("outside", LEGITIMATE.outside));
      const access = EXPECTED[operation];
      if (access === "own_run") {
        expect(result).toEqual({ allowed: true });
        return;
      }
      expect(result).toMatchObject({
        allowed: false,
        reason: access === "forbidden" ? "execution_forbidden_operation" : "execution_out_of_scope",
      });
    },
  );

  it.each(ALL_OPERATIONS)("refuses %s against another run", (operation) => {
    const result = authorize(orchestrator, operation, {
      ...at("self", LEGITIMATE.self),
      ...elsewhere.scope,
    });
    expect(result).toMatchObject({ allowed: false });
  });

  it("fails closed when nobody placed the target in the tree", () => {
    const { nodeRelation: _unplaced, ...unplaced } = at("descendant", "cancelled");
    for (const operation of ALL_OPERATIONS.filter((op) => EXPECTED[op] === "own_subtree")) {
      expect(authorize(orchestrator, operation, unplaced), operation).toMatchObject({
        allowed: false,
        reason: "execution_out_of_scope",
      });
    }
  });

  it("may ask a node to become exactly what its place allows, over every status and place", () => {
    expect(ORCHESTRATOR_WRITABLE_NODE_STATUSES).toEqual({
      new_child: ["validated"],
      descendant: ["cancelled"],
      self: ["succeeded", "failed"],
      outside: [],
    });
    for (const relation of ["self", "descendant", "new_child", "outside"] as const) {
      for (const status of [...EXECUTION_NODE_STATUSES, "", "nonsense"]) {
        const allowed = authorize(orchestrator, "node.put", at(relation, status)).allowed;
        const expected = (
          ORCHESTRATOR_WRITABLE_NODE_STATUSES[relation] as readonly string[]
        ).includes(status);
        expect(allowed, `${relation} → ${status}`).toBe(expected);
      }
    }
  });

  it("can never start, verify, seal, integrate, or mint: those are the engine's", () => {
    for (const status of [
      "queued",
      "running",
      "implemented",
      "verifying",
      "verified",
      "sealed",
      "integrated",
    ]) {
      for (const relation of ["self", "descendant", "new_child"] as const) {
        expect(authorize(orchestrator, "node.put", at(relation, status)).allowed).toBe(false);
      }
    }
    for (const operation of [
      "agent.mintToken",
      "agent.put",
      "verification.put",
      "checkpoint.put",
      "routingDecision.put",
      "artifact.put",
      "run.put",
    ] as const) {
      expect(authorize(orchestrator, operation, at("self", "succeeded")).allowed, operation).toBe(
        false,
      );
    }
  });

  it("leaves a worker's token exactly as P4 made it: no subtree reach, whatever the target claims", () => {
    const worker: Principal = { ...orchestrator, role: "worker" };
    expect(authorize(worker, "node.put", at("new_child", "validated")).allowed).toBe(false);
    expect(authorize(worker, "job.put", at("self", "implemented")).allowed).toBe(false);
    expect(authorize(worker, "node.get", at("descendant", "cancelled")).allowed).toBe(false);
  });
});
