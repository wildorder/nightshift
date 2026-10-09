/**
 * A red base, kept on the run (P15, D-P15-03, SC-P15-05).
 *
 * A gate audit that finds the base red no longer stops the run: the run starts,
 * its first job is the repair, and the engine holds the strands until the
 * repair lands. What the audit found is kept on the run's program node, where
 * the report, the Studio and the repair's worker find it: the `gate.red` event
 * that the engine's hold is read from, and each red gate's last output as a
 * verification log.
 *
 * Shared by `nightshift run` on a laptop and the runner on a machine of its own,
 * so the two record a red base the same way.
 */
import { EventSchema, type ExecutionNodeId } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import type { GateAudit } from "./gate-audit.js";
import { createEventOutbox } from "./outbox.js";
import { recordArtifact } from "./runner.js";

/** The payload of a `gate.red` event: the base audited, and the ids of its red gates. */
export const gateRedPayload = (
  audit: Pick<GateAudit, "base" | "failing">,
): { readonly baseCommit: string; readonly failing: readonly string[] } => ({
  baseCommit: audit.base,
  failing: [...audit.failing],
});

export interface RecordRedBaseInput {
  readonly scope: RunSession["scope"];
  /** The run's program node. */
  readonly nodeId: ExecutionNodeId;
  readonly audit: GateAudit;
  /** Who writes these records (A-30): the outbox's writer id. */
  readonly writerId: string;
  /**
   * Also record the `gate.red` event. False when the run's start already
   * wrote it (`startRun`'s `red`, on a laptop).
   */
  readonly event: boolean;
}

/** Each red gate's last output as a verification log on the program node, and `gate.red` when asked. */
export const recordRedBase = async (
  environment: Pick<ExecutionEnvironment, "stores" | "bodies" | "clock" | "ids">,
  input: RecordRedBaseInput,
): Promise<void> => {
  const outbox = createEventOutbox({
    events: environment.stores.events,
    scope: input.scope,
    clock: environment.clock,
    ids: environment.ids,
    writerId: input.writerId,
  });
  if (input.event) {
    // Written directly, not through the outbox: the engine's hold is read from
    // it, so it is durable before the root starts or the call fails. The key is
    // deterministic, so a repeated audit of the same run converges.
    const at = nowIso(environment.clock);
    await environment.stores.events.append(
      EventSchema.parse({
        schemaVersion: 1,
        ...input.scope,
        eventId: environment.ids.next("evt"),
        idempotencyKey: `control-plane:${input.scope.runId}:gate.red`,
        sequence: null,
        type: "gate.red",
        source: "control-plane",
        executionNodeId: input.nodeId,
        agentId: null,
        payload: gateRedPayload(input.audit),
        occurredAt: at,
        recordedAt: at,
      }),
    );
  }
  // Only the red ones: a `deferred` gate is not red (D-P7-10), and its output is not a failure's.
  for (const gate of input.audit.gates.filter((candidate) => candidate.verdict === "failed")) {
    const last = gate.result;
    if (last === undefined) continue;
    await recordArtifact(
      { ...environment, outbox },
      {
        scope: input.scope,
        nodeId: input.nodeId,
        kind: "verification-log",
        contentType: "text/plain; charset=utf-8",
        bytes: last.output,
      },
    );
  }
  await outbox.flush(5_000).catch(() => undefined);
};
