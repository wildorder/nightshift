/**
 * `nightshift gates {id} --record` and `--recorded`, and what `plan check`
 * asks of the gates (P15, D-P15-01, D-P15-02, D-P15-07, D-P15-08).
 *
 * `--record` runs the mechanical audit exactly as `nightshift gates` does and
 * writes the project's gate-health record over the control plane: `healthy`
 * with no findings and green gates, `repairing` otherwise, fingerprinted at the
 * commit it audited over the gate machinery the planning review named. Only
 * this command and the engine write it, never a file in the repository.
 *
 * `--recorded` runs no gate: it reads the record and says whether it still
 * holds for the gates on the program branch's head.
 */
import { readFile } from "node:fs/promises";
import {
  type GateFinding,
  GateFindingSchema,
  type GateHealth,
  type ProgramContract,
  type ProjectId,
  RepositoryPathSchema,
  UserPrincipalSchema,
} from "@nightshift/contracts";
import { gateHealthReasons, nowIso, type PlanReason } from "@nightshift/core";
import { type GateAudit, revParse } from "@nightshift/execution";
import { isTokenProfile, tokenClaims } from "@nightshift/persistence/http";
import { z } from "zod";
import type { CliEnvironment } from "../environment.js";
import { describeFailure, UsageError } from "../failures.js";
import { fingerprintAtCommit, gitBlobReader, type ReadBlob } from "../gate-fingerprint.js";
import { type ProgramFiles, readProgramFiles, resolveFrom } from "../program-files.js";
import { type FreshSession, openFreshSession, openSession, type Session } from "../session.js";
import { auditContractOf, auditProgramGates, describeAudit } from "./gates.js";

export interface RecordGatesOptions {
  readonly id: string;
  readonly repo?: string;
  /** The planning review's findings file: `{ machinery, findings }`. */
  readonly findings?: string;
}

export interface RecordedGatesOptions {
  readonly id: string;
  readonly repo?: string;
}

/** What the planning review writes, outside the program directory (skills/plan-program, step 3a). */
const FindingsFileSchema = z.strictObject({
  machinery: z.array(RepositoryPathSchema),
  findings: z.array(GateFindingSchema),
});

interface Review {
  readonly machinery: readonly string[];
  readonly findings: readonly GateFinding[];
}

const short = (sha: string): string => sha.slice(0, 8);

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const refuse = (environment: CliEnvironment, problems: readonly string[], file: string): number => {
  environment.err(
    `${file} is refused: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}`,
  );
  for (const problem of problems) environment.err(`  - ${problem}`);
  environment.err("Nothing was recorded.");
  return 1;
};

/** The findings file, read and checked against the contracts' schemas; every problem at once. */
const readReview = async (
  environment: CliEnvironment,
  path: string,
): Promise<{ readonly review?: Review; readonly problems: readonly string[] }> => {
  let text: string;
  try {
    text = await readFile(resolveFrom(environment.cwd, path), "utf8");
  } catch (cause) {
    throw new UsageError(
      `cannot read the findings file ${path}`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return {
      problems: [`it is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
  const parsed = FindingsFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? "(the file)" : issue.path.join(".")}: ${issue.message}`,
      ),
    };
  }
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const finding of parsed.data.findings) {
    if (seen.has(finding.id)) problems.push(`finding ${finding.id} appears more than once`);
    seen.add(finding.id);
  }
  return { review: parsed.data, problems };
};

/** What the findings name that this contract and this commit do not have. */
const reviewProblems = async (
  review: Review,
  contract: ProgramContract,
  read: ReadBlob,
  commit: string,
): Promise<string[]> => {
  const problems: string[] = [];
  const decisions = new Set((contract.decisions ?? []).map((decision) => decision.id));
  for (const finding of review.findings) {
    if (!decisions.has(finding.decisionId)) {
      problems.push(
        `finding ${finding.id} is answered by ${finding.decisionId}, which is not a decision in the contract's \`decisions\``,
      );
    }
  }
  const named = [
    ...review.machinery.map((path) => ({ path, by: "machinery" })),
    ...review.findings.flatMap((finding) =>
      finding.paths.map((path) => ({ path, by: `finding ${finding.id}` })),
    ),
  ];
  for (const { path, by } of named) {
    if ((await read(commit, path)) === undefined) {
      problems.push(`${by} names ${path}, which is not a file at ${short(commit)}`);
    }
  }
  return problems;
};

