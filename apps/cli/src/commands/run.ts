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
import { startRun } from "@nightshift/execution";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { isProgramDirectoryName, readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

/** What `--remote` says until P10 turns it on. */
export const REMOTE_REFUSAL = "remote execution arrives in P10";

export interface RunOptions {
  /** Path to the authored Program Contract, relative to the working directory. */
  readonly contract: string;
  /** The operator's clone. Defaults to the working directory. */
  readonly repo?: string;
  readonly remote: boolean;
}

export interface RunResult {
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
    return { program: files.contract, planText: files.planText };
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
  if (options.remote) {
    // Refused, not ignored, and refused before anything is written: the flag's
    // shape exists from day one so a script written today keeps working when P10
    // makes it do something.
    throw new UsageError(
      REMOTE_REFUSAL,
      "Drop `--remote` to start a local run; the run is created either way and an orchestrator " +
        "attaches to it in the repository.",
    );
  }

  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const source = await readSource(environment, options, repoPath);

  const session = await openSession(environment);

  // Validation, the program write, the run, its root node, the initial
  // checkpoint and the two events — all of it, in there.
  const started = await startRun(
    {
      stores: session.stores,
      clock: environment.clock,
      ids: environment.ids,
      git: environment.git,
    },
    { ...source, repoPath },
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
    runId: started.run.runId,
    programId: started.program.programId,
    projectId: started.program.projectId,
    rootNodeId: started.rootNode.executionNodeId,
    baseCommit: started.baseCommit,
  };
};
