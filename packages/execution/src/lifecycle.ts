/**
 * Lifecycle observations (P20, S-05): the engine-owned operations (a wait, a
 * startup, a piece of work, a queue turn, an integration) told to the S-01
 * observation seam as start / note / end transitions, so a report can measure
 * where the time went and why.
 *
 * Observation, never authority: this never throws and never changes an outcome.
 * A failure to build, validate or emit an observation drops it.
 */
import type {
  AgentId,
  ExecutionNodeId,
  LaunchRef,
  LifecycleObservation,
} from "@nightshift/contracts";
import { MeasurementObservationSchema } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
import type { ExecutionEnvironment } from "./environment.js";
import type { MeasurementRecorder } from "./measurement/recorder.js";

export interface LifecycleInput {
  readonly scope: RunScope;
  readonly nodeId: ExecutionNodeId;
  readonly agentId?: AgentId | undefined;
  readonly launch?: LaunchRef | undefined;
  /** When given, the agent's ledger holds the observation too, tied to its launch. */
  readonly recorder?: MeasurementRecorder | undefined;
  readonly operationId: string;
  readonly attempt?: number | undefined;
  readonly phase: string;
  readonly transition: "start" | "end" | "note";
  readonly reason?: string | undefined;
  readonly blockers?: readonly { readonly kind: string; readonly ref: string }[] | undefined;
  readonly refs?: readonly { readonly kind: string; readonly ref: string }[] | undefined;
  readonly parentOperationId?: string | undefined;
  readonly occurredAt?: string | undefined;
}

/** Tells two notes at one instant apart; per process, which is all an observation id needs. */
let notes = 0;

const MAX_REASON = 400;

/**
 * Emits one lifecycle observation as a `lifecycle.observed` event, and hands the
 * same observation to the recorder when one is given. Returns it, or
 * `undefined` when it was dropped.
 */
export const observeLifecycle = (
  environment: Pick<ExecutionEnvironment, "outbox" | "clock" | "ids">,
  input: LifecycleInput,
): LifecycleObservation | undefined => {
  try {
    const now = nowIso(environment.clock);
    const occurredAt = (input.occurredAt ?? now) as LifecycleObservation["receivedAt"];
    const suffix = input.transition === "note" ? `:${++notes}` : "";
    const candidate = {
      schemaVersion: 1,
      kind: "lifecycle",
      observationId: `${input.operationId}:${input.transition}:${occurredAt}${suffix}`,
      ...input.scope,
      executionNodeId: input.nodeId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.launch === undefined ? {} : { launch: input.launch }),
      source: "engine",
      provenance: { adapter: "execution" },
      occurredAt,
      receivedAt: now,
      inclusion: "self",
      operationId: input.operationId,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      phase: input.phase,
      transition: input.transition,
      ...(input.reason === undefined ? {} : { reason: input.reason.slice(0, MAX_REASON) }),
      blockers: (input.blockers ?? []).map(({ kind, ref }) => ({ kind, ref })),
      ...(input.refs === undefined || input.refs.length === 0
        ? {}
        : { refs: input.refs.map(({ kind, ref }) => ({ kind, ref })) }),
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: input.parentOperationId }),
    };
    const parsed = MeasurementObservationSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.kind !== "lifecycle") return undefined;
    const observation = parsed.data;
    try {
      environment.outbox.emit({
        type: "lifecycle.observed",
        source: "control-plane",
        payload: observation,
        executionNodeId: input.nodeId,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        occurredAt,
      });
    } catch {
      // The event is lost; the ledger copy below may still land.
    }
    if (input.recorder !== undefined) {
      try {
        const { source: _source, ...engine } = observation;
        input.recorder.lifecycle(engine);
      } catch {
        // The ledger is observation too.
      }
    }
    return observation;
  } catch {
    return undefined;
  }
};

/** The sorted `kind:ref` strings of a blocker set, so two passes compare equal. */
export const blockerKey = (
  blockers: readonly { readonly kind: string; readonly ref: string }[],
): string =>
  blockers
    .map((blocker) => `${blocker.kind}:${blocker.ref}`)
    .sort()
    .join("|");
