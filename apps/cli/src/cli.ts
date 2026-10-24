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
import { type CompletionVerb, completion } from "./commands/completion.js";
import { planConversation } from "./commands/conversation.js";
import { decisionBrief, reverseDecision } from "./commands/decision.js";
import { recordedGates, recordGates } from "./commands/gate-health.js";
import { gates } from "./commands/gates.js";
import { mintId } from "./commands/id.js";
import { init } from "./commands/init.js";
import { runLocal, useStage } from "./commands/local.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { getOrgConfig, setOrgConfig } from "./commands/org-config.js";
import {
  githubInstall,
  githubRemove,
  githubStatus,
  providersSet,
  providersStatus,
} from "./commands/org-remote.js";
import { planCheck, planPut, planRatify, planShow } from "./commands/plan.js";
import { preflight } from "./commands/preflight.js";
import { createProject } from "./commands/project-create.js";
import { rateRun } from "./commands/rate.js";
import { remoteCancel, remoteResume, remoteStatus } from "./commands/remote.js";
import { writeRunReport } from "./commands/report.js";
import { resume } from "./commands/resume.js";
import { exportRoutes } from "./commands/routes.js";
import { reverseRuling } from "./commands/ruling.js";
import { run } from "./commands/run.js";
import { secretList, secretRemove, secretSet } from "./commands/secrets.js";
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
  nightshift init [--project <id> | --name <name>] [--clients <claude,codex,cursor|all|none>] [--yes] [--repo <path>]
  nightshift plan put <program> --dir <scratch> [--based-on <n>] [--project <id>]
  nightshift plan show <program> [--version <n>] [--dir <scratch>] [--project <id>]
  nightshift plan check <program> [--dir <scratch>] [--project <id>]
  nightshift plan ratify <program> [--project <id>]
  nightshift plan conversation <program> [--list | --keep <3,5-7>] [--summary <file>] [--session <path>] [--project <id>]
  nightshift preflight <program> [--repo <path>] [--recheck]
  nightshift gates <program> [--record [--findings <file>] | --recorded] [--landings <n>] [--json] [--repo <path>]
  nightshift run <program> [--attended] [--harness <name>] [--model <name>] [--confirm-irreversible <decisionId>]… [--repo <path>]
  nightshift run <program> --remote [--compute good|better|best] [--repo <path>]
  nightshift remote status <program> [--watch] [--run <id>] [--repo <path>]
  nightshift remote cancel|resume <program> [--run <id>] [--repo <path>]
  nightshift resume <program> [--run <id>] [--repo <path>]
  nightshift ruling reverse <program> <decisionId> --reason <why> [--run <id>] [--repo <path>]
  nightshift decision reverse <program> <decisionId> --choice <new> --reason <why> [--run <id>] [--repo <path>]
  nightshift decision brief <program> <decisionId> [--out <path>] [--run <id>] [--repo <path>]
  nightshift report <program> [--run <id>] [--json [--role <r>] [--model <m>] [--since <iso>] [--until <iso>]] [--repo <path>]
  nightshift rate <program> up|down|clear [--run <id>] [--repo <path>]
  nightshift completion create <program> --title <t> [--run <id>] [--repo <path>]
  nightshift completion list <program> [--repo <path>]
  nightshift completion show|suggest <program> --history <id> [--repo <path>]
  nightshift completion add <program> --history <id> --member <programId>/<runId> [--role contributing|correction] [--repo <path>]
  nightshift completion remove <program> --history <id> --member <programId>/<runId> [--repo <path>]
  nightshift completion checkpoint <program> --history <id> --name <n> --member <programId>/<runId> [--repo <path>]
  nightshift org config get [--org <id>]
  nightshift org config set <file> [--org <id>]
  nightshift org github install [--installation <id>] [--org <id>]
  nightshift org github remove --installation <id> [--org <id>]
  nightshift org github status [--org <id>]
  nightshift org providers set <anthropic|openai> [--file <path>] [--org <id>]
  nightshift org providers status [--org <id>]
  nightshift secret set <NAME> [--project <id>] [--repo <path>]
  nightshift secret list [--project <id>] [--repo <path>]
  nightshift secret rm <NAME> [--project <id>] [--repo <path>]
  nightshift routes export <program> [--run <id>] [--repo <path>]
  nightshift routes export --project <id>
  nightshift id <prefix>
  nightshift --help | --version

