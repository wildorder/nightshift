/**
 * The §4.4 table, asserted cell by cell (T1 deliverable 3).
 *
 * Nothing here is sampled. Every operation is walked for every principal kind
 * and for every target dimension that matters — same org and another org, same
 * node, another node and another run — because the value of a table this small
 * is that it can be checked completely, and because SC-P4-04 is the claim that a
 * worker's token does exactly the operations §4.4 grants and nothing else.
 */
import { type OrgId, type Principal, PrincipalSchema, type UserId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixturePair } from "../testing/factories.js";
import {
  ACCESS_BY_ROLE,
  ALL_OPERATIONS,
  type AuthorizationTarget,
  authorize,
  EXECUTION_ACCESS,
  EXECUTION_WRITABLE_NODE_STATUSES,
  type ExecutionAccess,
  type Operation,
} from "./authorize.js";
import { EXECUTION_NODE_STATUSES } from "./transitions.js";

const [here, elsewhere] = createFixturePair();

const ORG_A = "org_00000000000000000000000001" as OrgId;
const ORG_B = "org_00000000000000000000000002" as OrgId;

const OWN_NODE = here.ids.next("node");
const OTHER_NODE = here.ids.next("node");
const OWN_AGENT = here.ids.next("agent");
const OTHER_AGENT = here.ids.next("agent");

const user: Principal = {
  kind: "user",
  userId: "58819310-5081-70f2-81fe-66601586db46" as UserId,
  orgId: ORG_A,
};

const execution: Principal = {
  kind: "execution",
  projectId: here.scope.projectId,
  programId: here.scope.programId,
  runId: here.scope.runId,
  nodeId: OWN_NODE,
  agentId: OWN_AGENT,
  role: "worker",
};

/** Its own run, its own node, its own agent: the only fully in-scope target. */
const ownTarget: AuthorizationTarget = {
  orgId: ORG_A,
  projectId: here.scope.projectId,
  programId: here.scope.programId,
  runId: here.scope.runId,
  nodeId: OWN_NODE,
  agentId: OWN_AGENT,
  // What a worker's `node.put` asks for when it is doing its job. Only
  // `node.put` reads it; the status matrix at the end of this file walks the rest.
  requestedNodeStatus: "implemented",
};

/** The same run, a sibling's node and agent. */
const siblingTarget: AuthorizationTarget = {
  ...ownTarget,
  nodeId: OTHER_NODE,
  agentId: OTHER_AGENT,
};

/** Another run entirely, in the same organisation. */
const otherRunTarget: AuthorizationTarget = {
  orgId: ORG_A,
  projectId: elsewhere.scope.projectId,
  programId: elsewhere.scope.programId,
  runId: elsewhere.scope.runId,
  nodeId: OTHER_NODE,
  agentId: OTHER_AGENT,
  requestedNodeStatus: "implemented",
};

describe("the operation union", () => {
  it("carries an execution-access decision for every operation", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(EXECUTION_ACCESS[operation]).toBeDefined();
    }
  });

  it("names every operation exactly once", () => {
    expect(new Set(ALL_OPERATIONS).size).toBe(ALL_OPERATIONS.length);
  });
});

describe("a user principal", () => {
  it.each(ALL_OPERATIONS)("allows %s within its own organisation", (operation) => {
    expect(authorize(user, operation, ownTarget)).toEqual({ allowed: true });
  });

  it.each(ALL_OPERATIONS)("refuses %s against another organisation", (operation) => {
    const result = authorize(user, operation, { ...ownTarget, orgId: ORG_B });
    expect(result).toMatchObject({ allowed: false, reason: "wrong_org" });
  });

  it.each(ALL_OPERATIONS)("allows %s when the target has no organisation yet", (operation) => {
    // `project.list` and `project.put` are the real cases; asserting it for the
    // whole union proves the rule is about the target, not about the operation.
    expect(authorize(user, operation, {})).toEqual({ allowed: true });
  });

  it("is not affected by the node or the agent named in the target", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(authorize(user, operation, siblingTarget)).toEqual({ allowed: true });
      expect(authorize(user, operation, otherRunTarget)).toEqual({ allowed: true });
    }
  });
});

