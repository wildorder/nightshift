/**
 * The line owner's reach (Pipkin M1b): the line.* operations but `line.cancel`,
 * on its own project and branch, and a write only under the line dispatch's
 * current generation.
 */
import type { LinePrincipal, OrgId, UserId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixturePair } from "../testing/factories.js";
import {
  ALL_OPERATIONS,
  type AuthorizationTarget,
  authorize,
  type Operation,
  READ_OPERATIONS,
} from "./authorize.js";

const [here, elsewhere] = createFixturePair();
const BRANCH = "nightshift/develop";

const principal: LinePrincipal = {
  kind: "line",
  projectId: here.scope.projectId,
  branch: BRANCH,
  agentId: here.ids.next("agent"),
  generation: 3,
};

const own: AuthorizationTarget = {
  projectId: here.scope.projectId,
  branch: BRANCH,
  currentGeneration: 3,
};

const LINE_OPERATIONS = ALL_OPERATIONS.filter((operation) => operation.startsWith("line."));
const OWN_LINE_OPERATIONS = LINE_OPERATIONS.filter((operation) => operation !== "line.cancel");

describe("authorize, for a line principal", () => {
  it("allows every line operation but cancel on its own line", () => {
    for (const operation of OWN_LINE_OPERATIONS) {
      expect(authorize(principal, operation, own), operation).toEqual({ allowed: true });
    }
  });

  it("refuses line.cancel, which is a human's", () => {
    expect(authorize(principal, "line.cancel", own)).toMatchObject({
      allowed: false,
      reason: "execution_forbidden_operation",
    });
  });

  it("refuses every operation outside the line.* family", () => {
    for (const operation of ALL_OPERATIONS.filter((op) => !op.startsWith("line."))) {
      expect(authorize(principal, operation, own), operation).toMatchObject({ allowed: false });
    }
  });

  it("refuses another project, another branch, and an unnamed branch", () => {
    const targets: AuthorizationTarget[] = [
      { ...own, projectId: elsewhere.scope.projectId },
      { ...own, branch: "nightshift/other" },
      { projectId: own.projectId, currentGeneration: 3 } as AuthorizationTarget,
    ];
    for (const target of targets) {
      for (const operation of OWN_LINE_OPERATIONS) {
        expect(authorize(principal, operation, target), operation).toMatchObject({
          allowed: false,
          reason: "execution_out_of_scope",
        });
      }
    }
  });

  it("refuses a write under a generation the dispatch has moved past, or an unknown one", () => {
    for (const operation of OWN_LINE_OPERATIONS.filter((op) => !READ_OPERATIONS.has(op))) {
      expect(authorize(principal, operation, { ...own, currentGeneration: 4 })).toMatchObject({
        allowed: false,
        reason: "stale_generation",
      });
      const { currentGeneration: _unknown, ...unresolved } = own;
      expect(authorize(principal, operation, unresolved)).toMatchObject({
        allowed: false,
        reason: "stale_generation",
      });
    }
  });

  it("lets a read through whatever the generation", () => {
    const { currentGeneration: _unknown, ...unresolved } = own;
    expect(authorize(principal, "line.get", unresolved)).toEqual({ allowed: true });
    expect(authorize(principal, "line.get", { ...own, currentGeneration: 9 })).toEqual({
      allowed: true,
    });
  });
});

describe("authorize, for a user and the line operations", () => {
  const user = (orgId: OrgId) => ({ kind: "user", userId: "user_x" as UserId, orgId }) as const;
  const ORG_A = "org_00000000000000000000000001" as OrgId;
  const ORG_B = "org_00000000000000000000000002" as OrgId;

  it("allows the org's own users every line operation and refuses another org's", () => {
    for (const operation of LINE_OPERATIONS as readonly Operation[]) {
      expect(authorize(user(ORG_A), operation, { ...own, orgId: ORG_A })).toEqual({
        allowed: true,
      });
      expect(authorize(user(ORG_A), operation, { ...own, orgId: ORG_B })).toMatchObject({
        allowed: false,
        reason: "wrong_org",
      });
    }
  });
});
