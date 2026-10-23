import { MAX_PLAN_DRAFT_ACTS, type PlanDraft, type Principal } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { PlanDraftError } from "../errors.js";
import { createFixtures, makePlanDraft } from "../testing/factories.js";
import { applyPlanDraftAct, reconcilePlanDraftWrite } from "./plan-draft.js";

const f = createFixtures();
const scope = f.scope;
const T1 = "2026-09-13T13:00:00.000Z";
const T2 = "2026-09-13T13:05:00.000Z";
const by = {
  kind: "user",
  userId: "operator-01",
  orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
} as Principal;

const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PlanDraftError) return error.reason;
    throw error;
  }
  return undefined;
};

const draftAt = (overrides: Partial<PlanDraft> = {}): PlanDraft =>
  makePlanDraft(f, { latestVersion: 2, state: "draft", acts: [], ...overrides });

describe("reconcilePlanDraftWrite", () => {
  it("starts a draft at version 1 when none is stored and nothing is based on", () => {
    const { version, draft } = reconcilePlanDraftWrite({ scope, basedOn: null, at: T1 });
    expect(version).toBe(1);
    expect(draft).toMatchObject({ state: "draft", latestVersion: 1, acts: [], createdAt: T1 });
  });

  it("refuses a write based on a version when there is no draft", () => {
    expect(reason(() => reconcilePlanDraftWrite({ scope, basedOn: 1, at: T1 }))).toBe("no_draft");
  });

  it("writes version n+1 on the latest, and puts the state back to draft", () => {
    const stored = draftAt({ state: "awaiting_owner" });
    const { version, draft } = reconcilePlanDraftWrite({ stored, scope, basedOn: 2, at: T2 });
    expect(version).toBe(3);
    expect(draft).toMatchObject({ state: "draft", latestVersion: 3, updatedAt: T2 });
    expect(draft.createdAt).toBe(stored.createdAt);
  });

  it("refuses a write based on an older version, or on none", () => {
    const stored = draftAt();
    expect(reason(() => reconcilePlanDraftWrite({ stored, scope, basedOn: 1, at: T1 }))).toBe(
      "stale_base",
    );
    expect(reason(() => reconcilePlanDraftWrite({ stored, scope, basedOn: null, at: T1 }))).toBe(
      "stale_base",
    );
    expect(reason(() => reconcilePlanDraftWrite({ stored, scope, basedOn: 3, at: T1 }))).toBe(
      "stale_base",
    );
  });

  it("refuses a write to a declined draft", () => {
    const stored = draftAt({ state: "declined" });
    expect(reason(() => reconcilePlanDraftWrite({ stored, scope, basedOn: 2, at: T1 }))).toBe(
      "declined",
    );
  });
});

describe("applyPlanDraftAct", () => {
  const hash = "e".repeat(64);
  it.each([
    ["awaiting_owner", "awaiting_owner"],
    ["changes_requested", "draft"],
    ["declined", "declined"],
    ["ratified", "ratified"],
  ] as const)("%s moves the draft to %s and is recorded", (kind, state) => {
    const next = applyPlanDraftAct(draftAt(), {
      kind,
      version: 2,
      by,
      note: "n",
      planHash: hash,
      at: T1,
    });
    expect(next.state).toBe(state);
    expect(next.updatedAt).toBe(T1);
    expect(next.acts).toEqual([
      {
        kind,
        version: 2,
        by,
        note: "n",
        ...(kind === "ratified" ? { planHash: hash } : {}),
        at: T1,
      },
    ]);
  });

  it("refuses an act on a version that is not the latest", () => {
    for (const version of [1, 3]) {
      expect(
        reason(() => applyPlanDraftAct(draftAt(), { kind: "awaiting_owner", version, by, at: T1 })),
      ).toBe("not_latest_version");
    }
  });

  it("refuses every act on a declined draft", () => {
    for (const kind of ["awaiting_owner", "changes_requested", "declined", "ratified"] as const) {
      expect(
        reason(() =>
          applyPlanDraftAct(draftAt({ state: "declined" }), {
            kind,
            version: 2,
            by,
            planHash: hash,
            at: T1,
          }),
        ),
      ).toBe("declined");
    }
  });

  it("refuses a ratification without a plan hash", () => {
    expect(
      reason(() => applyPlanDraftAct(draftAt(), { kind: "ratified", version: 2, by, at: T1 })),
    ).toBe("plan_hash_required");
  });

  it("keeps only the newest acts", () => {
    let draft = draftAt();
    for (let i = 0; i < MAX_PLAN_DRAFT_ACTS + 5; i++) {
      draft = applyPlanDraftAct(draft, {
        kind: "awaiting_owner",
        version: 2,
        by,
        note: `${i}`,
        at: T1,
      });
    }
    expect(draft.acts).toHaveLength(MAX_PLAN_DRAFT_ACTS);
    expect(draft.acts.at(-1)?.note).toBe(`${MAX_PLAN_DRAFT_ACTS + 4}`);
    expect(draft.acts[0]?.note).toBe("5");
  });
});