/** What §4.4 grants an execution, restated here so the table is checked twice. */
const EXPECTED_ACCESS: Readonly<Record<Operation, ExecutionAccess>> = {
  "project.list": "forbidden",
  "project.put": "forbidden",
  "project.get": "forbidden",
  "program.list": "forbidden",
  "program.put": "forbidden",
  "program.get": "forbidden",
  "program.ratify": "forbidden",
  "program.createPlanUploadUrl": "forbidden",
  "program.getPlanDocument": "forbidden",
  "prerequisite.list": "own_program",
  "prerequisite.put": "forbidden",
  "run.list": "forbidden",
  "run.put": "forbidden",
  "run.get": "own_run",
  "run.getState": "forbidden",
  "node.list": "own_run",
  "node.put": "own_node",
  "node.get": "own_node",
  "node.listChildren": "own_node",
  "job.list": "own_run",
  "job.put": "forbidden",
  "job.get": "own_run",
  "agent.put": "forbidden",
  "agent.get": "own_agent",
  "agent.listByNode": "own_node",
  "agent.mintToken": "forbidden",
  "event.append": "own_node",
  "event.list": "own_run",
  "decision.list": "own_run",
  "decision.put": "own_node",
  "decision.get": "own_run",
  "checkpoint.list": "own_run",
  "checkpoint.put": "forbidden",
  "checkpoint.get": "own_run",
  "verification.put": "forbidden",
  "verification.get": "own_run",
  "verification.listByNode": "own_node",
  "examination.put": "forbidden",
  "examination.get": "own_run",
  "examination.listByNode": "own_node",
  "routingDecision.put": "forbidden",
  "routingDecision.listByNode": "own_node",
  "artifact.list": "own_run",
  "artifact.put": "forbidden",
  "artifact.get": "own_run",
  "artifact.createUploadUrl": "forbidden",
  "artifact.createDownloadUrl": "forbidden",
  "orgConfig.get": "forbidden",
  "orgConfig.put": "forbidden",
  "dispatch.create": "forbidden",
  "dispatch.get": "forbidden",
  "dispatch.cancel": "forbidden",
  "dispatch.resume": "forbidden",
  "dispatch.heartbeat": "forbidden",
  "publication.request": "forbidden",
  "publication.list": "forbidden",
  "computeUtilization.get": "forbidden",
  "computeRecommendation.get": "forbidden",
  "warmCache.get": "forbidden",
  "gateHealth.get": "forbidden",
  "gateHealth.put": "forbidden",
  "orgCredential.put": "forbidden",
  "orgCredential.list": "forbidden",
  "orgGithub.put": "forbidden",
  "orgGithub.get": "forbidden",
  "orgGithub.delete": "forbidden",
  "githubApp.get": "forbidden",
};

