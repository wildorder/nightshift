/**
 * Starting a run (D-P3-17, A-32).
 *
 * One function, called by two things: the CLI's `nightshift run <contract>` and
 * the MCP server's `run.start`. That is the whole point of it existing here
 * rather than in either of them — "the same canonical model" (SC-16) is a claim
 * about one code path, not about two that were written to match.
 *
 * It does the half that is identical whether the run will execute locally or
 * remotely: validate the authored contract, persist the program, create the run,
 * its root node and an initial checkpoint. The local form then prints a run id
 * for an orchestrator to attach to; `--remote` adds a dispatch call in P10 and is
 * refused until then.
 *
 * ## Why there is an initial checkpoint
 *
 * A `Decision` carries `checkpointBefore`, and it is required. Without a
 * checkpoint at the run's start, the first decision an orchestrator records
 * would have nothing to point at — so the run begins with one, at the program
 * branch head, before anything has happened.
 */

import { createHash } from "node:crypto";
import type {
  Checkpoint,
  Decision,
  ExecutionLocation,
  ExecutionNode,
  ProgramContract,
  Project,
  Run,
} from "@nightshift/contracts";
import { defaultOrgConfig, EventSchema, ProgramContractSchema } from "@nightshift/contracts";
import type { Clock, IdGenerator, ProjectStores, RunScope } from "@nightshift/core";
import {
  finishRun,
  isPlanned,
  nowIso,
  planHash,
  requireEffectivePolicy,
  transitionRun,
} from "@nightshift/core";
import { carriedStrandsFor } from "./carry-over.js";
import { checkpointRef, type GitRunner, revParse, updateRef } from "./git/index.js";

export interface StartRunEnvironment {
  readonly stores: ProjectStores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly git: GitRunner;
}

export interface StartRunInput {
  /** The authored contract, as read from the file. Validated here. */
  readonly program: unknown;
  /** The operator's clone, whose program branch the run will integrate into. */
  readonly repoPath: string;
  /**
   * The plan document as it is on disk, for a planned program (P7, D-P7-02).
   * What is on disk is hashed and held to the ratified hash, so an edited plan
   * is refused here rather than silently run.
   */
  readonly planText?: string;
  /**
   * Where the run executes (P10, A-32): `remote` when `--remote` will dispatch
   * it to a machine of its own, else `local`. Recorded on the run and in its
   * first event; the dispatch route refuses a run that was not started remote.
   */
  readonly location?: ExecutionLocation;
}

export interface StartedRun {
  readonly program: ProgramContract;
  readonly run: Run;
  readonly rootNode: ExecutionNode;
  readonly checkpoint: Checkpoint;
  readonly baseCommit: string;
}

/** The project must exist before a program can belong to it. */
export class ProjectMissingError extends Error {
  override readonly name = "ProjectMissingError";

  constructor(readonly projectId: string) {
    super(
      `project ${projectId} does not exist. Create it first with \`nightshift project create\`, ` +
        "and put the id it prints in the contract's projectId.",
    );
  }
}

/**
 * A revised contract under an identifier that already holds a different one.
 *
 * The Program Contract is the stable authority for a run; a second run under the
 * same id with different content would make every record that references it
 * ambiguous. Mint a new `programId` (`nightshift id prog`) for revised work.
 */
export class ProgramContractChangedError extends Error {
  override readonly name = "ProgramContractChangedError";

  constructor(readonly programId: string) {
    super(
      `a different program contract is already stored under ${programId}. A contract is the ` +
        "stable authority for its runs and is not revised in place; mint a new programId with " +
        "`nightshift id prog` for the revised contract.",
    );
  }
}

/**
 * Create-or-confirm, for a contract with no strands. An identical contract is
 * stored again harmlessly; a different one under the same id is a conflict the
 * caller must resolve.
 */
const confirmContract = async (
  stores: ProjectStores,
  program: ProgramContract,
): Promise<ProgramContract> => {
  try {
    await stores.programContracts.put(program);
  } catch (error) {
    if ((error as { status?: unknown }).status === 409) {
      throw new ProgramContractChangedError(program.programId);
    }
    throw error;
  }
  return program;
};

