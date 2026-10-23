/**
 * `nightshift plan put|show|check|ratify` (P7, T3; P21 S-01; D-P7-02, D-P7-07).
 *
 * A plan's home is the control plane: a draft of content-hashed versions. `put`
 * writes the next version from a scratch directory outside any repository,
 * `show` reads one back (into a scratch with `--dir`), `check` prints the plane's
 * check of the latest version (the exit code is the answer; `--dir` checks a
 * scratch offline), and `ratify` ratifies the latest version by its hash. None of
 * them needs a repository. `ratifyPlan` stays for `nightshift run`, which ratifies
 * the plan files it is given.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mergeProgramFiles,
  type NightshiftConfig,
  PROGRAMS_DIRECTORY,
  type ProgramContract,
  ProgramContractSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  ProjectSchema,
} from "@nightshift/contracts";
import {
  CONFIRMED_CLASSES,
  checkPlan,
  explainCorrection,
  keepsConversation,
  PlanDraftError,
  type PlanReason,
  type ProgramScope,
  parseConversation,
  planHash,
  splitPlanSections,
} from "@nightshift/core";
import {
  createHttpPlanning,
  type PlanningClient,
  routes,
  sha256Hex,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import {
  CONTRACT_FILE,
  CONVERSATION_FILE,
  isProgramDirectoryName,
  PLAN_FILE,
  readConfig,
  resolveFrom,
} from "../program-files.js";
import { openSession, type Session } from "../session.js";

/** The scratch's marker: the version its files were last put as or shown from. */
export const VERSION_MARKER_FILE = ".nightshift-plan-version";

export interface PlanOptions {
  readonly id: string;
  /** Only a hint now: where `nightshift.config.json` is, for the project and the defaults. */
  readonly repo?: string;
  readonly project?: string;
  /** A scratch directory. */
  readonly dir?: string;
  readonly version?: number;
  readonly basedOn?: number;
}

export interface PlanCheckResult {
  readonly ready: boolean;
  readonly reasons: readonly PlanReason[];
  readonly planHash: string;
}

/** The documents a check or a ratification works on. */
export interface PlanDocuments {
  readonly directory: string;
  readonly contract: ProgramContract;
  readonly planText: string;
  readonly conversationText?: string;
}

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

const requireProgramId = (id: string): void => {
  if (!isProgramDirectoryName(id)) {
    throw new UsageError(
      `\`${id}\` is not a program id`,
      "A program id is the name of the program, for example `p1-billing`.",
    );
  }
};

/**
 * The program's id on the plane. `<id>` is that id (`prog_…`) or the program's
 * name: a name is read from the scratch's contract, else from the contract in
 * `docs/programs/<name>/` of the repository at hand, if there is one.
 */
const programIdOf = async (
  environment: CliEnvironment,
  options: Pick<PlanOptions, "id" | "repo" | "dir">,
): Promise<ProgramScope["programId"]> => {
  requireProgramId(options.id);
  const direct = ProgramIdSchema.safeParse(options.id);
  if (direct.success) return direct.data;
  const candidates = [
    ...(options.dir === undefined
      ? []
      : [join(resolveFrom(environment.cwd, options.dir), CONTRACT_FILE)]),
    join(
      resolveFrom(environment.cwd, options.repo ?? environment.cwd),
      PROGRAMS_DIRECTORY,
      options.id,
      CONTRACT_FILE,
    ),
  ];
  for (const path of candidates) {
    const text = await readText(path);
    if (text === undefined) continue;
    try {
      const stated = ProgramIdSchema.safeParse(
        (JSON.parse(text) as { programId?: unknown }).programId,
      );
      if (stated.success) return stated.data;
    } catch {
      // A contract that does not parse names no program.
    }
  }
  throw new UsageError(
    `\`${options.id}\` is not a program id the plane knows`,
    "Name the program by its id (prog_…), or run from a repository that holds docs/programs/<name>/contract.json.",
  );
};

/** The config beside `repo` (or the working directory), when there is one. */
export const configAt = async (
  environment: CliEnvironment,
  repo: string | undefined,
): Promise<NightshiftConfig | undefined> =>
  readConfig(resolveFrom(environment.cwd, repo ?? environment.cwd));

/**
 * The project a program's draft lives in: `--project`, else the scratch
 * contract's own, else the config at hand, else the one project of the
 * organisation that has a draft of this program.
 */