describe("an execution principal", () => {
  it("matches the table restated in this test, cell for cell", () => {
    expect(EXECUTION_ACCESS).toEqual(EXPECTED_ACCESS);
  });

  it.each(ALL_OPERATIONS)("decides %s on its own node as the table says", (operation) => {
    const access = EXPECTED_ACCESS[operation];
    const result = authorize(execution, operation, ownTarget);
    if (access === "forbidden") {
      expect(result).toMatchObject({
        allowed: false,
        reason: "execution_forbidden_operation",
      });
    } else {
      expect(result).toEqual({ allowed: true });
    }
  });

  it.each(ALL_OPERATIONS)("refuses %s against another run", (operation) => {
    const access = EXPECTED_ACCESS[operation];
    const result = authorize(execution, operation, otherRunTarget);
    expect(result).toMatchObject({
      allowed: false,
      reason: access === "forbidden" ? "execution_forbidden_operation" : "execution_out_of_scope",
    });
  });

  it.each(ALL_OPERATIONS)(
    "refuses %s against a sibling node where it is scoped to one",
    (operation) => {
      const access = EXPECTED_ACCESS[operation];
      const result = authorize(execution, operation, siblingTarget);
      if (access === "own_run" || access === "own_program") {
        // Run- and program-scoped reads do not care which node the path happens to name.
        expect(result).toEqual({ allowed: true });
        return;
      }
      expect(result).toMatchObject({
        allowed: false,
        reason: access === "forbidden" ? "execution_forbidden_operation" : "execution_out_of_scope",
      });
    },
  );

  it("ignores the organisation on the target: its reach is the run, not the org", () => {
    // The chain is what binds an execution. An org it never sees cannot widen or
    // narrow it, and a user's org check is a separate rule.
    expect(authorize(execution, "run.get", { ...ownTarget, orgId: ORG_B })).toEqual({
      allowed: true,
    });
  });

  it("writes exactly three things, and they are all on its own node", () => {
    const writes = ALL_OPERATIONS.filter(
      (operation) =>
        EXECUTION_ACCESS[operation] !== "forbidden" &&
        (operation.endsWith(".put") ||
          operation.endsWith(".append") ||
          operation.endsWith(".createUploadUrl") ||
          operation.endsWith(".createDownloadUrl") ||
          operation === "agent.mintToken"),
    );
    expect(writes).toEqual(["node.put", "event.append", "decision.put"]);
    for (const operation of writes) expect(EXECUTION_ACCESS[operation]).toBe("own_node");
  });

  /**
   * P11 (D-P11-06): a signed read of an artifact body is a human's. Walked over
   * every role rather than the worker alone, because the examiner's and
   * arbiter's tables are cut from the worker's and a cell added to one of them
   * would be the quiet way to give a running agent a transcript.
   */
  it("is refused a signed download of an artifact body, whatever its role", () => {
    for (const role of ["worker", "orchestrator", "examiner", "arbiter"] as const) {
      expect(ACCESS_BY_ROLE[role]["artifact.createDownloadUrl"], role).toBe("forbidden");
      expect(
        authorize({ ...execution, role }, "artifact.createDownloadUrl", ownTarget),
        role,
      ).toMatchObject({ allowed: false, reason: "execution_forbidden_operation" });
    }
    // While a user in the owning organisation is allowed, like every other read.
    expect(authorize(user, "artifact.createDownloadUrl", ownTarget)).toEqual({ allowed: true });
  });

  /**
   * P15 (D-P15-07): the gate-health record is written by a Nightshift command
   * or the engine, never by an agent. Walked over every agent role for the same
   * reason as the signed download.
   */
  it("is refused the project's gate health, whatever its agent role", () => {
    for (const role of ["worker", "orchestrator", "examiner", "arbiter"] as const) {
      for (const operation of ["gateHealth.get", "gateHealth.put"] as const) {
        expect(ACCESS_BY_ROLE[role][operation], `${role} ${operation}`).toBe("forbidden");
        expect(
          authorize({ ...execution, role }, operation, {
            orgId: ORG_A,
            projectId: here.scope.projectId,
          }),
          `${role} ${operation}`,
        ).toMatchObject({ allowed: false, reason: "execution_forbidden_operation" });
      }
    }
    // A member of the owning organisation reads and writes it; anyone else is refused.
    for (const operation of ["gateHealth.get", "gateHealth.put"] as const) {
      expect(authorize(user, operation, { orgId: ORG_A, projectId: here.scope.projectId })).toEqual(
        {
          allowed: true,
        },
      );
      expect(
        authorize(user, operation, { orgId: ORG_B, projectId: here.scope.projectId }),
      ).toMatchObject({
        allowed: false,
        reason: "wrong_org",
      });
    }
  });

  it("can never mint a token, create a node, or write a verification", () => {
    for (const operation of [
      "agent.mintToken",
      "agent.put",
      "verification.put",
      "checkpoint.put",
      "routingDecision.put",
      "run.put",
      "job.put",
    ] as const) {
      expect(authorize(execution, operation, ownTarget)).toMatchObject({
        allowed: false,
        reason: "execution_forbidden_operation",
      });
    }
  });

  it("cannot read the project or the program it runs in", () => {
    for (const operation of [
      "project.get",
      "project.list",
      "program.get",
      "program.list",
      "run.getState",
    ] as const) {
      expect(authorize(execution, operation, ownTarget)).toMatchObject({
        allowed: false,
        reason: "execution_forbidden_operation",
      });
    }
  });

  it("reads its own program's prerequisites from any run of it, and no other program's (P7)", () => {
    // The route is program scoped, so the target names no run, node or agent.
    const program = { projectId: here.scope.projectId, programId: here.scope.programId };
    expect(authorize(execution, "prerequisite.list", program)).toEqual({ allowed: true });
    expect(
      authorize(execution, "prerequisite.list", {
        projectId: elsewhere.scope.projectId,
        programId: elsewhere.scope.programId,
      }),
    ).toMatchObject({ allowed: false, reason: "execution_out_of_scope" });
    expect(
      authorize(execution, "prerequisite.list", {
        ...program,
        programId: elsewhere.scope.programId,
      }),
    ).toMatchObject({ allowed: false, reason: "execution_out_of_scope" });
  });

  it("can write nothing of a plan: not a ratification, a document or a prerequisite (P7)", () => {
    for (const operation of [
      "program.ratify",
      "program.createPlanUploadUrl",
      "prerequisite.put",
    ] as const) {
      expect(authorize(execution, operation, ownTarget)).toMatchObject({
        allowed: false,
        reason: "execution_forbidden_operation",
      });
    }
  });

  it("reads its own agent but not a sibling's", () => {
    expect(authorize(execution, "agent.get", ownTarget)).toEqual({ allowed: true });
    expect(authorize(execution, "agent.get", { ...ownTarget, agentId: OTHER_AGENT })).toMatchObject(
      { allowed: false, reason: "execution_out_of_scope" },
    );
  });

  it("is refused when any single link of the chain differs", () => {
    const links: readonly (keyof AuthorizationTarget)[] = ["projectId", "programId", "runId"];
    for (const link of links) {
      const target = { ...ownTarget, [link]: otherRunTarget[link] };
      expect(authorize(execution, "run.get", target)).toMatchObject({
        allowed: false,
        reason: "execution_out_of_scope",
      });
    }
  });

  it("never carries a credential in a refusal detail", () => {
    for (const operation of ALL_OPERATIONS) {
      const result = authorize(execution, operation, otherRunTarget);
      if (result.allowed) continue;
      expect(result.detail).not.toMatch(/eyJ|Bearer|token=/);
    }
  });
});

