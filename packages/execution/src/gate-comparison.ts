/**
 * The machine's gate audit against the laptop's reference (P16 S-02, D-07).
 *
 * Pure: both audits have run. Gate by gate:
 *
 * | Reference | Machine | Outcome |
 * |---|---|---|
 * | passed | passed | `agree` |
 * | failed | failed | `red`: the base is red, and repaired as today |
 * | passed | failed | `fault`: the machine is at fault, not the project |
 * | deferred, waiting, unrun, or absent | anything | the machine's own result stands: `red` when it failed, `stands` otherwise |
 * | failed | passed | `stands`: not red |
 * | passed | deferred, waiting, unrun | `stands`: the machine's own prerequisite or deferral |
 *
 * With no reference at all (a dispatch from before P16) every gate is the
 * machine's own, so the comparison says exactly what the audit says today.
 */
import type { ArtifactId, ReferenceAudit, ReferenceGateVerdict } from "@nightshift/contracts";
import type { AuditedGate, GateAudit, GateVerdict } from "./gate-audit.js";

export type GateAgreement = "agree" | "red" | "fault" | "stands";

export interface ComparedGate {
  readonly id: string;
  readonly command: string;
  readonly kind: AuditedGate["kind"];
  /** The laptop's verdict; absent when the reference does not name the gate, or there is none. */
  readonly reference?: ReferenceGateVerdict;
  readonly machine: GateVerdict;
  readonly outcome: GateAgreement;
  /** The laptop's output tail, when the reference kept one. */
  readonly referenceOutputArtifactId?: ArtifactId;
  /** The last of the laptop's output, as the reference carried it inline. */
  readonly referenceOutputTail?: string;
}

export interface GateComparison {
  readonly gates: readonly ComparedGate[];
  /** Green on the laptop, red here: the environment faults, in audit order. */
  readonly faults: readonly ComparedGate[];
  /** The ids red on the base, as `gate.red` names them. */
  readonly red: readonly string[];
}

/** One gate's outcome, from the two verdicts: the table above. */
export const gateAgreement = (
  reference: ReferenceGateVerdict | undefined,
  machine: GateVerdict,
): GateAgreement => {
  if (reference === "passed") {
    if (machine === "passed") return "agree";
    return machine === "failed" ? "fault" : "stands";
  }
  if (reference === "failed" && machine === "failed") return "red";
  // No evidence from the laptop, or the laptop's red is not this machine's.
  return machine === "failed" ? "red" : "stands";
};

/** The machine's audit compared with the reference, gate by gate. */
export const compareWithReference = (
  reference: Pick<ReferenceAudit, "gates"> | undefined,
  audit: Pick<GateAudit, "gates">,
): GateComparison => {
  const byId = new Map((reference?.gates ?? []).map((gate) => [gate.id, gate]));
  const gates = audit.gates.map((gate): ComparedGate => {
    const laptop = byId.get(gate.id);
    return {
      id: gate.id,
      command: gate.command,
      kind: gate.kind,
      ...(laptop === undefined ? {} : { reference: laptop.verdict }),
      machine: gate.verdict,
      outcome: gateAgreement(laptop?.verdict, gate.verdict),
      ...(laptop?.outputArtifactId === undefined
        ? {}
        : { referenceOutputArtifactId: laptop.outputArtifactId }),
      ...(laptop?.outputTail === undefined ? {} : { referenceOutputTail: laptop.outputTail }),
    };
  });
  return {
    gates,
    faults: gates.filter((gate) => gate.outcome === "fault"),
    red: gates.filter((gate) => gate.outcome === "red").map((gate) => gate.id),
  };
};
