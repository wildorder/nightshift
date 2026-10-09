/**
 * The reference audit (P16 D-06): what `run --remote` found on the laptop, in
 * the shape the dispatch carries it to the machine.
 *
 * Pure: the gate audit has already run, and the output of every gate that ran
 * has already been kept as an artifact, passed ones included, so an
 * environment fault (D-07) can show the laptop's output beside the machine's. The machine audits the same base and compares its
 * verdicts with these, gate by gate; a `deferred`, `waiting` or `unrun` gate is
 * no evidence from the laptop, and the machine's own result stands for it.
 */
import type {
  ArtifactId,
  IsoTimestamp,
  ReferenceAudit,
  ReferenceGate,
} from "@nightshift/contracts";
import { referenceGateRan } from "@nightshift/contracts";
import type { GateAudit } from "./gate-audit.js";

/** Each audited gate's verdict, with the artifact holding its output when it ran and one was kept. */
export const referenceGatesOf = (
  audit: Pick<GateAudit, "gates">,
  outputs: ReadonlyMap<string, ArtifactId> = new Map(),
): ReferenceGate[] =>
  audit.gates.map((gate) => {
    const outputArtifactId = referenceGateRan(gate.verdict) ? outputs.get(gate.id) : undefined;
    return {
      id: gate.id,
      kind: gate.kind,
      verdict: gate.verdict,
      ...(outputArtifactId === undefined ? {} : { outputArtifactId }),
    };
  });

export interface ReferenceAuditInput {
  readonly audit: Pick<GateAudit, "base" | "gates">;
  /** `node --version` where the audit ran, without the `v`; absent when there was none. */
  readonly node?: string | undefined;
  readonly auditedAt: IsoTimestamp;
  /** The artifact kept for each output of a gate that ran, by gate id (`recordGateOutputs`). */
  readonly outputs?: ReadonlyMap<string, ArtifactId>;
}

/** The reference a dispatch carries, from a gate audit. */
export const referenceAuditOf = (input: ReferenceAuditInput): ReferenceAudit => ({
  base: input.audit.base,
  ...(input.node === undefined ? {} : { node: input.node }),
  auditedAt: input.auditedAt,
  gates: referenceGatesOf(input.audit, input.outputs),
});
