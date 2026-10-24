import { describe, expect, it } from "vitest";
import { AGGREGATE_EXAMPLES } from "./examples.js";
import {
  MAX_PLAN_DRAFT_ACTS,
  type PlanDraft,
  PlanDraftSchema,
  type PlanDraftVersion,
  PlanDraftVersionSchema,
} from "./plan-draft.js";

const draft = (): PlanDraft => structuredClone(AGGREGATE_EXAMPLES.PlanDraft) as PlanDraft;
const version = (): PlanDraftVersion =>
  structuredClone(AGGREGATE_EXAMPLES.PlanDraftVersion) as PlanDraftVersion;

describe("PlanDraft", () => {
  it("accepts the example", () => {
    expect(PlanDraftSchema.parse(draft())).toEqual(draft());
  });

  it("refuses an unknown state, a zero latest version and an unknown act kind", () => {
    expect(PlanDraftSchema.safeParse({ ...draft(), state: "open" }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draft(), latestVersion: 0 }).success).toBe(false);
    const [act] = draft().acts;
    expect(
      PlanDraftSchema.safeParse({ ...draft(), acts: [{ ...act, kind: "write" }] }).success,
    ).toBe(false);
  });

  it("bounds the recorded acts", () => {
    const [act] = draft().acts;
    const acts = Array.from({ length: MAX_PLAN_DRAFT_ACTS + 1 }, () => act);
    expect(PlanDraftSchema.safeParse({ ...draft(), acts }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draft(), acts: acts.slice(1) }).success).toBe(true);
  });

  it("refuses unknown fields", () => {
    expect(PlanDraftSchema.safeParse({ ...draft(), extra: 1 }).success).toBe(false);
  });
});

describe("PlanDraftVersion", () => {
  it("accepts the example", () => {
    expect(PlanDraftVersionSchema.parse(version())).toEqual(version());
  });

  it("accepts a plain write without a plan hash or conversation", () => {
    const { planHash: _hash, ...rest } = version();
    expect(PlanDraftVersionSchema.safeParse({ ...rest, act: { kind: "write" } }).success).toBe(
      true,
    );
  });

  it("refuses a malformed document reference or hash", () => {
    expect(
      PlanDraftVersionSchema.safeParse({
        ...version(),
        plan: { ...version().plan, sha256: "XYZ" },
      }).success,
    ).toBe(false);
    expect(
      PlanDraftVersionSchema.safeParse({ ...version(), planHash: "A".repeat(64) }).success,
    ).toBe(false);
  });

  it("refuses version 0 and an answer without a decision", () => {
    expect(PlanDraftVersionSchema.safeParse({ ...version(), version: 0 }).success).toBe(false);
    expect(
      PlanDraftVersionSchema.safeParse({ ...version(), act: { kind: "answer", answer: "x" } })
        .success,
    ).toBe(false);
  });
});