/** "Not signed in", said plainly, or whatever else kept the control plane out of reach. */
const sessionProblem = (error: unknown): string => {
  const failure = describeFailure(error);
  if (failure.code === "not_logged_in") return "you are not signed in: run `nightshift login`";
  return `the control plane could not be reached (${failure.code}): ${failure.summary}${
    failure.advice === undefined ? "" : ` ${failure.advice}`
  }`;
};

/** The signed-in operator, as the record names them. The control plane holds it to the caller. */
const principalOf = (session: FreshSession, orgId: string) =>
  UserPrincipalSchema.parse({
    kind: "user",
    userId: isTokenProfile(session.profile) ? "local-operator" : tokenClaims(session.idToken).sub,
    orgId,
  });

/** A signed-in session and the project's organisation, or why not, said. */
const signedIn = async (
  environment: CliEnvironment,
  projectId: ProjectId,
): Promise<{ readonly session: FreshSession; readonly orgId: string } | undefined> => {
  try {
    const session = await openFreshSession(environment);
    const project = await session.stores.projects.get(projectId);
    if (project !== undefined) return { session, orgId: project.orgId };
    environment.err(
      `project ${projectId} is not on the control plane, so it has nowhere to keep the record. Nothing was recorded.`,
    );
  } catch (error) {
    environment.err(`cannot record the audit: ${sessionProblem(error)}. Nothing was recorded.`);
  }
  return undefined;
};

/** Why an audit that ran cannot be recorded, if it cannot. */
const auditRefusal = (
  id: string,
  branch: string,
  head: string,
  audit: GateAudit,
  review: Review,
): string | undefined => {
  if (audit.base !== head) {
    return `${branch} moved from ${short(head)} to ${short(audit.base)} during the audit. Nothing was recorded; run it again.`;
  }
  if (!audit.red || review.findings.length > 0) return undefined;
  return (
    `refused: ${audit.failing.join(", ")} ${audit.failing.length === 1 ? "is" : "are"} red and the audit has no findings. ` +
    "A red gate needs a finding that answers it: review it against the gate standard, " +
    `then \`nightshift gates ${id} --record --findings <file>\`. Nothing was recorded.`
  );
};

const describeRecord = (environment: CliEnvironment, record: GateHealth): void => {
  environment.out(`recorded the gates as ${record.verdict}`);
  environment.out(`  fingerprint ${record.fingerprint.slice(0, 12)}`);
  environment.out(`  commit      ${record.commit}`);
  environment.out(
    `  machinery   ${record.machinery.length === 0 ? "(none named)" : record.machinery.join(", ")}`,
  );
  if (record.verdict === "repairing") {
    environment.out(
      `  findings    ${record.findings.map((finding) => `${finding.id} → ${finding.decisionId}`).join(", ")}`,
    );
  }
};

/** Exit code 0 when the record was written, 1 when it was refused; nothing is written then. */
export const recordGates = async (
  environment: CliEnvironment,
  options: RecordGatesOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);

  let review: Review = { machinery: [], findings: [] };
  if (options.findings !== undefined) {
    const read = await readReview(environment, options.findings);
    if (read.review === undefined || read.problems.length > 0) {
      return refuse(environment, read.problems, options.findings);
    }
    review = read.review;
  }

  // Signed in, before minutes of gates: the record is the control plane's.
  const signed = await signedIn(environment, files.contract.projectId);
  if (signed === undefined) return 1;

  // The contract `nightshift gates` would audit, so the record is of that audit.
  const contract = await auditContractOf(environment, files, signed.session);
  const branch = contract.repository.programBranch;
  const read = gitBlobReader(repoPath);
  const head = await revParse(environment.git, repoPath, branch);
  // The decisions are the plan's being written: the contract on disk.
  const problems = await reviewProblems(review, files.contract, read, head);
  if (problems.length > 0) return refuse(environment, problems, options.findings ?? "the audit");

  const audit = await auditProgramGates(environment, contract, repoPath);
  describeAudit(environment, audit);
  const refusal = auditRefusal(options.id, branch, head, audit, review);
  if (refusal !== undefined) {
    environment.err(refusal);
    return 1;
  }

  const machinery = sortedUnique([
    ...review.machinery,
    ...review.findings.flatMap((finding) => finding.paths),
  ]);
  const record: GateHealth = {
    schemaVersion: 1,
    projectId: files.contract.projectId,
    programId: files.contract.programId,
    commit: audit.base as GateHealth["commit"],
    // Over the commands this audit ran, at the commit it ran them on.
    fingerprint: await fingerprintAtCommit(read, audit.base, contract, machinery),
    verdict: review.findings.length === 0 && !audit.red ? "healthy" : "repairing",
    findings: [...review.findings],
    machinery,
    auditedBy: principalOf(signed.session, signed.orgId),
    auditedAt: nowIso(environment.clock),
  };
  await signed.session.stores.gateHealth.put(record);
  describeRecord(environment, record);
  return 0;
};

