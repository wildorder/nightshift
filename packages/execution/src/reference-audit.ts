/**
 * The reference audit (P16 D-06): what `run --remote` found on the laptop, in
 * the shape the dispatch carries it to the machine.
 *
 * Pure: the gate audit has already run, and its red gates' output has already
 * been kept as artifacts. The machine audits the same base and compares its
 * verdicts with these, gate by gate; a `deferred`, `waiting` or `unrun` gate is
 * no evidence from the laptop, and the machine's own result stands for it.
 */
import type {
  ArtifactId,
  IsoTimestamp,
  ReferenceAudit,
  ReferenceGate,
} from "@nightshift/contracts";
import type { GateAudit } from "./gate-audit.js";

/** Each audited gate's verdict, with the artifact holding its output when it failed and one was kept. */
export const referenceGatesOf = (
  audit: Pick<GateAudit, "gates">,
  outputs: ReadonlyMap<string, ArtifactId> = new Map(),
): ReferenceGate[] =>
  audit.gates.map((gate) => {
    const outputArtifactId = gate.verdict === "failed" ? outputs.get(gate.id) : undefined;
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
  /** The artifact kept for each failed gate's output, by gate id (`recordRedBase`). */
  readonly outputs?: ReadonlyMap<string, ArtifactId>;
}

/** The reference a dispatch carries, from a gate audit. */
export const referenceAuditOf = (input: ReferenceAuditInput): ReferenceAudit => ({
  base: input.audit.base,
  ...(input.node === undefined ? {} : { node: input.node }),
  auditedAt: input.auditedAt,
  gates: referenceGatesOf(input.audit, input.outputs),
});
