/** A job's verification runs the landing steps; the run's end gates are the rest (A-57). */
import { describe, expect, it } from "vitest";
import { endSteps, landingSteps } from "./gate-repair.js";

const gates = {
  setup: [],
  verification: [
    { id: "test", command: "npm test" },
    { id: "lint", command: "npm run lint", at: "landing" as const },
    { id: "e2e", command: "npm run e2e", at: "end" as const },
  ],
};

describe("the end gates", () => {
  it("are the steps declared at the end, and every other step is a landing step", () => {
    expect(landingSteps(gates).map((step) => step.id)).toEqual(["test", "lint"]);
    expect(endSteps(gates).map((step) => step.id)).toEqual(["e2e"]);
  });
});
