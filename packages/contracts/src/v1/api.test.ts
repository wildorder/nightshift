import { describe, expect, it } from "vitest";
import {
  AppendEventBodySchema,
  AppendEventResponseSchema,
  ErrorResponseSchema,
  ProjectBodySchema,
  ProjectPageSchema,
  RunStateResponseSchema,
} from "./api.js";
import { AGGREGATE_EXAMPLES } from "./examples.js";

const record = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

const projectBody = () => {
  const { orgId: _orgId, ...body } = record(AGGREGATE_EXAMPLES.Project);
  return body;
};

const eventBody = () => {
  const {
    sequence: _sequence,
    recordedAt: _recordedAt,
    ...body
  } = record(AGGREGATE_EXAMPLES.Event);
  return body;
};

describe("ProjectBodySchema", () => {
  it("accepts a project without an org", () => {
    expect(ProjectBodySchema.safeParse(projectBody()).error?.issues ?? []).toEqual([]);
  });

  it("refuses a body that names an org (D-P2-13)", () => {
    const withOrg = { ...projectBody(), orgId: record(AGGREGATE_EXAMPLES.Project).orgId };
    expect(ProjectBodySchema.safeParse(withOrg).success).toBe(false);
  });
});

describe("AppendEventBodySchema", () => {
  it("accepts an event without sequence or recordedAt", () => {
    expect(AppendEventBodySchema.safeParse(eventBody()).error?.issues ?? []).toEqual([]);
  });

  it("refuses a client-supplied sequence or recordedAt", () => {
    expect(AppendEventBodySchema.safeParse({ ...eventBody(), sequence: 3 }).success).toBe(false);
    expect(
      AppendEventBodySchema.safeParse({ ...eventBody(), recordedAt: "2026-09-13T12:05:00.000Z" })
        .success,
    ).toBe(false);
  });

  it("keeps the inline payload bound the event schema enforces", () => {
    const oversized = { ...eventBody(), payload: { blob: "x".repeat(20_000) } };
    expect(AppendEventBodySchema.safeParse(oversized).success).toBe(false);
  });
});

describe("response schemas", () => {
  it("describe an error with optional issues", () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: "not_found", message: "no such run" } })
        .success,
    ).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: { code: "", message: "x" } }).success).toBe(
      false,
    );
  });

  it("describe a page whose cursor is absent on the last page", () => {
    expect(ProjectPageSchema.safeParse({ items: [AGGREGATE_EXAMPLES.Project] }).success).toBe(true);
    expect(ProjectPageSchema.safeParse({ items: [], cursor: "" }).success).toBe(false);
  });

  it("allow an append response carrying an unnumbered event (A-22)", () => {
    const event = { ...record(AGGREGATE_EXAMPLES.Event), sequence: null };
    expect(AppendEventResponseSchema.safeParse({ stored: true, event }).success).toBe(true);
  });

  it("describe run state with nothing numbered yet", () => {
    const state = {
      run: AGGREGATE_EXAMPLES.Run,
      nodes: [AGGREGATE_EXAMPLES.ExecutionNode],
      highestSequence: null,
      pendingEvents: 2,
    };
    expect(RunStateResponseSchema.safeParse(state).error?.issues ?? []).toEqual([]);
  });
});
