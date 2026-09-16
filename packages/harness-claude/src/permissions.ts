/**
 * Nightshift's worker permission vocabulary, expressed as Claude Code tool
 * policy (D-P3-15, A-29).
 *
 * `Scope.permissions` names three things — `fs.read`, `fs.write`, `shell.exec` —
 * and this module is the only place in Nightshift that knows what those mean to
 * Claude Code. Three properties hold, and the tests enumerate all eight subsets
 * of the vocabulary to prove them:
 *
 * 1. **An unknown permission grants nothing.** `grantedPermissions` from
 *    `@nightshift/core` returns only the three it recognises, and everything in
 *    this module is derived from that list, so a scope carrying
 *    `"kubernetes.apply"` yields exactly the tools its known permissions grant.
 *    `unknownPermissions` is reported on `agent.started` so the gap is visible
 *    rather than silent.
 * 2. **Git writes are never granted**, whatever the scope says. Nightshift owns
 *    every commit (A-29): `job.complete` snapshots the worktree into one
 *    Nightshift-authored commit, and a worker that could `git commit` would
 *    author history Nightshift did not. The denial list below is applied
 *    unconditionally — it is not conditional on `shell.exec`, because a deny
 *    that only exists when the shell is granted is a deny somebody will one day
 *    forget to re-add.
 * 3. **No human resolves a prompt.** `--permission-prompts none` means anything
 *    that would prompt is denied automatically. Combined with an explicit
 *    `--allowedTools`, the effect is: the policy pre-approves what the scope
 *    granted, and anything else is denied rather than escalated.
 *
 * ## Verified behaviour, Claude Code 2.1.273
 *
 * Observed on the installed CLI while writing this module, not inferred:
 *
 * - `--tools ""` disables every built-in tool **but leaves the MCP tools from
 *   `--mcp-config` in place**. That is what makes a zero-permission worker
 *   coherent: it can still call `job.complete` / `job.fail`, which is the only
 *   way any job ends well.
 * - `--disallowedTools "Bash(git commit:*),Bash(git add:*)"` denies at the point
 *   of use: `git status --short` ran, `git commit --allow-empty -m probe` came
 *   back as `is_error: true` with the text "Permission to use Bash with command
 *   … has been denied", and the run's final `result` frame listed it under
 *   `permission_denials`. The run still completed; the denial is not fatal.
 * - The list flags accept a comma-separated value. Comma, not space, is what
 *   this module emits, because a pattern like `Bash(git commit:*)` contains a
 *   space and a space-separated list would split it in half.
 * - `--permission-mode manual` is reported back on the `system`/`init` frame as
 *   `permissionMode: "default"`; they are the same mode under two names.
 */
import type { Scope } from "@nightshift/contracts";
import {
  grantedPermissions,
  PERMISSION_FS_READ,
  PERMISSION_FS_WRITE,
  PERMISSION_SHELL_EXEC,
  unknownPermissions,
  type WorkerPermission,
} from "@nightshift/core";

/**
 * Built-in tools that only read. `Read`, `Glob` and `Grep` are the whole
 * read-only surface of Claude Code 2.1.273; `WebFetch` and `WebSearch` are
 * excluded on purpose, since reading the repository is what `fs.read` names and
 * reaching the network is not.
 */
export const READ_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

/**
 * The sub-agent tool, granted alongside `fs.read`.
 *
 * Claude Code declares it as `Task` in `--tools` and reports the resulting call
 * as a `tool_use` named `Agent`; both spellings are handled in `stream.ts`. It
 * is tied to `fs.read` rather than given its own permission because a sub-agent
 * is an exploration device and because it draws from the same session tool
 * policy — the recorded run's sub-agent used `Read`, which was in `--tools`, and
 * `--permission-prompts none` applies session-wide. **The residual assumption is
 * stated so it can be re-checked**: if a future release let a sub-agent hold a
 * tool the parent session was not granted, this grant would widen authority and
 * would have to go. A worker with no permissions at all gets no sub-agent.
 */
export const SUBAGENT_TOOLS: readonly string[] = ["Task"];

/** Built-in tools that modify files. */
export const WRITE_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit"];

/**
 * The shell, and the two tools that read back and stop a shell the worker
 * already started. Without `BashOutput` and `KillShell` a backgrounded command
 * is unreadable and unstoppable, which is worse than not having the shell.
 */
export const SHELL_TOOLS: readonly string[] = ["Bash", "BashOutput", "KillShell"];

/**
 * The planning scratchpad, granted alongside `fs.read`.
 *
 * `TodoWrite` touches nothing outside the model's own turn, and a worker without
 * it plans a long job markedly worse. It is *not* granted unconditionally: a
 * scope that grants no permission at all gets `--tools ""` and therefore no
 * built-in tool whatsoever, which is the state the CLI was verified in and the
 * only honest reading of "an unknown permission grants nothing".
 */
