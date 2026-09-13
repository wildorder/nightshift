/**
 * SC-P1-17 — project IDs scope every aggregate.
 *
 * Driven from the contracts registry rather than a hand-written list, so a new
 * aggregate cannot be introduced without inheriting this check.
 */
import { AGGREGATE_EXAMPLES, AGGREGATE_NAMES, AGGREGATE_SCHEMAS } from "@nightshift/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const asRecord = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

/** Identifier prefixes that are never a valid `projectId`. */
const WRONG_PREFIXES = ["prog", "run", "node", "job", "agent", "evt"] as const;

describe("SC-P1-17: project IDs scope every aggregate", () => {
  it("checks every aggregate the registry knows about", () => {
    expect(AGGREGATE_NAMES.length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(AGGREGATE_SCHEMAS).sort()).toEqual([...AGGREGATE_NAMES].sort());
  });

  it("accepts the documented example for each aggregate", () => {
    for (const name of AGGREGATE_NAMES) {
      const result = AGGREGATE_SCHEMAS[name].safeParse(AGGREGATE_EXAMPLES[name]);
      expect(result.error?.issues ?? [], `${name} rejected its own example`).toEqual([]);
    }
  });

  it("rejects an absent projectId on every aggregate", () => {
    for (const name of AGGREGATE_NAMES) {
      const record = asRecord(AGGREGATE_EXAMPLES[name]);
      delete record.projectId;
      expect(
        AGGREGATE_SCHEMAS[name].safeParse(record).success,
        `${name} accepted a record with no projectId`,
      ).toBe(false);
    }
  });

  it("rejects an arbitrary non-identifier projectId on every aggregate", () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        // Only a correctly prefixed 26-character Crockford payload is valid, and
        // fc.string() will not produce one.
        fc.pre(!/^proj_[0-9A-HJKMNP-TV-Z]{26}$/.test(candidate));
        for (const name of AGGREGATE_NAMES) {
          const record = asRecord(AGGREGATE_EXAMPLES[name]);
          record.projectId = candidate;
          expect(
            AGGREGATE_SCHEMAS[name].safeParse(record).success,
            `${name} accepted projectId ${JSON.stringify(candidate)}`,
          ).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("rejects another aggregate's identifier as a projectId", () => {
    fc.assert(
      fc.property(fc.constantFrom(...WRONG_PREFIXES), (prefix) => {
        const candidate = `${prefix}_01HF7YAT00GGGGGGGGGGGGGGGG`;
        for (const name of AGGREGATE_NAMES) {
          const record = asRecord(AGGREGATE_EXAMPLES[name]);
          record.projectId = candidate;
          expect(
            AGGREGATE_SCHEMAS[name].safeParse(record).success,
            `${name} accepted ${candidate} as a projectId`,
          ).toBe(false);
        }
      }),
    );
  });

  it("rejects a non-string projectId on every aggregate", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.object(),
        ),
        (candidate) => {
          for (const name of AGGREGATE_NAMES) {
            const record = asRecord(AGGREGATE_EXAMPLES[name]);
            record.projectId = candidate;
            expect(AGGREGATE_SCHEMAS[name].safeParse(record).success).toBe(false);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
