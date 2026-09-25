/**
 * The command line, the MCP configuration file, the settings file, and the
 * Claude-specific half of the worker brief.
 *
 * ## THE COMMAND LINE — verified against Claude Code 2.1.273
 *
 * The P3 contract was written against 2.1.272; the installed CLI on the
 * operator's machine on 2026-09-15 is **2.1.273**, and every flag below was
 * checked against that release's `claude --help` and then exercised for real.
 * **This block is what a future upgrade diffs against.** If a flag disappears or
 * changes meaning, the adapter fails loudly at launch rather than silently
 * dropping a constraint, and the fix belongs here.
 *
 * ```text
 * claude
 *   -p <brief>                          the rendered worker brief, positional
 *   --output-format stream-json         the structured event stream (§4.7 rests on it)
 *   --verbose                           mandatory: "--output-format=stream-json requires --verbose"
 *   --model <model>                     RouteTarget.model, passed through unchanged
 *   --mcp-config <file>                 the worker's Nightshift MCP server
 *   --strict-mcp-config                 ignore every other MCP configuration on the machine
 *   --settings <file>                   Nightshift's own settings; see below
 *   --setting-sources ""                load no user, project or local settings
 *   --permission-mode bypassPermissions every tool, never a prompt (see `permissions.ts`)
 *   --disallowedTools <csv>             git writes, always (A-29)
 *   --no-session-persistence            nothing resumable is written to disk
 * ```
 *
 * Four things about that ordering and shape are load-bearing rather than taste:
 *
 * 1. **The brief comes immediately after `-p`, before every other flag.**
 *    `--disallowedTools` and `--mcp-config` are
 *    *variadic* (`<tools...>`) in this release, so a positional argument placed
 *    after one of them is swallowed as another value for it. `-p` is a boolean,
 *    so the brief lands where it belongs.
 * 2. **The list flag gets exactly one comma-separated value.** The help text
 *    allows comma or space separation; a deny pattern such as
 *    `Bash(git commit:*)` contains a space, and space separation would split it.
 * 3. **`--setting-sources ""`** is what stops the *operator's* `~/.claude`
 *    settings from reaching the worker. Without it a user-level hook or a
 *    user-level `permissions` block would change how a worker behaves from one
 *    operator's machine to the next.
 *    The worktree's own `CLAUDE.md` is still discovered, which is intended: that
 *    is the target repository's guidance to anyone working in it.
 * 4. **`--strict-mcp-config`** keeps the operator's other MCP servers out. A
 *    worker's entire Nightshift surface is the one server in `McpLaunch`, and a
 *    second server on the machine could hand it tools nobody authorised.
 *
 * Deliberately *not* passed, each for a reason:
 *
 * - `--tools` and `--allowedTools` — an allow-list is a guess at everything a
 *   worker will need, and the first miss is a denied tool with nobody there to
 *   fix it. The owner ruled them out on 2026-09-19 (`permissions.ts`).
 * - `--permission-prompts none` — nothing prompts in `bypassPermissions`.
 * - `--add-dir` — the worktree is the only directory a worker works in.
 * - `--include-partial-messages` — the complete assistant message always
 *   follows, and partial frames would multiply the stream for no event.
 * - `--include-hook-events` — it surfaces *configured* hooks' lifecycle frames;
 *   with no hook configured (see `stream.ts`) it adds nothing.
 * - `--max-budget-usd` — cost policy lives on the Program Contract and is the
 *   execution layer's to enforce, not a flag this adapter invents.
 * - `--resume` / `--continue` / `--fork-session` — a job is one run.
 * - `--bare` / `--safe-mode` / `--restricted` — each changes authentication or
 *   the tool set in ways that would silently contradict the policy above.
 */
import type { RouteTarget } from "@nightshift/contracts";
import { type McpLaunch, nightshiftToolNames } from "@nightshift/harness";
import { type ClaudeToolPolicy, claudeMcpToolName } from "./permissions.js";

/**
 * The Claude Code version this module's flags were verified against.
 *
 * Recorded rather than checked at runtime: the adapter must not refuse to launch
 * because the operator upgraded, but a human reading a failure wants to know
 * which release the flags were written for.
 */
export const VERIFIED_CLAUDE_VERSION = "2.1.273";

/** The executable. Resolved from `PATH`, so an operator's install location is theirs. */
export const CLAUDE_COMMAND = "claude";

/** How a list flag's value is joined. See the module comment, point 2. */
const list = (values: readonly string[]): string => values.join(",");

export interface ClaudeCommandInput {
  /** The full prompt: T1's brief plus {@link claudeBriefAddendum}. */
  readonly prompt: string;
  readonly model: RouteTarget;
  /** Absolute path to the `--mcp-config` file this adapter wrote. */
  readonly mcpConfigPath: string;
  /** Absolute path to the `--settings` file this adapter wrote. */
  readonly settingsPath: string;
  readonly policy: ClaudeToolPolicy;
}

