import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";

export const INIT_CLIENTS = {
  claude: { name: "Claude Code", skills: ".claude", scope: "local to this repository" },
  codex: { name: "Codex", skills: ".agents", scope: "user-wide (Codex config.toml)" },
  cursor: { name: "Cursor", skills: ".cursor", scope: "user-wide (~/.cursor/mcp.json)" },
} as const;

export type InitClient = keyof typeof INIT_CLIENTS;

export const parseInitClients = (value: string | undefined): InitClient[] => {
  const choices =
    value
      ?.trim()
      .toLowerCase()
      .split(/[\s,]+/) ?? [];
  if (choices.length === 1 && choices[0] === "none") return [];
  if (choices.length === 1 && choices[0] === "all") return ["claude", "codex", "cursor"];
  if (choices.length === 0 || choices.some((choice) => !Object.hasOwn(INIT_CLIENTS, choice))) {
    throw new UsageError(
      "choose where to install MCP and skills: claude, codex, cursor, all, or none",
      "Pass --clients codex,cursor (or --clients none to skip). --yes requires --clients.",
    );
  }
  return [...new Set(choices)] as InitClient[];
};

export const clientSkillsPath = (environment: CliEnvironment, client: InitClient): string =>
  join(environment.paths.home ?? homedir(), INIT_CLIENTS[client].skills, "skills");

export const mcpAddArgs = (client: "claude" | "codex", server: string): string[] => [
  "mcp",
  "add",
  ...(client === "claude" ? ["--scope", "local"] : []),
  "nightshift",
  "--",
  "node",
  server,
];

type McpStatus = "already" | "registered" | "unavailable";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Merge only the missing Nightshift entry; preserve existing servers and settings. */
const registerCursorMcp = async (
  environment: CliEnvironment,
  server: string,
): Promise<McpStatus> => {
  const directory = join(environment.paths.home ?? homedir(), ".cursor");
  const path = join(directory, "mcp.json");
  let config: unknown = {};
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
    throw new UsageError(`invalid MCP configuration at ${path}`, "Fix it, then run init again.");
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(servers, "nightshift")) return "already";
  config.mcpServers = { ...servers, nightshift: { command: "node", args: [server] } };
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return "registered";
};

export const registerClientMcp = async (
  environment: CliEnvironment,
  repoPath: string,
  client: InitClient,
): Promise<McpStatus> => {
  const server = environment.assets?.mcpServerPath;
  if (server === undefined) return "unavailable";
  if (client === "cursor") return registerCursorMcp(environment, server);
  const exec = environment.exec;
  if (exec === undefined) return "unavailable";
  try {
    const found = await exec(client, ["mcp", "get", "nightshift"], { cwd: repoPath });
    if (found.exitCode === 0) return "already";
    const added = await exec(client, mcpAddArgs(client, server), { cwd: repoPath });
    return added.exitCode === 0 ? "registered" : "unavailable";
  } catch {
    return "unavailable";
  }
};
