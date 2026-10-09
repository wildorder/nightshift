/**
 * An environment fault, kept on the run (P16 D-07).
 *
 * A gate green in the laptop's reference audit and red on the run's machine is
 * the machine's fault, not the project's: a machine never changes a project to
 * suit itself. So nothing is repaired and no `gate.red` is written. What both
 * audits found is kept on the run's program node instead: each disagreeing
 * gate's machine output as a verification log, beside the laptop's the
 * reference already kept, and one `environment.fault` event naming them with
 * both Node versions.
 */
import {
  type EnvironmentFaultGate,
  type EnvironmentFaultPayload,
  EnvironmentFaultPayloadSchema,
  EventSchema,
  type ExecutionNodeId,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import type { GateAudit } from "./gate-audit.js";
import type { GateComparison } from "./gate-comparison.js";
import { recordGateOutputs } from "./red-base.js";

export interface RecordEnvironmentFaultInput {
  readonly scope: RunSession["scope"];
  /** The run's program node. */
  readonly nodeId: ExecutionNodeId;
  /** The machine's audit. */
  readonly audit: Pick<GateAudit, "base" | "gates">;
  /** It, compared with the reference: at least one fault. */
  readonly comparison: Pick<GateComparison, "faults">;
  /** The reference's Node (`reference.node`). */
  readonly referenceNode?: string | undefined;
  /** `node --version` on the machine, as a worker user in the project environment. */
  readonly machineNode?: string | undefined;
  /** Who writes these records (A-30). */
  readonly writerId: string;
}

/** What the runner says of an environment fault: the gates, and both Nodes. */
export const environmentFaultReason = (
  payload: Pick<EnvironmentFaultPayload, "baseCommit" | "gates" | "referenceNode" | "machineNode">,
): string => {
  const named = payload.gates.map((gate) => `${gate.id} (\`${gate.command}\`)`).join(", ");
  return (
    `environment fault: ${named} passed in the reference audit of ${payload.baseCommit.slice(0, 8)} ` +
    `and failed on this machine (Node ${payload.referenceNode ?? "none"} on the reference, ` +
    `${payload.machineNode ?? "none"} on the machine). The machine is at fault, not the project: ` +
    "nothing is repaired, and the run is cancelled. Both outputs are on the run's program node."
  );
};

/**
 * Each fault's machine output as a verification log on the program node, then
 * the `environment.fault` event naming it. Returns the event's payload.
 */
export const recordEnvironmentFault = async (
  environment: Pick<ExecutionEnvironment, "stores" | "bodies" | "clock" | "ids">,
  input: RecordEnvironmentFaultInput,
): Promise<EnvironmentFaultPayload> => {
  const faulted = new Set(input.comparison.faults.map((gate) => gate.id));
  const outputs = await recordGateOutputs(environment, {
    scope: input.scope,
    nodeId: input.nodeId,
    gates: input.audit.gates.filter((gate) => faulted.has(gate.id)),
    writerId: input.writerId,
  });
  const payload = EnvironmentFaultPayloadSchema.parse({
    baseCommit: input.audit.base,
    gates: input.comparison.faults.map((gate): EnvironmentFaultGate => {
      const machineOutputArtifactId = outputs.get(gate.id);
      return {
        id: gate.id,
        command: gate.command,
        kind: gate.kind,
        reference: gate.reference ?? "unrun",
        machine: gate.machine,
        ...(gate.referenceOutputArtifactId === undefined
          ? {}
          : { referenceOutputArtifactId: gate.referenceOutputArtifactId }),
        ...(machineOutputArtifactId === undefined ? {} : { machineOutputArtifactId }),
      };
    }),
    ...(input.referenceNode === undefined ? {} : { referenceNode: input.referenceNode }),
    ...(input.machineNode === undefined ? {} : { machineNode: input.machineNode }),
  });
  // Written directly, as `gate.red` is: durable before the runner ends, or the
  // call fails. The key is deterministic, so a repeated audit converges.
  const at = nowIso(environment.clock);
  await environment.stores.events.append(
    EventSchema.parse({
      schemaVersion: 1,
      ...input.scope,
      eventId: environment.ids.next("evt"),
      idempotencyKey: `control-plane:${input.scope.runId}:environment.fault`,
      sequence: null,
      type: "environment.fault",
      source: "control-plane",
      executionNodeId: input.nodeId,
      agentId: null,
      payload,
      occurredAt: at,
      recordedAt: at,
    }),
  );
  return payload;
};
