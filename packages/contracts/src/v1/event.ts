/**
 * Event — the append-only record from which current state is rebuilt.
 *
 * Two channels, deliberately redundant (architecture §5). MCP carries *intent*:
 * semantic actions an agent takes on purpose. Hooks carry *ground truth*:
 * lifecycle facts that must not depend on agent compliance. `source` records
 * which channel an event arrived on, because an agent that neglects to report is
 * an observability gap MCP alone cannot close.
 *
 * Writes carry an idempotency key so a replayed local spool converges (A-06).
 */
import { z } from "zod";
import { AgentIdSchema, ArtifactIdSchema, EventIdSchema, ExecutionNodeIdSchema } from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, runScoped } from "./common.js";
import { ReferenceGateVerdictSchema } from "./dispatch.js";

export const EventSourceSchema = z.enum(["mcp", "hook", "control-plane"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/**
 * A closed union. Later programs extend it deliberately; an unknown type is
 * rejected rather than stored, so a typo cannot create a silent event class.
 */
export const EventTypeSchema = z.enum([
  // Run lifecycle — control plane.
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  // Delegation and node lifecycle — MCP intent plus control-plane facts.
  "node.delegated",
  "node.queued",
  "node.started",
  "node.progress",
  "node.implemented",
  "node.failed",
  "node.cancelled",
  "node.interrupted",
  "node.integrated",
  /** Added in P6 (D-P6-03). A sub-program's orchestrator ended it, its work done. */
  "node.succeeded",
  /**
   * Added in P6 (D-P6-06). The merge queue replayed a node's snapshot onto a
   * program head that had moved since its worktree was cut: a stale base,
   * detected and recorded rather than refused. Payload: both commits.
   */
  "node.rebased",
  /**
   * Added in P7 (D-P7-09, §4.4). A strand settled without succeeding, so it is
   * parked. Payload: the strand id and why.
   */
  "strand.parked",
  /**
   * Added in P7. A strand in a parked strand's downstream cone will not be
   * started. Payload: the strand id and the strands that blocked it.
   */
  "strand.blocked",
  /**
   * Added in P7 (D-P7-10). A node's checks could not all run, or it was built on
   * work whose checks could not: it sits on the run's provisional line, not the
   * program branch. Payload: the commit, the provisional ref, and what it waits on.
   */
  "node.deferred",
  /** Added in P7. A deferred node was dropped at resume because work under it failed its checks. */
  "node.discarded",
  /**
   * Added in P6 (D-P6-06). That replay conflicted. Nightshift resolves nothing:
   * the node fails, the paths are named, and an orchestrator decides.
   */
  "integration.conflict",
  // Agent lifecycle — hook ground truth (architecture §5).
  "agent.created",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  /**
   * Added in P3. The Job lifecycle (`p3-vertical-slice.md` §4.3) requires a
   * killed worker to leave durable interruption state on the agent as well as
   * the node, and the union P1 closed had no type for it. Widening a closed
   * union is the deliberate extension the module comment reserves.
   */
  "agent.interrupted",
  "agent.subagent_created",
  "agent.context_compacted",
  "tool.called",
  "tool.completed",
  // Verification and examination — Nightshift authority.
  "verification.requested",
  "verification.completed",
  "examination.requested",
  "examination.completed",
  /** Added in P8 (D-P8-15). The examiner put questions to the builder. Payload: the questions. */
  "examination.asked",
  /** Added in P8 (D-P8-15). The builder answered. Payload: the answers, and how. */
  "examination.answered",
  /** Added in P8 (D-P8-13). An orchestrator disputed a finding. Payload: which, and why. */
  "finding.disputed",
  /** Added in P8 (D-P8-13). An arbiter ruled on a finding. Payload: the ruling and its decision. */
  "finding.ruled",
  /** Added in P8 (D-P8-08). A budget is spent; nothing new starts. Payload: which and how much. */
  "run.budget_spent",
  // Gate health — P15.
  /**
   * Added in P15 (D-P15-03). The run's one mechanical pass at the start found
   * these gates red; the run repairs them first, and the strands wait on the
   * repair alone. Payload: `baseCommit` and `failing` (the step ids).
   */
  "gate.red",
  /**
   * Added in P15 (D-P15-06). A check failed and then passed when verification
   * reran it once on the same commit: flaky, not blocking, and the work lands.
   * Emitted by verification on the node whose check flaked. Payload:
   * `verificationId`, `commitSha`, and `stepIds` (the steps that flaked).
   */
  "gate.flaked",
  /**
   * Added in P15 (D-P15-04). A repair job landed. Payload: `jobContractId`,
   * `decisionId`, `cause` (a `RepairCause`), `definitionsChanged`, and — only
   * when the landing changed them — the new `setup` and `verification` step
   * definitions.
   */
  "gate.repaired",
  /**
   * Added in P16 (D-07). Gates green in the reference audit (the laptop's) are
   * red on the run's machine: the machine is at fault, not the project, so the
   * run is cancelled before the root starts and nothing is repaired. Recorded
   * on the run's program node. Payload: `EnvironmentFaultPayload`.
   */
  "environment.fault",
  // Decisions, checkpoints, routing, artifacts.
  "decision.recorded",
  "decision.overridden",
  "checkpoint.created",
  "routing.decided",
  "artifact.recorded",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Small structured metadata only. Anything larger belongs in S3 behind
 * `payloadArtifactId`; this bound is what keeps large output out of DynamoDB
 * (A-08) rather than a convention nobody checks.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 8192;

/**
 * UTF-8 size of an inline payload. Uses `TextEncoder` rather than `Buffer` so
 * this package stays runtime-neutral: the future Studio is a browser client of
 * these same contracts.
 */
export const inlinePayloadBytes = (payload: Readonly<Record<string, unknown>>): number =>
  new TextEncoder().encode(JSON.stringify(payload)).length;

export const EventSchema = z
  .strictObject({
    ...runScoped,
    eventId: EventIdSchema,
    /**
     * Deduplication key supplied by the writer. A duplicate submission with the
     * same key must not create a second event.
     */
    idempotencyKey: z.string().min(1).max(256),
    /**
     * Monotonic within a run, dense, assigned by the control plane.
     *
     * `null` means **durable but not yet numbered**. Sequence numbers are stamped
     * after the write commits, by an ordered consumer (A-22), so there is a brief
     * window in which an event exists and has no number. Modelled as nullable
     * rather than optional so no reader can forget the case: see
     * `isSequenced` and `orderEvents` in `@nightshift/core`.
     */
    sequence: z.int().min(0).nullable(),
    type: EventTypeSchema,
    source: EventSourceSchema,
    executionNodeId: ExecutionNodeIdSchema.nullable(),
    agentId: AgentIdSchema.nullable(),
    payload: z.record(z.string(), z.unknown()),
    /** Where the full payload lives when it exceeds the inline bound. */
    payloadArtifactId: ArtifactIdSchema.optional(),
    occurredAt: IsoTimestampSchema,
    recordedAt: IsoTimestampSchema,
  })
  .refine((value) => inlinePayloadBytes(value.payload) <= MAX_INLINE_PAYLOAD_BYTES, {
    message: `inline payload exceeds ${MAX_INLINE_PAYLOAD_BYTES} bytes; store it as an artifact and reference it with payloadArtifactId (A-08)`,
    path: ["payload"],
  });
export type Event = z.infer<typeof EventSchema>;

/** One gate the reference audit and the machine disagree on (P16 D-07). */
/** The most of one output an `environment.fault` gate carries inline. */
export const MAX_ENVIRONMENT_FAULT_TAIL_CHARS = 2000;

export const EnvironmentFaultGateSchema = z.strictObject({
  id: z.string().min(1),
  command: z.string(),
  kind: z.enum(["setup", "check"]),
  /** The laptop's verdict: `passed`, for a fault. */
  reference: ReferenceGateVerdictSchema,
  /** The machine's verdict: `failed`, for a fault. */
  machine: ReferenceGateVerdictSchema,
  /** The laptop's output tail, on the run's program node, when the reference kept one. */
  referenceOutputArtifactId: ArtifactIdSchema.optional(),
  /** The machine's output tail, on the run's program node. */
  machineOutputArtifactId: ArtifactIdSchema.optional(),
  /**
   * The last of the laptop's output, inline, so a reader shows it beside the
   * machine's without reading an artifact. Bounded with `machineTail` so the
   * event stays within `MAX_INLINE_PAYLOAD_BYTES`; absent on older events.
   */
  referenceTail: z.string().max(MAX_ENVIRONMENT_FAULT_TAIL_CHARS).optional(),
  /** The last of the machine's output, inline, bounded as `referenceTail` is. */
  machineTail: z.string().max(MAX_ENVIRONMENT_FAULT_TAIL_CHARS).optional(),
});
export type EnvironmentFaultGate = z.infer<typeof EnvironmentFaultGateSchema>;

/**
 * The payload of an `environment.fault` event, for the report and the Studio to read.
 *
 * A fault of many gates is written as several events, `part` 1 to `parts`, so
 * each stays within `MAX_INLINE_PAYLOAD_BYTES` and every gate keeps a readable
 * tail of both outputs; a reader takes the gates of every part. A fault that
 * fits in one event has neither field.
 */
export const EnvironmentFaultPayloadSchema = z
  .strictObject({
    /** The commit both audits were of. */
    baseCommit: CommitShaSchema,
    gates: z.array(EnvironmentFaultGateSchema).min(1),
    /** `node --version` where the reference audit ran, without the `v`; absent when there was none. */
    referenceNode: z.string().min(1).optional(),
    /** `node --version` on the machine, as a worker user in the project environment; absent when there was none. */
    machineNode: z.string().min(1).optional(),
    /** Which of the fault's events this is, from 1, when it took more than one. */
    part: z.int().min(1).optional(),
    /** How many events the fault took, when more than one. */
    parts: z.int().min(2).optional(),
  })
  .refine(
    (value) =>
      (value.part === undefined) === (value.parts === undefined) &&
      (value.part === undefined || value.parts === undefined || value.part <= value.parts),
    { message: "part and parts come together, and part is at most parts", path: ["part"] },
  );
export type EnvironmentFaultPayload = z.infer<typeof EnvironmentFaultPayloadSchema>;
