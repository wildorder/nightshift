/**
 * Identity fixtures (T9).
 *
 * Subjects are derived from the fixture generator, so they are stable, readable,
 * distinct per world, and shaped like the app client identifiers Cognito issues to
 * machine callers.
 */
import {
  type Membership,
  MembershipSchema,
  type OrgCredential,
  OrgCredentialSchema,
  type OrgId,
  type User,
  type UserId,
  UserIdSchema,
  UserSchema,
} from "@nightshift/contracts";
import { FIXTURE_TIMESTAMP, type Fixtures } from "./factories.js";

type Overrides<T> = Partial<Record<keyof T, unknown>>;

/** A fresh subject: the world's next agent identifier, with `_` made key-safe. */
export const nextUserId = (f: Fixtures): UserId =>
  UserIdSchema.parse(f.ids.next("agent").replace("_", "-"));

export const makeUser = (f: Fixtures, overrides: Overrides<User> = {}): User =>
  UserSchema.parse({
    schemaVersion: 1,
    userId: nextUserId(f),
    kind: "human",
    email: "fixture@example.com",
    createdAt: FIXTURE_TIMESTAMP,
    ...overrides,
  });

export const makeMembership = (
  userId: UserId,
  orgId: OrgId,
  overrides: Overrides<Membership> = {},
): Membership =>
  MembershipSchema.parse({
    schemaVersion: 1,
    userId,
    orgId,
    createdAt: FIXTURE_TIMESTAMP,
    ...overrides,
  });

/** P10 (D-P10-23): an org's Anthropic key, sealed. The ciphertext is nonsense; the shape is real. */
export const makeOrgCredential = (
  orgId: OrgId,
  overrides: Overrides<OrgCredential> = {},
): OrgCredential =>
  OrgCredentialSchema.parse({
    schemaVersion: 1,
    orgId,
    provider: "anthropic",
    ciphertext: "Y2lwaGVydGV4dA==",
    wrappedKey: "d3JhcHBlZC1rZXk=",
    lastFour: "wxyz",
    setAt: FIXTURE_TIMESTAMP,
    ...overrides,
  });
