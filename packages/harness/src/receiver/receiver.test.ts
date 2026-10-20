import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECEIVER_HOST } from "./config.js";
import { readReceiverJournal } from "./journal.js";
import { type LocalReceiver, startLocalReceiver } from "./receiver.js";

let dir: string;
const started: LocalReceiver[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "receiver-"));
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((r) => r.stop()));
  rmSync(dir, { recursive: true, force: true });
});

const start = async (extra: Partial<Parameters<typeof startLocalReceiver>[0]> = {}) => {
  const r = await startLocalReceiver({ journalPath: join(dir, "j.ndjson"), ...extra });
  started.push(r);
  return r;
};
const post = (
  r: LocalReceiver,
  path: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) =>
  fetch(`${r.endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${r.capability}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body,
  });
const lines = (r: LocalReceiver) =>
  readFileSync(r.journalPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("local receiver", () => {
  it("binds loopback only and keeps the capability out of argv", async () => {
    expect(RECEIVER_HOST).toBe("127.0.0.1");
    const r = await start();
    expect(r.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(r.capability).toMatch(/^[0-9a-f]{64}$/);
    const cmdline = readFileSync(`/proc/${r.pid}/cmdline`, "utf8");
    expect(cmdline).not.toContain(r.capability);
  });

  it("rejects missing/wrong capability, unknown paths and non-POST", async () => {
    const r = await start();
    expect((await fetch(`${r.endpoint}/v1/logs`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post(r, "/v1/logs", "{}", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(r, "/v1/other", "{}")).status).toBe(404);
    const get = await fetch(`${r.endpoint}/v1/logs`, {
      headers: { authorization: `Bearer ${r.capability}` },
    });
    expect(get.status).toBe(405);
    expect(lines(r)).toEqual([]);
  });

  it("answers 413 over the body cap and journals nothing", async () => {
    const r = await start({ maxBodyBytes: 16 });
    expect((await post(r, "/v1/logs", "x".repeat(100))).status).toBe(413);
    expect(readFileSync(r.journalPath, "utf8")).toBe("");
  });

  it("journals before answering 200, in receipt order, with utf8/base64 encodings", async () => {
    const r = await start();
    for (let i = 0; i < 5; i++) {
      expect((await post(r, "/v1/logs", JSON.stringify({ i }))).status).toBe(200);
      const all = lines(r);
      expect(all).toHaveLength(i + 1);
      expect(all[i]).toMatchObject({
        path: "/v1/logs",
        encoding: "utf8",
        body: JSON.stringify({ i }),
      });
    }
    const bin = new Uint8Array([0, 255, 1, 2]);
    expect(
      (await post(r, "/v1/metrics", bin, { "content-type": "application/x-protobuf" })).status,
    ).toBe(200);
    const all = lines(r);
    expect(all[5]).toMatchObject({ encoding: "base64", body: Buffer.from(bin).toString("base64") });
    const times = all.map((l) => String(l.receivedAt));
    expect([...times].sort()).toEqual(times);
  });

  it("answers 507 with a journal_full gap once the cap is reached", async () => {
    const r = await start({ maxJournalBytes: 300 });
    let status = 200;
    for (let i = 0; i < 10 && status === 200; i++)
      status = (await post(r, "/v1/logs", "{}")).status;
    expect(status).toBe(507);
    expect((await post(r, "/v1/logs", "{}")).status).toBe(507);
    const all = lines(r);
    expect(all.filter((l) => l.gap === "journal_full")).toHaveLength(1);
    expect(all.at(-1)).toMatchObject({ gap: "journal_full" });
  });

  it("writes a closed line on stop and the child exits cleanly", async () => {
    const r = await start();
    await post(r, "/v1/traces", "{}");
    expect(await r.stop()).toEqual({});
    const all = lines(r);
    expect(all.at(-1)).toMatchObject({ closed: true });
    expect(() => process.kill(r.pid, 0)).toThrow();
  });

  it("reports receiver_lost when the child died before stop", async () => {
    const r = await start();
    process.kill(r.pid, "SIGKILL");
    await new Promise((res) => setTimeout(res, 200));
    expect(await r.stop()).toEqual({ gap: "receiver_lost" });
  });

  it("rejects when the child cannot become ready", async () => {
    await expect(
      startLocalReceiver({ journalPath: join(dir, "no/such/dir/j"), readyTimeoutMs: 5000 }),
    ).rejects.toThrow();
  });
});

describe("readReceiverJournal", () => {
  it("yields a gap for a torn last line", async () => {
    const path = join(dir, "t.ndjson");
    const env = {
      receivedAt: "t",
      path: "/v1/logs",
      contentType: "application/json",
      encoding: "utf8",
      body: "{}",
    };
    writeFileSync(
      path,
      `${JSON.stringify(env)}\n${JSON.stringify({ closed: true, receivedAt: "t" })}\n{"receivedAt":"t","pa`,
    );
    const out = [];
    for await (const e of readReceiverJournal(path)) out.push(e);
    expect(out).toEqual([env, { closed: true, receivedAt: "t" }, { gap: "torn_line" }]);
  });
});
