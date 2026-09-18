/**
 * What an orchestrator-role server holds for a session.
 *
 * One run at a time, and one job in flight under it (contract §5). The state is
 * deliberately thin: the control plane is the authority for everything about the
 * run (A-06), and what lives here is only what a *process* has — the outbox it
 * delivers through, the job whose worker it is waiting on, and the identity it
 * acts as.
 *
 * Nothing here is read to answer a question about run state. `job.get` and
 * `program.status` go to the control plane, so an orchestrator and a human
 * reading `GET …/state` never disagree.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Agent,
  AgentId,
  Checkpoint,
  ExecutionNode,
  ProgramContract,
  ProgramId,
  ProjectId,
  Run,
  RunId,
} from "@nightshift/contracts";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { nowIso, type RunScope } from "@nightshift/core";
import {
  checkpointRef,
  createEventOutbox,
  type EventOutbox,
  type ExecutionEnvironment,
  type RunSession,
  revParse,
  type StartedJob,
  startRun,
  updateRef,
  type WorkerLaunchIdentity,
} from "@nightshift/execution";
import type { McpLaunch } from "@nightshift/harness";
import type { Runtime } from "./compose.js";
import { ToolRefusal } from "./results.js";

/** Where a repository declares which program it belongs to. */
export const DEFAULT_CONTRACT_FILE = "nightshift.program.json";

export interface AttachedRun {
  readonly session: RunSession;
  readonly environment: ExecutionEnvironment;
  readonly outbox: EventOutbox;
  /** The job this server started, while it is the current one. */
  job?: StartedJob | undefined;
  /** How many spooled events an earlier session for this run left behind. */
  readonly replayed: number;
  /** Whether the authored file disagrees with the stored contract. */
  readonly contractDrifted: boolean;
}

export interface OrchestratorSession {
  readonly runtime: Runtime;
  /** The operator's clone. Its program branch is what a job integrates into. */
  readonly repoPath: string;
  readonly contractFile: string;
  /** From the MCP initialize handshake: which harness is orchestrating. */
  clientInfo(): { readonly name: string; readonly version: string };
  /** Builds the launch for a worker's own MCP server (§4.2). */
  workerLaunch(identity: WorkerLaunchIdentity): McpLaunch;
  current?: AttachedRun | undefined;
}

const buildEnvironment = (runtime: Runtime, outbox: EventOutbox): ExecutionEnvironment => ({
  stores: runtime.stores,
  bodies: runtime.bodies,
  tokens: runtime.tokens,
  harness: runtime.harness,
  clock: runtime.clock,
  ids: runtime.ids,
  paths: runtime.paths,
  git: runtime.git,
  outbox,
});

/**
 * Which program this repository belongs to, from its authored contract.
 *
 * Only the identifiers are taken from the file. The **record** is the authority
 * for the contract's content (§4.5), and `attachRun` reports when the two have
 * drifted rather than quietly preferring either.
 */