describe("the principal schema", () => {
  it("accepts both kinds and nothing else", () => {
    expect(PrincipalSchema.parse(user)).toEqual(user);
    expect(PrincipalSchema.parse(execution)).toEqual(execution);
    expect(PrincipalSchema.safeParse({ kind: "service" }).success).toBe(false);
  });

  it("accepts the five roles a token is minted for, and no other (D-P6-04, D-P8-10, D-P8-13, D-P10-20)", () => {
    for (const role of ["orchestrator", "examiner", "arbiter", "engine"]) {
      expect(PrincipalSchema.safeParse({ ...execution, role }).success, role).toBe(true);
    }
    for (const role of ["answerer", "user", ""]) {
      expect(PrincipalSchema.safeParse({ ...execution, role }).success, role).toBe(false);
    }
  });

  it("refuses a user principal carrying a run", () => {
    expect(PrincipalSchema.safeParse({ ...user, runId: here.scope.runId }).success).toBe(false);
  });
});

/**
 * An allowed operation is not an allowed content. `node.put` is one cell of the
 * matrix above and fifteen statuses; D-P4-05 grants a worker two of them. This
 * walks all fifteen, because the gap this closes survived a 260-cell matrix
 * precisely by not being a question about operations.
 */
describe("what an execution may ask its own node to become", () => {
  it("is exactly implemented and failed", () => {
    expect([...EXECUTION_WRITABLE_NODE_STATUSES]).toEqual(["implemented", "failed"]);
  });

  it.each(EXECUTION_NODE_STATUSES.map((status) => [status] as const))(
    "node.put asking for %s",
    (status) => {
      const decision = authorize(execution, "node.put", {
        ...ownTarget,
        requestedNodeStatus: status,
      });
      if ((EXECUTION_WRITABLE_NODE_STATUSES as readonly string[]).includes(status)) {
        expect(decision.allowed).toBe(true);
        return;
      }
      expect(decision).toMatchObject({
        allowed: false,
        reason: "execution_forbidden_operation",
      });
    },
  );

  it("fails closed on a node.put that names no status, or one that is not a status", () => {
    const { requestedNodeStatus: _dropped, ...noStatus } = ownTarget;
    expect(authorize(execution, "node.put", noStatus)).toMatchObject({
      allowed: false,
      reason: "execution_forbidden_operation",
    });
    expect(
      authorize(execution, "node.put", { ...ownTarget, requestedNodeStatus: "verified " }),
    ).toMatchObject({ allowed: false, reason: "execution_forbidden_operation" });
  });

  it("still refuses a sibling's node as out of scope, whatever status is asked", () => {
    expect(
      authorize(execution, "node.put", { ...siblingTarget, requestedNodeStatus: "failed" }),
    ).toMatchObject({ allowed: false, reason: "execution_out_of_scope" });
  });

  it("does not constrain a user, who may assert any status the table allows", () => {
    for (const status of EXECUTION_NODE_STATUSES) {
      expect(
        authorize(user, "node.put", { ...ownTarget, requestedNodeStatus: status }).allowed,
      ).toBe(true);
    }
  });

  it("reads the requested status for node.put only", () => {
    // Every other own-node write ignores it: a decision or an event carrying a
    // `status` field is not a node asking to change state.
    for (const operation of ["event.append", "decision.put"] as const) {
      expect(
        authorize(execution, operation, { ...ownTarget, requestedNodeStatus: "verifying" }).allowed,
      ).toBe(true);
    }
  });
});
