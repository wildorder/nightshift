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
import { MAX_REFERENCE_OUTPUT_TAIL_CHARS, referenceGateRan } from "@nightshift/contracts";
import type { GateAudit } from "./gate-audit.js";
import { readableTail } from "./output-tail.js";

/**
 * What the tails of one reference may come to together, in characters: the
 * dispatch carrying them is one control-plane record, far below its item limit
 * at this size, however many gates the program has.
 */
export const MAX_REFERENCE_TAILS_CHARS = 64_000;

/**
 * Each audited gate's verdict, with the artifact holding its output when it ran
 * and one was kept, and the last of that output inline: the machine shows it
 * beside its own when the gate faults, and cannot read the artifact back.
 */
export const referenceGatesOf = (
  audit: Pick<GateAudit, "gates">,
  outputs: ReadonlyMap<string, ArtifactId> = new Map(),
): ReferenceGate[] => {
  const ran = audit.gates.filter(
    (gate) => referenceGateRan(gate.verdict) && gate.result !== undefined,
  ).length;
  const perGate = Math.min(
    MAX_REFERENCE_OUTPUT_TAIL_CHARS,
    Math.floor(MAX_REFERENCE_TAILS_CHARS / Math.max(1, ran)),
  );
  return audit.gates.map((gate) => {
    const ranHere = referenceGateRan(gate.verdict);
    const outputArtifactId = ranHere ? outputs.get(gate.id) : undefined;
    const tail =
      ranHere && gate.result !== undefined ? readableTail(gate.result.output, perGate) : "";
    return {
      id: gate.id,
      kind: gate.kind,
      verdict: gate.verdict,
      ...(outputArtifactId === undefined ? {} : { outputArtifactId }),
      ...(tail === "" ? {} : { outputTail: tail }),
    };
  });
};

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
