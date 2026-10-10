/**
 * `nightshift init` (P7, T3; SC-P7-13): a repository from nothing to plannable.
 *
 * Four things, each skipped when it is already done, so running it twice changes
 * nothing the second time:
 *
 * 1. a control-plane **project**, unless the config already names one;
 * 2. **`nightshift.config.json`**, with verification steps detected from
 *    `package.json` and confirmed by the human (or taken as found with `--yes`);
 * 3. the **skills**, copied to the selected clients' user skill directories;
 * 4. the **MCP server**, registered with each selected client, outside the repo.
 *
 * It does not sign anyone up and installs nothing from a registry: `init` sets up
 * a repository for a user who already has an account (P7 §5, out of scope).
 */
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  NIGHTSHIFT_CONFIG_FILE,
  type NightshiftConfig,
  NightshiftConfigSchema,
  type SetupStep,
  type VerificationStep,
} from "@nightshift/contracts";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readConfig, resolveFrom } from "../program-files.js";
import {
  clientSkillsPath,
  INIT_CLIENTS,
  type InitClient,
  mcpAddArgs,
  parseInitClients,
  registerClientMcp,
} from "./init-clients.js";
import { createProject } from "./project-create.js";

export interface InitOptions {
  readonly repo?: string;
  /** Use an existing project instead of creating one. */
  readonly project?: string;
  /** The new project's name. Defaults to the directory's. */
  readonly name?: string;
  /** Ask nothing: take what was detected. */
  readonly yes: boolean;
  /** Comma-separated clients, or all/none. Required when there is no prompt. */
  readonly clients?: string;
}

export interface InitResult {
  readonly projectId: string;
  readonly configWritten: boolean;
  readonly skillsInstalled: readonly string[];
  readonly mcpRegistered: boolean;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** The scripts a verification is usually made of, in the order they have to run. */
const VERIFICATION_SCRIPTS = ["build", "typecheck", "lint", "test"] as const;

/** What a lockfile makes setup: `--prefer-offline` so a warm volume's store answers first (D-P10-15). */
export const NPM_SETUP_COMMAND = "npm ci --prefer-offline";

/**
 * Setup read off the repository. Every checkout Nightshift creates starts with
 * no `node_modules`, so a lockfile means `npm ci` prepares each one: learned on
 * the first real repository, where every check failed without it. It is setup,
 * not a verification step, so the checks state only what is checked. Remotely
 * the npm cache lives on the project's warm volume, and `--prefer-offline`
 * takes what is there without asking the registry about it (P10, D-P10-15).
 */
export const detectSetup = async (repoPath: string): Promise<SetupStep[]> =>
  (await exists(join(repoPath, "package-lock.json")))
    ? [{ id: "install", command: NPM_SETUP_COMMAND }]
    : [];

/** Verification steps read off `package.json`'s scripts. */
export const detectVerification = async (repoPath: string): Promise<VerificationStep[]> => {
  let scripts: Record<string, unknown> = {};
  try {
    const manifest: unknown = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8"));
    const found = (manifest as { scripts?: unknown }).scripts;
    if (found !== null && typeof found === "object") scripts = found as Record<string, unknown>;
  } catch {
    return [];
  }
  const steps: VerificationStep[] = [];
  for (const name of VERIFICATION_SCRIPTS) {
    if (typeof scripts[name] === "string") steps.push({ id: name, command: `npm run ${name}` });
  }
  return steps;
};

/**
 * The repository's floor for examination: nothing beyond what its org requires
 * (P8, D-P8-03). A run's examination is the stricter of the org's and this, field
 * by field, so this adds nothing and takes nothing away; a repository that wants
 * more scrutiny than its org raises it here. Routing is the org's too
 * (`nightshift org config`); a repository only narrows it, with `routing`.
 */
const NO_EXAMINATION = {
  required: false,
  mustDifferModel: false,
  mustDifferProvider: false,
  blockOnMaterialFindings: false,
} as const;

const configFor = (
  projectId: string,
  setup: SetupStep[],
  verification: VerificationStep[],
): NightshiftConfig =>
  NightshiftConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    contextDocs: [],
    ...(setup.length === 0 ? {} : { setup }),
    verification,
    modelPolicy: {
      allowedProviders: ["anthropic", "openai"],
      allowedModels: [],
      forbiddenModels: [],
    },
    delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
    costPolicy: {},
    examinationPolicy: { low: NO_EXAMINATION, medium: NO_EXAMINATION, high: NO_EXAMINATION },
    defaultRisk: "medium",
  });

/** One line from the terminal, or `undefined` when there is nobody to ask. */
const ask = async (environment: CliEnvironment, question: string): Promise<string | undefined> => {
  environment.out(question);
  const source = environment.readPaste();
  try {
    return await source.line;
  } finally {
    source.cancel();
  }
};

