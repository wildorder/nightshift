/**
 * A bounded, launch-scoped loopback telemetry receiver (P20 S-01, D-03).
 *
 * Some providers export request telemetry only over OTLP/HTTP, so an adapter
 * that wants it needs an endpoint. The receiver is a SEPARATE child process
 * because the stdio MCP server that hosts the engine opens no socket (D-03:
 * "an isolated local receiver where an adapter needs one"). It binds only to
 * 127.0.0.1, lives for one launch, and journals received bytes durably.
 *
 * The capability is a per-launch secret, distinct from any Nightshift execution
 * credential; it is passed to the child through its environment, never argv.
 *
 * Nothing here decodes a provider's payload: the receiver journals bytes and
 * the adapter reads the journal (`readReceiverJournal`) and decodes.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Duration, millis } from "../harness.js";
import {
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_JOURNAL_BYTES,
  RECEIVER_ENV,
} from "./config.js";

export interface LocalReceiverOptions {
  readonly journalPath: string;
  readonly allowedPaths?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly maxJournalBytes?: number;
  readonly readyTimeoutMs?: number;
  /** The Node binary that runs the child; defaults to `process.execPath`. */
  readonly node?: string;
}

export interface LocalReceiver {
  /** `http://127.0.0.1:<port>` */
  readonly endpoint: string;
  /** Bearer token the exporter must present. */
  readonly capability: string;
  readonly journalPath: string;
  readonly pid: number;
  stop(grace?: Duration): Promise<{ gap?: "receiver_lost" | "stopped_before_flush" }>;
}

/** Make `.js` imports resolve to `.ts` siblings when the child runs from source (tests). */
const SOURCE_HOOKS = `
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
    throw error;
  }
}`;

const childEntry = (): { file: string; execArgv: string[] } => {
  const js = new URL("./receiver-main.js", import.meta.url);
  if (existsSync(fileURLToPath(js))) return { file: fileURLToPath(js), execArgv: [] };
  const register = `import { register } from "node:module"; register(${JSON.stringify(
    `data:text/javascript,${encodeURIComponent(SOURCE_HOOKS)}`,
  )});`;
  return {
    file: fileURLToPath(new URL("./receiver-main.ts", import.meta.url)),
    execArgv: ["--import", `data:text/javascript,${encodeURIComponent(register)}`],
  };
};

const waitForExit = (child: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

export const startLocalReceiver = async (options: LocalReceiverOptions): Promise<LocalReceiver> => {
  const capability = randomBytes(32).toString("hex");
  const entry = childEntry();
  const child = spawn(options.node ?? process.execPath, [...entry.execArgv, entry.file], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      [RECEIVER_ENV.capability]: capability,
      [RECEIVER_ENV.journalPath]: options.journalPath,
      [RECEIVER_ENV.allowedPaths]: JSON.stringify(options.allowedPaths ?? DEFAULT_ALLOWED_PATHS),
      [RECEIVER_ENV.maxBodyBytes]: String(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
      [RECEIVER_ENV.maxJournalBytes]: String(options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES),
    },
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString("utf8");
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const fail = (message: string): void => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`${message}${stderr === "" ? "" : `: ${stderr.trim()}`}`));
    };
    const timer = setTimeout(
      () => fail("local receiver was not ready in time"),
      options.readyTimeoutMs ?? 10_000,
    );
    child.once("error", (e) => fail(`local receiver failed to start: ${e.message}`));
    child.once("exit", () => fail("local receiver exited before it was ready"));
    child.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, newline));
        const p = (parsed as { port?: unknown }).port;
        if (typeof p !== "number" || !Number.isInteger(p) || p <= 0) throw new Error("bad port");
        clearTimeout(timer);
        resolve(p);
      } catch {
        fail("local receiver printed an invalid ready line");
      }
    });
  });
  child.stdout?.resume();

  let stopping: Promise<{ gap?: "receiver_lost" | "stopped_before_flush" }> | undefined;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    capability,
    journalPath: options.journalPath,
    pid: child.pid ?? 0,
    stop: (grace = millis(2000)) => {
      stopping ??= (async () => {
        if (exited) return { gap: "receiver_lost" as const };
        child.kill("SIGTERM");
        if (await waitForExit(child, grace.ms)) {
          return child.exitCode === 0 ? {} : { gap: "stopped_before_flush" as const };
        }
        child.kill("SIGKILL");
        await waitForExit(child, 5000);
        return { gap: "stopped_before_flush" as const };
      })();
      return stopping;
    },
  };
};
