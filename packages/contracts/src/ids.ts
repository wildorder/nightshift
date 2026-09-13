/**
 * Prefixed ULID identifiers (decision D-P1-07).
 *
 * Shape: `<prefix>_<26 Crockford base32 characters>`. Crockford base32 excludes
 * I, L, O and U, which is why the character class looks irregular.
 *
 * This module only *validates* IDs. Generation lives in `@nightshift/core`,
 * where it takes an injected clock and randomness source so that tests are
 * deterministic; `contracts` stays free of any generator.
 */
import { z } from "zod";

/** Crockford base32, the ULID alphabet: 0-9 and A-Z minus I, L, O, U. */
const CROCKFORD_BASE32 = "[0-9A-HJKMNP-TV-Z]";

/** The random-plus-time payload of a ULID is always 26 characters. */
const ULID_LENGTH = 26;

const idPattern = (prefix: string): RegExp =>
  new RegExp(`^${prefix}_${CROCKFORD_BASE32}{${ULID_LENGTH}}$`);

const rawId = (prefix: string) =>
  z.string().regex(idPattern(prefix), {
    message: `must be "${prefix}_" followed by ${ULID_LENGTH} Crockford base32 characters`,
  });

export const ProjectIdSchema = rawId("proj").brand<"ProjectId">();
export const ProgramIdSchema = rawId("prog").brand<"ProgramId">();
export const RunIdSchema = rawId("run").brand<"RunId">();
export const ExecutionNodeIdSchema = rawId("node").brand<"ExecutionNodeId">();
export const JobContractIdSchema = rawId("job").brand<"JobContractId">();
export const AgentIdSchema = rawId("agent").brand<"AgentId">();
export const DecisionIdSchema = rawId("dec").brand<"DecisionId">();
export const CheckpointIdSchema = rawId("ckpt").brand<"CheckpointId">();
export const VerificationIdSchema = rawId("ver").brand<"VerificationId">();
export const ExaminationIdSchema = rawId("exam").brand<"ExaminationId">();
export const RoutingDecisionIdSchema = rawId("route").brand<"RoutingDecisionId">();
export const ArtifactIdSchema = rawId("art").brand<"ArtifactId">();
export const EventIdSchema = rawId("evt").brand<"EventId">();

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type ProgramId = z.infer<typeof ProgramIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type ExecutionNodeId = z.infer<typeof ExecutionNodeIdSchema>;
export type JobContractId = z.infer<typeof JobContractIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;
export type VerificationId = z.infer<typeof VerificationIdSchema>;
export type ExaminationId = z.infer<typeof ExaminationIdSchema>;
export type RoutingDecisionId = z.infer<typeof RoutingDecisionIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;

/**
 * Every ID prefix, keyed by prefix. `core`'s generator iterates this so a new
 * aggregate cannot be introduced without an ID prefix.
 */
export const ID_SCHEMAS = {
  proj: ProjectIdSchema,
  prog: ProgramIdSchema,
  run: RunIdSchema,
  node: ExecutionNodeIdSchema,
  job: JobContractIdSchema,
  agent: AgentIdSchema,
  dec: DecisionIdSchema,
  ckpt: CheckpointIdSchema,
  ver: VerificationIdSchema,
  exam: ExaminationIdSchema,
  route: RoutingDecisionIdSchema,
  art: ArtifactIdSchema,
  evt: EventIdSchema,
} as const;

export type IdPrefix = keyof typeof ID_SCHEMAS;

export const ID_PREFIXES = Object.keys(ID_SCHEMAS) as readonly IdPrefix[];

export type IdOf<P extends IdPrefix> = z.infer<(typeof ID_SCHEMAS)[P]>;

/** Any Nightshift identifier, useful where the specific aggregate is irrelevant. */
export type AnyId = IdOf<IdPrefix>;

/**
 * Parses `value` as an identifier of `prefix`, throwing `ZodError` when it is
 * not one. Use when narrowing an untrusted string into a branded ID.
 */
export const parseId = <P extends IdPrefix>(prefix: P, value: unknown): IdOf<P> =>
  ID_SCHEMAS[prefix].parse(value) as IdOf<P>;

/** Non-throwing counterpart to {@link parseId}. */
export const isId = <P extends IdPrefix>(prefix: P, value: unknown): value is IdOf<P> =>
  ID_SCHEMAS[prefix].safeParse(value).success;

/** The prefix of an identifier, or `undefined` when `value` is not one. */
export const idPrefixOf = (value: string): IdPrefix | undefined =>
  ID_PREFIXES.find((prefix) => ID_SCHEMAS[prefix].safeParse(value).success);
