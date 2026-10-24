/**
 * Who may touch a plan draft (P21): every role reads, writes a version and marks
 * it for the owner in its own project; answering, requesting changes and
 * declining are a person's.
 */
import type { ExecutionRole, OrgId, Principal, UserId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixturePair } from "../testing/factories.js";
import { ACCESS_BY_ROLE, authorize, type Operation, READ_OPERATIONS } from "./authorize.js";

const [here, elsewhere] = createFixturePair();
const ORG_A = "org_00000000000000000000000001" as OrgId;
const ORG_B = "org_00000000000000000000000002" as OrgId;

const ROLES: readonly ExecutionRole[] = ["worker", "orchestrator", "examiner", "arbiter", "engine"];
const READS: readonly Operation[] = [
  "planDraft.get",
  "planDraft.listByProject",
  "planDraft.listVersions",
  "planDraft.getVersion",
  "planDraft.getLatestVersion",
];
const OPEN_WRITES: readonly Operation[] = ["planDraft.putVersion", "planDraft.markAwaitingOwner"];
const HUMAN_ONLY: readonly Operation[] = [
  "planDraft.answer",
  "planDraft.requestChanges",
  "planDraft.decline",
  "program.ratify",
];

const execution = (role: ExecutionRole): Principal => ({
  kind: "execution",
  ...here.scope,
  nodeId: here.ids.next("node"),
  agentId: here.ids.next("agent"),
  role,
  ...(role === "engine" ? { generation: 1 } : {}),
});
const own = { orgId: ORG_A, projectId: here.scope.projectId, currentGeneration: 1 };
const other = { orgId: ORG_A, projectId: elsewhere.scope.projectId, currentGeneration: 1 };
const user: Principal = {
  kind: "user",
  userId: "58819310-5081-70f2-81fe-66601586db46" as UserId,
  orgId: ORG_A,
};

describe("plan draft authorization", () => {
  it("treats the reads as reads", () => {
    for (const operation of READS) expect(READ_OPERATIONS.has(operation), operation).toBe(true);
    for (const operation of OPEN_WRITES) {
      expect(READ_OPERATIONS.has(operation), operation).toBe(false);
    }
  });

  for (const role of ROLES) {
    describe(role, () => {
      const principal = (): Principal => execution(role);
      it("reads, writes a version and marks awaiting_owner in its own project only", () => {
        for (const operation of [...READS, ...OPEN_WRITES]) {
          expect(ACCESS_BY_ROLE[role][operation], operation).toBe("own_project");
          expect(authorize(principal(), operation, own), operation).toEqual({ allowed: true });
          expect(authorize(principal(), operation, other), operation).toMatchObject({
            allowed: false,
            reason: "execution_out_of_scope",
          });
        }
      });
      it("is refused answering, requesting changes, declining and ratifying", () => {
        for (const operation of HUMAN_ONLY) {
          expect(authorize(principal(), operation, own), operation).toMatchObject({
            allowed: false,
            reason: "execution_forbidden_operation",
          });
        }
      });
    });
  }

  it("lets a user of the project's organisation do everything, and no other", () => {
    for (const operation of [...READS, ...OPEN_WRITES, ...HUMAN_ONLY]) {
      expect(authorize(user, operation, own), operation).toEqual({ allowed: true });
      expect(authorize(user, operation, { ...own, orgId: ORG_B }), operation).toMatchObject({
        allowed: false,
        reason: "wrong_org",
      });
    }
  });
});
