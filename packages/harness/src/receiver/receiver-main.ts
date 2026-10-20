/**
 * Child entry of the local telemetry receiver. Configured by environment only
 * (see `config.ts`); prints one `{ "port": n }` line when listening on loopback.
 * See `receiver.ts` for why this is a separate process.
 */
import { timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_JOURNAL_BYTES,
  RECEIVER_ENV,
  RECEIVER_HOST,
} from "./config.js";
import { durableAppend } from "./durable-append.js";

const env = process.env;
const capability = env[RECEIVER_ENV.capability];
const journalPath = env[RECEIVER_ENV.journalPath];
if (
  capability === undefined ||
  capability === "" ||
  journalPath === undefined ||
  journalPath === ""
) {
  process.stderr.write("receiver: capability and journal path are required\n");
  process.exit(2);
}
// The secret must not outlive its use as a comparison value in this process's environment.
delete env[RECEIVER_ENV.capability];

const intFromEnv = (name: string, fallback: number): number => {
  const raw = env[name];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const allowedPaths: readonly string[] = (() => {
  const raw = env[RECEIVER_ENV.allowedPaths];
  if (raw === undefined) return DEFAULT_ALLOWED_PATHS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string"))
      return parsed as string[];
  } catch {
    // fall through to the default
  }
  return DEFAULT_ALLOWED_PATHS;
})();
const maxBodyBytes = intFromEnv(RECEIVER_ENV.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
const maxJournalBytes = intFromEnv(RECEIVER_ENV.maxJournalBytes, DEFAULT_MAX_JOURNAL_BYTES);

const fd = openSync(journalPath, "a");
let journalBytes = fstatSync(fd).size;
const fs = {
  write: (f: number, text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        writeSync(f, text);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
  fsync: (f: number): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        fsyncSync(f);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
};

const expected = Buffer.from(capability, "utf8");
const authorized = (header: string | undefined): boolean => {
  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length), "utf8");
  // Length mismatch leaks only the length of a fixed-width random token.
  return given.length === expected.length && timingSafeEqual(given, expected);
};

let lastMs = 0;
const stamp = (): string => {
  lastMs = Math.max(lastMs, Date.now());
  return new Date(lastMs).toISOString();
};

/** The single writer: every append is chained, so the journal is in receipt order. */
let chain: Promise<unknown> = Promise.resolve();
let full = false;
type AppendResult = "ok" | "full" | "failed";
const enqueue = (build: (receivedAt: string) => object, capped: boolean): Promise<AppendResult> => {
  const run = async (): Promise<AppendResult> => {
    if (capped && full) return "full";
    const line = `${JSON.stringify(build(stamp()))}\n`;
    const size = Buffer.byteLength(line);
    try {
      if (capped && journalBytes + size > maxJournalBytes) {
        full = true;
        const gap = `${JSON.stringify({ gap: "journal_full", receivedAt: stamp() })}\n`;
        await durableAppend(fs, fd, gap);
        journalBytes += Buffer.byteLength(gap);
        return "full";
      }
      await durableAppend(fs, fd, line);
      journalBytes += size;
      return "ok";
    } catch {
      return "failed";
    }
  };
  const result = chain.then(run);
  chain = result;
  return result;
};

const JSON_LIKE = /(?:^|[/+])json(?:$|[;\s])/i;
const encode = (
  body: Buffer,
  contentType: string,
): { encoding: "utf8" | "base64"; body: string } => {
  if (JSON_LIKE.test(contentType)) {
    try {
      return { encoding: "utf8", body: new TextDecoder("utf-8", { fatal: true }).decode(body) };
    } catch {
      // not valid UTF-8
    }
  }
  return { encoding: "base64", body: body.toString("base64") };
};

const reply = (res: ServerResponse, status: number, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-length": "0", ...extra });
  res.end();
};

let closing = false;

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (closing) return reply(res, 503, { connection: "close" });
  if (!authorized(req.headers.authorization)) {
    req.resume();
    return reply(res, 401, { "www-authenticate": "Bearer" });
  }
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  if (!allowedPaths.includes(path)) {
    req.resume();
    return reply(res, 404);
  }
  if (req.method !== "POST") {
    req.resume();
    return reply(res, 405, { allow: "POST" });
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    req.resume();
    return reply(res, 413, { connection: "close" });
  }
  const chunks: Buffer[] = [];
  let received = 0;
  let tooLarge = false;
  await new Promise<void>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", resolve);
    req.on("aborted", resolve);
  });
  if (tooLarge) return reply(res, 413, { connection: "close" });
  if (!req.complete) return;
  const contentType = req.headers["content-type"] ?? "";
  const encoded = encode(Buffer.concat(chunks), contentType);
  const result = await enqueue(
    (receivedAt) => ({ receivedAt, path, contentType, ...encoded }),
    true,
  );
  if (result === "ok") return reply(res, 200);
  reply(res, result === "full" ? 507 : 500);
};

const inflight = new Set<Promise<void>>();
const server = createServer((req, res) => {
  const p = handle(req, res)
    .catch(() => {
      if (!res.headersSent) reply(res, 500);
    })
    .finally(() => inflight.delete(p));
  inflight.add(p);
});

const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeIdleConnections();
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 1500))]);
  await chain;
  await enqueue((receivedAt) => ({ closed: true, receivedAt }), false);
  closeSync(fd);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

server.listen(0, RECEIVER_HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ port })}\n`);
});
