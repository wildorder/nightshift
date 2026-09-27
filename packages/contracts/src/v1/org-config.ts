/**
 * Org configuration — an organisation's standing routing and examination policy
 * (P8, D-P8-02).
 *
 * Above every project, like a membership, so it is an identity record rather
 * than an aggregate: it carries no ownership chain. Every project in the org
 * inherits it, and a repository or a contract may only narrow it (D-P8-03).
 *
 * `version` counts writes. A write names the version it replaces plus one, and
 * the control plane refuses anything else, so two people editing at once cannot
 * silently overwrite each other.
 */
import { z } from "zod";
import { OrgIdSchema } from "../ids.js";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";
import { type ExaminationPolicy, ExaminationPolicySchema } from "./program-contract.js";
import { type RoutingPolicy, RoutingPolicySchema } from "./routing-policy.js";

export const OrgConfigSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  orgId: OrgIdSchema,
  routingPolicy: RoutingPolicySchema,
  examinationPolicy: ExaminationPolicySchema,
  /** 0 for the seeded default nobody has written; 1 for the first write, and so on. */
  version: z.int().min(0),
  updatedAt: IsoTimestampSchema,
});
export type OrgConfig = z.infer<typeof OrgConfigSchema>;

/** `PUT /orgs/{orgId}/config`: the policy, and the version this write replaces. */
export const OrgConfigBodySchema = z.strictObject({
  routingPolicy: RoutingPolicySchema,
  examinationPolicy: ExaminationPolicySchema,
  /** The version the writer read. The stored config must still be at it. */
  replacesVersion: z.int().min(0),
});
export type OrgConfigBody = z.infer<typeof OrgConfigBodySchema>;

/**
 * The policy a run executes under (D-P8-03): the org's, narrowed by the
 * repository and the contract, recorded on the run so the run means the same
 * thing whatever the org's configuration says later.
 */
export const EffectivePolicySchema = z.strictObject({
  routingPolicy: RoutingPolicySchema,
  examinationPolicy: ExaminationPolicySchema,
  /** The org configuration version it was narrowed from. */
  orgConfigVersion: z.int().min(0),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

/**
 * Low risk not examined; medium examined by a different model; high examined by
 * another provider's frontier model (P8 §4.2, the owner's answer to Q10). A
 * material finding blocks at both: the owner's amendment of 2026-09-26, after the
 * first planned runs on foodfly landed material advisory findings nothing fixed.
 * Minor findings are reported and never block.
 */
export const DEFAULT_EXAMINATION_POLICY: ExaminationPolicy = {
  low: {
    required: false,
    mustDifferModel: false,
    mustDifferProvider: false,
    blockOnMaterialFindings: false,
  },
  medium: {
    required: true,
    mustDifferModel: true,
    mustDifferProvider: false,
    blockOnMaterialFindings: true,
  },
  high: {
    required: true,
    mustDifferModel: true,
    mustDifferProvider: true,
    blockOnMaterialFindings: true,
  },
};

/**
 * What a new org starts with: one ladder per harness that runs on the
 * operator's own sign-in, cheapest first, as checked against each CLI's own
 * model list on 2026-09-25 (P8 §3.1). A starting point for an org to replace,
 * not a recommendation; the models are the ones the owner's org uses.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  ladders: {
    claude: [
      { tier: "cheap", routes: [{ harness: "claude", model: "claude-haiku-4-5-20251001" }] },
      { tier: "standard", routes: [{ harness: "claude", model: "claude-sonnet-5" }] },
      { tier: "frontier", routes: [{ harness: "claude", model: "claude-opus-5-5" }] },
    ],
    codex: [
      { tier: "cheap", routes: [{ harness: "codex", model: "gpt-6-luna" }] },
      { tier: "standard", routes: [{ harness: "codex", model: "gpt-6-sol" }] },
      { tier: "frontier", routes: [{ harness: "codex", model: "gpt-6-astra" }] },
    ],
  },
  rules: [
    {
      id: "R-orchestrate",
      when: { kind: ["orchestrate"] },
      start: { ladder: "claude", tier: "frontier" },
    },
    { id: "R-high", when: { risk: ["high"] }, start: { ladder: "claude", tier: "frontier" } },
    {
      id: "R-bounded",
      when: { risk: ["low"], ambiguity: ["low"], testability: ["strong"] },
      start: { ladder: "claude", tier: "cheap" },
    },
    { id: "R-default", when: {}, start: { ladder: "claude", tier: "standard" } },
  ],
  unavailable: [],
  prices: {},
};

/** The configuration an org has before anyone writes one: version 0, never stored. */
export const defaultOrgConfig = (orgId: OrgConfig["orgId"], at: string): OrgConfig => ({
  schemaVersion: 1,
  orgId,
  routingPolicy: DEFAULT_ROUTING_POLICY,
  examinationPolicy: DEFAULT_EXAMINATION_POLICY,
  version: 0,
  updatedAt: at,
});
