/**
 * Token to acting organisation (T9 deliverable 4, D-P2-13).
 *
 * The rule, in full:
 *
 * 1. The subject is the `sub` claim. It must be a Cognito subject; otherwise
 *    `missing_subject`. For an interactive user that is a UUID; for a machine
 *    caller using the client credentials grant it is the app client identifier.
 * 2. If the `custom:active_org` claim is present, it must be an org identifier
 *    (`malformed_org_claim`) and the subject must hold a membership in that org
 *    (`not_a_member`). That org acts.
 * 3. If the claim is absent: a subject with exactly one membership acts for that
 *    org; with none, `no_membership`; with several, `org_selection_required`. A
 *    user in several orgs is never assigned one implicitly.
 *
 * The org is never read from a path or a body.
 *
 * **This derives an org. It does not enforce org separation.** v1 has no org
 * boundary (A-21 non-guarantee): the handler resolves an org only where an
 * operation needs one — creating a project and listing projects — and no other
 * route checks it. Any authenticated caller can read any project by identifier.
 * Refusing cross-org access is a separate, deliberate step, and a half-enforced
 * boundary would be worse than none because it would be trusted.
 *
 * For P3: `custom:` attributes appear only in Cognito **ID** tokens on the Lite
 * feature plan, so an interactive client that needs to select an org must send
 * the ID token. Access tokens (and every client-credentials token) carry no
 * `custom:` claims, which is why the single-membership fallback exists.
 */
import { type OrgId, OrgIdSchema, type UserId, UserIdSchema } from "@nightshift/contracts";
import type { MembershipStore } from "@nightshift/core";

/** The claim a multi-org caller uses to choose which org it is acting for. */
export const ACTIVE_ORG_CLAIM = "custom:active_org";

export type ActingOrgRefusal =
  | "missing_subject"
  | "malformed_org_claim"
  | "not_a_member"
  | "no_membership"
  | "org_selection_required";

export type ActingOrgResolution =
  | { readonly ok: true; readonly orgId: OrgId; readonly userId: UserId }
  | { readonly ok: false; readonly reason: ActingOrgRefusal };

export const describeRefusal = (reason: ActingOrgRefusal): string => {
  switch (reason) {
    case "missing_subject":
      return "the token carries no usable subject";
    case "malformed_org_claim":
      return `the ${ACTIVE_ORG_CLAIM} claim is not an organisation identifier`;
    case "not_a_member":
      return `the caller is not a member of the organisation named in ${ACTIVE_ORG_CLAIM}`;
    case "no_membership":
      return "the caller belongs to no organisation";
    case "org_selection_required":
      return `the caller belongs to several organisations; select one with ${ACTIVE_ORG_CLAIM}`;
  }
};

export const resolveActingOrg = async (
  claims: Readonly<Record<string, unknown>>,
  memberships: MembershipStore,
): Promise<ActingOrgResolution> => {
  const subject = UserIdSchema.safeParse(claims.sub);
  if (!subject.success) return { ok: false, reason: "missing_subject" };
  const userId = subject.data;

  const claimed = claims[ACTIVE_ORG_CLAIM];
  if (claimed !== undefined) {
    const org = OrgIdSchema.safeParse(claimed);
    if (!org.success) return { ok: false, reason: "malformed_org_claim" };
    const held = await memberships.listByUser(userId);
    return held.some((membership) => membership.orgId === org.data)
      ? { ok: true, orgId: org.data, userId }
      : { ok: false, reason: "not_a_member" };
  }

  const held = await memberships.listByUser(userId);
  const only = held[0];
  if (only === undefined) return { ok: false, reason: "no_membership" };
  if (held.length > 1) return { ok: false, reason: "org_selection_required" };
  return { ok: true, orgId: only.orgId, userId };
};