/**
 * The argv for one worker run, in the order documented above.
 *
 * Pure: it writes no file and reads no environment, so a test can assert the
 * whole command line against a fake spawn without a filesystem.
 */
export const buildClaudeArgs = (input: ClaudeCommandInput): readonly string[] => [
  // The brief first, because every list flag below is variadic.
  "-p",
  input.prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  input.model.model,
  // P8: a rung may name a reasoning effort; absent, Claude's own default applies.
  ...(input.model.effort === undefined ? [] : ["--effort", input.model.effort]),
  "--mcp-config",
  input.mcpConfigPath,
  "--strict-mcp-config",
  "--settings",
  input.settingsPath,
  "--setting-sources",
  "",
  // Every tool, never a prompt, and no list of what a worker might need
  // (`permissions.ts`). The denials are the git write guard and nothing else.
  "--permission-mode",
  input.policy.permissionMode,
  "--disallowedTools",
  list(input.policy.denied),
  "--no-session-persistence",
];

/**
 * The `--mcp-config` file's contents.
 *
 * `McpLaunch` is passed through **unchanged** — no entry added, removed or
 * rewritten. The identity a worker carries is fixed by the party that spawned
 * it, and that is the whole of D-P3-01; an adapter that edited this block would
 * be the one place a worker's identity could drift.
 */
export const buildMcpConfig = (mcp: McpLaunch): string =>
  `${JSON.stringify(
    {
      mcpServers: {
        [mcp.name]: {
          command: mcp.command,
          args: [...mcp.args],
          env: { ...mcp.env },
        },
      },
    },
    null,
    2,
  )}\n`;

/**
 * The `--settings` file's contents.
 *
 * Empty of hooks on purpose. Every event §4.7 asks of this adapter is available
 * from the structured output stream in 2.1.273 (the reasoning, frame by frame,
 * is in `stream.ts`), so there is no hook log to tail and nothing here has to
 * cooperate with the worker.
 *
 * The file is still written, and still passed, because `--setting-sources ""`
 * leaves the CLI with no settings at all and this is the one place Nightshift
 * can state a worker-wide setting. `includeCoAuthoredBy: false` is the only
 * entry: it is the setting that would otherwise add a co-author trailer to a
 * commit, and Nightshift authors every commit itself with its own trailers
 * (A-29), so a worker must not be carrying a commit convention at all.
 *
 * Keeping the file (rather than dropping the flag) also means that when a future
 * release moves an event out of the stream, the mechanism the contract asks for
 * — a configured hook whose log the adapter tails — is one object away.
 */
export const buildSettings = (): string =>
  `${JSON.stringify({ includeCoAuthoredBy: false, hooks: {} }, null, 2)}\n`;

/**
 * What this adapter adds to T1's provider-neutral brief.
 *
 * Only genuinely Claude-specific facts belong here: how the Nightshift tools are
 * *named* to this model, and the two consequences of the tool policy that a
 * model would otherwise waste turns rediscovering. Everything about what the job
 * is, what may be touched, and that Nightshift collects the work, is T1's and
 * is not repeated.
 */
export const claudeBriefAddendum = (input: {
  readonly mcpServerName: string;
  /** The node's Nightshift tools, from `nightshiftToolNames`. A worker's by default. */
  readonly tools?: readonly string[];
}): string => {
  const tools = input.tools ?? nightshiftToolNames("job");
  const name = (tool: string): string => claudeMcpToolName(input.mcpServerName, tool);
  const lines = [
    "HOW THE NIGHTSHIFT TOOLS ARE NAMED TO YOU",
    "",
    "  The tools described above reach you through MCP, so they are prefixed and",
    "  their dots become underscores:",
    ...tools.map((tool) => `    ${tool.padEnd(22)} -> ${name(tool)}`),
    "",
    "  They are always available to you, whatever else your scope granted.",
    "",
    "YOUR TOOLS",
    "",
    "  You have every tool your environment offers, and nothing will ask for",
    "  approval: nobody is watching, so nothing is ever escalated.",
    "",
    "  The one exception: every git command that writes state is denied at the",
    "  point of use. Do not spend a turn trying one or working around it.",
    "  Nightshift is the one that commits your work, from whatever is in your",
    "  working directory when you report completion.",
  ];
  return lines.join("\n");
};

/** The full prompt: T1's brief, then the Claude-specific addendum. */
export const claudePrompt = (briefText: string, addendum: string): string =>
  `${briefText.trimEnd()}\n\n${addendum}\n`;
