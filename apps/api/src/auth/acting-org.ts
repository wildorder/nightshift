/**
 * Token to acting organisation (T9 deliverable 4, D-P2-13).
 *
 * The rule, in full:
 *
 * 1. The subject is the `sub` claim, and the `custom:active_org` claim is an org
 *    identifier if present. Both are read by the **authorizer**, which refuses a
 *    token carrying neither a usable subject nor a well-formed org claim with a
 *    401 — a malformed token is not an authorisation question.
 * 2. If the token named an org, the subject must hold a membership in it
 *    (`not_a_member`). That org acts.
 * 3. If it named none: a subject with exactly one membership acts for that org;
 *    with none, `no_membership`; with several, `org_selection_required`. A user
 *    in several orgs is never assigned one implicitly.
 *
 * The org is never read from a path or a body.
 *
 * **P4 makes this a boundary** (D-P4-02, A-34). This module still only *derives*
 * an org; `auth/enforce.ts` is what compares it against the target project's
 * owner, on every project-scoped route, before any record is read. The A-21
 * non-guarantee — "any authenticated caller can read any project by identifier"
 * — is retired by that check, not by this one.
 *
 * For P3: `custom:` attributes appear only in Cognito **ID** tokens on the Lite
 * feature plan, so an interactive client that needs to select an org must send
 * the ID token. Access tokens (and every client-credentials token) carry no
 * `custom:` claims, which is why the single-membership fallback exists.
 */
import { type OrgId, OrgIdSchema, type UserId, UserIdSchema } from "@nightshift/contracts";
import type { MembershipStore } from "@nightshift/core";
import type { UserToken } from "./principal.js";

/** The claim a multi-org caller uses to choose which org it is acting for. */
export const ACTIVE_ORG_CLAIM = "custom:active_org";

/** Why a set of claims is not a usable user token. The authorizer answers 401. */
export type UserTokenRefusal = "missing_subject" | "malformed_org_claim";

export type ActingOrgRefusal = "not_a_member" | "no_membership" | "org_selection_required";

export type ActingOrgResolution =
  | { readonly ok: true; readonly orgId: OrgId; readonly userId: UserId }
  | { readonly ok: false; readonly reason: ActingOrgRefusal };

export const describeTokenRefusal = (reason: UserTokenRefusal): string => {
  switch (reason) {
    case "missing_subject":
      return "the token carries no usable subject";
    case "malformed_org_claim":
      return `the ${ACTIVE_ORG_CLAIM} claim is not an organisation identifier`;
  }
};

export const describeRefusal = (reason: ActingOrgRefusal): string => {
  switch (reason) {
    case "not_a_member":
      return `the caller is not a member of the organisation named in ${ACTIVE_ORG_CLAIM}`;
    case "no_membership":
      return "the caller belongs to no organisation";
    case "org_selection_required":
      return `the caller belongs to several organisations; select one with ${ACTIVE_ORG_CLAIM}`;
  }
};

export type UserTokenResolution =
  | { readonly ok: true; readonly token: UserToken }
  | { readonly ok: false; readonly reason: UserTokenRefusal };

/**
 * Claims to a user token. The **authorizer's** half of the rule: everything here
 * is about the token's own shape, so it can be decided with no store at all.
 */
export const userTokenFrom = (claims: Readonly<Record<string, unknown>>): UserTokenResolution => {
  const subject = UserIdSchema.safeParse(claims.sub);
  if (!subject.success) return { ok: false, reason: "missing_subject" };

  const claimed = claims[ACTIVE_ORG_CLAIM];
  if (claimed === undefined || claimed === "") {
    return { ok: true, token: { kind: "user", userId: subject.data } };
  }
  const org = OrgIdSchema.safeParse(claimed);
  if (!org.success) return { ok: false, reason: "malformed_org_claim" };
  return { ok: true, token: { kind: "user", userId: subject.data, activeOrg: org.data } };
};

/**
 * A user token to the organisation it acts for. The **handler's** half: it needs
 * the caller's memberships, so it runs where the stores are.
 */
export const resolveActingOrg = async (
  token: UserToken,
  memberships: MembershipStore,
): Promise<ActingOrgResolution> => {
  const { userId, activeOrg } = token;
  const held = await memberships.listByUser(userId);

  if (activeOrg !== undefined) {
    return held.some((membership) => membership.orgId === activeOrg)
      ? { ok: true, orgId: activeOrg, userId }
      : { ok: false, reason: "not_a_member" };
  }

  const only = held[0];
  if (only === undefined) return { ok: false, reason: "no_membership" };
  if (held.length > 1) return { ok: false, reason: "org_selection_required" };
  return { ok: true, orgId: only.orgId, userId };
};
