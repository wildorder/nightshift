/**
 * `plan check`'s gate-health rule (P15, D-P15-01, D-P15-08).
 *
 * A plan is READY on its gates in one of two ways: the project's record is
 * `healthy` and its fingerprint still matches the gates, or it is `repairing`,
 * still matches, every finding is answered by a decision of this contract, and
 * the gate-health strand `S-00` comes before every other strand. Anything else
 * is a reason, and every reason is said at once.
 *
 * Pure: the caller reads the record from the control plane and computes the
 * current fingerprint over the record's machinery (`gateFingerprintAt`).
 */
import type { GateHealth, ProgramContract } from "@nightshift/contracts";
import { type PlanReason, strandsOf } from "./plan.js";

/** The gate-health strand's id: what every other strand of a repairing plan depends on. */
export const GATE_HEALTH_STRAND = "S-00";

/**
 * Why `contract` is not ready on its gates; empty when it is. `program` is the
 * directory name the commands are given, for the next thing to type.
 */
export const gateHealthReasons = (
  contract: ProgramContract,
  record: GateHealth | undefined,
  currentFingerprint: string,
  program = "<program>",
): PlanReason[] => {
  if (record === undefined) {
    return [
      {
        kind: "gate_health_unrecorded",
        message:
          "the project's gates have never been audited: run `nightshift gates " +
          `${program}\`, review them against the gate standard, then \`nightshift gates ${program} --record\``,
      },
    ];
  }
  if (record.fingerprint !== currentFingerprint) {
    return [
      {
        kind: "gate_health_stale",
        commit: record.commit,
        message:
          `the gates changed since they were audited at ${record.commit.slice(0, 8)} ` +
          "(their setup, commands, lockfiles or named machinery): audit them again and " +
          `\`nightshift gates ${program} --record\``,
      },
    ];
  }
  if (record.verdict === "healthy") return [];

  const decisions = new Map((contract.decisions ?? []).map((decision) => [decision.id, decision]));
  const reasons: PlanReason[] = [];
  for (const finding of record.findings) {
    const decision = decisions.get(finding.decisionId);
    if (decision !== undefined && decision.answer !== undefined) continue;
    reasons.push({
      kind: "gate_finding_unanswered",
      findingId: finding.id,
      decisionId: finding.decisionId,
      message:
        decision === undefined
          ? `gate finding ${finding.id} (rule ${finding.rule}) is answered by ${finding.decisionId}, which is not a decision of this contract`
          : `gate finding ${finding.id} (rule ${finding.rule}) waits on decision ${finding.decisionId}, which has no answer`,
    });
  }
  const strands = strandsOf(contract);
  if (!strands.some((strand) => strand.id === GATE_HEALTH_STRAND)) {
    reasons.push({
      kind: "gate_health_strand_missing",
      message:
        `the gates are being repaired, and there is no gate-health strand ${GATE_HEALTH_STRAND} ` +
        "to build the answered findings",
    });
  }
  for (const strand of strands) {
    if (strand.id === GATE_HEALTH_STRAND || strand.dependsOn.includes(GATE_HEALTH_STRAND)) continue;
    reasons.push({
      kind: "gate_health_strand_not_first",
      strandId: strand.id,
      message: `${strand.id} does not depend on ${GATE_HEALTH_STRAND}, so it would be built on gates that are about to change`,
    });
  }
  return reasons;
};
