import { describe, expect, it } from "vitest";
import {
  type AttributeSpec,
  buildAllowed,
  coerceAttribute,
  reduceOtlpFiltered,
  type Scalar,
} from "./reduce.js";

type V = { stringValue: string } | { intValue: number | string } | { boolValue: boolean };
const logs = (...records: Record<string, V>[]) => ({
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: records.map((r) => ({
            attributes: Object.entries(r).map(([key, value]) => ({ key, value })),
          })),
        },
      ],
    },
  ],
});
const s = (stringValue: string): V => ({ stringValue });
const sse = (kind: string, extra: Record<string, V> = {}) => ({
  "event.name": s("codex.sse_event"),
  "event.kind": s(kind),
  ...extra,
});
const allowed = buildAllowed(["model"]);

describe("record filter", () => {
  const body = logs(sse("response.completed"), sse("response.output_text.delta"), sse("other"));
  it("keeps everything without rules", () => {
    expect(reduceOtlpFiltered("logs", body, allowed).records).toHaveLength(3);
    const empty = reduceOtlpFiltered("logs", body, allowed, []);
    expect(empty.records).toHaveLength(3);
    expect(empty.filteredRecordCount).toBe(0);
  });
  it("requires all pairs of a rule", () => {
    const r = reduceOtlpFiltered("logs", body, allowed, [
      { "event.name": "codex.sse_event", "event.kind": "response.completed" },
    ]);
    expect(r.records).toHaveLength(1);
    expect(r.filteredRecordCount).toBe(2);
    expect(
      reduceOtlpFiltered("logs", body, allowed, [
        { "event.name": "codex.sse_event", "event.kind": "nope" },
      ]).records,
    ).toHaveLength(0);
  });
  it("keeps a record matching any rule", () => {
    const r = reduceOtlpFiltered("logs", body, allowed, [
      { "event.kind": "response.completed" },
      { "event.kind": "other" },
    ]);
    expect(r.records).toHaveLength(2);
    expect(r.filteredRecordCount).toBe(1);
  });
  it("matches on rule keys outside the allowlist, without journaling them", () => {
    const r = reduceOtlpFiltered("logs", body, allowed, [{ "event.kind": "other" }]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.attributes).toEqual({});
  });
  it("matches an intValue or numeric string against string and number rules", () => {
    const b = logs({ n: { intValue: 1007 } }, { n: s("1007") }, { n: s("8") });
    expect(reduceOtlpFiltered("logs", b, allowed, [{ n: "1007" }]).records).toHaveLength(2);
    expect(reduceOtlpFiltered("logs", b, allowed, [{ n: 1007 }]).records).toHaveLength(2);
  });
  it("counts filtered records separately from dropped attributes", () => {
    const r = reduceOtlpFiltered("logs", body, allowed, [{ "event.kind": "other" }]);
    expect(r.filteredRecordCount).toBe(2);
    expect(r.records[0]?.droppedAttributeCount).toBe(2);
  });
});

describe("typed attribute specs", () => {
  const c = (type: AttributeSpec["type"], v: Scalar, values?: string[]) =>
    coerceAttribute({ key: "k", type, ...(values ? { values } : {}) }, v);
  it("count", () => {
    expect(c("count", 5)).toBe(5);
    expect(c("count", "1007")).toBe(1007);
    for (const bad of [-1, 1.5, "-1", "1.5", "abc", "", " 1", true, Number.NaN])
      expect(c("count", bad)).toBeUndefined();
  });
  it("number", () => {
    expect(c("number", 1.5)).toBe(1.5);
    expect(c("number", "-2.5")).toBe(-2.5);
    for (const bad of ["x", "", true, Number.POSITIVE_INFINITY])
      expect(c("number", bad)).toBeUndefined();
  });
  it("boolean", () => {
    expect(c("boolean", true)).toBe(true);
    expect(c("boolean", "false")).toBe(false);
    for (const bad of ["yes", "TRUE", 1]) expect(c("boolean", bad)).toBeUndefined();
  });
  it("enum", () => {
    expect(c("enum", "a", ["a", "b"])).toBe("a");
    expect(c("enum", "c", ["a", "b"])).toBeUndefined();
    expect(c("enum", 1, ["1"])).toBeUndefined();
  });
  it("id", () => {
    expect(c("id", "gpt-5.1:abc/1+2")).toBe("gpt-5.1:abc/1+2");
    for (const bad of ["has space", "", "x".repeat(161), 5, "SENTINEL CONTENT"])
      expect(c("id", bad)).toBeUndefined();
  });
  it("timestamp", () => {
    expect(c("timestamp", "2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05Z");
    expect(c("timestamp", "2026-01-02T03:04:05.123+02:00")).toBe("2026-01-02T03:04:05.123+02:00");
    for (const bad of ["2026-01-02", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05", 5])
      expect(c("timestamp", bad)).toBeUndefined();
  });
  it("stores coerced values and counts failures as dropped attributes", () => {
    const a = buildAllowed([
      { key: "n", type: "count" },
      { key: "ok", type: "boolean" },
    ]);
    const r = reduceOtlpFiltered("logs", logs({ n: s("1007"), ok: s("SENTINEL-CONTENT") }), a);
    expect(r.records[0]?.attributes).toEqual({ n: 1007 });
    expect(r.records[0]?.droppedAttributeCount).toBe(1);
  });
});
