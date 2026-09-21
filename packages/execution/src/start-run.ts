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
import type {
  Checkpoint,
  ExecutionNode,
  ProgramContract,
  Project,
  Run,
} from "@nightshift/contracts";
import { EventSchema, ProgramContractSchema } from "@nightshift/contracts";
import type { Clock, IdGenerator, ProjectStores } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
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

export const startRun = async (
  environment: StartRunEnvironment,
  input: StartRunInput,
): Promise<StartedRun> => {
  const { stores, clock, ids } = environment;
  const program = ProgramContractSchema.parse(input.program);

  const project: Project | undefined = await stores.projects.get(program.projectId);
  if (project === undefined) throw new ProjectMissingError(program.projectId);

  // Create-or-confirm. An identical contract is stored again harmlessly; a
  // different one under the same id is a conflict the caller must resolve.
  try {
    await stores.programContracts.put(program);
  } catch (error) {
    if ((error as { status?: unknown }).status === 409) {
      throw new ProgramContractChangedError(program.programId);
    }
    throw error;
  }

  const baseCommit = await revParse(
    environment.git,
    input.repoPath,
    program.repository.programBranch,
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
    location: "local",
    rootNodeId,
    startedAt: at,
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
    location: "local",
  });
  await emit("checkpoint.created", { checkpointId, ref, commitSha: baseCommit });

  return { program, run, rootNode, checkpoint, baseCommit };
};