const confirmVerification = async (
  environment: CliEnvironment,
  setup: SetupStep[],
  detected: VerificationStep[],
  yes: boolean,
): Promise<VerificationStep[]> => {
  if (detected.length === 0) {
    throw new UsageError(
      "no verification commands could be detected: there is no package.json with a build, typecheck, lint or test script",
      `Write ${NIGHTSHIFT_CONFIG_FILE} by hand with the commands that prove this repository works, then run \`nightshift init\` again.`,
    );
  }
  if (setup.length > 0) {
    environment.out("Setup, run in every checkout Nightshift creates, before anything else:");
    for (const step of setup) environment.out(`  ${step.id.padEnd(10)} ${step.command}`);
  }
  environment.out("Verification, run on a clean checkout of every candidate commit:");
  for (const step of detected) environment.out(`  ${step.id.padEnd(10)} ${step.command}`);
  if (yes) return detected;
  const answer = await ask(
    environment,
    "Use these? [Y/n] (edit the file afterwards to change them)",
  );
  if (answer !== undefined && /^n/i.test(answer.trim())) {
    throw new UsageError(
      "nothing was written",
      `Write ${NIGHTSHIFT_CONFIG_FILE} by hand, or run \`nightshift init --yes --clients <choice>\` and edit it.`,
    );
  }
  return detected;
};

const installSkills = async (
  environment: CliEnvironment,
  client: InitClient,
): Promise<string[]> => {
  const source = environment.assets?.skillsDir;
  if (source === undefined || !(await exists(source))) return [];
  const target = clientSkillsPath(environment, client);
  const names = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of names) {
    await cp(join(source, name), join(target, name), { recursive: true, force: true });
  }
  return names;
};

const selectClients = async (
  environment: CliEnvironment,
  options: InitOptions,
): Promise<InitClient[]> => {
  let selection = options.clients;
  if (selection === undefined && !options.yes) {
    environment.out("Where should Nightshift install MCP and skills?");
    for (const [client, details] of Object.entries(INIT_CLIENTS)) {
      environment.out(
        `  ${client}: ${details.name}; skills ~/${details.skills}/skills; MCP ${details.scope}`,
      );
    }
    selection = await ask(
      environment,
      "Choose one or more (comma-separated): claude, codex, cursor, all, or none:",
    );
  }
  return parseInitClients(selection);
};

export const init = async (
  environment: CliEnvironment,
  options: InitOptions,
): Promise<InitResult> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  if (!(await exists(join(repoPath, ".git")))) {
    throw new UsageError(
      `${repoPath} is not the root of a git repository`,
      "Nightshift works in a clone: run `nightshift init` at its root, or pass --repo.",
    );
  }
  const clients = await selectClients(environment, options);
  const existing = await readConfig(repoPath);
  let projectId = existing?.projectId ?? options.project;
  let configWritten = false;
  if (existing === undefined) {
    const setup = await detectSetup(repoPath);
    const verification = await confirmVerification(
      environment,
      setup,
      await detectVerification(repoPath),
      options.yes,
    );
    if (projectId === undefined) {
      const created = await createProject(environment, {
        name: options.name ?? basename(repoPath),
      });
      projectId = created.projectId;
    }
    const config = configFor(projectId, setup, verification);
    await writeFile(join(repoPath, NIGHTSHIFT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    configWritten = true;
  }
  if (projectId === undefined) throw new Error("unreachable: a config always names a project");

  environment.out(
    configWritten
      ? `wrote ${NIGHTSHIFT_CONFIG_FILE} for project ${projectId}. Commit it: a program inherits what its contract does not state.`
      : `${NIGHTSHIFT_CONFIG_FILE} already names project ${projectId}; left as it is`,
  );
  const installation = await installClients(environment, repoPath, clients);
  environment.out(
    "Routing and examination are your org's: its ladders, rules and prices, and what each risk " +
      "is examined by. See them with `nightshift org config get`; this repository only narrows them.",
  );
  environment.out(
    "Next: plan a program with the plan-program skill, in your preferred client, in this directory.",
  );

  return { projectId, configWritten, ...installation };
};

const installClients = async (
  environment: CliEnvironment,
  repoPath: string,
  clients: readonly InitClient[],
): Promise<Pick<InitResult, "skillsInstalled" | "mcpRegistered">> => {
  const skillsInstalled = new Set<string>();
  let mcpRegistered = clients.length > 0;
  if (clients.length === 0) environment.out("MCP and skills installation skipped (none selected).");
  for (const client of clients) {
    const details = INIT_CLIENTS[client];
    const installed = await installSkills(environment, client);
    installed.forEach((skill) => {
      skillsInstalled.add(skill);
    });
    environment.out(
      installed.length > 0
        ? `${details.name}: installed skills to ${clientSkillsPath(environment, client)}: ${installed.join(", ")}`
        : `${details.name}: skills not installed: this build of the CLI does not carry them`,
    );
    const mcp = await registerClientMcp(environment, repoPath, client);
    if (mcp === "unavailable") {
      mcpRegistered = false;
      environment.out(
        `${details.name}: MCP server was not registered; the client CLI or bundled server is unavailable, or registration failed.`,
      );
      if (client !== "cursor") {
        const args = mcpAddArgs(
          client,
          environment.assets?.mcpServerPath ?? "<path to nightshift-mcp.js>",
        );
        environment.out(
          `  ${client} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`,
        );
      }
    } else {
      environment.out(
        `${details.name}: Nightshift MCP server ${mcp === "already" ? "already registered" : "registered"} (${details.scope})`,
      );
    }
  }
  return { skillsInstalled: [...skillsInstalled], mcpRegistered };
};