export const resolveScope = async (
  environment: CliEnvironment,
  session: Session,
  options: Pick<PlanOptions, "id" | "repo" | "project" | "dir">,
): Promise<ProgramScope> => {
  const programId = await programIdOf(environment, options);
  if (options.project !== undefined) {
    const parsed = ProjectIdSchema.safeParse(options.project);
    if (!parsed.success) throw new UsageError(`\`${options.project}\` is not a project id`);
    return { projectId: parsed.data, programId };
  }
  if (options.dir !== undefined) {
    const text = await readText(join(resolveFrom(environment.cwd, options.dir), CONTRACT_FILE));
    if (text !== undefined) {
      try {
        const stated = ProjectIdSchema.safeParse(
          (JSON.parse(text) as { projectId?: unknown }).projectId,
        );
        if (stated.success) return { projectId: stated.data, programId };
      } catch {
        // A contract that does not parse says nothing about its project.
      }
    }
  }
  const config = await configAt(environment, options.repo);
  if (config !== undefined) return { projectId: config.projectId, programId };

  const planning = createHttpPlanning({ transport: session.transport });
  const found: ProgramScope[] = [];
  let cursor: string | undefined;
  do {
    const response = await session.transport({
      method: "GET",
      path: routes.projects(),
      ...(cursor === undefined ? {} : { query: { cursor } }),
    });
    if (response.status !== 200) {
      throw new UsageError(`listing the projects answered ${response.status}`);
    }
    const body = response.body as { items?: unknown[]; cursor?: string };
    for (const item of body.items ?? []) {
      const project = ProjectSchema.parse(item);
      const scope = { projectId: project.projectId, programId };
      if ((await planning.getDraft(scope)) !== undefined) found.push(scope);
    }
    cursor = body.cursor;
  } while (cursor !== undefined);
  if (found.length === 1 && found[0] !== undefined) return found[0];
  throw new UsageError(
    found.length === 0
      ? `no project has a draft of \`${options.id}\``
      : `${found.length} projects have a draft of \`${options.id}\`: ${found.map((scope) => scope.projectId).join(", ")}`,
    "Name the project with --project <id>, or run from a repository with nightshift.config.json.",
  );
};

/** Readiness of documents in hand; ordinary plans can be checked entirely offline. */
const readinessOf = (files: PlanDocuments): PlanCheckResult => {
  const readiness = checkPlan(
    files.contract,
    splitPlanSections(files.planText),
    files.conversationText === undefined
      ? undefined
      : parseConversation(files.contract.programId, files.conversationText),
  );
  const reasons = readiness.ready ? [] : readiness.reasons;
  return {
    ready: reasons.length === 0,
    reasons,
    planHash: planHash(files.contract, files.planText, sha256Hex).hash,
  };
};

const printReasons = (
  environment: CliEnvironment,
  result: { readonly reasons: readonly { readonly message: string }[] },
): void => {
  environment.err(
    `NOT READY: ${result.reasons.length} ${result.reasons.length === 1 ? "reason" : "reasons"}`,
  );
  for (const reason of result.reasons) {
    const [first, ...rest] = reason.message.split("\n");
    environment.err(`  - ${first}`);
    for (const line of rest) environment.err(`    ${line}`);
  }
};

/**
 * What a correction names, checked against the control plane (P9, D-P9-04,
 * D-P9-05): problems that make it not ready, and the reversals of decisions
 * whose effects reach outside the repository, which are flagged, not refused.
 * Only a correction reaches the control plane; any other plan checks offline.
 */
const correctionOf = async (
  environment: CliEnvironment,
  files: PlanDocuments,
): Promise<{ readonly problems: readonly string[]; readonly flags: readonly string[] }> => {
  const targets = files.contract.corrects ?? [];
  if (targets.length === 0) return { problems: [], flags: [] };
  const session = await openSession(environment);
  const problems: string[] = [];
  const flags: string[] = [];
  for (const target of targets) {
    const scope = {
      projectId: files.contract.projectId,
      programId: target.programId,
      runId: target.runId,
    };
    const decision = await session.stores.decisions.get(scope, target.decisionId);
    const reversal = await session.stores.decisions.get(scope, target.reversedBy);
    problems.push(...explainCorrection({ target, decision, reversal }));
    if (decision !== undefined && CONFIRMED_CLASSES.includes(decision.reversibility)) {
      flags.push(
        `${decision.decisionId} is ${decision.reversibility}: its effects reach outside the ` +
          `repository. \`nightshift run\` asks you to confirm it before this correction runs.`,
      );
    }
  }
  return { problems, flags };
};

