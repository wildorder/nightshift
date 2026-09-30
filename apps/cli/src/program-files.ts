/**
 * A program's documents on disk (P7, D-P7-03): `docs/programs/{id}/plan.md` and
 * `contract.json`, in the same place for every program of a product's life.
 *
 * The contract a command works with is the **merged** one: what the authored
 * `contract.json` states, over the project's defaults in `nightshift.config.json`.
 * That is what is checked, hashed, ratified and run, so the control plane never
 * depends on a file it cannot see.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  inheritFromConfig,
  NIGHTSHIFT_CONFIG_FILE,
  type NightshiftConfig,
  NightshiftConfigSchema,
  PROGRAMS_DIRECTORY,
  type ProgramContract,
  ProgramContractSchema,
} from "@nightshift/contracts";
import { CONVERSATION_FILE, keepsConversation } from "@nightshift/core";
import { UsageError } from "./failures.js";

export const CONTRACT_FILE = "contract.json";
export const PLAN_FILE = "plan.md";
/** P14 (D-P14-06): the kept planning conversation, beside the plan. */
export { CONVERSATION_FILE } from "@nightshift/core";

/** A program id on disk is a directory name: no separators, nothing that climbs. */
const PROGRAM_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const isProgramDirectoryName = (value: string): boolean =>
  PROGRAM_DIRECTORY_NAME.test(value) && !value.endsWith(".json");

export const resolveFrom = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path);

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

const parseJson = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new UsageError(
      `${path} is not valid JSON`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
};

/** The project's defaults, or `undefined` when the repository has no config yet. */
export const readConfig = async (repoPath: string): Promise<NightshiftConfig | undefined> => {
  const path = join(repoPath, NIGHTSHIFT_CONFIG_FILE);
  const text = await readText(path);
  return text === undefined ? undefined : NightshiftConfigSchema.parse(parseJson(path, text));
};

export interface ProgramFiles {
  /** The directory name under `docs/programs/`. */
  readonly id: string;
  /** Repository-relative, with forward slashes: what git is asked about. */
  readonly directory: string;
  readonly contractPath: string;
  readonly planPath: string;
  /** The authored contract over the project's defaults, validated. */
  readonly contract: ProgramContract;
  readonly planText: string;
  /** `conversation.md`, when the program keeps one and it has been written (P14). */
  readonly conversationText?: string;
}

/** Reads and validates `docs/programs/{id}/`. A `ZodError` from here is the contract's. */
export const readProgramFiles = async (repoPath: string, id: string): Promise<ProgramFiles> => {
  if (!isProgramDirectoryName(id)) {
    throw new UsageError(
      `\`${id}\` is not a program id`,
      `A program id is the name of its directory under ${PROGRAMS_DIRECTORY}/, for example \`p1-billing\`.`,
    );
  }
  const directory = `${PROGRAMS_DIRECTORY}/${id}`;
  const contractPath = join(repoPath, PROGRAMS_DIRECTORY, id, CONTRACT_FILE);
  const planPath = join(repoPath, PROGRAMS_DIRECTORY, id, PLAN_FILE);

  const contractText = await readText(contractPath);
  if (contractText === undefined) {
    throw new UsageError(
      `there is no program \`${id}\` here: ${contractPath} does not exist`,
      `Plan one with the plan-program skill, which writes ${directory}/${PLAN_FILE} and ${CONTRACT_FILE}.`,
    );
  }
  const planText = await readText(planPath);
  if (planText === undefined) {
    throw new UsageError(
      `program \`${id}\` has a contract and no plan: ${planPath} does not exist`,
      "A program is planned in a document a developer reads; the contract alone is not a plan.",
    );
  }

  const config = await readConfig(repoPath);
  const authored = parseJson(contractPath, contractText);
  const contract = ProgramContractSchema.parse(
    config === undefined ? authored : inheritFromConfig(authored, config),
  );
  const conversationText = keepsConversation(contract)
    ? await readText(join(repoPath, PROGRAMS_DIRECTORY, id, CONVERSATION_FILE))
    : undefined;
  return {
    id,
    directory,
    contractPath,
    planPath,
    contract,
    planText,
    ...(conversationText === undefined ? {} : { conversationText }),
  };
};
