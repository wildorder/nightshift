/**
 * The `codex exec` command line (P5, T3, D-P5-02).
 *
 * ## THE EXACT COMMAND LINE
 *
 * Every flag below was checked against the installed CLI's `codex exec --help`
 * and then against a real run. **Verified on 0.154.0** (the task was written
 * against 0.149.0; the machine had moved on, and every flag still stands):
 *
 * ```text
 * codex exec --json
 *   -C <worktree>
 *   --sandbox workspace-write            (read-only when fs.write is not granted)
 *   -c approval_policy="never"
 *   -c allow_login_shell=false
 *   -c shell_environment_policy.set={"PATH" = "<guard dir>:<PATH>"}
 *   -c mcp_servers.<name>.command="…"
 *   -c mcp_servers.<name>.args=["…"]
 *   -c mcp_servers.<name>.env={…}
 *   -c mcp_servers.<name>.default_tools_approval_mode="approve"
 *   --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
 *   -m <model>
 *   <brief>
 * ```
 *
 * ## What each one is for, and what was measured
 *
 * - `--json`: newline-delimited events on stdout (`stream.ts`).
 * - `approval_policy="never"`: nothing is ever escalated to a human who is not
 *   there, and no model decides an approval either. **`--approve-for-me` is not
 *   used** (D-P5-02): it routes approvals through an automatic reviewer, which is
 *   a second model making authority decisions Nightshift did not make.
 * - `default_tools_approval_mode="approve"`, **on the Nightshift server only**.
 *   Measured, and not in the task spec: with `approval_policy="never"` alone,
 *   every MCP tool call fails with "MCP tool call requires approval, but approval
 *   policy is never", so a worker could neither report progress nor finish.
 *   Pre-approving the one server Nightshift itself supplies is the same decision
 *   the Claude adapter makes with `--allowedTools mcp__nightshift__*`, made ahead
 *   of time by Nightshift rather than at run time by anything.
 * - `allow_login_shell=false`: Codex otherwise runs commands as `zsh -lc`, and a
 *   login shell rebuilds `PATH` from the operator's profile, which would put the
 *   real `git` back in front of the guard below.
 * - `--ignore-user-config` and `--ignore-rules`: the operator's `config.toml`
 *   and execpolicy rules are theirs, for their own sessions. A worker's
 *   behaviour must not vary with them. Authentication still uses `CODEX_HOME`.
 * - `--ephemeral`: no session files. The transcript Nightshift keeps is the
 *   stream itself.
 * - `--skip-git-repo-check`: a job worktree's `.git` is a file, not a directory.
 *
 * ## THE GIT GUARD
 *
 * Measured on 0.154.0: `workspace-write` **does not stop `git commit` in a job
 * worktree** — the commit succeeded, exit 0. Codex has no per-command deny list
 * that can be supplied on the command line, so the adapter puts a small `git`
 * script first on the `PATH` **of the commands the model runs** that refuses
 * every subcommand that writes state and hands the rest to the real `git`
 * (rule 5, D-P3-15).
 *
 * `shell_environment_policy.set`, not the Codex process's own `PATH`, and the
 * first real worker is why: the worker's Nightshift MCP server is a child of
 * Codex, it inherits Codex's environment, and `job.complete` is where Nightshift
 * itself runs `git add` to collect the work. A guard on the process's `PATH`
 * refused Nightshift its own commit. The policy applies to model-run commands
 * and to nothing else, which is exactly the boundary wanted.
 *
 * This is a guard at the point of use, exactly as strong as the Claude adapter's
 * `Bash(git commit:*)` denials and no stronger: a worker that ran `/usr/bin/git`
 * by its full path would get past either. **The enforcement is A-29**, which
 * does not depend on the worker's cooperation: `completeJob` snapshots the
 * worktree into one Nightshift-authored commit parented on the base, so anything
 * a worker committed is squashed away and never becomes history.
 */
import type { RouteTarget, Scope } from "@nightshift/contracts";
import { grantsPermission, type McpLaunch, PERMISSION_FS_WRITE } from "@nightshift/harness";

/** The CLI version every flag and every stream shape here was verified against. */
export const VERIFIED_CODEX_VERSION = "0.154.0";

export const CODEX_COMMAND = "codex";

export type CodexSandbox = "read-only" | "workspace-write";

/**
 * The sandbox for a scope. `fs.write` is what separates the two; Codex has no
 * way to withhold its shell, so a scope without `shell.exec` still has one,
 * bounded by the sandbox (a stated non-guarantee of D-P5-02: Codex's sandbox is
 * Codex's).
 */
export const codexSandboxFor = (scope: Scope): CodexSandbox =>
  grantsPermission(scope, PERMISSION_FS_WRITE) ? "workspace-write" : "read-only";

/**
 * A TOML basic string. JSON's escapes are a subset of TOML's for every character
 * `JSON.stringify` emits, so this is exact rather than approximate.
 */
export const tomlString = (value: string): string => JSON.stringify(value);

export const tomlArray = (values: readonly string[]): string =>
  `[${values.map(tomlString).join(", ")}]`;

