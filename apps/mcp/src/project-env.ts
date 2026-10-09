/**
 * The project environment, as a file (P16 S-01).
 *
 * On a machine the runner computes one environment for every project process
 * (`projectEnvironment` in `runner/workspace.ts`) and writes it to
 * `<run>/project.env`, `KEY=VALUE` a line. The orchestrator-role server it
 * launches is told the file's path, reads it (`createRuntime`), and threads it
 * explicitly (P16, D-10): to every project step it runs, through
 * `ExecutionEnvironment.projectEnv`, and to each worker user, through
 * `RunAs.env`. No Nightshift process takes it as its own: the runner, the MCP
 * servers and the agent CLIs stay in the image's environment. The boot proof
 * reads the same file. Nothing in it is a secret: it names directories, a
 * socket and versions.
 */
import { readFile } from "node:fs/promises";

/** Set by the runner on the processes it launches; absent on a laptop. */
export const PROJECT_ENV_FILE_ENV = "NIGHTSHIFT_PROJECT_ENV_FILE";

/** `KEY=VALUE` lines, in the order given. */
export const formatProjectEnv = (env: Readonly<Record<string, string>>): string =>
  `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;

/** The inverse of `formatProjectEnv`: blank lines and `#` comments skipped, `=` in a value kept. */
export const parseProjectEnv = (text: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
};

/** The file `env` names, parsed; `undefined` on a laptop, where nothing names one. */
export const readProjectEnv = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string> | undefined> => {
  const path = env[PROJECT_ENV_FILE_ENV];
  if (path === undefined || path === "") return undefined;
  return parseProjectEnv(await readFile(path, "utf8"));
};
