/**
 * `nightshift run <contract> [--repo <path>] [--remote]` (D-P3-17, A-32).
 *
 * This command holds **no domain logic at all** (A-16). It reads a file, resolves
 * two paths, and calls `startRun` from `@nightshift/execution` — the same
 * function the MCP server's `run.start` calls. That sharing is the point: "the
 * same canonical model" is a claim about one code path, not about two that were
 * written to match, and a `nightshift run` that reimplemented the writes would
 * make it false on the first divergence.
 *
 * **Nothing is spawned.** The run is created `pending`, and what starts it is a
 * human opening their orchestrator in the repository so the Nightshift MCP
 * server attaches. Authorizing work is a human act at a terminal, so the last
 * line this prints is an instruction to a person, not a process.
 */
import { readFile, stat } from "node:fs/promises";
import { isPlanned } from "@nightshift/core";
import { startRun } from "@nightshift/execution";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import {
  isProgramDirectoryName,
  type ProgramFiles,
  readProgramFiles,
  resolveFrom,
} from "../program-files.js";
import { openSession } from "../session.js";
import { REMOTE_NEEDS_PLAN } from "./remote.js";
import { runProgram } from "./run-program.js";

/** What `--remote` says for anything but a ratified planned program (P10, D-P10-09). */
export const REMOTE_REFUSAL = REMOTE_NEEDS_PLAN;

export interface RunOptions {
  /** A program id under `docs/programs/`, or the path to an authored Program Contract. */
  readonly contract: string;
  /** The operator's clone. Defaults to the working directory. */
  readonly repo?: string;
  readonly remote: boolean;
  /** A planned program only: create the run and let a human's own session orchestrate it. */
  readonly attended?: boolean;
  /** A planned program only: the human's choice of orchestrator (A-38). */
  readonly harness?: string;
  readonly model?: string;
  /** A correction only (P9, D-P9-05): decisions outside the repository the owner confirms. */
  readonly confirmIrreversible?: readonly string[];
  /**
   * Start even when the gate audit finds a gate that fails every time: for a
   * program whose work is to make that gate pass.
   */
  readonly allowRedGates?: boolean;
  /** With `--remote` (P10, D-P10-14): the tier, else the contract's, the config's, the recommendation, `good`. */
  readonly compute?: string;
}

export interface RunResult {
  /** 0 unless a planned program was run to its end and did not succeed, or was refused by preflight. */
  readonly exitCode: number;
  readonly runId: string;
  readonly programId: string;
  readonly projectId: string;
  readonly rootNodeId: string;
  readonly baseCommit: string;
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** What `startRun` is given: a contract, and for a planned program its plan document. */
interface RunSource {
  readonly program: unknown;
  readonly planText?: string;
  /** Set when the source is a program directory, which is what a planned program is run from. */
  readonly files?: ProgramFiles;
}

/**
 * `nightshift run <contract path>` keeps working; `nightshift run {id}` names a
 * program's directory under `docs/programs/` (D-P7-03). A path that exists wins,
 * so a contract file that happens to be named like an id is still a file.
 */
const readSource = async (
  environment: CliEnvironment,
  options: RunOptions,
  repoPath: string,
): Promise<RunSource> => {
  const contractPath = resolveFrom(environment.cwd, options.contract);
  if (isProgramDirectoryName(options.contract) && !(await isFile(contractPath))) {
    const files = await readProgramFiles(repoPath, options.contract);
    return { program: files.contract, planText: files.planText, files };
  }
  return { program: await readContractFile(contractPath) };
};

const readContractFile = async (contractPath: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(contractPath, "utf8");
  } catch (cause) {
    throw new UsageError(
      `could not read the Program Contract at ${contractPath}`,
      `Pass a program id, for example \`nightshift run p1-billing\`, or the path to an authored contract. (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new UsageError(
      `${contractPath} is not valid JSON`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
};

export const run = async (environment: CliEnvironment, options: RunOptions): Promise<RunResult> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  // Remote execution is for a ratified planned program and nothing else
  // (D-P10-09): a contract path is refused before it is even read.
  if (options.remote && !isProgramDirectoryName(options.contract)) {
    throw new UsageError(
      `${REMOTE_REFUSAL}; \`${options.contract}\` is not a program directory name`,
      "Drop `--remote` to start a local run from a contract.",
    );
  }
  const source = await readSource(environment, options, repoPath);
  if (options.remote && source.files === undefined) {
    throw new UsageError(
      `${REMOTE_REFUSAL}; no docs/programs/${options.contract}/ under ${repoPath}`,
      "Run from the repository root, or pass --repo <path>.",
    );
  }
  if (options.remote && source.files !== undefined && !isPlanned(source.files.contract)) {
    throw new UsageError(
      `${REMOTE_REFUSAL}; ${options.contract} has no strands, so it is not a planned program`,
      "Plan it (`nightshift plan check`) and ratify it, or drop `--remote` to run the contract locally.",
    );
  }

  const session = await openSession(environment);

  if (source.files !== undefined && isPlanned(source.files.contract)) {
    const planned = await runProgram(environment, session, source.files, {
      repoPath,
      attended: options.attended === true,
      allowRedGates: options.allowRedGates === true,
      remote: options.remote,
      ...(options.compute === undefined ? {} : { compute: options.compute }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.confirmIrreversible === undefined
        ? {}
        : { confirmIrreversible: options.confirmIrreversible }),
    });
    return {
      exitCode: planned.exitCode,
      runId: planned.started?.run.runId ?? "",
      programId: source.files.contract.programId,
      projectId: source.files.contract.projectId,
      rootNodeId: planned.started?.rootNode.executionNodeId ?? "",
      baseCommit: planned.started?.baseCommit ?? "",
    };
  }

  // Validation, the program write, the run, its root node, the initial
  // checkpoint and the two events — all of it, in there.
  const started = await startRun(
    {
      stores: session.stores,
      clock: environment.clock,
      ids: environment.ids,
      git: environment.git,
    },
    {
      program: source.program,
      repoPath,
      ...(source.planText === undefined ? {} : { planText: source.planText }),
    },
  );

  environment.out(started.run.runId);
  environment.out(
    `run ${started.run.runId} is pending for program ${started.program.programId} ` +
      `at ${started.baseCommit.slice(0, 8)} on ${started.program.repository.programBranch}`,
  );
  environment.out(
    `Open your orchestrator in ${repoPath} so the Nightshift MCP server can attach to this run.`,
  );

  return {
    exitCode: 0,
    runId: started.run.runId,
    programId: started.program.programId,
    projectId: started.program.projectId,
    rootNodeId: started.rootNode.executionNodeId,
    baseCommit: started.baseCommit,
  };
};
