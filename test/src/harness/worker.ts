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
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpLaunch } from "@nightshift/harness";
import {
  type ScriptName,
  WORKER_MCP_ENV,
  WORKER_SCRIPT_ENV,
  WORKER_WORKTREE_ENV,
} from "./scripted.js";

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

/** The helper every `implement` script adds. Correct, and its test passes. */
const MEDIAN_SOURCE = `
export const median = (values) => {
  if (values.length === 0) throw new RangeError("median of an empty list is undefined");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
`;

const PASSING_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "../src/math.js";

test("median of an odd-length list is the middle value", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median of an even-length list is the mean of the middle two", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
`;

/** The same helper, with a test that asserts something untrue. */
const FAILING_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "../src/math.js";

test("median of an odd-length list is the middle value", () => {
  // Wrong on purpose: SC-P3-07 needs a verification that genuinely fails.
  assert.equal(median([3, 1, 2]), 99);
});
`;

const addMedian = async (worktree: string, testSource: string): Promise<void> => {
  const mathPath = join(worktree, "src", "math.js");
  const existing = await readFile(mathPath, "utf8");
  await writeFile(mathPath, `${existing}${MEDIAN_SOURCE}`, "utf8");
  await writeFile(join(worktree, "test", "median.test.js"), testSource, "utf8");
};

const SCRIPTS: Readonly<Record<ScriptName, (worker: Worker, worktree: string) => Promise<number>>> =
  {
    implement: async (worker, worktree) => {
      await worker.call("job.get");
      await worker.call("job.progress", { message: "reading src/math.js" });
      await addMedian(worktree, PASSING_TEST);
      await worker.call("job.progress", { message: "added median and its tests", percent: 80 });
      const result = await worker.call("job.complete", {
        summary: "Added a median helper to src/math.js, with tests for odd and even lengths.",
      });
      if (result.outcome !== "implemented") {
        note(`job.complete answered ${JSON.stringify(result)}`);
        return 1;
      }
      return 0;
    },

    "implement-broken": async (worker, worktree) => {
      await worker.call("job.get");
      await addMedian(worktree, FAILING_TEST);
      await worker.call("job.progress", { message: "added median; confident, wrongly" });
      // The worker reports success. Verification is what disagrees, which is the
      // whole of SC-P3-06 and SC-P3-07.
      await worker.call("job.complete", { summary: "Added a median helper." });
      return 0;
    },

    "out-of-scope": async (worker, worktree) => {
      await worker.call("job.get");
      await addMedian(worktree, PASSING_TEST);
      // Outside `src/**` and `test/**`. Everything else about this job is fine,
      // which is the point: the scope check is what stops it.
      await appendFile(join(worktree, "README.md"), "\nEdited by a worker that strayed.\n", "utf8");
      await worker.call("job.complete", { summary: "Added median, and tidied the README." });
      return 0;
    },

    hang: async (worker) => {
      await worker.call("job.get");
      await worker.call("job.progress", { message: "waiting for an instruction that never comes" });
      // Until killed. The harness's cancel signals the process group.
      await new Promise(() => {});
      return 0;
    },

    fail: async (worker) => {
      await worker.call("job.get");
      await worker.call("job.fail", {
        reason: "the job asks for a median of a stream, and the module is list-based",
      });
      return 0;
    },

    "silent-exit": async (_worker, worktree) => {
      // Calls nothing, reports nothing, prints nothing on the stream. The
      // lifecycle must still be observable (SC-P3-12), and the node must still
      // end durably (contract §4.3).
      await writeFile(join(worktree, "src", "half-done.js"), "export const x = 1;\n", "utf8");
      return 1;
    },
  };

const main = async (): Promise<number> => {
  const script = requireEnv(WORKER_SCRIPT_ENV) as ScriptName;
  const worktree = requireEnv(WORKER_WORKTREE_ENV);
  const launch = JSON.parse(requireEnv(WORKER_MCP_ENV)) as McpLaunch;

  const run = SCRIPTS[script];
  if (run === undefined) throw new Error(`no such script: ${script}`);

  // `silent-exit` deliberately never connects: a worker whose MCP server was
  // never spoken to is exactly the case the hook channel has to survive.
  if (script === "silent-exit") return run({} as Worker, worktree);

  const worker = await connect(launch);
  try {
    return await run(worker, worktree);
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