interface Scratch {
  readonly directory: string;
  readonly contractText: string;
  readonly planText: string;
  readonly conversationText?: string;
  /** The contract the scratch states, over the config's defaults when it states no project. */
  readonly contract: ProgramContract;
  /** What is uploaded: the scratch's text, byte for byte, unless defaults had to be merged in. */
  readonly uploadText: string;
}

/** Reads and validates a scratch directory's three files. */
const readScratch = async (
  environment: CliEnvironment,
  options: PlanOptions,
  dir: string,
): Promise<Scratch> => {
  const directory = resolveFrom(environment.cwd, dir);
  const contractText = await readText(join(directory, CONTRACT_FILE));
  if (contractText === undefined) {
    throw new UsageError(
      `${join(directory, CONTRACT_FILE)} does not exist`,
      "A scratch holds contract.json, plan.md and optionally conversation.md.",
    );
  }
  const planText = await readText(join(directory, PLAN_FILE));
  if (planText === undefined) {
    throw new UsageError(
      `${join(directory, PLAN_FILE)} does not exist`,
      "A program is planned in a document a developer reads; the contract alone is not a plan.",
    );
  }
  let authored: unknown;
  try {
    authored = JSON.parse(contractText);
  } catch (cause) {
    throw new UsageError(
      `${join(directory, CONTRACT_FILE)} is not valid JSON`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const states = (authored as { projectId?: unknown } | null)?.projectId !== undefined;
  const config = states ? undefined : await configAt(environment, options.repo);
  const merged = mergeProgramFiles(authored, config);
  const contract = ProgramContractSchema.parse(merged);
  const conversationText = keepsConversation(contract)
    ? await readText(join(directory, CONVERSATION_FILE))
    : undefined;
  return {
    directory,
    contractText,
    planText,
    contract,
    uploadText: config === undefined ? contractText : `${JSON.stringify(merged, null, 2)}\n`,
    ...(conversationText === undefined ? {} : { conversationText }),
  };
};

const writeMarker = (directory: string, version: number): Promise<void> =>
  writeFile(join(directory, VERSION_MARKER_FILE), `${version}\n`);

const readMarker = async (directory: string): Promise<number | undefined> => {
  const text = await readText(join(directory, VERSION_MARKER_FILE));
  const value = text === undefined ? Number.NaN : Number(text.trim());
  return Number.isInteger(value) && value >= 1 ? value : undefined;
};

const planningOf = (session: Session): PlanningClient =>
  createHttpPlanning({ transport: session.transport });

const principalOf = (author: { readonly kind: string; readonly id?: string }): string =>
  author.id === undefined ? author.kind : `${author.kind} ${author.id}`;

const actOf = (act: { readonly kind: string; readonly decisionId?: string }): string =>
  act.kind === "answer" ? `answer ${act.decisionId}` : act.kind;

export const planPut = async (
  environment: CliEnvironment,
  options: PlanOptions,
): Promise<number> => {
  requireProgramId(options.id);
  if (options.dir === undefined) throw new UsageError("`plan put` needs --dir <scratch>");
  const scratch = await readScratch(environment, options, options.dir);
  if (ProgramIdSchema.safeParse(options.id).success && scratch.contract.programId !== options.id) {
    throw new UsageError(
      `the scratch's contract is for program \`${scratch.contract.programId}\`, not \`${options.id}\``,
    );
  }
  const session = await openSession(environment);
  const planning = planningOf(session);
  const scope = { projectId: scratch.contract.projectId, programId: scratch.contract.programId };
  const draft = await planning.getDraft(scope);
  const marker = await readMarker(scratch.directory);
  const basedOn = options.basedOn ?? marker ?? null;
  if (basedOn === null && draft !== undefined) {
    throw new UsageError(
      `the plane already holds version ${draft.latestVersion} of \`${options.id}\`, and this scratch records no version it was based on`,
      `Run \`nightshift plan show ${options.id} --dir <scratch>\` first, or pass --based-on ${draft.latestVersion} to write over it.`,
    );
  }
  const stale = (latest: number): number => {
    environment.err(
      `stale: this put is based on ${basedOn === null ? "no version" : `version ${basedOn}`}, but the latest version is ${latest}. Nothing was written.`,
    );
    environment.err(
      `Run \`nightshift plan show ${options.id} --dir <scratch>\` to read version ${latest}.`,
    );
    return 1;
  };
  if (draft !== undefined && basedOn !== draft.latestVersion) return stale(draft.latestVersion);

  let written: Awaited<ReturnType<PlanningClient["putVersion"]>>;
  try {
    written = await planning.putVersion(
      scope,
      {
        contract: scratch.uploadText,
        planText: scratch.planText,
        ...(scratch.conversationText === undefined
          ? {}
          : { conversationText: scratch.conversationText }),
      },
      basedOn,
      // A program named by its directory name keeps that name on the plane.
      ProgramIdSchema.safeParse(options.id).success ? undefined : options.id,
    );
  } catch (error) {
    if (error instanceof PlanDraftError && /stale_base/.test(error.message)) {
      const latest = await planning.getDraft(scope);
      if (latest !== undefined) return stale(latest.latestVersion);
    }
    throw error;
  }
  await writeMarker(scratch.directory, written.version.version);
  environment.out(
    `put version ${written.version.version} of ${options.id} (plan ${written.version.planHash?.slice(0, 12) ?? "unhashed"}) by ${principalOf(written.version.author)}`,
  );
  environment.out(
    written.check.ready
      ? "check READY"
      : `check NOT READY: ${written.check.reasons.length} reasons`,
  );
  return 0;
};

export const planShow = async (
  environment: CliEnvironment,
  options: PlanOptions,
): Promise<number> => {
  const session = await openSession(environment);
  const scope = await resolveScope(environment, session, options);
  const planning = planningOf(session);
  const found = await planning.getVersion(scope, options.version);
  const draft = await planning.getDraft(scope);
  if (found === undefined || draft === undefined) {
    throw new UsageError(
      options.version === undefined
        ? `the plane has no draft of \`${options.id}\``
        : `the plane has no version ${options.version} of \`${options.id}\``,
    );
  }
  const { version, check } = found;
  environment.out(`${options.id} version ${version.version} of ${draft.latestVersion}`);
  environment.out(`  author  ${principalOf(version.author)}`);
  environment.out(`  act     ${actOf(version.act)}`);
  environment.out(`  at      ${version.createdAt}`);
  environment.out(`  plan    ${version.planHash ?? "(the contract does not parse)"}`);
  environment.out(`  state   ${draft.state}`);
  for (const act of draft.acts) {
    environment.out(
      `  act     ${act.kind} version ${act.version} by ${principalOf(act.by)} at ${act.at}${act.note === undefined ? "" : `: ${act.note}`}`,
    );
  }
  if (check.ready) {
    environment.out("  check   READY");
  } else {
    environment.out(
      `  check   NOT READY: ${check.reasons.length} ${check.reasons.length === 1 ? "reason" : "reasons"}`,
    );
    for (const reason of check.reasons) {
      const [first, ...rest] = reason.message.split("\n");
      environment.out(`    - ${first}`);
      for (const line of rest) environment.out(`      ${line}`);
    }
  }
  if (options.dir !== undefined) {
    const directory = resolveFrom(environment.cwd, options.dir);
    const read = async (ref: { readonly sha256: string }): Promise<string> => {
      const document = await planning.planDocument(scope, ref.sha256);
      if (document === undefined) throw new UsageError(`the plane holds no document ${ref.sha256}`);
      return document.text;
    };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, CONTRACT_FILE), await read(version.contract));
    await writeFile(join(directory, PLAN_FILE), await read(version.plan));
    if (version.conversation === undefined) {
      await rm(join(directory, CONVERSATION_FILE), { force: true });
    } else {
      await writeFile(join(directory, CONVERSATION_FILE), await read(version.conversation));
    }
    await writeMarker(directory, version.version);
    environment.out(`wrote version ${version.version} to ${directory}`);
  }
  return 0;
};

