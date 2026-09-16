/**
 * Argument parsing and dispatch, on `node:util`'s `parseArgs` and nothing else.
 *
 * No CLI framework, deliberately: six commands and a dozen flags do not need
 * one, and the alternative is a dependency in the layer whose entire job is to
 * be thin (A-16). `parseArgs` in `strict` mode already refuses an unknown flag
 * and a flag with no value, which is most of what a framework would be bought
 * for.
 *
 * Each command parses **its own** options rather than sharing one grammar: the
 * options really are per-command, and a single table would accept `nightshift
 * logout --repo`. The command word is taken off the front first, so `parseArgs`
 * only ever sees one command's arguments.
 *
 * Dispatch returns an exit code and throws nothing an operator sees; every
 * failure has already been through {@link describeFailure} by the time it leaves
 * {@link runCli}.
 */
import { parseArgs } from "node:util";
import { mintId } from "./commands/id.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { createProject } from "./commands/project-create.js";
import { run } from "./commands/run.js";
import { whoami } from "./commands/whoami.js";
import type { CliEnvironment } from "./environment.js";
import { describeFailure, failureLines, UsageError } from "./failures.js";

export const USAGE = `nightshift — the Nightshift control plane, from a terminal

Usage:
  nightshift login [--api <url>] [--auth-domain <domain>] [--client-id <id>] [--stage <stage>]
  nightshift logout [--no-revoke]
  nightshift whoami
  nightshift project create --name <name> [--description <text>]
  nightshift run <contract> [--repo <path>] [--remote]
  nightshift id <prefix>
  nightshift --help | --version

Sign in once with all three flags; they are remembered in your profile, so every
later \`nightshift login\` needs none.`;

/** Bumped by hand. The CLI has no release train of its own in v1. */
export const VERSION = "0.0.0";

/** Reads one option that must be present and non-empty. */
const required = (values: Record<string, unknown>, name: string, usage: string): string => {
  const value = values[name];
  if (typeof value !== "string" || value === "") {
    throw new UsageError(`--${name} is required and must not be empty`, usage);
  }
  return value;
};

const optional = (values: Record<string, unknown>, name: string): string | undefined => {
  const value = values[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** `parseArgs` throws its own `TypeError`s; they become usage failures. */
const parse = <T extends Parameters<typeof parseArgs>[0]>(
  config: T,
  usage: string,
): ReturnType<typeof parseArgs> => {
  try {
    return parseArgs(config);
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause), usage);
  }
};

const LOGIN_USAGE =
  "nightshift login [--api <url>] [--auth-domain <domain>] [--client-id <id>] [--stage <stage>]";

const doLogin = async (environment: CliEnvironment, args: readonly string[]): Promise<void> => {
  const { values } = parse(
    {
      args: [...args],
      options: {
        api: { type: "string" },
        "auth-domain": { type: "string" },
        "client-id": { type: "string" },
        stage: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    },
    LOGIN_USAGE,
  );
  const api = optional(values, "api");
  const authDomain = optional(values, "auth-domain");
  const clientId = optional(values, "client-id");
  const stage = optional(values, "stage");
  await login(environment, {
    flags: {
      ...(api === undefined ? {} : { api }),
      ...(authDomain === undefined ? {} : { authDomain }),
      ...(clientId === undefined ? {} : { clientId }),
      ...(stage === undefined ? {} : { stage }),
    },
  });
};

const doLogout = async (environment: CliEnvironment, args: readonly string[]): Promise<void> => {
  const { values } = parse(
    {
      args: [...args],
      // Spelled as its own option rather than relying on a `--no-` prefix:
      // `node:util`'s `parseArgs` has no negation support, unlike the frameworks
      // this deliberately does not use, and an unrecognised `--no-revoke` would
      // otherwise be refused as an unknown flag.
      options: { "no-revoke": { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    },
    "nightshift logout [--no-revoke]",
  );
  await logout(environment, { revoke: values["no-revoke"] !== true });
};

const doProject = async (environment: CliEnvironment, args: readonly string[]): Promise<void> => {
  const usage = "nightshift project create --name <name> [--description <text>]";
  const [subcommand, ...rest] = args;
  if (subcommand !== "create") {
    throw new UsageError(
      subcommand === undefined
        ? "`nightshift project` needs a subcommand"
        : `unknown subcommand \`project ${subcommand}\``,
      usage,
    );
  }
  const { values } = parse(
    {
      args: [...rest],
      options: { name: { type: "string" }, description: { type: "string" } },
      allowPositionals: false,
      strict: true,
    },
    usage,
  );
  const description = optional(values, "description");
  await createProject(environment, {
    name: required(values, "name", usage),
    ...(description === undefined ? {} : { description }),
  });
};

const doRun = async (environment: CliEnvironment, args: readonly string[]): Promise<void> => {
  const usage = "nightshift run <contract> [--repo <path>] [--remote]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { repo: { type: "string" }, remote: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const contract = positionals[0];
  if (contract === undefined) {
    throw new UsageError("`nightshift run` needs the path to a Program Contract", usage);
  }
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument \`${positionals[1]}\``, usage);
  }
  const repo = optional(values, "repo");
  await run(environment, {
    contract,
    ...(repo === undefined ? {} : { repo }),
    remote: values.remote === true,
  });
};

const doId = (environment: CliEnvironment, args: readonly string[]): void => {
  const usage = "nightshift id <prefix>";
  const { positionals } = parse(
    { args: [...args], options: {}, allowPositionals: true, strict: true },
    usage,
  );
  const prefix = positionals[0];
  if (prefix === undefined) throw new UsageError("`nightshift id` needs a prefix", usage);
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument \`${positionals[1]}\``, usage);
  }
  mintId(environment, prefix);
};

const dispatch = async (
  environment: CliEnvironment,
  command: string,
  args: readonly string[],
): Promise<void> => {
  switch (command) {
    case "login":
      return doLogin(environment, args);
    case "logout":
      return doLogout(environment, args);
    case "whoami": {
      await whoami(environment);
      return;
    }
    case "project":
      return doProject(environment, args);
    case "run":
      return doRun(environment, args);
    case "id":
      return doId(environment, args);
    default:
      throw new UsageError(`unknown command \`${command}\``, USAGE);
  }
};

/**
 * Runs one invocation and answers its exit code.
 *
 * `argv` is what follows the program name. Nothing here reads `process.argv`,
 * `process.env` or `process.exit`, so the whole CLI is exercisable in a test.
 */
export const runCli = async (
  environment: CliEnvironment,
  argv: readonly string[],
): Promise<number> => {
  const [command, ...args] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    environment.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "--version" || command === "-v") {
    environment.out(VERSION);
    return 0;
  }

  try {
    await dispatch(environment, command, args);
    return 0;
  } catch (error) {
    const failure = describeFailure(error);
    for (const line of failureLines(failure)) environment.err(line);
    // Two codes, because the distinction is the one a script cares about: 2 is
    // "you typed it wrong", 1 is "it did not work".
    return failure.code === "bad_usage" ? 2 : 1;
  }
};