/** A planned program that no human has ratified. Nothing executes before that (D-P7-02). */
export class PlanNotRatifiedError extends Error {
  override readonly name = "PlanNotRatifiedError";

  constructor(readonly programId: string) {
    super(
      `program ${programId} is planned and has not been ratified, so nothing will run. ` +
        "Check it with `nightshift plan check`, then ratify it with `nightshift plan ratify`.",
    );
  }
}

/** The plan on disk is not the plan that was ratified. An edited plan is re-ratified, never silently run. */
export class PlanChangedError extends Error {
  override readonly name = "PlanChangedError";

  constructor(
    readonly programId: string,
    readonly ratifiedHash: string,
    readonly diskHash: string,
  ) {
    super(
      `the plan for ${programId} has changed since it was ratified (ratified ${ratifiedHash.slice(0, 12)}, ` +
        `on disk ${diskHash.slice(0, 12)}). Ratify it again with \`nightshift plan ratify\`, or restore ` +
        "the ratified plan; nothing was started.",
    );
  }
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The contract a run of a **planned** program executes: the control plane's
 * ratified record, once what is on disk has been held to its hash. A planned
 * contract is never written from here; ratification is the only thing that
 * writes one.
 */
export const requireRatifiedPlan = async (
  stores: ProjectStores,
  program: ProgramContract,
  planText: string | undefined,
): Promise<ProgramContract> => {
  const recorded = await stores.programContracts.get(program.projectId, program.programId);
  if (recorded?.status !== "ratified" || recorded.planHash === undefined) {
    throw new PlanNotRatifiedError(program.programId);
  }
  if (planText === undefined) {
    throw new PlanChangedError(program.programId, recorded.planHash, "(no plan document given)");
  }
  const onDisk = planHash(program, planText, sha256Hex).hash;
  if (onDisk !== recorded.planHash) {
    throw new PlanChangedError(program.programId, recorded.planHash, onDisk);
  }
  return recorded;
};

export const startRun = async (
  environment: StartRunEnvironment,
  input: StartRunInput,
): Promise<StartedRun> => {
  const { stores, clock, ids } = environment;
  const authored = ProgramContractSchema.parse(input.program);

  const project: Project | undefined = await stores.projects.get(authored.projectId);
  if (project === undefined) throw new ProjectMissingError(authored.projectId);

  const program = isPlanned(authored)
    ? await requireRatifiedPlan(stores, authored, input.planText)
    : await confirmContract(stores, authored);

  // P8 (D-P8-03): the org's routing and examination policy, narrowed by the
  // contract, fixed for the life of the run. A narrowing that widens is refused
  // here, before anything exists.
  const orgConfig =
    (await stores.orgConfigs.get(project.orgId)) ?? defaultOrgConfig(project.orgId, nowIso(clock));
  const policy = requireEffectivePolicy(orgConfig, program);

  const baseCommit = await revParse(
    environment.git,
    input.repoPath,
    program.repository.programBranch,
  );

  // What an earlier run of this same plan already finished, and is on the
  // branch this run starts from: not built again (carry-over.ts).
  const carriedStrands = await carriedStrandsFor(
    { stores, git: environment.git },
    { program, repoPath: input.repoPath, baseCommit },
  );

  const runId = ids.next("run");
  const rootNodeId = ids.next("node");
  const scope = { projectId: program.projectId, programId: program.programId, runId };
  const at = nowIso(clock);

  const run: Run = {
    schemaVersion: 1,
    ...scope,
    // `pending`, not `running`: authorizing the work is a human act at a
    // terminal, and it is the orchestrator attaching that starts it (A-32).
    status: "pending",
    location: input.location ?? "local",
    rootNodeId,
    startedAt: at,
    policy,
    ...(carriedStrands.length === 0 ? {} : { carriedStrands: [...carriedStrands] }),
  };
  await stores.runs.put(run);

  const rootNode: ExecutionNode = {
    schemaVersion: 1,
    ...scope,
    executionNodeId: rootNodeId,
    kind: "program",
    parentNodeId: null,
    depth: 0,
    // The root's authority is the contract's scope; every child may only narrow it.
    scope: program.scope,
    status: "validated",
    jobContractId: null,
    commitSha: null,
    // The plan this run executes, so the run is reconstructable from the control
    // plane alone whatever the contract says later (D-P7-02, A-06).
    ...(program.planHash === undefined || program.planDocument === undefined
      ? {}
      : { plan: { planHash: program.planHash, planDocument: program.planDocument } }),
    createdAt: at,
    updatedAt: at,
  };
  await stores.executionNodes.put(rootNode);

  const checkpointId = ids.next("ckpt");
  const ref = checkpointRef(checkpointId);
  await updateRef(environment.git, input.repoPath, ref, baseCommit);
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    ...scope,
    checkpointId,
    executionNodeId: rootNodeId,
    commitSha: baseCommit,
    ref,
    label: "run start",
    createdAt: at,
  };
  await stores.checkpoints.put(checkpoint);

