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
import { decisionBrief, reverseDecision } from "./commands/decision.js";
import { mintId } from "./commands/id.js";
import { init } from "./commands/init.js";
import { runLocal, useStage } from "./commands/local.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { getOrgConfig, setOrgConfig } from "./commands/org-config.js";
import { planCheck, planRatify } from "./commands/plan.js";
import { preflight } from "./commands/preflight.js";
import { createProject } from "./commands/project-create.js";
import { writeRunReport } from "./commands/report.js";
import { resume } from "./commands/resume.js";
import { exportRoutes } from "./commands/routes.js";
import { reverseRuling } from "./commands/ruling.js";
import { run } from "./commands/run.js";
import { whoami } from "./commands/whoami.js";
import type { CliEnvironment } from "./environment.js";
import { describeFailure, failureLines, UsageError } from "./failures.js";

export const USAGE = `nightshift — the Nightshift control plane, from a terminal

Usage:
  nightshift login [--no-browser]
  nightshift logout [--no-revoke]
  nightshift whoami
  nightshift local [--port <n>] [--state <dir>] [--no-open]
  nightshift use <stage>
  nightshift project create --name <name> [--description <text>]
  nightshift init [--project <id> | --name <name>] [--yes] [--repo <path>]
  nightshift plan check <program> [--repo <path>]
  nightshift plan ratify <program> [--repo <path>]
  nightshift preflight <program> [--repo <path>] [--recheck]
  nightshift run <program> [--attended] [--harness <name>] [--model <name>] [--confirm-irreversible <decisionId>]… [--repo <path>]
  nightshift run <contract> [--repo <path>] [--remote]
  nightshift resume <program> [--run <id>] [--repo <path>]
  nightshift ruling reverse <program> <decisionId> --reason <why> [--run <id>] [--repo <path>]
  nightshift decision reverse <program> <decisionId> --choice <new> --reason <why> [--run <id>] [--repo <path>]
  nightshift decision brief <program> <decisionId> [--out <path>] [--run <id>] [--repo <path>]
  nightshift report <program> [--run <id>] [--repo <path>]
  nightshift org config get [--org <id>]
  nightshift org config set <file> [--org <id>]
  nightshift routes export <program> [--run <id>] [--repo <path>]
  nightshift routes export --project <id>
  nightshift id <prefix>
  nightshift --help | --version

A <program> is the name of its directory under docs/programs/, which holds its
plan.md and contract.json. \`plan check\` answers READY or every reason, and its
exit code is the answer; nothing runs until \`plan ratify\` has recorded the plan.
\`run <program>\` then takes it to docs/programs/<program>/report.md with nobody
watching, and exits non-zero when anything was parked. --attended only creates
the run, for your own orchestrator session to attach to. A check that needs
something only you can supply does not stop the night: the work carries on a
provisional line, and \`resume\` runs those checks and lands it when you are back.

\`nightshift login\` needs no flags: the CLI knows where the control plane is.
Over SSH, add --no-browser and paste the address your browser lands on.

Developer flags for \`login\`, for another stage or a control plane the CLI does
not ship: --stage <stage>, --api <url>, --auth-domain <domain>, --client-id <id>.
They are remembered in your profile.`;

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
  "nightshift login [--no-browser] [--stage <stage>] [--api <url>] [--auth-domain <domain>] [--client-id <id>]";

