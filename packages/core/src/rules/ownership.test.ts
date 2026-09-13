import { describe, expect, it } from "vitest";
import { OwnershipViolationError } from "../errors.js";
import { createFixturePair } from "../testing/factories.js";
import {
  assertOwnershipChain,
  assertSameProgram,
  assertSameProject,
  assertSameRun,
  runScopeOf,
  sameProject,
  sameRun,
} from "./ownership.js";

// One shared generator, so every identifier in world b differs from world a.
const [a, b] = createFixturePair();

describe("assertSameProject", () => {
  it("accepts the same project", () => {
    expect(() => assertSameProject(a.scope, a.scope)).not.toThrow();
  });

  // SC-P1-12: a job can never move between projects.
  it("rejects a different project", () => {
    expect(() => assertSameProject(a.scope, b.scope)).toThrow(OwnershipViolationError);
  });

  it("names the offending field and both values", () => {
    try {
      assertSameProject(a.scope, b.scope);
      expect.unreachable("should have thrown");
    } catch (error) {
      const violation = error as OwnershipViolationError;
      expect(violation.field).toBe("projectId");
      expect(violation.expected).toBe(a.scope.projectId);
      expect(violation.actual).toBe(b.scope.projectId);
      expect(violation.code).toBe("ownership_violation");
    }
  });
});

describe("assertSameProgram", () => {
  it("rejects a matching project with a different program", () => {
    const mixed = { ...a.scope, programId: b.scope.programId };
    expect(() => assertSameProgram(a.scope, mixed)).toThrow(OwnershipViolationError);
    try {
      assertSameProgram(a.scope, mixed);
    } catch (error) {
      expect((error as OwnershipViolationError).field).toBe("programId");
    }
  });
});

describe("assertSameRun", () => {
  it("rejects a matching program with a different run", () => {
    const mixed = { ...a.scope, runId: b.scope.runId };
    expect(() => assertSameRun(a.scope, mixed)).toThrow(OwnershipViolationError);
    try {
      assertSameRun(a.scope, mixed);
    } catch (error) {
      expect((error as OwnershipViolationError).field).toBe("runId");
    }
  });

  it("checks the chain outermost first, so the most significant mismatch is reported", () => {
    // Every part differs; projectId is the one that should surface.
    try {
      assertSameRun(a.scope, b.scope);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as OwnershipViolationError).field).toBe("projectId");
    }
  });
});

describe("assertOwnershipChain", () => {
  it("accepts a child in the same chain", () => {
    expect(() => assertOwnershipChain(a.scope, { ...a.scope })).not.toThrow();
  });

  it("rejects a child in any other chain", () => {
    expect(() => assertOwnershipChain(a.scope, b.scope)).toThrow(OwnershipViolationError);
  });
});

describe("non-throwing predicates", () => {
  it("sameProject and sameRun agree with the assertions", () => {
    expect(sameProject(a.scope, a.scope)).toBe(true);
    expect(sameProject(a.scope, b.scope)).toBe(false);
    expect(sameRun(a.scope, a.scope)).toBe(true);
    expect(sameRun(a.scope, { ...a.scope, runId: b.scope.runId })).toBe(false);
  });
});

describe("runScopeOf", () => {
  it("extracts exactly the three chain fields", () => {
    const node = { ...a.scope, extra: "ignored" };
    expect(Object.keys(runScopeOf(node)).sort()).toEqual(["programId", "projectId", "runId"]);
  });
});
