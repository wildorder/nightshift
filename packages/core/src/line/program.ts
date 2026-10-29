/**
 * The project's line program: the program a line owner session is a run of.
 *
 * The plane makes it when a project first names a line, so a client never
 * writes one. Its id is derived from the project and the branch, so two
 * requests racing to make it make the same one.
 */
import { createHash } from "node:crypto";
import {
  type LineConfig,
  type ProgramContract,
  type ProgramId,
  ProgramIdSchema,
  type ProjectId,
} from "@nightshift/contracts";
import { ProgramContractExistsError } from "../errors.js";
import type { ProjectStores } from "../ports/stores.js";

/** Crockford base32, the ULID alphabet. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The one success criterion of every line program. */
export const LINE_PROGRAM_CRITERION =
  "every published range is composed onto the line or parked with its reason";

/** The line program's identifier for a project's line branch: stable, and valid. */
export const lineProgramId = (projectId: ProjectId, branch: string): ProgramId => {
  const digest = createHash("sha256").update(`line\n${projectId}\n${branch}`).digest();
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
    if (out.length === 26) break;
  }
  return ProgramIdSchema.parse(`prog_${out}`);
};

export const isLineProgram = (contract: ProgramContract): boolean => contract.kind === "line";

/** The honest contract of a project's line program, from the line setting and the program that named it. */
export const lineProgramContract = (input: {
  readonly projectId: ProjectId;
  readonly line: LineConfig;
  readonly naming: ProgramContract;
  readonly createdAt: string;
}): ProgramContract => {
  const { projectId, line, naming, createdAt } = input;
  return {
    schemaVersion: naming.schemaVersion,
    projectId,
    programId: lineProgramId(projectId, line.branch),
    objective: `Keep the project line ${line.branch} composed: every range published to it is composed onto the line or parked.`,
    repository: {
      url: naming.repository.url,
      baseBranch: naming.repository.baseBranch,
      programBranch: line.branch,
    },
    successCriteria: [{ id: "line-composed", outcome: LINE_PROGRAM_CRITERION }],
    constraints: [],
    scope: naming.scope,
    ...(naming.setup === undefined ? {} : { setup: naming.setup }),
    ...(naming.secrets === undefined ? {} : { secrets: naming.secrets }),
    verification: naming.verification,
    modelPolicy: naming.modelPolicy,
    examinationPolicy: naming.examinationPolicy,
    delegationLimits: naming.delegationLimits,
    costPolicy: naming.costPolicy,
    defaultRisk: naming.defaultRisk,
    ...(naming.routing === undefined ? {} : { routing: naming.routing }),
    ...(naming.compute === undefined ? {} : { compute: naming.compute }),
    line,
    kind: "line",
    createdAt,
  };
};

/**
 * The stored line program for the project and branch, created when none is. A
 * creation that lost a race reads back the winner's.
 */
export const ensureLineProgram = async (
  stores: Pick<ProjectStores, "programContracts">,
  input: {
    readonly projectId: ProjectId;
    readonly naming: ProgramContract;
    readonly createdAt: string;
  },
): Promise<ProgramContract> => {
  const line = input.naming.line;
  if (line === undefined) throw new Error("ensureLineProgram: the naming program has no line");
  const programId = lineProgramId(input.projectId, line.branch);
  const stored = await stores.programContracts.get(input.projectId, programId);
  if (stored !== undefined) return stored;
  const contract = lineProgramContract({ ...input, line });
  try {
    await stores.programContracts.create(contract);
    return contract;
  } catch (error) {
    if (!(error instanceof ProgramContractExistsError)) throw error;
    const winner = await stores.programContracts.get(input.projectId, programId);
    if (winner === undefined) throw error;
    return winner;
  }
};