const repositoryProgram = async (
  state: OrchestratorSession,
): Promise<{ projectId: ProjectId; programId: ProgramId }> => {
  const path = resolve(state.repoPath, state.contractFile);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ToolRefusal(
      "not_found",
      `this repository has no readable program contract at ${path}, so there is no way to know ` +
        `which program it belongs to: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const authored = raw as { projectId?: unknown; programId?: unknown };
  return {
    projectId: ProjectIdSchema.parse(authored.projectId),
    programId: ProgramIdSchema.parse(authored.programId),
  };
};

/**
 * The orchestrator's own `Agent`, created and started.
 *
 * Its `harness` is the MCP client's name from the initialize handshake — which
 * is what is actually orchestrating — and its model is what `run.attach` was
 * told. Neither is guessed: an agent record claiming a model nobody chose would
 * poison the routing dataset it sits beside.
 */
const createOrchestratorAgent = async (
  state: OrchestratorSession,
  scope: RunScope,
  rootNodeId: ExecutionNode["executionNodeId"],
  model: string,
): Promise<AgentId> => {
  const client = state.clientInfo();
  const { stores, clock, ids } = state.runtime;
  const agent: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: rootNodeId,
    role: "orchestrator",
    harness: client.name,
    provider: "anthropic",
    model,
    status: "created",
    createdAt: nowIso(clock),
  };
  await stores.agents.put(agent);
  await stores.agents.put({ ...agent, status: "started", startedAt: nowIso(clock) });
  return agent.agentId;
};

/** Moves the root node and the run to `running`, one table step at a time. */
const beginRun = async (
  state: OrchestratorSession,
  run: Run,
  rootNode: ExecutionNode,
): Promise<Run> => {
  const { stores, clock } = state.runtime;
  let node = rootNode;
  for (const next of ["queued", "running"] as const) {
    if (
      (next === "queued" && node.status === "validated") ||
      (next === "running" && node.status === "queued")
    ) {
      node = { ...node, status: next, updatedAt: nowIso(clock) };
      await stores.executionNodes.put(node);
    }
  }
  if (run.status !== "pending") return run;
  const running: Run = { ...run, status: "running" };
  await stores.runs.put(running);
  return running;
};

interface Located {
  readonly program: ProgramContract;
  readonly run: Run;
  readonly rootNode: ExecutionNode;
}

/**
 * The run to attach to: the one named, or the single `pending` one.
 *
 * Two pending runs is a refusal that lists them. Picking one would mean an
 * orchestrator working on a run nobody asked it to, which is worse than making
 * the operator say which.
 */
const locateRun = async (
  state: OrchestratorSession,
  runId: string | undefined,
): Promise<Located> => {
  const { stores } = state.runtime;
  const { projectId, programId } = await repositoryProgram(state);
  const program = await stores.programContracts.get(projectId, programId);
  if (program === undefined) {
    throw new ToolRefusal(
      "not_found",
      `program ${programId} is not in the control plane. Authorize a run first with ` +
        "`nightshift run`, or start one here with run.start.",
    );
  }

  const chosen = await chooseRun(state, { projectId, programId }, runId);
  const scope: RunScope = { projectId, programId, runId: chosen.runId };
  const rootNode = await stores.executionNodes.get(scope, chosen.rootNodeId);
  if (rootNode === undefined) {
    throw new ToolRefusal("not_found", `run ${chosen.runId} names a root node that does not exist`);
  }
  return { program, run: chosen, rootNode };
};

const chooseRun = async (
  state: OrchestratorSession,
  scope: { readonly projectId: ProjectId; readonly programId: ProgramId },
  runId: string | undefined,
): Promise<Run> => {
  const { stores } = state.runtime;
  if (runId !== undefined) {
    const run = await stores.runs.get(scope, RunIdSchema.parse(runId));
    if (run === undefined) {
      throw new ToolRefusal(
        "not_found",
        `run ${runId} does not exist in program ${scope.programId}`,
      );
    }
    return run;
  }

  const runs = await stores.runs.listByProgram(scope);
  const pending = runs.items.filter((run) => run.status === "pending");
  const only = pending[0];
  if (only === undefined) {
    throw new ToolRefusal(
      "not_found",
      `program ${scope.programId} has no pending run to attach to. Authorize one with ` +
        "`nightshift run <contract>`, which prints the run id.",
    );
  }
  if (pending.length > 1) {
    throw new ToolRefusal(
      "validation_failed",
      `program ${scope.programId} has ${pending.length} pending runs, so there is no single one to ` +
        `attach to. Name the one you mean: ${pending.map((run) => run.runId).join(", ")}`,
      { pendingRuns: pending.map((run) => run.runId) },
    );
  }
  return only;
};

/** Whether the authored file still says what the stored contract says. */
const contractDrifted = async (
  state: OrchestratorSession,
  stored: ProgramContract,
): Promise<boolean> => {
  try {
    const authored: unknown = JSON.parse(
      await readFile(resolve(state.repoPath, state.contractFile), "utf8"),
    );
    return JSON.stringify(authored) !== JSON.stringify(stored);
  } catch {
    return false;
  }
};

export interface AttachInput {
  readonly model: string;
  readonly runId?: string;
}

export const attachRun = async (
  state: OrchestratorSession,
  input: AttachInput,
): Promise<AttachedRun> => {
  if (state.current !== undefined) {
    throw new ToolRefusal(
      "already_attached",
      `this server is already bound to run ${state.current.session.scope.runId}. One run per ` +
        "session: start a new orchestrator for another.",
    );
  }

  const { runtime } = state;
  const { program, run, rootNode } = await locateRun(state, input.runId);
  const scope: RunScope = {
    projectId: program.projectId,
    programId: program.programId,
    runId: run.runId,
  };

  const agentId = await createOrchestratorAgent(
    state,
    scope,
    rootNode.executionNodeId,
    input.model,
  );
  const outbox = createEventOutbox({
    events: runtime.stores.events,
    scope,
    clock: runtime.clock,
    ids: runtime.ids,
    writerId: agentId,
  });

  // A spool an earlier server for this run left behind, replayed **before** any
  // new event is accepted, so the stream stays in order. The idempotency keys
  // make replaying safe even if the earlier server had in fact delivered them.
  const replayed = await outbox.replay(runtime.paths.spool(scope.runId));

  const started = await beginRun(state, run, rootNode);
  outbox.emit({
    type: "run.started",
    source: "control-plane",
    payload: { orchestrator: state.clientInfo().name, model: input.model },
    executionNodeId: rootNode.executionNodeId,
    agentId,
  });

  const attached: AttachedRun = {
    session: {
      scope,
      program,
      run: started,
      rootNodeId: rootNode.executionNodeId,
      orchestratorAgentId: agentId,
      repoPath: state.repoPath,
    },
    environment: buildEnvironment(runtime, outbox),
    outbox,
    replayed,
    contractDrifted: await contractDrifted(state, program),
  };
  state.current = attached;
  return attached;
};

export interface StartRunInput {
  readonly program: unknown;
  readonly repoPath: string;
  readonly model: string;
}

/**
 * `run.start`: the CLI's own function, then an attach (D-P3-17).
 *
 * The control-plane writes are `startRun` in `@nightshift/execution`, shared
 * verbatim with `nightshift run`. Two implementations of "what starting a run
 * means" is exactly what A-32's "same canonical model" forbids.
 */
export const startNewRun = async (
  state: OrchestratorSession,
  input: StartRunInput,
): Promise<AttachedRun & { readonly baseCommit: string }> => {
  const { runtime } = state;
  const started = await startRun(
    { stores: runtime.stores, clock: runtime.clock, ids: runtime.ids, git: runtime.git },
    { program: input.program, repoPath: input.repoPath },
  );
  const attached = await attachRun(state, { model: input.model, runId: started.run.runId });
  return { ...attached, baseCommit: started.baseCommit };
};

/** A node's line in `execution.status`. One line, because a tree is read at a glance. */
export const describeNodeLine = (node: ExecutionNode, agent: Agent | undefined): string => {
  const commit = node.commitSha === null ? "" : ` @${node.commitSha.slice(0, 8)}`;
  const worker = agent === undefined ? "" : ` [${agent.role} ${agent.model} ${agent.status}]`;
  const reason = node.outcomeReason === undefined ? "" : ` — ${node.outcomeReason}`;
  return `${"  ".repeat(node.depth)}${node.executionNodeId} ${node.kind} ${node.status}${commit}${worker}${reason}`;
};

/** A checkpoint at the program branch head: a ref, and the record that finds it. */
export const createCheckpointAt = async (
  state: OrchestratorSession,
  attached: AttachedRun,
  label: string | undefined,
): Promise<Checkpoint> => {
  const { runtime } = state;
  const commitSha = await revParse(
    runtime.git,
    state.repoPath,
    attached.session.program.repository.programBranch,
  );
  const checkpointId = runtime.ids.next("ckpt");
  const ref = checkpointRef(checkpointId);
  await updateRef(runtime.git, state.repoPath, ref, commitSha);
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    ...attached.session.scope,
    checkpointId,
    executionNodeId: attached.session.rootNodeId,
    commitSha,
    ref,
    ...(label === undefined ? {} : { label }),
    createdAt: nowIso(runtime.clock),
  };
  await runtime.stores.checkpoints.put(checkpoint);
  attached.outbox.emit({
    type: "checkpoint.created",
    source: "control-plane",
    payload: { checkpointId, ref, commitSha },
    executionNodeId: attached.session.rootNodeId,
  });
  return checkpoint;
};

export type { RunId };
