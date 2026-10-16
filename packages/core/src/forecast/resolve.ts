/**
 * What a gate's command actually runs (P17, D-P17-04).
 *
 * A contract says `npm run test`; what runs is `scripts.test` in package.json,
 * its `pretest` hook, the shell script that calls, and the tool at the end of
 * the chain. The catalogue matches tool signatures against all of it, so the
 * resolver follows what it can and quotes the deepest line it reached. An
 * unresolved reference is reported as unresolved, never guessed.
 *
 * A shell script that does several things by its first argument
 * (`case "$MODE" in test) … ;; e2e) … ;; esac`) is read for the mode it was
 * called with: positional arguments are carried into the script, variables
 * assigned from them are known, and only the matching branch's lines count.
 * Otherwise keki-backend's one `scripts/test-docker.sh` made every gate look
 * like the Playwright run (2026-10-16).
 *
 * Pure: it reads files through the `read` it is given, nothing else.
 */

/** One line of the chain a command resolves to, and where it came from. */
export interface ResolvedLine {
  /** `contract`, `package.json → scripts.test`, `scripts/verify-db.sh:14`. */
  readonly source: string;
  readonly text: string;
}

export interface ResolvedCommand {
  readonly stepId: string;
  readonly command: string;
  readonly lines: readonly ResolvedLine[];
  /** Script names or paths the resolver could not follow. */
  readonly unresolved: readonly string[];
}

/** Reads a repository file at the audited commit; `undefined` when it is not there. */
export type ReadFile = (path: string) => Promise<string | undefined>;

/** How deep a chain is followed: a script that calls a script that calls a tool. */
const MAX_DEPTH = 4;

const SCRIPT_RUNNERS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:--[\w-]+(?:=\S+)?\s+|-[rw]\s+)*([\w:.-]+)/,
  /^(?:npx|pnpm\s+exec|pnpm\s+dlx|yarn\s+exec)\s+(\S+)/,
];
/** `npm test` and friends: a lifecycle script without `run`. */
const LIFECYCLE = new Set(["test", "start", "stop", "restart"]);

const SHELL_FILE =
  /(?:^|\s)(?:bash|sh|zsh|node|tsx|npx\s+tsx|python3?|uv\s+run)\s+(\S+\.(?:sh|bash|mjs|cjs|js|ts|py))((?:\s+\S+)*)/;

/** The commands of a shell text, split on lines and on `&&`, `||`, `;` and `|`. */
const commandsOf = (line: string): string[] =>
  line
    .split(/\s*(?:\r?\n|&&|\|\||;|\|)\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith("#"));

const scriptsOf = (packageJson: string | undefined): Record<string, string> => {
  if (packageJson === undefined) return {};
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

const unquote = (word: string): string => word.replace(/^["']|["']$/g, "");

/**
 * A shell word's value, when it is known: a literal, a positional argument
 * (`$1`, `${1:-}`), or a variable assigned from one. `undefined` when it is not.
 */
const shellValue = (
  word: string,
  args: readonly string[],
  vars: ReadonlyMap<string, string>,
): string | undefined => {
  const bare = unquote(word.trim());
  const positional = /^\$\{?(\d+)(?::-[^}]*)?\}?$/.exec(bare);
  if (positional !== null) return args[Number(positional[1]) - 1];
  const variable = /^\$\{?([A-Za-z_]\w*)(?::-[^}]*)?\}?$/.exec(bare);
  if (variable !== null) return vars.get(variable[1] ?? "");
  if (bare.includes("$")) return undefined;
  return bare;
};

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_]\w*)=(\S+)\s*$/;
const CASE_OPEN = /^case\s+(\S+)\s+in\s*$/;
const CASE_BRANCH = /^([^()]+)\)\s*(.*)$/;

/**
 * The lines of a shell script that run for `args`: everything outside a
 * `case`, and inside one only the branch its subject selects when the subject
 * is known (every branch when it is not). Each with its line number, and the
 * variables assigned on the way, for the commands the script runs in turn.
 */