A plan lives on the control plane as versions of a draft, readable from anywhere.
\`plan put\` writes the next version from a scratch directory (contract.json,
plan.md, optional conversation.md) outside any repository; a put based on an
older version than the latest is refused and names the latest. \`plan show\` prints
a version, its author and the draft's state, and with --dir writes its files to a
scratch. \`plan check\` answers READY or every reason for the latest version, and
its exit code is the answer (--dir checks a scratch offline); nothing runs until
\`plan ratify\` has ratified the latest version by its hash. \`plan conversation\`
keeps the planning session's summary and the exchanges that shaped the plan, word
for word, as the next version's conversation; the stories' quotes are checked
against it. The project is --project, else the scratch's contract, else
nightshift.config.json at hand, else the one project with a draft of the program.
A <program> in the commands below is the name of its directory under docs/programs/.
\`run <program>\` then takes it to docs/programs/<program>/report.md with nobody
watching, and exits non-zero when anything was parked. --attended only creates
the run, for your own orchestrator session to attach to. A check that needs
something only you can supply does not stop the night: the work carries on a
provisional line, and \`resume\` runs those checks and lands it when you are back.
\`gates <program>\` runs the program's setup and every check on the program
branch, in a fresh checkout, as verification will. A local \`run\` records this
baseline before starting; a remote run records its baseline on its machine.
Failing baseline checks do not prevent work from starting. Required verification
must still pass before integration. \`gates <program> --record\` keeps the audit as the
project's gate-health record, fingerprinted over the gates' commands, the
lockfiles and the gate machinery --findings names: healthy, or repairing when
the review found something to fix. A red gate needs a finding. \`--recorded\`
runs nothing, and says whether the record still holds for the gates now.
Gate-health records are optional diagnostics, not requirements for \`plan check\`
or ratification. No special gate-health strand or global repair dependency is required.

\`run <program> --remote\` dispatches the run to a machine and stays attached:
WAIT while the machine comes up and prepares the repository, then OK GO once
the orchestrator is running, and you can close the laptop. No laptop audit or
laptop-to-machine gate agreement is required. A failed dispatch exits 1.
Ctrl-C detaches without cancelling anything;
\`remote status <program> --watch\` reattaches to the same display, and
\`remote cancel <program>\` stops the machine.

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
  const usage =
    "nightshift run <program | contract> [--repo <path>] [--remote [--compute <tier>] [--no-push]]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: {
        repo: { type: "string" },
        remote: { type: "boolean", default: false },
        compute: { type: "string" },
        "no-push": { type: "boolean", default: false },
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
  const compute = optional(values, "compute");
  const result = await run(environment, {
    contract,
    ...(repo === undefined ? {} : { repo }),
    remote: values.remote === true,
    ...(compute === undefined ? {} : { compute }),
    ...(values["no-push"] === true ? { push: false } : {}),
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
  flags: Record<string, { type: "boolean" | "string" }> = {},
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
  const usage =
    "nightshift init [--project <id> | --name <name>] [--clients <claude,codex,cursor|all|none>] [--yes] [--repo <path>]";
  const { values } = parse(
    {
      args: [...args],
      options: {
        repo: { type: "string" },
        project: { type: "string" },
        name: { type: "string" },
        clients: { type: "string" },
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
  const clients = optional(values, "clients");
  await init(environment, {
    ...(clients === undefined ? {} : { clients }),
    ...(repo === undefined ? {} : { repo }),
    ...(project === undefined ? {} : { project }),
    ...(name === undefined ? {} : { name }),
    yes: values.yes === true,
  });
};

const CONVERSATION_USAGE =
  "nightshift plan conversation <program> [--list | --keep <3,5-7>] [--summary <file>] [--session <path>] [--project <id>] [--repo <path>]";

const versionNumber = (
  name: string,
  value: string | undefined,
  usage: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`--${name} must be a version number, 1 or more`, usage);
  }
  return parsed;
};

const doPlan = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const [subcommand, ...rest] = args;
  const usage = "nightshift plan put|show|check|ratify|conversation <program> [--project <id>]";
  if (subcommand === "conversation") {
    const { id, repo, values } = programArgs(rest, CONVERSATION_USAGE, {
      list: { type: "boolean" },
      keep: { type: "string" },
      summary: { type: "string" },
      session: { type: "string" },
      project: { type: "string" },
    });
    const keep = optional(values, "keep");
    const summary = optional(values, "summary");
    const session = optional(values, "session");
    const project = optional(values, "project");
    if (values.list === true && (keep !== undefined || summary !== undefined)) {
      throw new UsageError("--list shows the messages; it keeps nothing", CONVERSATION_USAGE);
    }
    return planConversation(environment, {
      id,
      ...(repo === undefined ? {} : { repo }),
      ...(project === undefined ? {} : { project }),
      ...(keep === undefined ? {} : { keep }),
      ...(summary === undefined ? {} : { summary }),
      ...(session === undefined ? {} : { session }),
    });
  }
  if (
    subcommand !== "put" &&
    subcommand !== "show" &&
    subcommand !== "check" &&
    subcommand !== "ratify"
  ) {
    throw new UsageError(
      subcommand === undefined
        ? "`nightshift plan` needs a subcommand"
        : `unknown subcommand \`plan ${subcommand}\``,
      usage,
    );
  }
  const flags: Record<string, { type: "boolean" | "string" }> = { project: { type: "string" } };
  if (subcommand !== "ratify") flags.dir = { type: "string" };
  if (subcommand === "put") flags["based-on"] = { type: "string" };
  if (subcommand === "show") flags.version = { type: "string" };
  const { id, repo, values } = programArgs(rest, usage, flags);
  const project = optional(values, "project");
  const dir = optional(values, "dir");
  const version = versionNumber("version", optional(values, "version"), usage);
  const basedOn = versionNumber("based-on", optional(values, "based-on"), usage);
  const options = {
    id,
    ...(repo === undefined ? {} : { repo }),
    ...(project === undefined ? {} : { project }),
    ...(dir === undefined ? {} : { dir }),
    ...(version === undefined ? {} : { version }),
    ...(basedOn === undefined ? {} : { basedOn }),
  };
  switch (subcommand) {
    case "put":
      return planPut(environment, options);
    case "show":
      return planShow(environment, options);
    case "check":
      return planCheck(environment, options);
    default:
      return planRatify(environment, options);
  }
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

