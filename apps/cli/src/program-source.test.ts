import { createFixtures, makePlanDraft } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { UsageError } from "./failures.js";
import { draftNamed } from "./program-source.js";

const sessionOf = (drafts: ReturnType<typeof makePlanDraft>[]) =>
  ({
    stores: { planDrafts: { listByProject: async () => ({ items: drafts }) } },
  }) as never;

describe("draftNamed", () => {
  const a = createFixtures();
  const b = createFixtures();

  it("finds the one draft with the name", async () => {
    const drafts = [makePlanDraft(a, { name: "alpha" }), makePlanDraft(b, { name: "beta" })];
    const found = await draftNamed(sessionOf(drafts), a.scope.projectId, "beta");
    expect(found?.programId).toBe(b.scope.programId);
    expect(await draftNamed(sessionOf(drafts), a.scope.projectId, "gamma")).toBeUndefined();
  });

  it("refuses a name held by more than one draft, naming the program ids", async () => {
    const drafts = [makePlanDraft(a, { name: "dup" }), makePlanDraft(b, { name: "dup" })];
    const refused = await draftNamed(sessionOf(drafts), a.scope.projectId, "dup").catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain(a.scope.programId);
    expect((refused as UsageError).message).toContain(b.scope.programId);
  });
});