/** Exit code 0 when `READY`, 1 otherwise: the exit code is the answer. */
export const planCheck = async (
  environment: CliEnvironment,
  options: PlanOptions,
): Promise<number> => {
  requireProgramId(options.id);
  if (options.dir === undefined) {
    const session = await openSession(environment);
    const scope = await resolveScope(environment, session, options);
    const found = await planningOf(session).getVersion(scope, options.version);
    if (found === undefined) {
      throw new UsageError(`the plane has no draft of \`${options.id}\``);
    }
    if (!found.check.ready) {
      printReasons(environment, found.check);
      return 1;
    }
    environment.out("READY");
    environment.out(
      `${options.id} version ${found.version.version}; plan ${found.version.planHash?.slice(0, 12) ?? "unhashed"}`,
    );
    return 0;
  }

  const scratch = await readScratch(environment, options, options.dir);
  const files: PlanDocuments = { ...scratch };
  const local = readinessOf(files);
  const correction = await correctionOf(environment, files);
  const result: PlanCheckResult =
    correction.problems.length === 0
      ? local
      : {
          ...local,
          ready: false,
          reasons: [
            ...local.reasons,
            ...correction.problems.map((message) => ({
              kind: "correction_invalid" as const,
              message,
            })),
          ],
        };
  if (!result.ready) {
    printReasons(environment, result);
    return 1;
  }
  environment.out("READY");
  for (const flag of correction.flags) environment.out(`FLAG ${flag}`);
  environment.out(
    `${scratch.directory}: ${scratch.contract.stories?.length ?? 0} stories, ` +
      `${scratch.contract.strands?.length ?? 0} strands, ` +
      `${scratch.contract.prerequisites?.length ?? 0} prerequisites, ` +
      `${scratch.contract.decisions?.length ?? 0} decisions; plan ${result.planHash.slice(0, 12)}`,
  );
  return 0;
};

