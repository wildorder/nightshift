/**
 * The scripted worker child (T9 deliverable 2).
 *
 * A real process, standing where a headless model would. It launches the
 * **worker-role Nightshift MCP server** from the launch its harness handed it,
 * over stdio, with the SDK's own client — so the worker tool surface, the role
 * split and the identity-through-environment path are all genuinely exercised.
 *
 * It writes one JSON frame per line to stdout, which its harness parses as a
 * provider's output stream would be parsed. That is the stand-in for a CLI's
 * event stream, not for a model's good behaviour: `silent-exit` prints nothing
 * and calls nothing, and the lifecycle is still observable from the process.
 *
 * Every script ends the process itself. Nothing here decides anything about a
 * node — that is the execution layer's, as it is for a real worker.
 */

import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpLaunch } from "@nightshift/harness";
import {
  WORKER_ARGS_ENV,
  WORKER_KIND_ENV,
  WORKER_MCP_ENV,
  WORKER_SCRIPT_ENV,
  WORKER_WORKTREE_ENV,
} from "./scripted.js";
import {
  type OrchestratorSurface,
  SCRIPTS,
  type ScriptName,
  type WorkerSurface,
} from "./scripts.js";

/** One line of the stream the harness reads. */
const frame = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const note = (text: string): void => {
  process.stderr.write(`[scripted-worker] ${text}\n`);
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

interface Worker {
  readonly client: Client;
  /** Calls a worker tool, reporting it on the stream as a real stream would. */
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const connect = async (launch: McpLaunch): Promise<Worker> => {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
    // The server writes diagnostics to stderr; let them through to ours so a
    // failing test can see why a worker could not start.
    stderr: "inherit",
  });
  const client = new Client({ name: "scripted-worker", version: "1.0.0" });
  await client.connect(transport);

  return {
    client,
    call: async (name, args = {}) => {
      frame({ hook: "tool.called", payload: { tool: name } });
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
      frame({
        hook: "tool.completed",
        payload: { tool: name, ok: structured.ok === true },
      });
      return structured;
    },
    close: () => client.close(),
  };
};

/** The worker operations over stdio: each one is a real tool call. */
const surfaceOver = (worker: Worker): WorkerSurface => ({
  get: async () => {
    await worker.call("job.get");
  },
  progress: async (message, percent) => {
    await worker.call("job.progress", percent === undefined ? { message } : { message, percent });
  },
  decide: async (decision) => {
    await worker.call("decision.record", { ...decision });
  },
  complete: async (summary) => {
    const result = await worker.call("job.complete", { summary });
    if (result.outcome !== "implemented") note(`job.complete answered ${JSON.stringify(result)}`);
    return result.outcome === "implemented" ? "implemented" : "scope_violation";
  },
  fail: async (reason) => {
    await worker.call("job.fail", { reason });
  },
});

/** The sub-orchestrator role's tools, over stdio: each one a real tool call. */
const orchestratorOver = (worker: Worker): OrchestratorSurface => ({
  delegate: async (objective, includes) => {
    const result = await worker.call("delegate", {
      objective,
      scope: { includes: [...includes] },
      acceptance: ["node --test passes"],
    });
    if (result.ok !== true) throw new Error(`delegate was refused: ${JSON.stringify(result)}`);
    return String(result.jobId);
  },
  waitAll: async (jobIds) => {
    const statuses: Record<string, string> = {};
    let remaining = [...jobIds];
    while (remaining.length > 0) {
      const result = await worker.call("job.wait", { jobIds: remaining, timeoutSeconds: 10 });
      for (const job of (result.jobs ?? []) as {
        jobContractId: string;
        status: string;
        settled: boolean;
      }[]) {
        if (job.settled) statuses[job.jobContractId] = job.status;
      }
      remaining = remaining.filter((jobId) => statuses[jobId] === undefined);
    }
    return statuses;
  },
  progress: async (message) => {
    await worker.call("subprogram.progress", { message });
  },
  complete: async (summary) => {
    const result = await worker.call("subprogram.complete", { summary });
    if (result.ok !== true)
      throw new Error(`subprogram.complete was refused: ${JSON.stringify(result)}`);
  },
  fail: async (reason) => {
    await worker.call("subprogram.fail", { reason });
  },
});

/** A surface for the one script that must never speak to anything. */
const NO_SURFACE = {} as WorkerSurface;

/** A child is stopped by killing its process group, so nothing ever settles this. */
const NEVER = new Promise<void>(() => {});

const main = async (): Promise<number> => {
  const script = requireEnv(WORKER_SCRIPT_ENV) as ScriptName;
  const worktree = requireEnv(WORKER_WORKTREE_ENV);
  const launch = JSON.parse(requireEnv(WORKER_MCP_ENV)) as McpLaunch;

  const run = SCRIPTS[script];
  if (run === undefined) throw new Error(`no such script: ${script}`);

  // `silent-exit` deliberately never connects: a worker whose MCP server was
  // never spoken to is exactly the case the hook channel has to survive.
  if (script === "silent-exit") {
    return run({ surface: NO_SURFACE, worktree, cancelled: NEVER, note });
  }

  const args = JSON.parse(process.env[WORKER_ARGS_ENV] ?? "[]") as string[];
  // Shared by every worker of the run, and by nothing else: under the state
  // directory, which the launch carries to the worker's MCP server.
  const stateDir = launch.env.NIGHTSHIFT_STATE_DIR;
  const sharedDir = stateDir === undefined ? undefined : join(stateDir, "barriers");

  const worker = await connect(launch);
  try {
    return await run({
      surface: surfaceOver(worker),
      worktree,
      cancelled: NEVER,
      note,
      args,
      ...(sharedDir === undefined ? {} : { sharedDir }),
      ...(process.env[WORKER_KIND_ENV] === "sub-program"
        ? { orchestrator: orchestratorOver(worker) }
        : {}),
    });
  } finally {
    await worker.close().catch(() => {});
  }
};

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    note(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    process.exit(1);
  });