const doLogin = async (environment: CliEnvironment, args: readonly string[]): Promise<void> => {
  const { values } = parse(
    {
      args: [...args],
      options: {
        api: { type: "string" },
        "auth-domain": { type: "string" },
        "client-id": { type: "string" },
        stage: { type: "string" },
        // Over SSH the opener "succeeds" on the remote desktop. This skips it and
        // prints the URL for a browser that can reach the loopback port.
        "no-browser": { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    },
    LOGIN_USAGE,
  );
  const noBrowser = values["no-browser"] === true;
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
      ...(noBrowser ? { noBrowser } : {}),
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

const doLocal = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const { values } = parse(
    {
      args: [...args],
      options: {
        port: { type: "string" },
        state: { type: "string" },
        "no-open": { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    },
    "nightshift local [--port <n>] [--state <dir>] [--no-open]",
  );
  const port = optional(values, "port");
  const state = optional(values, "state");
  return runLocal(environment, {
    ...(port === undefined ? {} : { port }),
    ...(state === undefined ? {} : { state }),
    open: values["no-open"] !== true,
  });
};

const doUse = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const [stage, ...rest] = args;
  if (stage === undefined || rest.length > 0) {
    throw new UsageError("name one stage", "nightshift use <stage>");
  }
  return useStage(environment, stage);
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

const doRun = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage = "nightshift run <program | contract> [--repo <path>] [--remote]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: {
        repo: { type: "string" },
        remote: { type: "boolean", default: false },
        attended: { type: "boolean", default: false },
        harness: { type: "string" },
        model: { type: "string" },
        "confirm-irreversible": { type: "string", multiple: true },
      },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const contract = positionals[0];
  if (contract === undefined) {
    throw new UsageError(
      "`nightshift run` needs a program id or the path to a Program Contract",
      usage,
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument \`${positionals[1]}\``, usage);
  }
  const repo = optional(values, "repo");
  const harness = optional(values, "harness");
  const model = optional(values, "model");
  const result = await run(environment, {
    contract,
    ...(repo === undefined ? {} : { repo }),
    remote: values.remote === true,
    attended: values.attended === true,
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(values["confirm-irreversible"] === undefined
      ? {}
      : { confirmIrreversible: values["confirm-irreversible"] as string[] }),
  });
  return result.exitCode;
};

/** One positional, the program id, and the flags every program command shares. */
const programArgs = (
  args: readonly string[],
  usage: string,
  flags: Record<string, { type: "boolean" }> = {},
): { readonly id: string; readonly repo?: string; readonly values: Record<string, unknown> } => {
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { repo: { type: "string" }, ...flags },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const id = positionals[0];
  if (id === undefined) throw new UsageError("a program id is required", usage);
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument \`${positionals[1]}\``, usage);
  }
  const repo = optional(values, "repo");
  return { id, ...(repo === undefined ? {} : { repo }), values };
};

const doInit = async (environment: CliEnvironment, args: readonly string[]): Promise<void> => {
  const usage = "nightshift init [--project <id> | --name <name>] [--yes] [--repo <path>]";
  const { values } = parse(
    {
      args: [...args],
      options: {
        repo: { type: "string" },
        project: { type: "string" },
        name: { type: "string" },
        yes: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    },
    usage,
  );
  const repo = optional(values, "repo");
  const project = optional(values, "project");
  const name = optional(values, "name");
  await init(environment, {
    ...(repo === undefined ? {} : { repo }),
    ...(project === undefined ? {} : { project }),
    ...(name === undefined ? {} : { name }),
    yes: values.yes === true,
  });
};

const doPlan = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const [subcommand, ...rest] = args;
  const usage = "nightshift plan check|ratify <program> [--repo <path>]";
  if (subcommand !== "check" && subcommand !== "ratify") {
    throw new UsageError(
      subcommand === undefined
        ? "`nightshift plan` needs a subcommand"
        : `unknown subcommand \`plan ${subcommand}\``,
      usage,
    );
  }
  const { id, repo } = programArgs(rest, usage);
  const options = { id, ...(repo === undefined ? {} : { repo }) };
  return subcommand === "check"
    ? planCheck(environment, options)
    : planRatify(environment, options);
};

const doPreflight = async (
  environment: CliEnvironment,
  args: readonly string[],
): Promise<number> => {
  const usage = "nightshift preflight <program> [--repo <path>] [--recheck]";
  const { id, repo, values } = programArgs(args, usage, { recheck: { type: "boolean" } });
  return preflight(environment, {
    id,
    ...(repo === undefined ? {} : { repo }),
    recheck: values.recheck === true,
  });
};

const doResume = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage = "nightshift resume <program> [--run <id>] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { repo: { type: "string" }, run: { type: "string" } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const id = positionals[0];
  if (id === undefined) throw new UsageError("a program id is required", usage);
  const repo = optional(values, "repo");
  const run = optional(values, "run");
  return resume(environment, {
    id,
    ...(repo === undefined ? {} : { repo }),
    ...(run === undefined ? {} : { run }),
  });
};

const doRuling = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage =
    "nightshift ruling reverse <program> <decisionId> --reason <why> [--run <id>] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { reason: { type: "string" }, run: { type: "string" }, repo: { type: "string" } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [verb, id, decisionId] = positionals;
  if (verb !== "reverse" || id === undefined || decisionId === undefined) {
    throw new UsageError("`nightshift ruling` takes `reverse <program> <decisionId>`", usage);
  }
  const run = optional(values, "run");
  const repo = optional(values, "repo");
  return reverseRuling(environment, {
    id,
    decisionId,
    reason: required(values, "reason", usage),
    ...(run === undefined ? {} : { run }),
    ...(repo === undefined ? {} : { repo }),
  });
};