/** An inline table with every key quoted, so no environment name needs checking. */
export const tomlInlineTable = (entries: Readonly<Record<string, string>>): string =>
  `{${Object.entries(entries)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(", ")}}`;

/** A server name as a dotted-key segment: bare when it can be, quoted otherwise. */
const keySegment = (name: string): string =>
  /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);

/**
 * The worker's MCP server, as `-c` overrides. `input.mcp` is passed through
 * unchanged: command, arguments, and the environment that carries the worker's
 * identity and its execution token.
 */
export const mcpOverrides = (mcp: McpLaunch): readonly string[] => {
  const prefix = `mcp_servers.${keySegment(mcp.name)}`;
  return [
    "-c",
    `${prefix}.command=${tomlString(mcp.command)}`,
    "-c",
    `${prefix}.args=${tomlArray(mcp.args)}`,
    "-c",
    `${prefix}.env=${tomlInlineTable(mcp.env)}`,
    "-c",
    `${prefix}.default_tools_approval_mode="approve"`,
  ];
};

export interface CodexCommandInput {
  readonly prompt: string;
  readonly model: RouteTarget;
  readonly worktree: string;
  readonly sandbox: CodexSandbox;
  readonly mcp: McpLaunch;
  /** The `PATH` for commands the model runs, with the git guard first. Absent on Windows. */
  readonly shellPath?: string | undefined;
}

export const buildCodexArgs = (input: CodexCommandInput): readonly string[] => [
  "exec",
  "--json",
  "-C",
  input.worktree,
  "--sandbox",
  input.sandbox,
  "-c",
  'approval_policy="never"',
  "-c",
  "allow_login_shell=false",
  ...(input.shellPath === undefined
    ? []
    : ["-c", `shell_environment_policy.set=${tomlInlineTable({ PATH: input.shellPath })}`]),
  ...mcpOverrides(input.mcp),
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "-m",
  input.model.model,
  // Last, and after every option, so a brief can never be read as one.
  input.prompt,
];

/**
 * Subcommands that write repository state. The same list the Claude adapter
 * denies, for the same reason: Nightshift owns every commit (A-29).
 */
export const FORBIDDEN_GIT_SUBCOMMANDS: readonly string[] = [
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "commit-tree",
  "config",
  "fetch",
  "filter-branch",
  "gc",
  "init",
  "merge",
  "mv",
  "notes",
  "pull",
  "push",
  "rebase",
  "remote",
  "replace",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "symbolic-ref",
  "tag",
  "update-index",
  "update-ref",
  "worktree",
  "write-tree",
];

/**
 * The `git` guard, as a POSIX shell script.
 *
 * It skips leading options to find the subcommand, refuses a forbidden one with
 * exit 126 and a sentence a model can act on, and `exec`s the real `git` for
 * everything else — `status`, `diff`, `log` and `show` are how a worker looks at
 * its own work. `-c` and `-C` take an argument, which is skipped with them.
 */
export const buildGitGuard = (realGit: string): string =>
  [
    "#!/bin/sh",
    "# Written by Nightshift for one worker. Nightshift owns every commit (A-29).",
    "skip=0",
    'for arg in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  case "$arg" in',
    "    -c|-C|--git-dir|--work-tree|--namespace) skip=1; continue ;;",
    "    -*) continue ;;",
    `    ${FORBIDDEN_GIT_SUBCOMMANDS.join("|")})`,
    '      echo "nightshift: git $arg is not available to a worker. Nightshift owns every commit: leave your changes in the worktree and call job.complete." >&2',
    "      exit 126 ;;",
    "    *) break ;;",
    "  esac",
    "done",
    `exec ${shellQuote(realGit)} "$@"`,
    "",
  ].join("\n");

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** What only a Codex worker needs to be told. The shared brief says the rest. */
export const codexBriefAddendum = (input: {
  readonly mcpServerName: string;
  readonly sandbox: CodexSandbox;
}): string =>
  [
    "HOW THE NIGHTSHIFT TOOLS REACH YOU",
    "",
    `  They are the tools of the MCP server named ${input.mcpServerName}: job.get, job.progress,`,
    "  job.complete, job.fail and decision.record. They are already approved; call",
    "  them directly. They are the only way to report anything, and replying in",
    "  prose does not finish the job.",
    "",
    "YOUR SANDBOX — already decided, not negotiable",
    "",
    input.sandbox === "workspace-write"
      ? "  You may read anywhere and write inside your working directory. Nothing will\n  be escalated for approval: nobody is watching, and a command the sandbox\n  refuses stays refused."
      : "  You may read, and you may not write. Nothing will be escalated for approval.",
    "",
    "  Every git command that writes state is refused. Do not spend a turn trying",
    "  one, or looking for a way around it: Nightshift is the one that commits your",
    "  work, from whatever is in your working directory when you call job.complete.",
  ].join("\n");

export const codexPrompt = (briefText: string, addendum: string): string =>
  `${briefText.trimEnd()}\n\n${addendum}\n`;
