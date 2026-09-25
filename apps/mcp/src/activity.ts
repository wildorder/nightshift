/**
 * What is happening across a run, in the plan's terms, for the session that is
 * orchestrating it (2026-09-24, the owner's feedback on the first real planned
 * run: "ask it to run the thing and it goes dark for three hours").
 *
 * Everything below the root runs in processes of their own: each strand's
 * orchestrator and each worker. Their reasoning is not the session's to read,
 * but what they *do* is on the record already — a strand's orchestrator
 * delegating a job, deciding something, reporting progress; a worker's progress
 * notes and tool calls; verification, landings, failures. This turns those
 * events into short lines, labelled by strand and job, so the session can keep a
 * human in the loop without anyone reading raw output.
 *
 * A feed remembers what it has handed over, per attached run, so each call
 * answers "since last time". Tool calls are too many to list: they are counted
 * per node as a heartbeat, so a strand that is working never looks silent.
 */
import type { Decision, Event, ExecutionNode, JobContract } from "@nightshift/contracts";
import type { ProjectStores, RunScope } from "@nightshift/core";

export interface ActivityLine {
  readonly at: string;
  /** `S-02`, `S-02 › add the webhook lambda`, `root`, or a job's own title in an unplanned run. */
  readonly who: string;
  readonly text: string;
}

export interface ActivityFeed {
  /** What happened since the last call, oldest first. */
  since(): Promise<readonly ActivityLine[]>;
  /** Everything so far, oldest first, the last `limit` lines. */
  all(limit: number): Promise<readonly ActivityLine[]>;
}

const readAll = async <T>(
  read: (page: {
    cursor?: string;
  }) => Promise<{ items: readonly T[]; cursor?: string | undefined }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** The first line of an objective, without its markdown heading marks, cut to fit a line. */
const titleOf = (objective: string): string => {
  const line = objective.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const bare = line
    .replace(/^#+\s*/, "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim();
  return bare.length > 70 ? `${bare.slice(0, 67)}…` : bare;
};

const short = (text: unknown, max = 160): string => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

interface Context {
  readonly nodes: ReadonlyMap<string, ExecutionNode>;
  readonly jobs: ReadonlyMap<string, JobContract>;
  readonly decisions: ReadonlyMap<string, Decision>;
}

/** The strand a node is in: itself, or the nearest ancestor whose Job Contract names one. */
const strandOf = (context: Context, node: ExecutionNode | undefined): string | undefined => {
  let current = node;
  for (let step = 0; current !== undefined && step < 16; step += 1) {
    const job =
      current.jobContractId === null ? undefined : context.jobs.get(current.jobContractId);
    if (job?.strandId !== undefined) return job.strandId;
    current = current.parentNodeId === null ? undefined : context.nodes.get(current.parentNodeId);
  }
  return undefined;
};

const whoIs = (context: Context, nodeId: string | null): string => {
  const node = nodeId === null ? undefined : context.nodes.get(nodeId);
  if (node === undefined || node.parentNodeId === null) return "root";
  const job = node.jobContractId === null ? undefined : context.jobs.get(node.jobContractId);
  if (job?.strandId !== undefined) return job.strandId;
  const strand = strandOf(context, node);
  const title = job === undefined ? node.executionNodeId : titleOf(job.objective);
  return strand === undefined ? title : `${strand} › ${title}`;
};

const payloadOf = (event: Event): Record<string, unknown> =>
  (event.payload ?? {}) as Record<string, unknown>;

const listOf = (value: unknown): string => short(Array.isArray(value) ? value.join(", ") : "");

type Render = (p: Record<string, unknown>, context: Context) => string;

const verificationText: Render = (p) => {
  if (p.outcome === "failed") {
    const steps = listOf(p.failingSteps);
    return `verification failed${steps === "" ? "" : `: ${steps}`}`;
  }
  return p.outcome === "deferred"
    ? "verification deferred for a human prerequisite"
    : "verification passed";
};

const decisionText: Render = (p, context) => {
  const decision = context.decisions.get(String(p.decisionId));
  return decision === undefined
    ? `decided: ${short(p.choice)}`
    : `decided: ${short(decision.choice, 90)} — ${short(decision.context, 120)}`;
};

/** One line per narrated event type. */
const RENDER: Readonly<Record<string, Render>> = {
  "node.started": () => "started",
  "node.progress": (p) => `“${short(p.message)}”`,
  "decision.recorded": decisionText,
  "node.implemented": () => "finished its work; verifying",
  "verification.completed": verificationText,
  "node.rebased": () => "rebased onto work that landed meanwhile",
  "integration.conflict": (p) =>
    `conflicts with work that landed meanwhile: ${listOf(p.conflicts)}`,
  "node.integrated": (p) => `landed ${String(p.commitSha ?? "").slice(0, 8)}`,
  "node.deferred": (p) => `on the provisional line, waiting on ${listOf(p.waitingOn)}`,
  "node.failed": (p) => `failed: ${short(p.reason)}`,
  "node.cancelled": (p) => `cancelled: ${short(p.reason)}`,
  "node.interrupted": (p) => `interrupted: ${short(p.reason)}`,
  "node.succeeded": (p) => `succeeded${p.summary === undefined ? "" : `: ${short(p.summary)}`}`,
  "node.discarded": (p) => `discarded: ${short(p.reason)}`,
  "strand.parked": (p) => `${String(p.strandId)} parked (${String(p.outcome)})`,
  "strand.blocked": (p) => `${String(p.strandId)} blocked by ${listOf(p.blockedBy)}`,
};

interface Tally {
  count: number;
  readonly tools: Map<string, number>;
  at: string;
}

/**
 * Turns one batch of events into lines. Tool calls are counted per node and
 * written out as one heartbeat line just before that node's next narrated line,
 * or at the end.
 */
class Narration {
  readonly lines: ActivityLine[] = [];
  readonly ids: string[] = [];
  private readonly calls = new Map<string, Tally>();

  constructor(
    private readonly context: Context,
    private readonly handed: ReadonlySet<string>,
  ) {}

  add(event: Event): void {
    const nodeId = event.executionNodeId;
    const render = RENDER[event.type];
    if (event.type === "tool.called" && nodeId !== null) {
      this.ids.push(event.eventId);
      if (!this.handed.has(event.eventId)) this.count(nodeId, event);
      return;
    }
    if (render === undefined) return;
    this.ids.push(event.eventId);
    if (this.handed.has(event.eventId)) return;
    if (nodeId !== null) this.heartbeat(nodeId);
    this.lines.push({
      at: event.occurredAt,
      who: whoIs(this.context, nodeId),
      text: render(payloadOf(event), this.context),
    });
  }

  finish(): ActivityLine[] {
    for (const nodeId of [...this.calls.keys()]) this.heartbeat(nodeId);
    return this.lines.sort((a, b) => a.at.localeCompare(b.at));
  }

  private count(nodeId: string, event: Event): void {
    const tally = this.calls.get(nodeId) ?? { count: 0, tools: new Map(), at: event.occurredAt };
    const tool = String(payloadOf(event).tool ?? "tool").replace(/^mcp__nightshift__/, "");
    tally.count += 1;
    tally.tools.set(tool, (tally.tools.get(tool) ?? 0) + 1);
    tally.at = event.occurredAt;
    this.calls.set(nodeId, tally);
  }

  private heartbeat(nodeId: string): void {
    const tally = this.calls.get(nodeId);
    if (tally === undefined) return;
    this.calls.delete(nodeId);
    const top = [...tally.tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tool, n]) => `${tool}×${n}`)
      .join(", ");
    const plural = tally.count === 1 ? "" : "s";
    this.lines.push({
      at: tally.at,
      who: whoIs(this.context, nodeId),
      text: `working: ${tally.count} tool call${plural} (${top})`,
    });
  }
}

