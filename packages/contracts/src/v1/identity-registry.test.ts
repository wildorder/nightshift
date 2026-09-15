import { describe, expect, it } from "vitest";
import {
  EXAMPLE_USER_ID,
  IDENTITY_EXAMPLES,
  IDENTITY_RECORD_NAMES,
  IDENTITY_SCHEMAS,
} from "./identity-registry.js";
import { AGGREGATE_NAMES } from "./registry.js";

const withField = (value: unknown, field: string, replacement: unknown) => ({
  ...(structuredClone(value) as Record<string, unknown>),
  [field]: replacement,
});

const entries = IDENTITY_RECORD_NAMES.map(
  (name) => [name, IDENTITY_SCHEMAS[name], IDENTITY_EXAMPLES[name]] as const,
);

describe("identity registry", () => {
  it("covers exactly the identity records", () => {
    expect(Object.keys(IDENTITY_SCHEMAS).sort()).toEqual([...IDENTITY_RECORD_NAMES].sort());
  });

  it("stays disjoint from the project-scoped aggregate registry (D-P2-17)", () => {
    const aggregates = new Set<string>(AGGREGATE_NAMES);
    for (const name of IDENTITY_RECORD_NAMES) expect(aggregates.has(name)).toBe(false);
  });
});

describe.each(entries)("%s", (_name, schema, example) => {
  it("accepts its documented valid example", () => {
    const result = schema.safeParse(example);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("rejects a schemaVersion other than 1", () => {
    for (const version of [0, 2, "1", null, undefined]) {
      expect(schema.safeParse(withField(example, "schemaVersion", version)).success).toBe(false);
    }
  });

  it("rejects an unknown field", () => {
    expect(schema.safeParse(withField(example, "unexpectedField", 1)).success).toBe(false);
  });

  it("carries no projectId: identity sits above every project", () => {
    expect(Object.hasOwn(example as object, "projectId")).toBe(false);
  });

  it("rejects a userId that could corrupt a composite key", () => {
    for (const bad of ["", "has#hash", "has space", "-leading-hyphen", "x".repeat(129)]) {
      expect(schema.safeParse(withField(example, "userId", bad)).success, bad).toBe(false);
    }
  });
});

describe("User", () => {
  it("accepts a machine principal keyed by an app client id, with no email", () => {
    const machine = {
      schemaVersion: 1,
      userId: "4q2jv9a1b3c5d7e9f1g3h5j7k9",
      kind: "machine",
      createdAt: "2026-09-14T09:00:00.000Z",
    };
    expect(IDENTITY_SCHEMAS.User.safeParse(machine).success).toBe(true);
  });

  it("rejects an unknown principal kind", () => {
    expect(
      IDENTITY_SCHEMAS.User.safeParse(withField(IDENTITY_EXAMPLES.User, "kind", "robot")).success,
    ).toBe(false);
  });
});

describe("Membership", () => {
  it("rejects an orgId that is not an org identifier", () => {
    const record = withField(IDENTITY_EXAMPLES.Membership, "orgId", `proj_${"0".repeat(26)}`);
    expect(IDENTITY_SCHEMAS.Membership.safeParse(record).success).toBe(false);
  });

  it("uses the same subject as the example user", () => {
    expect((IDENTITY_EXAMPLES.Membership as { userId: string }).userId).toBe(EXAMPLE_USER_ID);
  });
});