/**
 * The current fingerprint of the gates `files` states, on the program branch's
 * head, over the record's machinery: what the record is held to.
 */
const currentFingerprint = async (
  environment: CliEnvironment,
  repoPath: string,
  files: ProgramFiles,
  record: GateHealth,
): Promise<{ readonly head: string; readonly fingerprint: string }> => {
  const head = await revParse(environment.git, repoPath, files.contract.repository.programBranch);
  const fingerprint = await fingerprintAtCommit(
    gitBlobReader(repoPath),
    head,
    files.contract,
    record.machinery,
  );
  return { head, fingerprint };
};

const readRecord = async (
  environment: CliEnvironment,
  projectId: ProjectId,
): Promise<
  { readonly ok: true; readonly record?: GateHealth } | { readonly ok: false; readonly why: string }
> => {
  let session: Session;
  try {
    session = await openSession(environment);
    const record = await session.stores.gateHealth.get(projectId);
    return { ok: true, ...(record === undefined ? {} : { record }) };
  } catch (error) {
    return { ok: false, why: sessionProblem(error) };
  }
};

/** Exit code 0 only when a healthy record matches the gates now; 1 otherwise, saying which. */
export const recordedGates = async (
  environment: CliEnvironment,
  options: RecordedGatesOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const read = await readRecord(environment, files.contract.projectId);
  if (!read.ok) {
    environment.err(`cannot read the project's gate-health record: ${read.why}`);
    return 1;
  }
  const { record } = read;
  if (record === undefined) {
    environment.err(
      `no gate-health record: the project's gates have never been audited. Run \`nightshift gates ${options.id} --record\`.`,
    );
    return 1;
  }
  const { head, fingerprint } = await currentFingerprint(environment, repoPath, files, record);
  const matches = fingerprint === record.fingerprint;
  environment.out(`verdict     ${record.verdict}`);
  environment.out(`audited     ${record.commit} (${record.auditedAt})`);
  environment.out(
    `fingerprint ${record.fingerprint.slice(0, 12)} ${
      matches ? "matches" : `does not match ${fingerprint.slice(0, 12)}`
    }, the gates on ${files.contract.repository.programBranch} at ${short(head)}`,
  );
  if (!matches) {
    environment.err(
      `stale: the gates changed since the audit at ${short(record.commit)} (their setup, commands, lockfiles or named machinery). Audit them again.`,
    );
    return 1;
  }
  if (record.verdict !== "healthy") {
    environment.err(
      `repairing: ${record.findings.length} ${record.findings.length === 1 ? "finding is" : "findings are"} being fixed (${record.findings
        .map((finding) => `${finding.id} → ${finding.decisionId}`)
        .join(", ")}).`,
    );
    return 1;
  }
  environment.out("the record holds: the gates are healthy and unchanged since the audit");
  return 0;
};

/**
 * `plan check`'s gate-health reasons (D-P15-08). Never throws: a record that
 * cannot be read, or a fingerprint that cannot be computed, is itself a reason.
 */
export const gateHealthReadiness = async (
  environment: CliEnvironment,
  repoPath: string,
  files: ProgramFiles,
): Promise<PlanReason[]> => {
  const read = await readRecord(environment, files.contract.projectId);
  if (!read.ok) {
    return [
      {
        kind: "gate_health_unreadable",
        message: `could not read the project's gate-health record: ${read.why}`,
      },
    ];
  }
  if (read.record === undefined) return gateHealthReasons(files.contract, undefined, "", files.id);
  try {
    const { fingerprint } = await currentFingerprint(environment, repoPath, files, read.record);
    return gateHealthReasons(files.contract, read.record, fingerprint, files.id);
  } catch (error) {
    return [
      {
        kind: "gate_health_unreadable",
        message: `could not fingerprint the gates on ${files.contract.repository.programBranch}: ${describeFailure(error).summary}`,
      },
    ];
  }
};