const GATES_USAGE =
  "nightshift gates <program> [--record [--findings <file>] | --recorded] [--landings <n>] [--json] [--repo <path>]";

const doGates = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const { id, repo, values } = programArgs(args, GATES_USAGE, {
    record: { type: "boolean" },
    findings: { type: "string" },
    recorded: { type: "boolean" },
    landings: { type: "string" },
    json: { type: "boolean" },
  });
  const findings = optional(values, "findings");
  const landingsGiven = optional(values, "landings");
  const landings = landingsGiven === undefined ? undefined : Number.parseInt(landingsGiven, 10);
  if (landings !== undefined && (!Number.isInteger(landings) || landings < 1)) {
    throw new UsageError("--landings takes a whole number of landings, 1 or more", GATES_USAGE);
  }
  const where = { id, ...(repo === undefined ? {} : { repo }) };
  if (values.record === true && values.recorded === true) {
    throw new UsageError(
      "--record writes the record and --recorded reads it: pick one",
      GATES_USAGE,
    );
  }
  if (findings !== undefined && values.record !== true) {
    throw new UsageError("--findings is the audit `--record` writes; add --record", GATES_USAGE);
  }
  if (values.record === true) {
    return recordGates(environment, { ...where, ...(findings === undefined ? {} : { findings }) });
  }
  if (values.recorded === true) return recordedGates(environment, where);
  return (
    await gates(environment, {
      ...where,
      ...(landings === undefined ? {} : { landings }),
      ...(values.json === true ? { json: true } : {}),
    })
  ).exitCode;
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
  const usage =
    "nightshift report <program> [--run <id>] [--json [--role <r>] [--model <m>] [--since <iso>] [--until <iso>]] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: {
        run: { type: "string" },
        repo: { type: "string" },
        json: { type: "boolean" },
        role: { type: "string" },
        model: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [id] = positionals;
  if (id === undefined) throw new UsageError("`nightshift report` needs a program", usage);
  const run = optional(values, "run");
  const repo = optional(values, "repo");
  const role = optional(values, "role");
  const model = optional(values, "model");
  const since = optional(values, "since");
  const until = optional(values, "until");
  for (const [flag, value] of [
    ["--since", since],
    ["--until", until],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new UsageError(`${flag} takes an ISO timestamp, not \`${value}\``, usage);
    }
  }
  const json = values.json === true;
  const filters = {
    ...(role === undefined ? {} : { role }),
    ...(model === undefined ? {} : { model }),
    ...(since === undefined ? {} : { from: since }),
    ...(until === undefined ? {} : { to: until }),
  };
  if (!json && Object.keys(filters).length > 0) {
    throw new UsageError(
      "--role, --model, --since and --until narrow the export: add --json",
      usage,
    );
  }
  return writeRunReport(environment, {
    id,
    ...(run === undefined ? {} : { run }),
    ...(repo === undefined ? {} : { repo }),
    ...(json ? { json, filters } : {}),
  });
};