export const createActivityFeed = (stores: ProjectStores, scope: RunScope): ActivityFeed => {
  const handed = new Set<string>();

  const read = async (): Promise<{ lines: ActivityLine[]; ids: string[] }> => {
    const [events, nodes, jobs, decisions] = await Promise.all([
      readAll((page) => stores.events.listByRun(scope, page)),
      readAll((page) => stores.executionNodes.listByRun(scope, page)),
      readAll((page) => stores.jobContracts.listByRun(scope, page)),
      readAll((page) => stores.decisions.listByRun(scope, page)),
    ]);
    const context: Context = {
      nodes: new Map(nodes.map((node) => [node.executionNodeId as string, node])),
      jobs: new Map(jobs.map((job) => [job.jobContractId as string, job])),
      decisions: new Map(decisions.map((decision) => [decision.decisionId as string, decision])),
    };
    const ordered = [...events].sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
    );
    const narration = new Narration(context, handed);
    for (const event of ordered) narration.add(event);
    return { lines: narration.finish(), ids: narration.ids };
  };

  return {
    since: async () => {
      const { lines, ids } = await read();
      for (const id of ids) handed.add(id);
      return lines;
    },
    all: async (limit) => {
      const saved = new Set(handed);
      handed.clear();
      try {
        const { lines } = await read();
        return lines.slice(-limit);
      } finally {
        for (const id of saved) handed.add(id);
      }
    },
  };
};

/** One line, for a model to read and relay: `09:14 S-02 › add the webhook lambda — landed 5ed6460a`. */
export const renderActivity = (lines: readonly ActivityLine[]): string[] =>
  lines.map((line) => `${line.at.slice(11, 16)} ${line.who} — ${line.text}`);
