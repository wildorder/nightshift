/**
 * A bounded, launch-scoped loopback telemetry receiver (P20 S-01, D-03).
 *
 * Some providers export request telemetry only over OTLP/HTTP, so an adapter
 * that wants it needs an endpoint. The receiver is a SEPARATE child process
 * because the stdio MCP server that hosts the engine opens no socket (D-03:
 * "an isolated local receiver where an adapter needs one"). It binds only to
 * 127.0.0.1, lives for one launch, and journals a reduced metadata envelope durably.
 *
 * The capability is a per-launch secret, distinct from any Nightshift execution
 * credential; it is passed to the child through its environment, never argv.
 *
 * Harness telemetry is metadata only: the receiver accepts OTLP/JSON only and
 * reduces each record to timing/identity fields plus attributes on a REQUIRED
 * allowlist before anything is written. Log bodies, span events/links,
 * exemplars and other attributes are never retained. The adapter reads the
 * reduced records with `readReceiverJournal`.
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
  DEFAULT_MAX_RECORDS_PER_ENVELOPE,
  RECEIVER_ENV,
} from "./config.js";
import { type AttributeSpec, attributeSpecProblem, recordFilterProblem } from "./reduce.js";

export interface LocalReceiverOptions {
  readonly journalPath: string;
  /**
   * Attributes that may be journaled (at least one). A bare string key keeps any
   * scalar; an `AttributeSpec` journals only values conforming to its type.
   */
  readonly allowedAttributes: readonly (string | AttributeSpec)[];
  /**
   * Keep a record only if any rule matches all its exact attribute pairs (raw
   * attributes; a number also matches its decimal string). Empty keeps all.
   */
  readonly recordFilter?: readonly Record<string, string | number | boolean>[];
  readonly allowedPaths?: readonly string[];
  /** Upper bound on records per journal envelope; the rest are counted as dropped. */
  readonly maxRecordsPerEnvelope?: number;
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
  const bare = options.allowedAttributes.filter((k): k is string => typeof k === "string");
  const specs = options.allowedAttributes.filter((k): k is AttributeSpec => typeof k !== "string");
  if (bare.some((k) => /[,\n]/.test(k)))
    throw new Error("receiver allowed attributes must not contain commas or newlines");
  for (const spec of specs) {
    const problem = attributeSpecProblem(spec);
    if (problem !== undefined) throw new Error(`receiver ${problem}`);
  }
  if (options.recordFilter !== undefined) {
    const problem = recordFilterProblem(options.recordFilter);
    if (problem !== undefined) throw new Error(`receiver ${problem}`);
  }
  const capability = randomBytes(32).toString("hex");
  const entry = childEntry();
  const child = spawn(options.node ?? process.execPath, [...entry.execArgv, entry.file], {
    // stdin is the stop signal (2026-10-22): its end asks the child to flush and
    // exit, which works on every platform. On Windows `kill("SIGTERM")` ends the
    // process outright, before its handler can write the closing line, so every
    // stop there was reported `stopped_before_flush`. A parent that dies closes
    // the pipe too, so the receiver does not outlive it.
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      [RECEIVER_ENV.capability]: capability,
      [RECEIVER_ENV.journalPath]: options.journalPath,
      [RECEIVER_ENV.allowedPaths]: JSON.stringify(options.allowedPaths ?? DEFAULT_ALLOWED_PATHS),
      [RECEIVER_ENV.allowedAttributes]: bare.join("\n"),
      [RECEIVER_ENV.attributeSpecs]: JSON.stringify(specs),
      [RECEIVER_ENV.recordFilter]: JSON.stringify(options.recordFilter ?? []),
      [RECEIVER_ENV.maxRecords]: String(
        options.maxRecordsPerEnvelope ?? DEFAULT_MAX_RECORDS_PER_ENVELOPE,
      ),
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
        child.stdin?.end();
        if (await waitForExit(child, grace.ms)) {
          return child.exitCode === 0 ? {} : { gap: "stopped_before_flush" as const };
        }
        // Not stopped by its stdin in time: a signal, then a kill, as before.
        child.kill("SIGTERM");
        if (await waitForExit(child, 500)) {
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
