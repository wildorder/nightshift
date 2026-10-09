/**
 * How a Claude Code worker is permitted (owner's decision, 2026-09-19; A-29).
 *
 * **A worker runs in `bypassPermissions`, with every tool Claude Code has.**
 * There is no `--tools` list and no `--allowedTools` list. An allow-list is a
 * guess, made in advance, at everything a worker will need; the first tool it
 * misses is denied under `--print`, the worker burns turns or fails, and nobody
 * is there to fix the list. Earlier iterations of Nightshift learned this the
 * hard way, and P3 rebuilt it anyway. It is gone.
 *
 * What bounds a worker is therefore **not** the harness:
 *
 * - Nightshift owns every commit (A-29). `job.complete` snapshots the worktree
 *   onto the base, so nothing a worker commits becomes history, and nothing
 *   integrates until Nightshift has verified it.
 * - The worker's only Nightshift credential is an execution token good for its
 *   four operations on its own node (A-35).
 * - Its environment is an allowlist (`environment.ts`).
 *
 * A worker is given no permission list and no path scope (the owner's ruling,
 * 2026-10-09): its reach is the environment it runs in. A worker's effects
 * outside its worktree are not contained by Nightshift at all; that is the
 * operator's machine's business, or the remote runner's machine (P10).
 *
 * ## The one list that remains, and why it is not the same thing
 *
 * `--disallowedTools` still carries the git write denials. A deny-list cannot
 * starve a worker of a tool it needs: it names the one family of commands that
 * is never a worker's to run. Verified on 2.1.273 that it holds in
 * `bypassPermissions`: `git add -A` came back denied and listed under
 * `permission_denials`, while an MCP tool, a shell write and the `Write` tool
 * all ran with no list naming any of them. It is a guard at the point of use;
 * the enforcement is A-29.
 *
 * The list flag takes a comma-separated value, because a pattern like
 * `Bash(git commit:*)` contains a space.
 */

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

/** What the adapter passes to Claude Code. The same for every worker. */
export interface ClaudeToolPolicy {
  /** Value for `--permission-mode`. Always the same; see the module comment. */
  readonly permissionMode: "bypassPermissions";
  /** Value for `--disallowedTools`: the git write denials, unconditionally. */
  readonly denied: readonly string[];
}

export const claudeToolPolicy = (): ClaudeToolPolicy => ({
  permissionMode: "bypassPermissions",
  denied: gitWriteDenials(),
});

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
