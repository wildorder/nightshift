/**
 * What a gate's command actually runs (P17, D-P17-04).
 *
 * A contract says `npm run test`; what runs is `scripts.test` in package.json,
 * its `pretest` hook, the shell script that calls, and the tool at the end of
 * the chain. The catalogue matches tool signatures against all of it, so the
 * resolver follows what it can and quotes the deepest line it reached. An
 * unresolved reference is reported as unresolved, never guessed.
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
  /(?:^|\s)(?:bash|sh|zsh|node|tsx|npx\s+tsx|python3?|uv\s+run)\s+(\S+\.(?:sh|bash|mjs|cjs|js|ts|py))/;

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

  const follow = async (text: string, depth: number): Promise<void> => {
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
          await follow(script, depth + 1);
        }
      }
      // A script file the command runs.
      const file = SHELL_FILE.exec(part)?.[1];
      if (file !== undefined && !seen.has(`file:${file}`)) {
        seen.add(`file:${file}`);
        const content = await read(file);
        if (content === undefined) {
          unresolved.push(file);
          continue;
        }
        content.split(/\r?\n/).forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed === "" || trimmed.startsWith("#")) return;
          lines.push({ source: `${file}:${index + 1}`, text: trimmed });
        });
        await follow(content, depth + 1);
      }
    }
  };
  await follow(command, 1);
  return { stepId, command, lines, unresolved };
};