const doRate = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage = "nightshift rate <program> up|down|clear [--run <id>] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { run: { type: "string" }, repo: { type: "string" } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [id, action, ...extra] = positionals;
  if (id === undefined) throw new UsageError("`nightshift rate` needs a program", usage);
  if (action !== "up" && action !== "down" && action !== "clear") {
    throw new UsageError("`nightshift rate <program>` takes `up`, `down` or `clear`", usage);
  }
  if (extra.length > 0) throw new UsageError(`unexpected argument \`${extra[0]}\``, usage);
  const run = optional(values, "run");
  const repo = optional(values, "repo");
  return rateRun(environment, {
    id,
    action,
    ...(run === undefined ? {} : { run }),
    ...(repo === undefined ? {} : { repo }),
  });
};

const COMPLETION_USAGE =
  "nightshift completion create <program> --title <t> [--run <id>]\n" +
  "nightshift completion list <program>\n" +
  "nightshift completion show|suggest <program> --history <id>\n" +
  "nightshift completion add <program> --history <id> --member <programId>/<runId> [--role contributing|correction]\n" +
  "nightshift completion remove <program> --history <id> --member <programId>/<runId>\n" +
  "nightshift completion checkpoint <program> --history <id> --name <n> --member <programId>/<runId>";

/** The options each verb takes; `--repo` belongs to all of them. */
const COMPLETION_FLAGS: Readonly<Record<CompletionVerb, readonly string[]>> = {
  create: ["title", "run"],
  list: [],
  show: ["history"],
  suggest: ["history"],
  add: ["history", "member", "role"],
  remove: ["history", "member"],
  checkpoint: ["history", "member", "name"],
};

const doCompletion = async (
  environment: CliEnvironment,
  args: readonly string[],
): Promise<number> => {
  const { values, positionals } = parse(
    {
      args: [...args],
      options: {
        title: { type: "string" },
        run: { type: "string" },
        history: { type: "string" },
        member: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        repo: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    },
    COMPLETION_USAGE,
  );
  const [verb, id, ...extra] = positionals;
  if (verb === undefined || !Object.hasOwn(COMPLETION_FLAGS, verb)) {
    throw new UsageError(
      "`nightshift completion` takes create, list, show, suggest, add, remove or checkpoint",
      COMPLETION_USAGE,
    );
  }
  const known = verb as CompletionVerb;
  if (id === undefined) {
    throw new UsageError(`\`nightshift completion ${known}\` needs a program`, COMPLETION_USAGE);
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument \`${extra[0]}\``, COMPLETION_USAGE);
  }
  for (const flag of Object.keys(values)) {
    if (flag !== "repo" && !(COMPLETION_FLAGS[known] as readonly string[]).includes(flag)) {
      throw new UsageError(`\`completion ${known}\` does not take --${flag}`, COMPLETION_USAGE);
    }
  }
  const role = optional(values, "role");
  if (role !== undefined && role !== "contributing" && role !== "correction") {
    throw new UsageError("--role must be `contributing` or `correction`", COMPLETION_USAGE);
  }
  const needs = (flag: string): string => required(values, flag, COMPLETION_USAGE);
  const pick = (flag: string): Record<string, string> => {
    const value = optional(values, flag);
    return value === undefined ? {} : { [flag]: value };
  };
  if (known === "create") needs("title");
  if (known === "add" || known === "remove" || known === "checkpoint") needs("member");
  if (known === "checkpoint") needs("name");
  if (known !== "create" && known !== "list") needs("history");
  return completion(environment, {
    verb: known,
    id,
    ...pick("repo"),
    ...pick("run"),
    ...pick("title"),
    ...pick("history"),
    ...pick("member"),
    ...pick("name"),
    ...(role === undefined ? {} : { role }),
  });
};

