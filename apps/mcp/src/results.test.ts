import { describe, expect, it } from "vitest";
import { ok } from "./results.js";

describe("ok", () => {
  it("carries its summary in the structured half, which is all Claude Code shows its model (PIP-32)", () => {
    const result = ok("Revise the plan: J1 and J2 collide.", { verdict: "revise" });
    expect(result.content).toEqual([{ type: "text", text: "Revise the plan: J1 and J2 collide." }]);
    expect(result.structuredContent).toEqual({
      ok: true,
      message: "Revise the plan: J1 and J2 collide.",
      verdict: "revise",
    });
  });
});
