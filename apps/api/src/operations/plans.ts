/**
 * Planning: ratification, the plan document, human prerequisites (P7, T1).
 *
 * ## What ratifying checks, and why here
 *
 * The CLI computes the hash and the readiness of a plan before it asks. None of
 * that is trusted. The control plane reads the document it was sent **from its
 * own object store**, hashes those bytes, recomputes the plan hash from the
 * contract in the request, and runs the same deterministic readiness check
 * (`checkPlan` in `core`). What it records is therefore what it holds: a
 * `planDocument` whose `sha256` is the digest of bytes it can serve back
 * (SC-P7-04), under a hash of exactly the contract it stored.
 *
 * ## Who marks a prerequisite satisfied
 *
 * Nobody says "satisfied". The write carries the exit code of the
 * `verifyCommand` and the status follows from it, so the only way to satisfy a
 * prerequisite is to report a zero exit (D-P7-05). `authorize` keeps the route
 * to user principals: an execution token may read prerequisites and write none.
 */
import { createHash } from "node:crypto";
import {
  MAX_RATIFICATION_HISTORY,
  PLAN_DOCUMENT_CONTENT_TYPE,
  type PlanDocumentResponse,
  PlanDocumentUploadRequestBodySchema,
  type PlanDocumentUploadResponse,
  PlanHashSchema,
  type Prerequisite,
  PrerequisiteIdSchema,
  type PrerequisiteListResponse,
  PrerequisiteWriteBodySchema,
  type ProgramContract,
  ProgramContractSchema,
  type Ratification,
  RatificationRequestBodySchema,
} from "@nightshift/contracts";
import {
  checkPlan,
  explainCorrection,
  isPlanned,
  nowIso,
  type PlanDocumentStore,
  planHash,
  prerequisitesOf,
  splitPlanSections,
} from "@nightshift/core";
import { type ApiDeps, HttpError, parseBody } from "../http.js";
import { assertChainMatches, type PathParams, programScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireProgram, requireProject } from "./common.js";

const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const planStore = (deps: ApiDeps): PlanDocumentStore => {
  if (deps.plans === undefined) {
    throw new HttpError(
      501,
      "plans_unavailable",
      "this control plane was wired without a plan document store",
    );
  }
  return deps.plans;
};

const planSha256From = (params: PathParams): string => {
  const result = PlanHashSchema.safeParse(params.sha256);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_path",
      "path parameter sha256 is not a lowercase hex SHA-256",
      result.error.issues,
    );
  }
  return result.data;
};

export const createPlanUploadUrl: Handler = async ({ deps, request, params }) => {
  const body = parseBody(PlanDocumentUploadRequestBodySchema, request.body);
  const scope = programScopeFrom(params);
  const sha256 = planSha256From(params);
  // The project, not the program: a program's first ratification is what creates it.
  await requireProject(deps.stores, scope.projectId);

  const target = await planStore(deps).signUpload({
    scope,
    sha256,
    contentType: PLAN_DOCUMENT_CONTENT_TYPE,
    sizeBytes: body.sizeBytes,
  });
  const response: PlanDocumentUploadResponse = {
    sha256,
    uri: target.uri,
    uploadUrl: target.uploadUrl,
    key: target.key,
    contentType: target.contentType,
    expiresAt: target.expiresAt,
  };
  return { status: 200, body: response };
};

