/** The timeline's one line per event (T4), including an environment fault (P16 D-07). */
import { createFixtures, makeEvent } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { narrate } from "./narrate";

const f = createFixtures();
const fault = {
  baseCommit: "c".repeat(40),
  referenceNode: "24.4.1",
  machineNode: "18.20.4",
  gates: [
    {
      id: "unit",
      command: "npm test",
      kind: "check",
      reference: "passed",
      machine: "failed",
      machineTail: "TypeError: fetch is not a function",
    },
  ],
};

describe("narrate", () => {
  it("narrates an environment fault: the gates, both verdicts and both Nodes", () => {
    const line = narrate(
      makeEvent(f, { type: "environment.fault", source: "control-plane", payload: fault }),
    );
    expect(line).toBe(
      "environment fault: unit (passed on the reference, failed here); Node 24.4.1 on the " +
        "reference, 18.20.4 on the machine. The machine is at fault, not the base: nothing is " +
        "repaired, and the run is cancelled",
    );
  });

  it("names the part of a fault written as several events, and a missing Node", () => {
    const { referenceNode: _none, ...withoutReference } = fault;
    const line = narrate(
      makeEvent(f, {
        type: "environment.fault",
        source: "control-plane",
        payload: { ...withoutReference, part: 2, parts: 3 },
      }),
    );
    expect(line).toContain("environment fault (part 2 of 3): unit");
    expect(line).toContain("Node none on the reference, 18.20.4 on the machine");
  });

  it("still names an event it has no words for", () => {
    expect(narrate(makeEvent(f, { type: "gate.flaked", payload: {} }))).toBe("gate.flaked");
  });
});
