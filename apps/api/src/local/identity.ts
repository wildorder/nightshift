/**
 * Who the local instance's operator is (P12, D-P12-03).
 *
 * An ordinary `User` with an ordinary `Membership`, so authorisation runs as it
 * does in AWS: `enforce` resolves the acting org from memberships, and a second
 * local org later is one more row and the acting-org selection the API already
 * has, not a redesign.
 */
import type { OrgId, UserId } from "@nightshift/contracts";
import type { IdentityStores, IdGenerator } from "@nightshift/core";
import type { RequestPrincipal } from "../auth/principal.js";

export const LOCAL_OPERATOR = "local-operator" as UserId;

export interface LocalOperator {
  readonly userId: UserId;
  readonly orgId: OrgId;
  readonly principal: RequestPrincipal;
}

/** Seeds the operator and one org on first start; finds them on every start after. */
export const ensureOperator = async (
  stores: IdentityStores,
  ids: IdGenerator,
  now: string,
): Promise<LocalOperator> => {
  if ((await stores.users.get(LOCAL_OPERATOR)) === undefined) {
    await stores.users.put({
      schemaVersion: 1,
      userId: LOCAL_OPERATOR,
      kind: "human",
      createdAt: now,
    });
  }
  const held = await stores.memberships.listByUser(LOCAL_OPERATOR);
  let orgId = held[0]?.orgId;
  if (orgId === undefined) {
    orgId = ids.next("org");
    await stores.memberships.put({
      schemaVersion: 1,
      userId: LOCAL_OPERATOR,
      orgId,
      createdAt: now,
    });
  }
  return { userId: LOCAL_OPERATOR, orgId, principal: { kind: "user", userId: LOCAL_OPERATOR } };
};