/** The stored bytes as text, held to the name they were stored under. */
const readPlanDocument = async (
  deps: ApiDeps,
  scope: ReturnType<typeof programScopeFrom>,
  sha256: string,
): Promise<{ readonly uri: string; readonly text: string; readonly sizeBytes: number }> => {
  const stored = await planStore(deps).get(scope, sha256);
  if (stored === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `no plan document ${sha256} is stored for program ${scope.programId}`,
    );
  }
  const actual = sha256Hex(stored.body);
  if (actual !== sha256) {
    throw new HttpError(
      422,
      "plan_document_mismatch",
      `the document stored as ${sha256} hashes to ${actual}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stored.body);
  } catch {
    throw new HttpError(422, "plan_document_mismatch", "the plan document is not UTF-8 text");
  }
  return { uri: stored.uri, text, sizeBytes: stored.body.length };
};

export const getPlanDocument: Handler = async ({ deps, params }) => {
  const scope = programScopeFrom(params);
  const sha256 = planSha256From(params);
  await requireProgram(deps.stores, scope);
  const document = await readPlanDocument(deps, scope, sha256);
  const response: PlanDocumentResponse = {
    planDocument: { uri: document.uri, sha256, sizeBytes: document.sizeBytes },
    text: document.text,
  };
  return { status: 200, body: response };
};

/**
 * A prerequisite keeps the check it already passed only while its
 * `verifyCommand` is the one that was run; anything a client says about status
 * is dropped. Hurdles the engine discovered (D-P7-10) are the control plane's
 * own record and survive a re-ratification.
 */
const carryPrerequisites = (
  existing: ProgramContract | undefined,
  next: ProgramContract,
): Prerequisite[] | undefined => {
  const before = existing === undefined ? [] : prerequisitesOf(existing);
  const planned = prerequisitesOf(next)
    .filter((prerequisite) => prerequisite.discoveredInRunId === undefined)
    .map(({ status: _status, lastCheck: _lastCheck, ...prerequisite }): Prerequisite => {
      const was = before.find((candidate) => candidate.id === prerequisite.id);
      return was !== undefined && was.verifyCommand === prerequisite.verifyCommand
        ? {
            ...prerequisite,
            status: was.status,
            ...(was.lastCheck === undefined ? {} : { lastCheck: was.lastCheck }),
          }
        : { ...prerequisite, status: "pending" };
    });
  const discovered = before.filter(
    (prerequisite) =>
      prerequisite.discoveredInRunId !== undefined &&
      !planned.some((candidate) => candidate.id === prerequisite.id),
  );
  const all = [...planned, ...discovered];
  return all.length === 0 && next.prerequisites === undefined ? undefined : all;
};

/**
 * A correction may name only decisions of this project that a human has
 * reversed (P9, D-P9-04). Read from the project's own partitions: the chain in
 * the contract is the caller's, and the project was already checked.
 */
const assertCorrectable = async (deps: ApiDeps, contract: ProgramContract): Promise<void> => {
  const problems: string[] = [];
  for (const target of contract.corrects ?? []) {
    const scope = {
      projectId: contract.projectId,
      programId: target.programId,
      runId: target.runId,
    };
    problems.push(
      ...explainCorrection({
        target,
        decision: await deps.stores.decisions.get(scope, target.decisionId),
        reversal: await deps.stores.decisions.get(scope, target.reversedBy),
      }),
    );
  }
  if (problems.length > 0) {
    throw new HttpError(422, "correction_invalid", problems.join("; "));
  }
};

export const ratifyProgram: Handler = async ({ deps, request, params }) => {
  const body = parseBody(RatificationRequestBodySchema, request.body);
  const scope = programScopeFrom(params);
  assertChainMatches(scope, body.contract);
  await requireProject(deps.stores, scope.projectId);

  if (!isPlanned(body.contract)) {
    throw new HttpError(
      422,
      "plan_not_ready",
      "the contract has no strands, so there is no plan to ratify; it runs as it is",
    );
  }

  const document = await readPlanDocument(deps, scope, body.planSha256);
  const computed = planHash(body.contract, document.text, sha256Hex);
  if (computed.plan !== body.planSha256) {
    // Only a document stored with CRLF line endings gets here: it is hashed as
    // stored above, and as normalised by `planHash`.
    throw new HttpError(
      422,
      "plan_document_mismatch",
      "the plan document must be uploaded with LF line endings, as it is hashed",
    );
  }
  if (computed.hash !== body.planHash) {
    throw new HttpError(
      422,
      "plan_hash_mismatch",
      `the plan hash is ${computed.hash} for this contract and document, not ${body.planHash}`,
    );
  }

  const readiness = checkPlan(body.contract, splitPlanSections(document.text));
  if (!readiness.ready) {
    throw new HttpError(
      422,
      "plan_not_ready",
      `the plan is not ready: ${readiness.reasons.map((reason) => reason.message).join("; ")}`,
      readiness.reasons,
    );
  }

  await assertCorrectable(deps, body.contract);

  const existing = await deps.stores.programContracts.get(scope.projectId, scope.programId);
  // Ratifying what is already ratified is a retry, not a second ratification.
  if (existing?.status === "ratified" && existing.planHash === computed.hash) {
    return { status: 200, body: existing };
  }

  const ratification: Ratification = {
    planHash: computed.hash,
    planDocument: { uri: document.uri, sha256: computed.plan, sizeBytes: document.sizeBytes },
    ratifiedAt: nowIso(deps.clock),
  };
  const prerequisites = carryPrerequisites(existing, body.contract);
  const ratified = ProgramContractSchema.parse({
    ...body.contract,
    ...(prerequisites === undefined ? {} : { prerequisites }),
    status: "ratified",
    planHash: ratification.planHash,
    planDocument: ratification.planDocument,
    ratifications: [...(existing?.ratifications ?? []), ratification].slice(
      -MAX_RATIFICATION_HISTORY,
    ),
  });
  await deps.stores.programContracts.put(ratified);
  return { status: existing === undefined ? 201 : 200, body: ratified };
};

export const listPrerequisites: Handler = async ({ deps, params }) => {
  const program = await requireProgram(deps.stores, programScopeFrom(params));
  const response: PrerequisiteListResponse = { items: [...prerequisitesOf(program)] };
  return { status: 200, body: response };
};

const prerequisiteIdFrom = (params: PathParams): string => {
  const result = PrerequisiteIdSchema.safeParse(params.prerequisiteId);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_path",
      'path parameter prerequisiteId must look like "HP-01"',
      result.error.issues,
    );
  }
  return result.data;
};

export const putPrerequisite: Handler = async ({ deps, request, params }) => {
  const body = parseBody(PrerequisiteWriteBodySchema, request.body);
  const scope = programScopeFrom(params);
  const id = prerequisiteIdFrom(params);
  const program = await requireProgram(deps.stores, scope);
  const all = [...prerequisitesOf(program)];
  const index = all.findIndex((candidate) => candidate.id === id);
  const existing = all[index];

  let next: Prerequisite;
  if (body.kind === "check") {
    if (existing === undefined) {
      throw new HttpError(404, "not_found", `program ${scope.programId} has no prerequisite ${id}`);
    }
    next = {
      ...existing,
      status: body.exitCode === 0 ? "satisfied" : "pending",
      lastCheck: { exitCode: body.exitCode, checkedAt: nowIso(deps.clock) },
    };
    all[index] = next;
  } else {
    if (existing !== undefined) {
      // A hurdle met twice is one hurdle; a planned id is never overwritten by a run.
      if (existing.discoveredInRunId === body.runId) return { status: 200, body: existing };
      throw new HttpError(409, "conflict", `prerequisite ${id} already exists`);
    }
    const run = await deps.stores.runs.get(scope, body.runId);
    if (run === undefined) {
      throw new HttpError(404, "not_found", `run ${body.runId} does not exist in this program`);
    }
    next = {
      id,
      description: body.description,
      remediation: body.remediation,
      verifyCommand: body.verifyCommand,
      status: "pending",
      discoveredInRunId: body.runId,
    };
    all.push(next);
  }

  // Neither write touches what was ratified: statuses and discovered hurdles
  // are outside the plan hash, so the contract stays ratified as it was.
  await deps.stores.programContracts.put(
    ProgramContractSchema.parse({ ...program, prerequisites: all }),
  );
  return { status: existing === undefined ? 201 : 200, body: next };
};
