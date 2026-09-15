import { createFixtures, makeMembership, nextUserId } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { ACTIVE_ORG_CLAIM, resolveActingOrg } from "./acting-org.js";

const world = () => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  return { memberships: stores.memberships, f };
};

describe("resolveActingOrg", () => {
  it("acts for the only org when no org is claimed", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    const orgId = f.ids.next("org");
    await memberships.put(makeMembership(userId, orgId));
    expect(await resolveActingOrg({ sub: userId }, memberships)).toEqual({
      ok: true,
      orgId,
      userId,
    });
  });

  it("refuses to pick one of several orgs implicitly", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    await memberships.put(makeMembership(userId, f.ids.next("org")));
    await memberships.put(makeMembership(userId, f.ids.next("org")));
    expect(await resolveActingOrg({ sub: userId }, memberships)).toEqual({
      ok: false,
      reason: "org_selection_required",
    });
  });

  it("lets a user in several orgs select each of them by claim", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    const orgs = [f.ids.next("org"), f.ids.next("org")];
    for (const orgId of orgs) await memberships.put(makeMembership(userId, orgId));
    for (const orgId of orgs) {
      expect(
        await resolveActingOrg({ sub: userId, [ACTIVE_ORG_CLAIM]: orgId }, memberships),
      ).toEqual({ ok: true, orgId, userId });
    }
  });

  it("refuses a claimed org the user does not belong to", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    await memberships.put(makeMembership(userId, f.ids.next("org")));
    const claims = { sub: userId, [ACTIVE_ORG_CLAIM]: f.ids.next("org") };
    expect(await resolveActingOrg(claims, memberships)).toEqual({
      ok: false,
      reason: "not_a_member",
    });
  });

  it("refuses a malformed org claim", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    await memberships.put(makeMembership(userId, f.ids.next("org")));
    for (const claimed of ["acme", 42, `proj_${"0".repeat(26)}`]) {
      expect(
        await resolveActingOrg({ sub: userId, [ACTIVE_ORG_CLAIM]: claimed }, memberships),
      ).toEqual({ ok: false, reason: "malformed_org_claim" });
    }
  });

  it("refuses a token with no usable subject", async () => {
    const { memberships } = world();
    for (const claims of [{}, { sub: "" }, { sub: 7 }, { sub: "has#hash" }]) {
      expect(await resolveActingOrg(claims, memberships)).toEqual({
        ok: false,
        reason: "missing_subject",
      });
    }
  });

  it("refuses a subject with no membership", async () => {
    const { memberships, f } = world();
    expect(await resolveActingOrg({ sub: nextUserId(f) }, memberships)).toEqual({
      ok: false,
      reason: "no_membership",
    });
  });
});
