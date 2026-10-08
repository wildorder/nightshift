/**
 * The registry of identity records (D-P2-17).
 *
 * Kept apart from `AGGREGATE_SCHEMAS` on purpose. Every aggregate there is project
 * scoped, and SC-P1-17's registry-driven tests assert exactly that. Users and
 * memberships sit above every project, so adding them there would either fail
 * those tests or tempt someone to weaken them. This registry carries the checks
 * that do apply — a valid example, a literal `schemaVersion`, strictness — and its
 * own test asserts the two registries stay disjoint.
 */
import type { z } from "zod";
import { OrgComputeUsageSchema } from "./compute-usage.js";
import { OrgCredentialSchema } from "./credentials.js";
import { EXAMPLE_IDS } from "./examples.js";
import { MembershipSchema } from "./membership.js";
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  OrgConfigSchema,
} from "./org-config.js";
import { UserSchema } from "./user.js";

/** P10 (D-P10-23) adds `OrgCredential`: an org's provider key, envelope-encrypted. */
export const IDENTITY_RECORD_NAMES = [
  "User",
  "Membership",
  "OrgConfig",
  "OrgCredential",
  "OrgComputeUsage",
] as const;

export type IdentityRecordName = (typeof IDENTITY_RECORD_NAMES)[number];

export const IDENTITY_SCHEMAS: { readonly [K in IdentityRecordName]: z.ZodType } = {
  User: UserSchema,
  Membership: MembershipSchema,
  OrgConfig: OrgConfigSchema,
  OrgCredential: OrgCredentialSchema,
  OrgComputeUsage: OrgComputeUsageSchema,
};

/** A Cognito UUID subject, for fixtures. */
export const EXAMPLE_USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Typed as `unknown` for the same reason as `AGGREGATE_EXAMPLES`. */
export const IDENTITY_EXAMPLES: { readonly [K in IdentityRecordName]: unknown } = {
  User: {
    schemaVersion: 1,
    userId: EXAMPLE_USER_ID,
    kind: "human",
    email: "operator@example.com",
    createdAt: "2026-09-14T09:00:00.000Z",
  },
  Membership: {
    schemaVersion: 1,
    userId: EXAMPLE_USER_ID,
    orgId: EXAMPLE_IDS.orgId,
    createdAt: "2026-09-14T09:00:00.000Z",
  },
  OrgConfig: {
    schemaVersion: 1,
    orgId: EXAMPLE_IDS.orgId,
    routingPolicy: DEFAULT_ROUTING_POLICY,
    examinationPolicy: DEFAULT_EXAMINATION_POLICY,
    installations: [],
    version: 1,
    updatedAt: "2026-09-25T09:00:00.000Z",
  },
  OrgCredential: {
    schemaVersion: 1,
    orgId: EXAMPLE_IDS.orgId,
    provider: "anthropic",
    ciphertext: "AAECAwQFBgcICQoLDA0ODw==",
    wrappedKey: "EBESExQVFhcYGRobHB0eHw==",
    lastFour: "wxyz",
    setAt: "2026-10-01T09:00:00.000Z",
  },
  OrgComputeUsage: {
    schemaVersion: 1,
    orgId: EXAMPLE_IDS.orgId,
    month: "2026-10",
    meteredUsd: 12.5,
    updatedAt: "2026-10-01T09:00:00.000Z",
  },
};