const printRatified = (
  environment: CliEnvironment,
  what: string,
  ratified: ProgramContract,
): void => {
  environment.out(`ratified ${what}`);
  environment.out(`  program   ${ratified.programId}`);
  environment.out(`  plan hash ${ratified.planHash}`);
  environment.out(
    `  document  ${ratified.planDocument?.uri} (${ratified.planDocument?.sizeBytes} bytes, sha256 ${ratified.planDocument?.sha256})`,
  );
  if (ratified.conversation !== undefined) {
    environment.out(
      `  conversation ${ratified.conversation.uri} (${ratified.conversation.sizeBytes} bytes)`,
    );
  }
  environment.out(`  stories   ${(ratified.stories ?? []).map((story) => story.id).join(", ")}`);
  environment.out(`  strands   ${(ratified.strands ?? []).map((strand) => strand.id).join(", ")}`);
};

/**
 * Ratifies the plan on disk: READY, uploaded and recorded under its
 * hash. The one way a plan is ratified, by `nightshift plan ratify` and by
 * `nightshift run`, whose asking to run a plan is the human's approval of it
 * (2026-10-16). `undefined`, with the reasons said, when it cannot be.
 */
export const ratifyPlan = async (
  environment: CliEnvironment,
  session: Session,
  files: PlanDocuments,
): Promise<ProgramContract | undefined> => {
  const result = readinessOf(files);
  if (!result.ready) {
    printReasons(environment, result);
    environment.err("Nothing was ratified. Fix the plan and run `nightshift plan check` again.");
    return undefined;
  }

  const planning = createHttpPlanning({ transport: session.transport });
  // Upload first, then record: if the upload fails this throws, and nothing was asked for.
  const ratified = await planning.ratify(files.contract, files.planText, files.conversationText);

  printRatified(environment, files.directory, ratified);
  return ratified;
};

/** Ratifies the latest version on the plane by its hash. Needs no repository and pushes no branch. */
export const planRatify = async (
  environment: CliEnvironment,
  options: PlanOptions,
): Promise<number> => {
  const session = await openSession(environment);
  const scope = await resolveScope(environment, session, options);
  const planning = planningOf(session);
  const latest = await planning.getVersion(scope);
  if (latest === undefined) {
    throw new UsageError(`the plane has no draft of \`${options.id}\``);
  }
  if (!latest.check.ready || latest.version.planHash === undefined) {
    printReasons(
      environment,
      latest.check.ready ? { reasons: [{ message: "the contract does not parse" }] } : latest.check,
    );
    environment.err(
      "Nothing was ratified. Fix the plan, put a new version and run `nightshift plan check` again.",
    );
    return 1;
  }
  const ratified = await planning.ratifyVersion(scope, latest.version.planHash);
  printRatified(environment, `${options.id} version ${latest.version.version}`, ratified);
  return 0;
};
