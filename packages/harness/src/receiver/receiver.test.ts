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
  const r = await startLocalReceiver({
    journalPath: join(dir, "j.ndjson"),
    allowedAttributes: ["model"],
    ...extra,
  });
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
const firstRecord = (r: LocalReceiver): Record<string, unknown> | undefined => {
  const records = lines(r)[0]?.records;
  return Array.isArray(records) ? (records[0] as Record<string, unknown>) : undefined;
};

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

  it("journals before answering 200, in receipt order, as reduced envelopes", async () => {
    const r = await start();
    for (let i = 0; i < 5; i++) {
      expect((await post(r, "/v1/logs", JSON.stringify({ i }))).status).toBe(200);
      const all = lines(r);
      expect(all).toHaveLength(i + 1);
      expect(all[i]).toMatchObject({
        path: "/v1/logs",
        signal: "logs",
        records: [],
        droppedRecordCount: 0,
      });
    }
    const times = lines(r).map((l) => String(l.receivedAt));
    expect([...times].sort()).toEqual(times);
  });

  it("journals only allowlisted attributes and drops the log body", async () => {
    const r = await start();
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc-x" } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  observedTimeUnixNano: "1700000000000000001",
                  severityText: "INFO",
                  body: { stringValue: "PROMPT-LIKE: summarise my private notes" },
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "model", value: { stringValue: "m-1" } },
                    { key: "secret", value: { stringValue: "SECRET-TOKEN-123" } },
                    { key: "prompt", value: { stringValue: "PROMPT-TEXT-456" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect((await post(r, "/v1/logs", JSON.stringify(payload))).status).toBe(200);
    const [env] = lines(r);
    expect(env).toMatchObject({
      signal: "logs",
      droppedRecordCount: 0,
      records: [
        {
          kind: "log",
          timeUnixNano: "1700000000000000000",
          observedTimeUnixNano: "1700000000000000001",
          severityText: "INFO",
          eventName: "api_request",
          attributes: { model: "m-1" },
          resourceAttributes: {},
          // event.name, secret, prompt and the resource service.name
          droppedAttributeCount: 4,
        },
      ],
    });
    const raw = readFileSync(r.journalPath, "utf8");
    for (const s of [
      "PROMPT-LIKE",
      "SECRET-TOKEN-123",
      "PROMPT-TEXT-456",
      "svc-x",
      "private notes",
    ])
      expect(raw).not.toContain(s);
  });

  it("counts exactly the non-allowlisted record attributes", async () => {
    const r = await start();
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "model", value: { stringValue: "m" } },
                    { key: "secret", value: { stringValue: "s" } },
                    { key: "prompt", value: { stringValue: "p" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await post(r, "/v1/logs", JSON.stringify(payload));
    const rec = firstRecord(r);
    expect(rec).toMatchObject({ attributes: { model: "m" }, droppedAttributeCount: 2 });
  });

  it("truncates long strings and drops array and map values", async () => {
    const r = await start({ allowedAttributes: ["model", "list", "map", "n", "ok"] });
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "model", value: { stringValue: "a".repeat(400) } },
                    { key: "list", value: { arrayValue: { values: [] } } },
                    { key: "map", value: { kvlistValue: { values: [] } } },
                    { key: "n", value: { intValue: "7" } },
                    { key: "ok", value: { boolValue: true } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await post(r, "/v1/logs", JSON.stringify(payload));
    const rec = firstRecord(r);
    expect(rec).toMatchObject({
      attributes: { model: "a".repeat(256), n: 7, ok: true },
      droppedAttributeCount: 2,
    });
  });

  it("keeps metric name, unit, value and allowlisted attributes only", async () => {
    const r = await start();
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "tokens",
                  unit: "1",
                  sum: {
                    dataPoints: [
                      {
                        asInt: "42",
                        timeUnixNano: "5",
                        attributes: [
                          { key: "model", value: { stringValue: "m" } },
                          { key: "user.email", value: { stringValue: "a@b.example" } },
                        ],
                        exemplars: [{ asDouble: 1, filteredAttributes: [] }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    await post(r, "/v1/metrics", JSON.stringify(payload));
    expect(lines(r)[0]?.records).toMatchObject([
      {
        kind: "metric",
        name: "tokens",
        unit: "1",
        value: 42,
        timeUnixNano: "5",
        attributes: { model: "m" },
        droppedAttributeCount: 1,
      },
    ]);
    const raw = readFileSync(r.journalPath, "utf8");
    expect(raw).not.toContain("a@b.example");
    expect(raw).not.toContain("exemplar");
  });

  it("keeps span ids and timing and drops events and links", async () => {
    const r = await start();
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "llm.call",
                  traceId: "t1",
                  spanId: "s1",
                  parentSpanId: "p1",
                  startTimeUnixNano: "10",
                  endTimeUnixNano: "20",
                  status: { code: 1, message: "STATUS-MESSAGE" },
                  attributes: [{ key: "model", value: { stringValue: "m" } }],
                  events: [{ name: "EVENT-NAME-LEAK", attributes: [] }],
                  links: [{ traceId: "LINK-LEAK" }],
                },
              ],
            },
          ],
        },
      ],
    };
    await post(r, "/v1/traces", JSON.stringify(payload));
    expect(lines(r)[0]?.records).toMatchObject([
      {
        kind: "span",
        name: "llm.call",
        traceId: "t1",
        spanId: "s1",
        parentSpanId: "p1",
        startTimeUnixNano: "10",
        endTimeUnixNano: "20",
        statusCode: 1,
        attributes: { model: "m" },
      },
    ]);
    const raw = readFileSync(r.journalPath, "utf8");
    for (const s of ["EVENT-NAME-LEAK", "LINK-LEAK", "STATUS-MESSAGE"])
      expect(raw).not.toContain(s);
  });

  it("refuses non-JSON content types with 415 and journals nothing", async () => {
    const r = await start();
    const bin = new Uint8Array([0, 255, 1, 2]);
    expect(
      (await post(r, "/v1/metrics", bin, { "content-type": "application/x-protobuf" })).status,
    ).toBe(415);
    expect(readFileSync(r.journalPath, "utf8")).toBe("");
  });

  it("refuses unparseable JSON with 400 and journals nothing", async () => {
    const r = await start();
    expect((await post(r, "/v1/logs", "{not json")).status).toBe(400);
    expect((await post(r, "/v1/logs", "[1]")).status).toBe(400);
    expect(readFileSync(r.journalPath, "utf8")).toBe("");
  });

  it("caps records per envelope and writes a gap", async () => {
    const r = await start({ maxRecordsPerEnvelope: 2 });
    const logRecords = Array.from({ length: 5 }, () => ({ severityText: "INFO" }));
    const payload = { resourceLogs: [{ scopeLogs: [{ logRecords }] }] };
    expect((await post(r, "/v1/logs", JSON.stringify(payload))).status).toBe(200);
    const all = lines(r);
    expect(all[0]?.records).toHaveLength(2);
    expect(all[0]?.droppedRecordCount).toBe(3);
    expect(all[1]).toMatchObject({ gap: "records_truncated" });
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
      startLocalReceiver({
        journalPath: join(dir, "no/such/dir/j"),
        allowedAttributes: ["model"],
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });

  it("refuses to start without an attribute allowlist", async () => {
    await expect(
      startLocalReceiver({
        journalPath: join(dir, "j.ndjson"),
        allowedAttributes: [],
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/allowlist/);
  });
});

describe("readReceiverJournal", () => {
  it("yields a gap for a torn last line", async () => {
    const path = join(dir, "t.ndjson");
    const env = {
      receivedAt: "t",
      path: "/v1/logs",
      contentType: "application/json",
      signal: "logs",
      records: [],
      droppedRecordCount: 0,
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