export const activeLines = (
  content: string,
  args: readonly string[],
): {
  readonly lines: { readonly number: number; readonly text: string }[];
  readonly vars: Map<string, string>;
} => {
  const vars = new Map<string, string>();
  const lines: { number: number; text: string }[] = [];
  // Each open `case`: its subject when known (`undefined`: every branch runs),
  // whether the current branch is active, and whether a branch has matched
  // already, since the first match wins and `*` is only the default.
  const cases: { subject: string | undefined; active: boolean; matched: boolean }[] = [];
  const running = (): boolean => cases.every((level) => level.active);
  content.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) return;
    const opening = CASE_OPEN.exec(text);
    if (opening !== null) {
      cases.push({
        subject: running() ? shellValue(opening[1] ?? "", args, vars) : undefined,
        active: false,
        matched: false,
      });
      return;
    }
    if (text === "esac") {
      cases.pop();
      return;
    }
    const level = cases.at(-1);
    if (level !== undefined) {
      if (text === ";;") {
        level.active = false;
        return;
      }
      const branch = CASE_BRANCH.exec(text);
      if (branch !== null && !text.startsWith("(")) {
        const patterns = (branch[1] ?? "").split("|").map((pattern) => unquote(pattern.trim()));
        level.active =
          level.subject === undefined ||
          (!level.matched &&
            patterns.some((pattern) => pattern === "*" || pattern === level.subject));
        if (level.active && level.subject !== undefined) level.matched = true;
        const rest = (branch[2] ?? "").replace(/;;\s*$/, "").trim();
        if (rest !== "" && running()) lines.push({ number: index + 1, text: rest });
        if (/;;\s*$/.test(text)) level.active = false;
        return;
      }
    }
    if (!running()) return;
    const assignment = ASSIGNMENT.exec(text);
    if (assignment !== null) {
      const value = shellValue(assignment[2] ?? "", args, vars);
      if (value !== undefined) vars.set(assignment[1] ?? "", value);
    }
    lines.push({ number: index + 1, text });
  });
  return { lines, vars };
};

/** Everything a command resolves to, from the root package.json and the files it names. */
export const resolveCommand = async (
  stepId: string,
  command: string,
  read: ReadFile,
): Promise<ResolvedCommand> => {
  const scripts = scriptsOf(await read("package.json"));
  const lines: ResolvedLine[] = [{ source: "contract", text: command }];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  const follow = async (
    text: string,
    depth: number,
    args: readonly string[],
    vars: ReadonlyMap<string, string>,
  ): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    for (const part of commandsOf(text)) {
      // A package script, by name, with its pre and post hooks.
      for (const pattern of SCRIPT_RUNNERS) {
        const match = pattern.exec(part);
        if (match === null) continue;
        const name = match[1] ?? "";
        const isScript = name in scripts || (LIFECYCLE.has(name) && name in scripts);
        if (pattern === SCRIPT_RUNNERS[0] && !isScript && !/\brun\b/.test(part)) {
          // `pnpm -r test` with no root script: it runs in each workspace package.
          if (/\s-r\b|--recursive|--filter/.test(part)) {
            lines.push({ source: "workspaces", text: `${name} in every workspace package` });
            continue;
          }
        }
        if (!isScript) {
          if (pattern === SCRIPT_RUNNERS[0]) unresolved.push(name);
          continue;
        }
        for (const hook of [`pre${name}`, name, `post${name}`]) {
          const script = scripts[hook];
          if (script === undefined || seen.has(`script:${hook}`)) continue;
          seen.add(`script:${hook}`);
          lines.push({ source: `package.json → scripts.${hook}`, text: script });
          await follow(script, depth + 1, [], new Map());
        }
      }
      // A script file the command runs, with the arguments it is given.
      const invoked = SHELL_FILE.exec(part);
      const file = invoked?.[1];
      if (file !== undefined) {
        const given = (invoked?.[2] ?? "")
          .trim()
          .split(/\s+/)
          .filter((word) => word !== "")
          .map((word) => shellValue(word, args, vars) ?? word);
        const key = `file:${file}:${given.join(" ")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const content = await read(file);
        if (content === undefined) {
          unresolved.push(file);
          continue;
        }
        const active = activeLines(content, given);
        for (const line of active.lines)
          lines.push({ source: `${file}:${line.number}`, text: line.text });
        await follow(
          active.lines.map((line) => line.text).join("\n"),
          depth + 1,
          given,
          active.vars,
        );
      }
    }
  };
  await follow(command, 1, [], new Map());
  return { stepId, command, lines, unresolved };
};