const doDecision = async (
  environment: CliEnvironment,
  args: readonly string[],
): Promise<number> => {
  const usage =
    "nightshift decision reverse <program> <decisionId> --choice <new> --reason <why> [--run <id>] [--repo <path>]\n" +
    "nightshift decision brief <program> <decisionId> [--out <path>] [--run <id>] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: {
        choice: { type: "string" },
        reason: { type: "string" },
        out: { type: "string" },
        run: { type: "string" },
        repo: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [verb, id, decisionId] = positionals;
  if (id === undefined || decisionId === undefined) {
    throw new UsageError(
      "`nightshift decision` takes `reverse` or `brief` <program> <decisionId>",
      usage,
    );
  }
  const run = optional(values, "run");
  const repo = optional(values, "repo");
  const target = {
    id,
    decisionId,
    ...(run === undefined ? {} : { run }),
    ...(repo === undefined ? {} : { repo }),
  };
  if (verb === "reverse") {
    const reversed = await reverseDecision(environment, {
      ...target,
      choice: required(values, "choice", usage),
      reason: required(values, "reason", usage),
    });
    return reversed.exitCode;
  }
  if (verb === "brief") {
    const out = optional(values, "out");
    return decisionBrief(environment, { ...target, ...(out === undefined ? {} : { out }) });
  }
  throw new UsageError("`nightshift decision` takes `reverse` or `brief`", usage);
};

const doReport = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage = "nightshift report <program> [--run <id>] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { run: { type: "string" }, repo: { type: "string" } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [id] = positionals;
  if (id === undefined) throw new UsageError("`nightshift report` needs a program", usage);
  const run = optional(values, "run");
  const repo = optional(values, "repo");
  return writeRunReport(environment, {
    id,
    ...(run === undefined ? {} : { run }),
    ...(repo === undefined ? {} : { repo }),
  });
};

const doOrg = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage =
    "nightshift org config get [--org <id>] | nightshift org config set <file> [--org <id>]";
  const { values, positionals } = parse(
    { args: [...args], options: { org: { type: "string" } }, allowPositionals: true, strict: true },
    usage,
  );
  const [noun, verb, file] = positionals;
  const org = optional(values, "org");
  if (noun !== "config")
    throw new UsageError("`nightshift org` takes `config get` or `config set <file>`", usage);
  if (verb === "get") return getOrgConfig(environment, org);
  if (verb === "set" && file !== undefined) return setOrgConfig(environment, file, org);
  throw new UsageError("`nightshift org config` takes `get` or `set <file>`", usage);
};

const doRoutes = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage =
    "nightshift routes export <program> [--run <id>] [--repo <path>] | nightshift routes export --project <id>";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { run: { type: "string" }, project: { type: "string" }, repo: { type: "string" } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [verb, id] = positionals;
  if (verb !== "export") throw new UsageError("`nightshift routes` takes `export`", usage);
  const run = optional(values, "run");
  const project = optional(values, "project");
  const repo = optional(values, "repo");
  return exportRoutes(environment, {
    ...(id === undefined ? {} : { id }),
    ...(run === undefined ? {} : { run }),
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
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

/** A command's own exit code, when its answer is one (`plan check`); otherwise nothing, meaning 0. */
const dispatch = async (
  environment: CliEnvironment,
  command: string,
  args: readonly string[],
): Promise<number | undefined> => {
  switch (command) {
    case "login":
      await doLogin(environment, args);
      return undefined;
    case "logout":
      await doLogout(environment, args);
      return undefined;
    case "whoami": {
      await whoami(environment);
      return undefined;
    }
    case "local":
      return doLocal(environment, args);
    case "use":
      return doUse(environment, args);
    case "project":
      await doProject(environment, args);
      return undefined;
    case "init":
      await doInit(environment, args);
      return undefined;
    case "plan":
      return doPlan(environment, args);
    case "preflight":
      return doPreflight(environment, args);
    case "run":
      return doRun(environment, args);
    case "resume":
      return doResume(environment, args);
    case "ruling":
      return doRuling(environment, args);
    case "decision":
      return doDecision(environment, args);
    case "report":
      return doReport(environment, args);
    case "org":
      return doOrg(environment, args);
    case "routes":
      return doRoutes(environment, args);
    case "id":
      doId(environment, args);
      return undefined;
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
    return (await dispatch(environment, command, args)) ?? 0;
  } catch (error) {
    const failure = describeFailure(error);
    for (const line of failureLines(failure)) environment.err(line);
    // Two codes, because the distinction is the one a script cares about: 2 is
    // "you typed it wrong", 1 is "it did not work".
    return failure.code === "bad_usage" ? 2 : 1;
  }
};
