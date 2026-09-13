/**
 * P1's exit demo (T7).
 *
 * Run it on its own:
 *
 * ```sh
 * npx vitest run --project test -t "P1 exit demo"
 * ```
 *
 * It prints a generated parent scope, a child that tried to widen it, and the
 * `ScopeWideningError` the domain library answered with. That is the whole point
 * of P1 in one screen: a child cannot widen its parent's authority, and the
 * refusal is structural rather than advisory.
 */
import { narrow, ScopeWideningError } from "@nightshift/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parentScope, wideningRequest } from "../arbitraries.js";

/** Renders a scope as an indented block, so the demo output reads as a document. */
const show = (label: string, value: unknown): string =>
  `  ${label}\n${JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;

describe("P1 exit demo", () => {
  it("refuses a child that tries to widen its parent's authority", () => {
    // Draw one concrete counterexample from the same generators the property
    // tests use, so the demo is not a hand-picked special case.
    const sample = fc.sample(
      parentScope().chain((parent) =>
        wideningRequest(parent).map((widening) => ({ parent, widening })),
      ),
      { numRuns: 200, seed: 20260913 },
    );

    const example = sample.find((candidate) => candidate.widening !== undefined);
    expect(example, "generators produced no widening to demonstrate").toBeDefined();
    if (example?.widening === undefined) return;

    const { parent, widening } = example;

    let caught: ScopeWideningError | undefined;
    try {
      narrow(parent, widening.request);
    } catch (error) {
      if (error instanceof ScopeWideningError) caught = error;
      else throw error;
    }

    expect(caught, "narrow accepted a widening request").toBeInstanceOf(ScopeWideningError);
    if (caught === undefined) return;

    const lines = [
      "",
      "─".repeat(72),
      "  SC-P1-10 — children may narrow inherited authority, never widen it",
      "─".repeat(72),
      show("parent scope (the authority actually held):", parent),
      "",
      show(`child request (widens the "${widening.kind}" dimension):`, widening.request),
      "",
      `  result: ${caught.name} (code "${caught.code}")`,
      ...caught.reasons.map((reason) => `    · ${reason}`),
      "",
      "  Unverified authority is not granted. The delegation is refused.",
      "─".repeat(72),
      "",
    ];
    console.info(lines.join("\n"));
  });
});