  // The human's decisions, before any work exists to be built on the alternative
  // (D-P7-06, SC-P7-09). Deterministic ids are not available, so a retried
  // `nightshift run` is a new run with its own; these belong to this run.
  for (const planned of program.decisions ?? []) {
    if (planned.answer === undefined) continue;
    const others = planned.options.filter((option) => option !== planned.answer);
    const decision: Decision = {
      schemaVersion: 1,
      ...scope,
      decisionId: ids.next("dec"),
      executionNodeId: rootNodeId,
      agentId: null,
      context: `${planned.id}: ${planned.question}`,
      alternatives:
        others.length > 0
          ? others.map((summary) => ({ summary }))
          : [
              {
                summary: "Leave it to the run",
                rejectedBecause: "a human chose to decide it up front",
              },
            ],
      choice: planned.answer,
      rationale: planned.rationale ?? "Decided by a human at planning, before the run.",
      // Nothing has been built on it yet, which is the point of deciding it first.
      reversibility: "reversible",
      checkpointBefore: checkpointId,
      affectedNodes: [],
      authority: "human",
      supersedesDecisionId: null,
      createdAt: at,
    };
    await stores.decisions.put(decision);
  }

  // Written directly rather than through an outbox: the outbox is created per
  // run by the server that attaches, and this runs before there is one. The keys
  // are deterministic all the same, so a retried `nightshift run` converges.
  let n = 0;
  const emit = async (type: "run.created" | "checkpoint.created", payload: object) => {
    n += 1;
    await stores.events.append(
      EventSchema.parse({
        schemaVersion: 1,
        ...scope,
        eventId: ids.next("evt"),
        idempotencyKey: `control-plane:${runId}:start:${n}`,
        sequence: null,
        type,
        source: "control-plane",
        executionNodeId: rootNodeId,
        agentId: null,
        payload,
        occurredAt: at,
        recordedAt: at,
      }),
    );
  };
  await emit("run.created", {
    programBranch: program.repository.programBranch,
    baseCommit,
    location: input.location ?? "local",
  });
  await emit("checkpoint.created", { checkpointId, ref, commitSha: baseCommit });

  return { program, run, rootNode, checkpoint, baseCommit };
};

/**
 * Ends a run that never got to work: its program node and the run to
 * `running`, then both to `failed` with `reason`, one table step at a time.
 * For a run whose machine found, before any agent started, that it cannot
 * succeed (the gate audit, on a remote machine).
 */
export const failBeforeStart = async (
  deps: Pick<StartRunEnvironment, "stores" | "clock">,
  scope: RunScope,
  reason: string,
): Promise<void> => {
  const { stores, clock } = deps;
  const run = await stores.runs.get(scope, scope.runId);
  if (run === undefined || run.status !== "pending") return;
  let node = await stores.executionNodes.get(scope, run.rootNodeId);
  for (const next of ["queued", "running"] as const) {
    if (
      node !== undefined &&
      ((next === "queued" && node.status === "validated") ||
        (next === "running" && node.status === "queued"))
    ) {
      node = { ...node, status: next, updatedAt: nowIso(clock) };
      await stores.executionNodes.put(node);
    }
  }
  const at = nowIso(clock);
  const running: Run = { ...run, status: "running" };
  await stores.runs.put(running);
  await stores.runs.put(transitionRun(running, "fail", { endedAt: at, outcomeReason: reason }));
  if (node !== undefined) {
    const ended = finishRun(node, "failed", at, reason);
    if (ended !== node) await stores.executionNodes.put(ended);
  }
};
