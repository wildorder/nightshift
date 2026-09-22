/**
 * `nightshift.config.json` — a repository's project-wide defaults (P7, D-P7-03).
 *
 * A product runs many programs over its life, each in `docs/programs/{id}/`.
 * What is true of every one of them is stated once, here, and a program's
 * contract **inherits what it does not state**: a contract that names its own
 * `verification` keeps it, one that does not gets the project's. Not a record
 * and never sent to the control plane: the contract that is ratified and run is
 * the merged one, so the control plane holds everything it needs (A-06).
 */
import { z } from "zod";
import { ProjectIdSchema } from "../ids.js";
import { RiskLevelSchema } from "./common.js";
import {
  CostPolicySchema,
  DelegationLimitsSchema,
  ExaminationPolicySchema,
  ModelPolicySchema,
  VerificationStepSchema,
} from "./program-contract.js";

export const NIGHTSHIFT_CONFIG_FILE = "nightshift.config.json";

/** Where a program's documents live, relative to the repository root (D-P7-03). */
export const PROGRAMS_DIRECTORY = "docs/programs";

export const NightshiftConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: ProjectIdSchema,
  /** The product vision `plan-program` reads first. Repository-relative. */
  visionPath: z.string().min(1).optional(),
  /** Other documents every plan should be written in the light of. */
  contextDocs: z.array(z.string().min(1)),
  verification: z.array(VerificationStepSchema).min(1),
  modelPolicy: ModelPolicySchema,
  delegationLimits: DelegationLimitsSchema,
  costPolicy: CostPolicySchema,
  /**
   * Required of every contract and rarely a program's own to decide, so they
   * default here too. Beyond D-P7-03's list, and optional for that reason.
   */
  examinationPolicy: ExaminationPolicySchema.optional(),
  defaultRisk: RiskLevelSchema.optional(),
});
export type NightshiftConfig = z.infer<typeof NightshiftConfigSchema>;

/** The contract fields a config can supply. */
export const INHERITED_CONTRACT_FIELDS = [
  "projectId",
  "verification",
  "modelPolicy",
  "delegationLimits",
  "costPolicy",
  "examinationPolicy",
  "defaultRisk",
] as const;

/**
 * An authored contract with the project's defaults under it. What the contract
 * states always wins; what neither states is left absent for the contract's own
 * schema to refuse. Takes and returns `unknown` on purpose: the result has not
 * been validated, and only `ProgramContractSchema` says whether it is a contract.
 */
export const inheritFromConfig = (contract: unknown, config: NightshiftConfig): unknown => {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return contract;
  const stated = contract as Record<string, unknown>;
  const defaults: Record<string, unknown> = {};
  for (const field of INHERITED_CONTRACT_FIELDS) {
    if (stated[field] === undefined && config[field] !== undefined) defaults[field] = config[field];
  }
  return { ...defaults, ...stated };
};