const doOrg = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage =
    "nightshift org config get|set <file> | org github install [--installation <id>]|remove --installation <id>|status | org providers set <provider> [--file <path>]|status  [--org <id>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: {
        org: { type: "string" },
        installation: { type: "string" },
        file: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [noun, verb, third] = positionals;
  const org = optional(values, "org");
  if (noun === "config") {
    if (verb === "get") return getOrgConfig(environment, org);
    if (verb === "set" && third !== undefined) return setOrgConfig(environment, third, org);
    throw new UsageError("`nightshift org config` takes `get` or `set <file>`", usage);
  }
  // P10 (D-P10-02, D-P10-23): the customer's two onboarding verbs.
  if (noun === "github") {
    const installation = optional(values, "installation");
    if (verb === "install") {
      return githubInstall(environment, {
        ...(installation === undefined ? {} : { installation }),
        ...(org === undefined ? {} : { org }),
      });
    }
    if (verb === "remove") {
      return githubRemove(environment, {
        ...(installation === undefined ? {} : { installation }),
        ...(org === undefined ? {} : { org }),
      });
    }
    if (verb === "status") return githubStatus(environment, org);
    throw new UsageError("`nightshift org github` takes `install`, `remove` or `status`", usage);
  }
  if (noun === "providers") {
    if (verb === "set" && third !== undefined) {
      return providersSet(environment, third, org, optional(values, "file"));
    }
    if (verb === "status") return providersStatus(environment, org);
    throw new UsageError("`nightshift org providers` takes `set <provider>` or `status`", usage);
  }
  throw new UsageError("`nightshift org` takes `config`, `github` or `providers`", usage);
};

/** `nightshift secret set|list|rm` (A-62): a project's secrets. */
const doSecret = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage =
    "nightshift secret set <NAME> | secret list | secret rm <NAME>  [--project <id>] [--repo <path>]";
  const { values, positionals } = parse(
    {
      args: [...args],
      options: { project: { type: "string" }, repo: { type: "string" } },
      allowPositionals: true,
      strict: true,
    },
    usage,
  );
  const [verb, name] = positionals;
  const project = optional(values, "project");
  const repo = optional(values, "repo");
  const options = {
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
  };
  if (verb === "set" && name !== undefined) return secretSet(environment, name, options);
  if (verb === "list") return secretList(environment, options);
  if (verb === "rm" && name !== undefined) return secretRemove(environment, name, options);
  throw new UsageError("`nightshift secret` takes `set <NAME>`, `list` or `rm <NAME>`", usage);
};

/** `nightshift remote status|cancel|resume <program>` (P10, D-P10-18). */
const doRemote = async (environment: CliEnvironment, args: readonly string[]): Promise<number> => {
  const usage =
    "nightshift remote status <program> [--watch] [--run <id>] [--repo <path>]\n" +
    "nightshift remote cancel|resume <program> [--run <id>] [--repo <path>]";
  const [verb, ...rest] = args;
  if (verb !== "status" && verb !== "cancel" && verb !== "resume") {
    throw new UsageError("`nightshift remote` takes `status`, `cancel` or `resume`", usage);
  }
  const { id, repo, values } = programArgs(rest, usage, {
    run: { type: "string" },
    watch: { type: "boolean" },
  });
  const runId = optional(values, "run");
  if (values.watch === true && verb !== "status") {
    throw new UsageError("--watch is for `nightshift remote status`", usage);
  }
  const options = {
    id,
    ...(repo === undefined ? {} : { repo }),
    ...(runId === undefined ? {} : { run: runId }),
    ...(values.watch === true ? { watch: true } : {}),
  };
  if (verb === "status") return remoteStatus(environment, options);
  if (verb === "cancel") return remoteCancel(environment, options);
  return remoteResume(environment, options);
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
    case "gates":
      return doGates(environment, args);
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
    case "rate":
      return doRate(environment, args);
    case "completion":
      return doCompletion(environment, args);
    case "org":
      return doOrg(environment, args);
    case "secret":
      return doSecret(environment, args);
    case "remote":
      return doRemote(environment, args);
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
