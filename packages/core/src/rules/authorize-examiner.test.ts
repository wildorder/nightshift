/**
 * The examiner's and the arbiter's tables (P8, D-P8-10, D-P8-13), asserted
 * cell by cell against the worker's they are cut from.
 *
 * Each is a worker's table with exactly the differences restated here, so a
 * change to either that is not a change to this file fails.
 */
import type { OrgId, Principal } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixturePair } from "../testing/factories.js";
import {
  ALL_OPERATIONS,
  ARBITER_ACCESS,
  type AuthorizationTarget,
  authorize,
  EXAMINER_ACCESS,
  EXECUTION_ACCESS,
  type Operation,
} from "./authorize.js";

const [here] = createFixturePair();
const OWN_NODE = here.ids.next("node");
const OTHER_NODE = here.ids.next("node");
const OWN_AGENT = here.ids.next("agent");

const principal = (role: "examiner" | "arbiter"): Principal => ({
  kind: "execution",
  ...here.scope,
  nodeId: OWN_NODE,
  agentId: OWN_AGENT,
  role,
});

const target = (nodeId: string, requestedNodeStatus?: string): AuthorizationTarget => ({
  orgId: "org_00000000000000000000000001" as OrgId,
  ...here.scope,
  nodeId: nodeId as never,
  agentId: OWN_AGENT,
  ...(requestedNodeStatus === undefined ? {} : { requestedNodeStatus }),
});

const differences = (table: typeof EXECUTION_ACCESS): Partial<Record<Operation, string>> =>
  Object.fromEntries(
    ALL_OPERATIONS.filter((operation) => table[operation] !== EXECUTION_ACCESS[operation]).map(
      (operation) => [operation, table[operation]],
    ),
  );

describe("the examiner's table (D-P8-10)", () => {
  it("is a worker's, but writes its own examination and moves nothing", () => {
    expect(differences(EXAMINER_ACCESS)).toEqual({
      "node.put": "forbidden",
      "decision.put": "forbidden",
      "examination.put": "own_node",
    });
  });

  it("may write an examination of its own node, and of no other", () => {
    expect(authorize(principal("examiner"), "examination.put", target(OWN_NODE))).toEqual({
      allowed: true,
    });
    expect(authorize(principal("examiner"), "examination.put", target(OTHER_NODE))).toMatchObject({
      allowed: false,
      reason: "execution_out_of_scope",
    });
  });

  it("may not move its node, whatever it asks for", () => {
    for (const status of ["implemented", "failed", "verified", "sealed"]) {
      expect(
        authorize(principal("examiner"), "node.put", target(OWN_NODE, status)),
        status,
      ).toMatchObject({
        allowed: false,
        reason: "execution_forbidden_operation",
      });
    }
  });
});

describe("the arbiter's table (D-P8-13)", () => {
  it("is a worker's, but records its ruling and moves nothing", () => {
    expect(differences(ARBITER_ACCESS)).toEqual({ "node.put": "forbidden" });
    expect(ARBITER_ACCESS["decision.put"]).toBe("own_node");
    expect(ARBITER_ACCESS["examination.put"]).toBe("forbidden");
  });

  it("may record a decision on its own node, and write no examination", () => {
    expect(authorize(principal("arbiter"), "decision.put", target(OWN_NODE))).toEqual({
      allowed: true,
    });
    expect(authorize(principal("arbiter"), "decision.put", target(OTHER_NODE))).toMatchObject({
      allowed: false,
    });
    expect(authorize(principal("arbiter"), "examination.put", target(OWN_NODE))).toMatchObject({
      allowed: false,
      reason: "execution_forbidden_operation",
    });
  });

  it("may not mint a token or reach its org's configuration", () => {
    for (const operation of ["agent.mintToken", "orgConfig.get", "orgConfig.put"] as const) {
      expect(authorize(principal("arbiter"), operation, target(OWN_NODE)), operation).toMatchObject(
        {
          allowed: false,
        },
      );
      expect(
        authorize(principal("examiner"), operation, target(OWN_NODE)),
        operation,
      ).toMatchObject({
        allowed: false,
      });
    }
  });
});
