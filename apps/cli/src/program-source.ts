/**
 * A program's documents from the control plane (P21 S-02).
 *
 * `findProgram` is `readProgramFiles` with the plane as the home: it finds the
 * program's draft by its name among the project's drafts and reads the documents
 * of the version asked for by sha256. A program planned before P21, with only
 * `docs/programs/{name}/` committed, is put on the plane once (the import) and
 * found there from then on. `readProgramFiles` stays as the importer's reader.
 */
import {
  mergeProgramFiles,
  type PlanDraft,
  type PlanDraftVersion,
  type ProgramContract,
  ProgramContractSchema,
  ProjectIdSchema,
} from "@nightshift/contracts";
import type { ProgramScope } from "@nightshift/core";
import { createHttpPlanning, type PlanningClient } from "@nightshift/persistence/http";
import type { CliEnvironment } from "./environment.js";
import { UsageError } from "./failures.js";
import {
  isProgramDirectoryName,
  readConfig,
  readProgramFiles,
  resolveFrom,
} from "./program-files.js";
import type { Session } from "./session.js";

export interface FindProgramOptions {
  /** Where `nightshift.config.json` and, for the import, `docs/programs/` are. */
  readonly repoPath: string;
  /** The program's name: its directory name. */
  readonly name: string;
  readonly project?: string | undefined;
  /** The newest version, or the one a person ratified. */
  readonly use: "latest" | "ratified";
}

export interface ProgramSource {
  /** The program's name. */
  readonly id: string;
  /** Where the program's documents are published at finish, repository-relative. */
  readonly directory: string;
  readonly contract: ProgramContract;
  readonly planText: string;
  readonly conversationText?: string;
  readonly scope: ProgramScope;
  readonly draft: PlanDraft;
  /** The draft version the documents were read from (the latest, for `ratified` too). */
  readonly version: PlanDraftVersion;
}

const planningOf = (session: Session): PlanningClient =>
  createHttpPlanning({ transport: session.transport });

const projectOf = async (
  environment: CliEnvironment,
  options: FindProgramOptions,
): Promise<ProgramScope["projectId"]> => {
  if (options.project !== undefined) {
    const parsed = ProjectIdSchema.safeParse(options.project);
    if (!parsed.success) throw new UsageError(`\`${options.project}\` is not a project id`);
    return parsed.data;
  }
  const config = await readConfig(resolveFrom(environment.cwd, options.repoPath));
  if (config === undefined) {
    throw new UsageError(
      `cannot tell which project \`${options.name}\` belongs to`,
      "Pass --project <id>, or run from a repository with nightshift.config.json.",
    );
  }
  return config.projectId;
};

/** The project's draft with this name, if it has one. */
const draftNamed = async (
  session: Session,
  projectId: ProgramScope["projectId"],
  name: string,
): Promise<PlanDraft | undefined> => {
  let cursor: string | undefined;
  do {
    const page = await session.stores.planDrafts.listByProject(projectId, {
      ...(cursor === undefined ? {} : { cursor }),
    });
    const found = page.items.find((draft) => draft.name === name);
    if (found !== undefined) return found;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return undefined;
};

/**
 * Puts a program planned before P21 on the plane from its committed files: the
 * next version of the draft the plane already holds for its program id, with the
 * name attached, or version 1 (the import) when it holds none.
 */
const importCommitted = async (
  environment: CliEnvironment,
  session: Session,
  options: FindProgramOptions,
  projectId: ProgramScope["projectId"],
): Promise<void> => {
  const repoPath = resolveFrom(environment.cwd, options.repoPath);
  const committed = await readProgramFiles(repoPath, options.name).catch((error: unknown) => {
    if (error instanceof UsageError && /does not exist/.test(error.message)) {
      throw new UsageError(
        `the plane has no program named \`${options.name}\` and ${repoPath} does not hold one: put its plan with \`nightshift plan put ${options.name} --dir <scratch>\``,
      );
    }
    throw error;
  });
  const planning = planningOf(session);
  const scope: ProgramScope = { projectId, programId: committed.contract.programId };
  if (committed.contract.projectId !== projectId) {
    throw new UsageError(
      `docs/programs/${options.name}/contract.json is for project ${committed.contract.projectId}, not ${projectId}`,
    );
  }
  const existing = await planning.getDraft(scope);
  if (existing === undefined) {
    environment.err(
      `importing docs/programs/${options.name}/ into the plane as version 1 of \`${options.name}\``,
    );
  }
  await planning.putVersion(
    scope,
    {
      contract: `${JSON.stringify(committed.contract, null, 2)}\n`,
      planText: committed.planText,
      ...(committed.conversationText === undefined
        ? {}
        : { conversationText: committed.conversationText }),
    },
    existing === undefined ? null : existing.latestVersion,
    options.name,
  );
};

const readDocument = async (
  planning: PlanningClient,
  scope: ProgramScope,
  what: string,
  sha256: string,
): Promise<string> => {
  const document = await planning.planDocument(scope, sha256);
  if (document === undefined) {
    throw new UsageError(`the plane holds no ${what} ${sha256} for \`${scope.programId}\``);
  }
  return document.text;
};

/** Finds a program by name on the plane; see the module comment. */
export const findProgram = async (
  environment: CliEnvironment,
  session: Session,
  options: FindProgramOptions,
): Promise<ProgramSource> => {
  if (!isProgramDirectoryName(options.name)) {
    throw new UsageError(
      `\`${options.name}\` is not a program name`,
      "A program name is the name of its directory, for example `p1-billing`.",
    );
  }
  const projectId = await projectOf(environment, options);
  let draft = await draftNamed(session, projectId, options.name);
  if (draft === undefined) {
    await importCommitted(environment, session, options, projectId);
    draft = await draftNamed(session, projectId, options.name);
    if (draft === undefined) {
      throw new UsageError(`the plane has no program named \`${options.name}\``);
    }
  }
  const scope: ProgramScope = { projectId, programId: draft.programId };
  const planning = planningOf(session);
  const latest = await planning.getVersion(scope);
  if (latest === undefined) {
    throw new UsageError(`the plane has no version of \`${options.name}\``);
  }
  const version = latest.version;
  const directory = `docs/programs/${options.name}`;

  if (options.use === "ratified") {
    const contract = await session.stores.programContracts.get(projectId, draft.programId);
    if (contract?.planDocument === undefined) {
      throw new UsageError(
        `\`${options.name}\` has not been ratified`,
        `Ratify it with \`nightshift plan ratify ${options.name}\`.`,
      );
    }
    const planText = await readDocument(planning, scope, "plan", contract.planDocument.sha256);
    const conversationText =
      contract.conversation === undefined
        ? undefined
        : await readDocument(planning, scope, "conversation", contract.conversation.sha256);
    return {
      id: options.name,
      directory,
      contract,
      planText,
      ...(conversationText === undefined ? {} : { conversationText }),
      scope,
      draft,
      version,
    };
  }

  const config = await readConfig(resolveFrom(environment.cwd, options.repoPath));
  const authored = JSON.parse(
    await readDocument(planning, scope, "contract", version.contract.sha256),
  );
  const contract = ProgramContractSchema.parse(mergeProgramFiles(authored, config));
  const planText = await readDocument(planning, scope, "plan", version.plan.sha256);
  const conversationText =
    version.conversation === undefined
      ? undefined
      : await readDocument(planning, scope, "conversation", version.conversation.sha256);
  return {
    id: options.name,
    directory,
    contract,
    planText,
    ...(conversationText === undefined ? {} : { conversationText }),
    scope,
    draft,
    version,
  };
};
