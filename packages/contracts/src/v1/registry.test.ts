/**
 * Registry-driven contract tests.
 *
 * These iterate `AGGREGATE_SCHEMAS` rather than naming schemas one by one, so a
 * new aggregate automatically inherits the project-scoping, schema-version and
 * strictness checks. SC-P1-17 depends on exactly that: adding an aggregate
 * without a `projectId` must fail a test nobody had to remember to write.
 */
import { describe, expect, it } from "vitest";
import { AGGREGATE_EXAMPLES } from "./examples.js";
import {
  AGGREGATE_NAMES,
  AGGREGATE_SCHEMAS,
  type AggregateName,
  RUN_SCOPED_AGGREGATES,
} from "./registry.js";

const asRecord = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

const without = (value: unknown, field: string): Record<string, unknown> => {
  const clone = asRecord(value);
  delete clone[field];
  return clone;
};

const withField = (
  value: unknown,
  field: string,
  replacement: unknown,
): Record<string, unknown> => {
  const clone = asRecord(value);
  clone[field] = replacement;
  return clone;
};

const entries = AGGREGATE_NAMES.map(
  (name) => [name, AGGREGATE_SCHEMAS[name], AGGREGATE_EXAMPLES[name]] as const,
);

describe("aggregate registry", () => {
  it("covers exactly the aggregates named in the source plan", () => {
    expect(Object.keys(AGGREGATE_SCHEMAS).sort()).toEqual([...AGGREGATE_NAMES].sort());
  });

  it("has an example for every aggregate", () => {
    for (const name of AGGREGATE_NAMES) {
      expect(AGGREGATE_EXAMPLES[name], `missing example for ${name}`).toBeDefined();
    }
  });
});

describe.each(entries)("%s", (_name, schema, example) => {
  it("accepts its documented valid example", () => {
    const result = schema.safeParse(example);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  // SC-P1-17: projectId scopes every aggregate (A-07).
  it("rejects a missing projectId", () => {
    expect(schema.safeParse(without(example, "projectId")).success).toBe(false);
  });

  it("rejects a malformed projectId", () => {
    for (const malformed of [
      "proj_not-a-ulid",
      "proj_",
      "",
      "prog_01HF7YAT00GGGGGGGGGGGGGGGG",
      42,
    ]) {
      expect(
        schema.safeParse(withField(example, "projectId", malformed)).success,
        `accepted malformed projectId ${JSON.stringify(malformed)}`,
      ).toBe(false);
    }
  });

  it("rejects a schemaVersion other than 1", () => {
    for (const version of [0, 2, "1", null, undefined]) {
      expect(
        schema.safeParse(withField(example, "schemaVersion", version)).success,
        `accepted schemaVersion ${JSON.stringify(version)}`,
      ).toBe(false);
    }
  });

  it("rejects an unknown field", () => {
    expect(schema.safeParse(withField(example, "unexpectedField", "surprise")).success).toBe(false);
  });
});

describe.each(RUN_SCOPED_AGGREGATES.map((name: AggregateName) => [name] as const))(
  "%s ownership chain",
  (name) => {
    const schema = AGGREGATE_SCHEMAS[name];
    const example = AGGREGATE_EXAMPLES[name];

    it("requires programId", () => {
      expect(schema.safeParse(without(example, "programId")).success).toBe(false);
    });

    it("requires runId", () => {
      expect(schema.safeParse(without(example, "runId")).success).toBe(false);
    });

    it("rejects a runId that is not a run identifier", () => {
      expect(
        schema.safeParse(withField(example, "runId", "prog_01HF7YAT00GGGGGGGGGGGGGGGG")).success,
      ).toBe(false);
    });
  },
);
