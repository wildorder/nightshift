/**
 * P14 adds stories to the planned part of a contract. A contract ratified
 * before P14 must hash exactly as it did, or every ratified program would read
 * as edited and `nightshift run` would refuse it (D-P7-02).
 */
import { createHash } from "node:crypto";
import { AGGREGATE_EXAMPLES, ProgramContractSchema } from "@nightshift/contracts";
import { planHash } from "@nightshift/core";
import { describe, expect, it } from "vitest";

describe("the plan hash across P14", () => {
  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

  it("hashes a contract written before P14 exactly as P13 did", () => {
    // The golden value is main's own build (3e4a297) over the same contract.
    const example = structuredClone(AGGREGATE_EXAMPLES.ProgramContract) as Record<string, unknown>;
    delete example.stories;
    example.successCriteria = (example.successCriteria as { serves?: unknown }[]).map(
      ({ serves: _serves, ...criterion }) => criterion,
    );
    const contract = ProgramContractSchema.parse(example);
    expect(planHash(contract, "# Plan\n\ntext\n", sha256).hash).toBe(
      "795a5c43576ec892fdf088758b5bc96f22ac2702106e040757deb69c3fb81fbb",
    );
    const emptied = ProgramContractSchema.parse({
      ...example,
      stories: [],
      successCriteria: (example.successCriteria as object[]).map((criterion) => ({
        ...criterion,
        serves: [],
      })),
    });
    expect(planHash(emptied, "# Plan\n\ntext\n", sha256)).toEqual(
      planHash(contract, "# Plan\n\ntext\n", sha256),
    );
  });
});
