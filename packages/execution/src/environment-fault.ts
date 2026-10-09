/**
 * An environment fault, kept on the run (P16 D-07).
 *
 * A gate green in the laptop's reference audit and red on the run's machine is
 * the machine's fault, not the project's: a machine never changes a project to
 * suit itself. So nothing is repaired and no `gate.red` is written. What both
 * audits found is kept on the run's program node instead: each disagreeing
 * gate's machine output as a verification log, beside the laptop's the
 * reference already kept, and one `environment.fault` event naming them with
 * both Node versions and the last of both outputs inline, so the report, the
 * Studio and `remote status` show them side by side without reading a body.
 */
import {
  type ArtifactId,
  type EnvironmentFaultGate,
  type EnvironmentFaultPayload,
  EnvironmentFaultPayloadSchema,
  EventSchema,
  type ExecutionNodeId,
  inlinePayloadBytes,
  MAX_ENVIRONMENT_FAULT_TAIL_CHARS,
  MAX_INLINE_PAYLOAD_BYTES,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import type { GateAudit } from "./gate-audit.js";
import type { GateComparison } from "./gate-comparison.js";
import { lastChars, readableOutput } from "./output-tail.js";
import { recordGateOutputs } from "./red-base.js";

/** Both outputs of one faulted gate, as text; either may be missing. */
export interface FaultOutputs {
  readonly reference?: string | undefined;
  readonly machine?: string | undefined;
}

/**
 * The payload with each gate's tails as long as they can be while the whole
 * stays within `limitBytes`.
 *
 * Every tail is cut to one shared length, the largest that fits: an output
 * shorter than it is kept whole and leaves its room to the others. So a fault
 * of many gates gives each a shorter tail, never none while there is room for
 * any: the length found is the largest that fits, and it only drops to zero
 * when the gates alone fill the event. Pure.
 */
export const boundEnvironmentFault = (
  payload: EnvironmentFaultPayload,
  outputs: ReadonlyMap<string, FaultOutputs>,
  limitBytes: number = MAX_INLINE_PAYLOAD_BYTES,
): EnvironmentFaultPayload => {
  const readable = (text: string | undefined): string =>
    text === undefined ? "" : lastChars(readableOutput(text), MAX_ENVIRONMENT_FAULT_TAIL_CHARS);
  const texts = payload.gates.map((gate) => ({
    reference: readable(outputs.get(gate.id)?.reference),
    machine: readable(outputs.get(gate.id)?.machine),
  }));
  const build = (length: number): EnvironmentFaultPayload => ({
    ...payload,
    gates: payload.gates.map((gate, index): EnvironmentFaultGate => {
      const { referenceTail: _reference, machineTail: _machine, ...rest } = gate;
      const referenceTail = lastChars(texts[index]?.reference ?? "", length);
      const machineTail = lastChars(texts[index]?.machine ?? "", length);
      return {
        ...rest,
        ...(referenceTail === "" ? {} : { referenceTail }),
        ...(machineTail === "" ? {} : { machineTail }),
      };
    }),
  });
  const fits = (length: number): boolean => inlinePayloadBytes(build(length)) <= limitBytes;
  // The size only grows with the length, so the largest that fits is found by halving.
  let fitting = 0;
  let over = MAX_ENVIRONMENT_FAULT_TAIL_CHARS + 1;
  if (fits(MAX_ENVIRONMENT_FAULT_TAIL_CHARS)) fitting = MAX_ENVIRONMENT_FAULT_TAIL_CHARS;
  else {
    while (over - fitting > 1) {
      const middle = Math.floor((fitting + over) / 2);
      if (fits(middle)) fitting = middle;
      else over = middle;
    }
  }
  return build(fitting);
};

/**
 * The least of each output a gate keeps, in characters, unless its output is
 * shorter: enough of a failure to read what went wrong. A fault whose gates
 * cannot all keep this much in one event is written as several.
 */
export const MIN_ENVIRONMENT_FAULT_TAIL_CHARS = 300;

/**
 * The fault as the events it is written as: one when it fits, as most do;
 * otherwise its gates, in order, in as few parts as keep every tail at least
 * `MIN_ENVIRONMENT_FAULT_TAIL_CHARS` long (or whole) within `limitBytes`, each
 * part bounded by `boundEnvironmentFault`. Pure.
 */
export const splitEnvironmentFault = (
  payload: EnvironmentFaultPayload,
  outputs: ReadonlyMap<string, FaultOutputs>,
  limitBytes: number = MAX_INLINE_PAYLOAD_BYTES,
): EnvironmentFaultPayload[] => {
  const { part: _part, parts: _parts, ...whole } = payload;
  // Cleaned once: what is cleaned already comes through cleaning unchanged.
  const readable = (text: string | undefined): string =>
    text === undefined ? "" : lastChars(readableOutput(text), MAX_ENVIRONMENT_FAULT_TAIL_CHARS);
  const texts = new Map(
    [...outputs].map(([id, output]) => [
      id,
      { reference: readable(output.reference), machine: readable(output.machine) },
    ]),
  );
  // A part is good when it fits and each tail is as long as the floor asks.
  const floor = (text: string | undefined): number =>
    Math.min(MIN_ENVIRONMENT_FAULT_TAIL_CHARS, text?.length ?? 0);
  const good = (bounded: EnvironmentFaultPayload): boolean =>
    inlinePayloadBytes(bounded) <= limitBytes &&
    bounded.gates.every(
      (gate) =>
        (gate.referenceTail?.length ?? 0) >= floor(texts.get(gate.id)?.reference) &&
        (gate.machineTail?.length ?? 0) >= floor(texts.get(gate.id)?.machine),
    );
  const chunks: EnvironmentFaultPayload["gates"][] = [];
  let current: EnvironmentFaultPayload["gates"] = [];
  for (const gate of whole.gates) {
    const candidate = [...current, gate];
    const bounded = boundEnvironmentFault({ ...whole, gates: candidate }, texts, limitBytes);
    if (current.length > 0 && !good(bounded)) {
      chunks.push(current);
      current = [gate];
    } else {
      current = candidate;
    }
  }
  chunks.push(current);
  const parts = chunks.length;
  return chunks.map((gates, index) =>
    boundEnvironmentFault(
      { ...whole, gates, ...(parts === 1 ? {} : { part: index + 1, parts }) },
      texts,
      limitBytes,
    ),
  );
};

/**
 * The laptop's output of a faulted gate: as the reference carried it, or else
 * read back from its artifact where this body store can read. A machine's
 * cannot (it signs uploads only), and a tail it cannot read is left out rather
 * than failing the fault it would only illustrate.
 */
const referenceOutput = async (
  environment: Pick<ExecutionEnvironment, "bodies">,
  scope: RunSession["scope"],
  gate: GateComparison["faults"][number],
): Promise<string | undefined> => {
  if (gate.referenceOutputTail !== undefined) return gate.referenceOutputTail;
  if (gate.referenceOutputArtifactId === undefined) return undefined;
  try {
    const body = await environment.bodies.get(scope, gate.referenceOutputArtifactId as ArtifactId);
    return body === undefined
      ? undefined
      : new TextDecoder().decode(body.subarray(Math.max(0, body.length - 64_000)));
  } catch {
    return undefined;
  }
};

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
 * the `environment.fault` event naming it, with the tails of both outputs
 * inline (`splitEnvironmentFault`: one event, or several for a fault of many
 * gates). Returns the whole fault, every part's gates together.
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
  const texts = new Map<string, FaultOutputs>();
  for (const gate of input.comparison.faults) {
    const machine = input.audit.gates.find((audited) => audited.id === gate.id)?.result?.output;
    texts.set(gate.id, {
      reference: await referenceOutput(environment, input.scope, gate),
      // The last of it is all a tail needs: a long log is not cleaned whole.
      machine:
        machine === undefined
          ? undefined
          : new TextDecoder().decode(machine.subarray(Math.max(0, machine.length - 64_000))),
    });
  }
  const unbounded: EnvironmentFaultPayload = EnvironmentFaultPayloadSchema.parse({
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
  const written = splitEnvironmentFault(unbounded, texts).map((part) =>
    EnvironmentFaultPayloadSchema.parse(part),
  );
  // Written directly, as `gate.red` is: durable before the runner ends, or the
  // call fails. The keys are deterministic, so a repeated audit converges.
  const at = nowIso(environment.clock);
  for (const part of written) {
    await environment.stores.events.append(
      EventSchema.parse({
        schemaVersion: 1,
        ...input.scope,
        eventId: environment.ids.next("evt"),
        idempotencyKey:
          part.part === undefined || part.part === 1
            ? `control-plane:${input.scope.runId}:environment.fault`
            : `control-plane:${input.scope.runId}:environment.fault:${part.part}`,
        sequence: null,
        type: "environment.fault",
        source: "control-plane",
        executionNodeId: input.nodeId,
        agentId: null,
        payload: part,
        occurredAt: at,
        recordedAt: at,
      }),
    );
  }
  // The whole fault, as its parts together say it.
  const payload: EnvironmentFaultPayload = {
    ...unbounded,
    gates: written.flatMap((part) => part.gates),
  };
  return payload;
};
