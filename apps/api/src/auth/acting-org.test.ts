import { createFixtures, makeMembership, nextUserId } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { ACTIVE_ORG_CLAIM, resolveActingOrg, userTokenFrom } from "./acting-org.js";
import type { UserToken } from "./principal.js";

const world = () => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  return { memberships: stores.memberships, f };
};

/** The two steps as one call, which is what the request path does either side of the authorizer. */
const resolveFromClaims = async (
  claims: Readonly<Record<string, unknown>>,
  memberships: ReturnType<typeof world>["memberships"],
) => {
  const token = userTokenFrom(claims);
  return token.ok ? resolveActingOrg(token.token, memberships) : token;
};

describe("userTokenFrom", () => {
  it("reads the subject and the org claim, and nothing else", () => {
    const { f } = world();
    const userId = nextUserId(f);
    const orgId = f.ids.next("org");
    expect(userTokenFrom({ sub: userId, [ACTIVE_ORG_CLAIM]: orgId, iss: "ignored" })).toEqual({
      ok: true,
      token: { kind: "user", userId, activeOrg: orgId },
    });
  });

  it("treats an absent or empty org claim as no selection", () => {
    const { f } = world();
    const userId = nextUserId(f);
    for (const claims of [{ sub: userId }, { sub: userId, [ACTIVE_ORG_CLAIM]: "" }]) {
      expect(userTokenFrom(claims)).toEqual({ ok: true, token: { kind: "user", userId } });
    }
  });

  it("refuses a malformed org claim", () => {
    const { f } = world();
    const userId = nextUserId(f);
    for (const claimed of ["acme", 42, `proj_${"0".repeat(26)}`]) {
      expect(userTokenFrom({ sub: userId, [ACTIVE_ORG_CLAIM]: claimed })).toEqual({
        ok: false,
        reason: "malformed_org_claim",
      });
    }
  });

  it("refuses a token with no usable subject", () => {
    for (const claims of [{}, { sub: "" }, { sub: 7 }, { sub: "has#hash" }]) {
      expect(userTokenFrom(claims)).toEqual({ ok: false, reason: "missing_subject" });
    }
  });
});

describe("resolveActingOrg", () => {
  it("acts for the only org when no org is claimed", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    const orgId = f.ids.next("org");
    await memberships.put(makeMembership(userId, orgId));
    expect(await resolveFromClaims({ sub: userId }, memberships)).toEqual({
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
    expect(await resolveFromClaims({ sub: userId }, memberships)).toEqual({
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
        await resolveFromClaims({ sub: userId, [ACTIVE_ORG_CLAIM]: orgId }, memberships),
      ).toEqual({ ok: true, orgId, userId });
    }
  });

  it("refuses a claimed org the user does not belong to", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    await memberships.put(makeMembership(userId, f.ids.next("org")));
    const claims = { sub: userId, [ACTIVE_ORG_CLAIM]: f.ids.next("org") };
    expect(await resolveFromClaims(claims, memberships)).toEqual({
      ok: false,
      reason: "not_a_member",
    });
  });

  it("refuses a subject with no membership", async () => {
    const { memberships, f } = world();
    expect(await resolveFromClaims({ sub: nextUserId(f) }, memberships)).toEqual({
      ok: false,
      reason: "no_membership",
    });
  });

  it("takes a user token directly, without a claim set in sight", async () => {
    const { memberships, f } = world();
    const userId = nextUserId(f);
    const orgId = f.ids.next("org");
    await memberships.put(makeMembership(userId, orgId));
    const token: UserToken = { kind: "user", userId, activeOrg: orgId };
    expect(await resolveActingOrg(token, memberships)).toEqual({ ok: true, orgId, userId });
  });
});
