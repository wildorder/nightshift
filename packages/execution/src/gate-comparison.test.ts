import type { ArtifactId, ReferenceGate, ReferenceGateVerdict } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import type { AuditedGate, GateVerdict } from "./gate-audit.js";
import { compareWithReference, type GateAgreement, gateAgreement } from "./gate-comparison.js";

const ART = "art_01M4AAAAAAAAAAAAAAAAAAAAAA" as ArtifactId;

const machineGate = (id: string, verdict: GateVerdict): AuditedGate => ({
  id,
  command: `npm run ${id}`,
  kind: "check",
  verdict,
  waitingOn: [],
});

const VERDICTS: readonly GateVerdict[] = ["passed", "failed", "deferred", "waiting", "unrun"];

describe("the machine's audit against the reference (P16 S-02, D-07)", () => {
  // The plan's table, every row, and every pairing it implies.
  const rows: ReadonlyArray<[ReferenceGateVerdict | undefined, GateVerdict, GateAgreement]> = [
    ["passed", "passed", "agree"],
    ["failed", "failed", "red"],
    ["passed", "failed", "fault"],
    // No evidence from the laptop: the machine's own result stands.
    ...(["deferred", "waiting", "unrun", undefined] as const).flatMap((reference) =>
      VERDICTS.map((machine): [ReferenceGateVerdict | undefined, GateVerdict, GateAgreement] => [
        reference,
        machine,
        machine === "failed" ? "red" : "stands",
      ]),
    ),
    // Red on the laptop, green here: not red.
    ["failed", "passed", "stands"],
    ["failed", "deferred", "stands"],
    ["failed", "waiting", "stands"],
    ["failed", "unrun", "stands"],
    // Green on the laptop, not run to an end here: the machine's prerequisite or deferral stands.
    ["passed", "deferred", "stands"],
    ["passed", "waiting", "stands"],
    ["passed", "unrun", "stands"],
  ];

  it.each(rows)("reference %s, machine %s: %s", (reference, machine, outcome) => {
    expect(gateAgreement(reference, machine)).toBe(outcome);
  });

  it("covers every pairing of verdicts", () => {
    const seen = new Set(rows.map(([reference, machine]) => `${reference}/${machine}`));
    for (const reference of [...VERDICTS, undefined]) {
      for (const machine of VERDICTS) expect(seen).toContain(`${reference}/${machine}`);
    }
  });

  it("compares gate by gate, naming the faults and the red ones, with the laptop's output", () => {
    const reference: ReferenceGate[] = [
      { id: "build", kind: "check", verdict: "passed", outputArtifactId: ART },
      { id: "test", kind: "check", verdict: "passed", outputArtifactId: ART },
      { id: "lint", kind: "check", verdict: "failed", outputArtifactId: ART },
      { id: "e2e", kind: "check", verdict: "waiting" },
    ];
    const comparison = compareWithReference(
      { gates: reference },
      {
        gates: [
          machineGate("build", "passed"),
          machineGate("test", "failed"),
          machineGate("lint", "failed"),
          machineGate("e2e", "failed"),
          machineGate("new", "failed"),
        ],
      },
    );
    expect(comparison.gates.map((gate) => [gate.id, gate.outcome])).toEqual([
      ["build", "agree"],
      ["test", "fault"],
      ["lint", "red"],
      ["e2e", "red"],
      ["new", "red"],
    ]);
    expect(comparison.faults).toEqual([
      {
        id: "test",
        command: "npm run test",
        kind: "check",
        reference: "passed",
        machine: "failed",
        outcome: "fault",
        referenceOutputArtifactId: ART,
      },
    ]);
    expect(comparison.red).toEqual(["lint", "e2e", "new"]);
    expect("reference" in (comparison.gates[4] ?? {})).toBe(false);
  });

  it("with no reference, says exactly what the machine's audit says", () => {
    const comparison = compareWithReference(undefined, {
      gates: VERDICTS.map((verdict) => machineGate(verdict, verdict)),
    });
    expect(comparison.faults).toEqual([]);
    expect(comparison.red).toEqual(["failed"]);
  });
});
