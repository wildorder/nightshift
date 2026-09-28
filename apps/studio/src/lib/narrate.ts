/**
 * One line per event, for the timeline (T4). The phrasing follows the MCP
 * server's activity narration (`apps/mcp/src/activity.ts`) so a run reads the
 * same in a terminal and in the Studio.
 */
import type { Event } from "@nightshift/contracts";

const short = (text: unknown, max = 160): string => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const listOf = (value: unknown): string => short(Array.isArray(value) ? value.join(", ") : "");

type Render = (p: Record<string, unknown>) => string;

const routedText: Render = (p) => {
  const chosen = (p.chosen ?? {}) as { model?: unknown };
  const model = String(chosen.model ?? "a model");
  if (p.purpose !== undefined) return `${String(p.purpose)} route: ${model}`;
  const attempt = typeof p.attempt === "number" ? p.attempt : 1;
  const rung = (p.rung ?? {}) as { tier?: unknown };
  const where =
    p.ladder === undefined ? model : `${model} (${String(p.ladder)}, ${String(rung.tier ?? "?")})`;
  return attempt > 1
    ? `attempt ${attempt} on ${where}`
    : `routed to ${where} by ${String(p.ruleId ?? "its rule")}`;
};

const RENDER: Readonly<Record<string, Render>> = {
  "run.created": () => "run created",
  "run.started": () => "run started",
  "run.completed": () => "run completed",
  "run.failed": (p) => `run failed${p.reason === undefined ? "" : `: ${short(p.reason)}`}`,
  "run.cancelled": (p) => `run cancelled${p.reason === undefined ? "" : `: ${short(p.reason)}`}`,
  "run.interrupted": () => "run interrupted",
  "node.delegated": (p) =>
    `delegated${p.objective === undefined ? "" : `: ${short(p.objective, 100)}`}`,
  "node.queued": (p) => `queued${p.reason === undefined ? "" : ` (${short(p.reason)})`}`,
  "node.started": () => "started",
  "node.progress": (p) => `“${short(p.message)}”`,
  "node.implemented": () => "finished its work; verifying",
  "node.failed": (p) => `failed: ${short(p.reason)}`,
  "node.cancelled": (p) => `cancelled: ${short(p.reason)}`,
  "node.interrupted": (p) => `interrupted: ${short(p.reason)}`,
  "node.integrated": (p) => `landed ${String(p.commitSha ?? "").slice(0, 8)}`,
  "node.succeeded": (p) => `succeeded${p.summary === undefined ? "" : `: ${short(p.summary)}`}`,
  "node.rebased": () => "rebased onto work that landed meanwhile",
  "node.deferred": (p) => `on the provisional line, waiting on ${listOf(p.waitingOn)}`,
  "node.discarded": (p) => `discarded: ${short(p.reason)}`,
  "strand.parked": (p) => `${String(p.strandId)} parked (${String(p.outcome)})`,
  "strand.blocked": (p) => `${String(p.strandId)} blocked by ${listOf(p.blockedBy)}`,
  "integration.conflict": (p) =>
    `conflicts with work that landed meanwhile: ${listOf(p.conflicts)}`,
  "agent.created": (p) => `agent created${p.model === undefined ? "" : ` (${String(p.model)})`}`,
  "agent.started": () => "agent started",
  "agent.completed": () => "agent completed",
  "agent.failed": (p) => `agent failed${p.reason === undefined ? "" : `: ${short(p.reason)}`}`,
  "agent.cancelled": () => "agent cancelled",
  "agent.interrupted": () => "agent interrupted",
  "agent.subagent_created": () => "spawned a sub-agent",
  "agent.context_compacted": () => "compacted its context",
  "tool.called": (p) => `called ${String(p.tool ?? "a tool").replace(/^mcp__nightshift__/, "")}`,
  "tool.completed": (p) =>
    `${String(p.tool ?? "a tool").replace(/^mcp__nightshift__/, "")} returned`,
  "verification.requested": () => "verification requested",
  "verification.completed": (p) => {
    if (p.outcome === "failed") {
      const steps = listOf(p.failingSteps);
      return `verification failed${steps === "" ? "" : `: ${steps}`}`;
    }
    return p.outcome === "deferred"
      ? "verification deferred for a human prerequisite"
      : "verification passed";
  },
  "examination.requested": (p) => {
    const examiner = (p.examiner ?? {}) as { model?: unknown };
    return `examining with ${String(examiner.model ?? "an examiner")}${p.blocking === true ? " (blocking)" : ""}`;
  },
  "examination.asked": (p) => `the examiner asks the builder: ${listOf(p.questions)}`,
  "examination.answered": () => "the builder answered",
  "examination.completed": (p) => {
    const findings = Array.isArray(p.findings) ? p.findings.length : 0;
    return `examined: ${String(p.outcome)}${findings === 0 ? "" : `, ${findings} finding(s)`}`;
  },
  "finding.disputed": (p) => `disputed ${listOf(p.findings)}: ${short(p.reason)}`,
  "finding.ruled": (p) => `the arbiter ${String(p.ruling)} ${String(p.findingId)}`,
  "run.budget_spent": (p) =>
    `budget spent: ${String(p.budget)} ${String(p.spent)} of ${String(p.limit)}; nothing new starts`,
  "decision.recorded": (p) => `decided: ${short(p.choice ?? p.decisionId)}`,
  "decision.overridden": (p) => `decision overridden: ${short(p.choice ?? p.decisionId)}`,
  "checkpoint.created": (p) => `checkpoint ${String(p.commitSha ?? "").slice(0, 8)}`,
  "routing.decided": routedText,
  "artifact.recorded": (p) => `artifact recorded: ${String(p.kind ?? "")}`,
};

export const narrate = (event: Event): string => {
  const render = RENDER[event.type];
  return render === undefined
    ? event.type
    : render((event.payload ?? {}) as Record<string, unknown>);
};
