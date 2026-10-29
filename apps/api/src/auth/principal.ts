/**
 * What the authorizer proved, as the handler receives it (D-P4-01, A-33).
 *
 * The handler never sees a claim set. It sees one of two typed values, and the
 * difference between them is the whole of P4's point: a **user token** says who
 * is calling Nightshift, an **execution principal** says what a running agent
 * may do.
 *
 * ## Why a user token is not yet a `UserPrincipal`
 *
 * `core`'s `Principal` carries the acting organisation, and resolving that means
 * reading the caller's memberships (D-P2-13). The authorizer holds
 * `kms:GetPublicKey` and nothing else — giving it the table would put a DynamoDB
 * read in front of every request and widen its IAM well past what it needs to
 * check a signature.
 *
 * So the authorizer decides the *kind* and validates the token, and `enforce`
 * completes a user token into a `UserPrincipal` with one cached read. An
 * execution principal arrives complete, because its whole chain is in the token.
 */
import {
  type ExecutionPrincipal,
  type OrgId,
  OrgIdSchema,
  type UserId,
  UserIdSchema,
} from "@nightshift/contracts";
import { z } from "zod";

/** A validated Cognito token: a human through the interactive client, or a machine. */
export interface UserToken {
  readonly kind: "user";
  readonly userId: UserId;
  /** The `custom:active_org` claim, when the token carried one. */
  readonly activeOrg?: OrgId;
}

export type RequestPrincipal = UserToken | ExecutionPrincipal;

export const isUserToken = (principal: RequestPrincipal): principal is UserToken =>
  principal.kind === "user";

/**
 * A user token as it crosses the authorizer → handler boundary.
 *
 * Parsed, not cast: the value arrives as JSON in the request context, and a
 * shape the handler did not expect must be a refusal rather than a surprise
 * three layers down.
 */
export const UserTokenLikeSchema = z.strictObject({
  kind: z.literal("user"),
  userId: UserIdSchema,
  activeOrg: OrgIdSchema.optional(),
});
