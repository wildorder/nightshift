/**
 * `nightshift init` (P7, T3; SC-P7-13): a repository from nothing to plannable.
 *
 * Four things, each skipped when it is already done, so running it twice changes
 * nothing the second time:
 *
 * 1. a control-plane **project**, unless the config already names one;
 * 2. **`nightshift.config.json`**, with verification steps detected from
 *    `package.json` and confirmed by the human (or taken as found with `--yes`);
 * 3. the **skills**, copied to the operator's `~/.claude/skills/`, never into the
 *    repository: what a public repository contains is its owner's call;
 * 4. the **MCP server**, registered for this directory at Claude Code's *local*
 *    scope, which also writes nothing into the repository.
 *
 * It does not sign anyone up and installs nothing from a registry: `init` sets up
 * a repository for a user who already has an account (P7 §5, out of scope).
 */
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  NIGHTSHIFT_CONFIG_FILE,
  type NightshiftConfig,
  NightshiftConfigSchema,
  type VerificationStep,
} from "@nightshift/contracts";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readConfig, resolveFrom } from "../program-files.js";
import { createProject } from "./project-create.js";

export interface InitOptions {
  readonly repo?: string;
  /** Use an existing project instead of creating one. */
  readonly project?: string;
  /** The new project's name. Defaults to the directory's. */
  readonly name?: string;
  /** Ask nothing: take what was detected. */
  readonly yes: boolean;
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

/**
 * Verification steps read off `package.json`. A clean checkout has no
 * `node_modules`, and verification runs on one, so a lockfile means the first
 * step is `npm ci`: learned on the first real repository, where everything after
 * it failed without it.
 */
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
  if (await exists(join(repoPath, "package-lock.json"))) {
    steps.push({ id: "install", command: "npm ci" });
  }
  for (const name of VERIFICATION_SCRIPTS) {
    if (typeof scripts[name] === "string") steps.push({ id: name, command: `npm run ${name}` });
  }
  return steps;
};

/**
 * Defaults a human is expected to edit. Examination is off at every risk level
 * because nothing can examine until P8, and a contract that required it would be
 * refused at the first delegation.
 */
const NO_EXAMINATION = {
  required: false,
  mustDifferModel: false,
  mustDifferProvider: false,
  blockOnMaterialFindings: false,
} as const;

const configFor = (projectId: string, verification: VerificationStep[]): NightshiftConfig =>
  NightshiftConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    contextDocs: [],
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
  detected: VerificationStep[],
  yes: boolean,
): Promise<VerificationStep[]> => {
  if (detected.length === 0) {
    throw new UsageError(
      "no verification commands could be detected: there is no package.json with a build, typecheck, lint or test script",
      `Write ${NIGHTSHIFT_CONFIG_FILE} by hand with the commands that prove this repository works, then run \`nightshift init\` again.`,
    );
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
      `Write ${NIGHTSHIFT_CONFIG_FILE} by hand, or run \`nightshift init --yes\` and edit it.`,
    );
  }
  return detected;
};

const installSkills = async (environment: CliEnvironment): Promise<string[]> => {
  const source = environment.assets?.skillsDir;
  if (source === undefined || !(await exists(source))) return [];
  const target = join(environment.paths.home ?? homedir(), ".claude", "skills");
  const names = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of names) {
    await cp(join(source, name), join(target, name), { recursive: true, force: true });
  }
  return names;
};

/** Registered when `claude mcp get nightshift` says so, from inside the repository. */
const registerMcp = async (
  environment: CliEnvironment,
  repoPath: string,
): Promise<"already" | "registered" | "unavailable"> => {
  const server = environment.assets?.mcpServerPath;
  const exec = environment.exec;
  if (server === undefined || exec === undefined) return "unavailable";
  try {
    const found = await exec("claude", ["mcp", "get", "nightshift"], { cwd: repoPath });
    if (found.exitCode === 0) return "already";
    const added = await exec(
      "claude",
      ["mcp", "add", "--scope", "local", "nightshift", "--", "node", server],
      { cwd: repoPath },
    );
    return added.exitCode === 0 ? "registered" : "unavailable";
  } catch {
    // No Claude Code on this machine. Said below, with the command to run later.
    return "unavailable";
  }
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

  const existing = await readConfig(repoPath);
  let projectId = existing?.projectId ?? options.project;
  let configWritten = false;
  if (existing === undefined) {
    const verification = await confirmVerification(
      environment,
      await detectVerification(repoPath),
      options.yes,
    );
    if (projectId === undefined) {
      const created = await createProject(environment, {
        name: options.name ?? basename(repoPath),
      });
      projectId = created.projectId;
    }
    const config = configFor(projectId, verification);
    await writeFile(join(repoPath, NIGHTSHIFT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    configWritten = true;
  }
  if (projectId === undefined) throw new Error("unreachable: a config always names a project");

  const skillsInstalled = await installSkills(environment);
  const mcp = await registerMcp(environment, repoPath);

  environment.out(
    configWritten
      ? `wrote ${NIGHTSHIFT_CONFIG_FILE} for project ${projectId}. Commit it: a program inherits what its contract does not state.`
      : `${NIGHTSHIFT_CONFIG_FILE} already names project ${projectId}; left as it is`,
  );
  environment.out(
    skillsInstalled.length > 0
      ? `installed skills to ~/.claude/skills: ${skillsInstalled.join(", ")}`
      : "skills not installed: this build of the CLI does not carry them",
  );
  if (mcp === "unavailable") {
    environment.out(
      "the MCP server was not registered: Claude Code was not found. When it is installed, run in this directory:",
    );
    environment.out(
      `  claude mcp add --scope local nightshift -- node ${environment.assets?.mcpServerPath ?? "<path to nightshift-mcp.js>"}`,
    );
  } else {
    environment.out(
      mcp === "already"
        ? "the Nightshift MCP server is already registered for this directory"
        : "registered the Nightshift MCP server for this directory (local scope; nothing written to the repository)",
    );
  }
  environment.out(
    "Next: plan a program with the plan-program skill, in Claude Code, in this directory.",
  );

  return { projectId, configWritten, skillsInstalled, mcpRegistered: mcp !== "unavailable" };
};