export const PLANNING_TOOLS: readonly string[] = ["TodoWrite"];

/**
 * Git subcommands a worker may never run (A-29).
 *
 * Every one of these writes git state: the object database, the index, a ref,
 * the worktree, or the configuration that decides where those go. Read-only
 * plumbing — `git status`, `git diff`, `git log`, `git show`, `git ls-files` —
 * is deliberately absent, because a worker that cannot see what it changed
 * writes worse summaries and Nightshift is the one doing the committing anyway.
 *
 * Expressed as Claude Code prefix patterns: `Bash(<prefix>:*)` matches any
 * command beginning with `<prefix>`.
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
  "config",
  "fetch",
  "filter-branch",
  "gc",
  "init",
  "merge",
  "mv",
  "notes",
  "prune",
  "pull",
  "push",
  "rebase",
  "reflog",
  "remote",
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
];

/** The `--disallowedTools` patterns that keep git write commands out of the shell. */
export const gitWriteDenials = (): readonly string[] =>
  FORBIDDEN_GIT_SUBCOMMANDS.map((subcommand) => `Bash(git ${subcommand}:*)`);

/**
 * How a scope's permissions become Claude Code flags.
 *
 * `tools` is the built-in set the session may use at all; `allowed` is what is
 * pre-approved so it never prompts; `denied` wins over both. `mcpToolPrefix`
 * appears in `allowed` so the worker's own Nightshift tools — `job.complete`,
 * `job.fail` and the rest — are always callable, which is the one thing a
 * worker must be able to do regardless of what its scope granted.
 */
export interface ClaudeToolPolicy {
  /** Value for `--tools`. Empty string means "no built-in tools at all". */
  readonly tools: readonly string[];
  /** Value for `--allowedTools`. */
  readonly allowed: readonly string[];
  /** Value for `--disallowedTools`. */
  readonly denied: readonly string[];
  /** Value for `--permission-mode`. */
  readonly permissionMode: "manual" | "acceptEdits";
  /** The permissions this policy was derived from, in vocabulary order. */
  readonly granted: readonly WorkerPermission[];
  /** Permissions on the scope that Nightshift does not understand. None are granted. */
  readonly unknown: readonly string[];
}

export interface ClaudeToolPolicyInput {
  readonly scope: Scope;
  /**
   * The MCP server name from `McpLaunch.name`. Claude Code exposes that
   * server's tools as `mcp__<name>__<tool>`, and allowing the `mcp__<name>`
   * prefix pre-approves all of them.
   */
  readonly mcpServerName: string;
}

/**
 * Derive the Claude Code tool policy for a scope.
 *
 * Deterministic and order-stable: the same scope always produces the same
 * flags, so a recorded command line is a diffable artefact.
 */
export const claudeToolPolicy = (input: ClaudeToolPolicyInput): ClaudeToolPolicy => {
  const granted = grantedPermissions(input.scope);
  const has = (permission: WorkerPermission): boolean => granted.includes(permission);

  const tools: string[] = [];
  if (has(PERMISSION_FS_READ)) tools.push(...READ_TOOLS, ...PLANNING_TOOLS, ...SUBAGENT_TOOLS);
  if (has(PERMISSION_FS_WRITE)) tools.push(...WRITE_TOOLS);
  if (has(PERMISSION_SHELL_EXEC)) tools.push(...SHELL_TOOLS);

  return {
    tools,
    // The built-in set is already narrowed by `--tools`; pre-approving exactly
    // that set is what stops a prompt (and therefore an automatic denial, under
    // `--permission-prompts none`) on a tool the scope did grant.
    allowed: [...tools, `mcp__${input.mcpServerName}`],
    denied: gitWriteDenials(),
    // `acceptEdits` only matters when an edit tool exists to accept; with no
    // `fs.write` there is nothing for it to auto-approve, and `manual` is the
    // narrower of the two, so it is what an unprivileged worker gets.
    permissionMode: has(PERMISSION_FS_WRITE) ? "acceptEdits" : "manual",
    granted,
    unknown: unknownPermissions(input.scope),
  };
};

/**
 * How a Nightshift MCP tool is named to the model.
 *
 * Claude Code prefixes the server name and replaces every character outside
 * `[A-Za-z0-9_-]` with `_`, so the worker role's `job.complete` reaches the
 * model as `mcp__nightshift__job_complete`. Verified against the installed
 * 2.1.273 by recording a run against a stdio server that registered exactly the
 * worker tool names.
 */
export const claudeMcpToolName = (serverName: string, toolName: string): string =>
  `mcp__${serverName}__${toolName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
