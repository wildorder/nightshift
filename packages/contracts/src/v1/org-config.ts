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
import { ComputeCeilingsSchema } from "./compute.js";
import { GitHubInstallationSchema } from "./credentials.js";
import { type ExaminationPolicy, ExaminationPolicySchema } from "./program-contract.js";
import { type RoutingPolicy, RoutingPolicySchema } from "./routing-policy.js";

const OrgConfigRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  orgId: OrgIdSchema,
  routingPolicy: RoutingPolicySchema,
  examinationPolicy: ExaminationPolicySchema,
  /**
   * P10 (D-P10-19): the org's compute ceilings. Absent means the shipped
   * defaults, `DEFAULT_COMPUTE_CEILINGS`; a project or program may only lower them.
   */
  compute: ComputeCeilingsSchema.optional(),
  /**
   * P10 (D-P10-02, D-P10-28): the GitHub App installations this org granted,
   * one per GitHub account, written by `org github install` and never by a
   * client's claim alone. Dispatch matches a repository against any of them.
   */
  installations: z.array(GitHubInstallationSchema),
  /** 0 for the seeded default nobody has written; 1 for the first write, and so on. */
  version: z.int().min(0),
  updatedAt: IsoTimestampSchema,
});

/**
 * Until D-P10-28 (2026-10-08) an org held one installation, under `github`.
 * A stored record of that shape is read as a one-element set; the next write
 * stores the set. Nothing writes `github` any more.
 */
const liftSingleInstallation = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || !("github" in raw) || "installations" in raw) {
    return raw;
  }
  const { github, ...rest } = raw as { github?: unknown };
  return { ...rest, installations: github === undefined ? [] : [github] };
};

export const OrgConfigSchema = z.preprocess(liftSingleInstallation, OrgConfigRecordSchema);
export type OrgConfig = z.infer<typeof OrgConfigRecordSchema>;

/**
 * `PUT /orgs/{orgId}/config`: the policy, and the version this write replaces.
 * `installations` is not here: an installation is recorded by its own route,
 * which verifies it through the App, and a config write leaves the set as it is.
 */
export const OrgConfigBodySchema = z.strictObject({
  routingPolicy: RoutingPolicySchema,
  examinationPolicy: ExaminationPolicySchema,
  compute: ComputeCeilingsSchema.optional(),
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
 * What a new org starts with: for each role, Anthropic's model then OpenAI's
 * at the same standing, so a usage limit on either falls back to the other.
 * The implementer starts on each provider's workhorse and escalates to its
 * frontier model on a retry. A starting point for an org to replace, not a
 * recommendation.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  roles: {
    orchestrator: [
      { harness: "claude", model: "claude-opus-5-5" },
      { harness: "codex", model: "gpt-6-astra" },
    ],
    implementer: [
      { harness: "claude", model: "claude-sonnet-5" },
      { harness: "codex", model: "gpt-6-sol" },
      { harness: "claude", model: "claude-opus-5-5" },
      { harness: "codex", model: "gpt-6-astra" },
    ],
    examiner: [
      { harness: "codex", model: "gpt-6-astra" },
      { harness: "claude", model: "claude-opus-5-5" },
      { harness: "codex", model: "gpt-6-sol" },
      { harness: "claude", model: "claude-sonnet-5" },
    ],
    arbiter: [
      { harness: "claude", model: "claude-opus-5-5" },
      { harness: "codex", model: "gpt-6-astra" },
    ],
  },
  unavailable: [],
  prices: {},
};

/** The configuration an org has before anyone writes one: version 0, never stored. */
export const defaultOrgConfig = (orgId: OrgConfig["orgId"], at: string): OrgConfig => ({
  schemaVersion: 1,
  orgId,
  routingPolicy: DEFAULT_ROUTING_POLICY,
  examinationPolicy: DEFAULT_EXAMINATION_POLICY,
  installations: [],
  version: 0,
  updatedAt: at,
});
