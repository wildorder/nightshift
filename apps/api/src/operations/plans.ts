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
import {
  PLAN_DOCUMENT_CONTENT_TYPE,
  type PlanDocumentResponse,
  PlanDocumentUploadRequestBodySchema,
  type PlanDocumentUploadResponse,
  PlanHashSchema,
  type Prerequisite,
  PrerequisiteIdSchema,
  type PrerequisiteListResponse,
  type PrerequisiteWriteBody,
  PrerequisiteWriteBodySchema,
  type Principal,
  ProgramContractSchema,
  RatificationBodySchema,
} from "@nightshift/contracts";
import { nowIso, prerequisitesOf, withLaptopCheck, withMachineCheck } from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import { assertChainMatches, type PathParams, programScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireProgram, requireProject } from "./common.js";
import { ratifyDraftVersion } from "./plan-drafts.js";
import { planStore, ratifyContract, readPlanDocument } from "./ratification.js";

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

export const getPlanDocument: Handler = async ({ deps, params }) => {
  const scope = programScopeFrom(params);
  const sha256 = planSha256From(params);
  // A draft's documents are readable before its program record exists, which is
  // only from the first ratification.
  const program = await deps.stores.programContracts.get(scope.projectId, scope.programId);
  if (
    program === undefined &&
    (await deps.stores.planDrafts.get(scope.projectId, scope.programId)) === undefined
  ) {
    await requireProgram(deps.stores, scope);
  }
  const document = await readPlanDocument(deps, scope, sha256);
  const response: PlanDocumentResponse = {
    planDocument: { uri: document.uri, sha256, sizeBytes: document.sizeBytes },
    text: document.text,
  };
  return { status: 200, body: response };
};

export const ratifyProgram: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(RatificationBodySchema, request.body);
  const scope = programScopeFrom(params);
  if (!("contract" in body)) return ratifyDraftVersion(deps, scope, body.planHash, principal);
  assertChainMatches(scope, body.contract);
  await requireProject(deps.stores, scope.projectId);
  const done = await ratifyContract(deps, {
    scope,
    contract: body.contract,
    planHash: body.planHash,
    planSha256: body.planSha256,
    conversationSha256: body.conversationSha256,
  });
  return done;
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

/**
 * Who may record a check where (P16, D-08). A laptop check, which moves
 * `status`, is a human's preflight; no execution token writes one. A machine
 * check is the engine's, and only under its own dispatch: the run and the
 * generation its token was minted for.
 */
const assertCheckSite = (principal: Principal, body: PrerequisiteCheckBody): void => {
  if (body.where !== "machine") {
    if (principal.kind === "execution") {
      throw new HttpError(
        403,
        "execution_forbidden_operation",
        "a laptop check is the preflight's; an execution records a check only as where: machine",
      );
    }
    return;
  }
  if (principal.kind !== "execution" || principal.role !== "engine") {
    throw new HttpError(
      403,
      "prerequisite_check_site",
      "a machine check is recorded by the engine on the run's machine, under its own dispatch",
    );
  }
  if (
    body.dispatch?.runId !== principal.runId ||
    body.dispatch.generation !== principal.generation
  ) {
    throw new HttpError(
      403,
      "execution_out_of_scope",
      "an engine records a machine check only under its own dispatch: its run and its generation",
    );
  }
};

type PrerequisiteCheckBody = Extract<PrerequisiteWriteBody, { kind: "check" }>;

type PrerequisiteWrite = { readonly status: 200 | 201; readonly body: Prerequisite };

/**
 * A check applied where it ran. A machine's is kept apart and never moves the
 * laptop's status; the laptop's leaves the machines' checks as they were.
 */
const checked = (
  existing: Prerequisite,
  body: PrerequisiteCheckBody,
  checkedAt: string,
): Prerequisite =>
  body.where === "machine" && body.dispatch !== undefined
    ? withMachineCheck(existing, { ...body.dispatch, exitCode: body.exitCode, checkedAt })
    : withLaptopCheck(existing, { exitCode: body.exitCode, checkedAt });

/** A hurdle the engine met (D-P7-10): new, or the same run's again; a planned id is never overwritten. */
const discovered = (
  existing: Prerequisite | undefined,
  id: string,
  body: Extract<PrerequisiteWriteBody, { kind: "discovered" }>,
): PrerequisiteWrite => {
  if (existing !== undefined) {
    if (existing.discoveredInRunId === body.runId) return { status: 200, body: existing };
    throw new HttpError(409, "conflict", `prerequisite ${id} already exists`);
  }
  return {
    status: 201,
    body: {
      id,
      description: body.description,
      remediation: body.remediation,
      verifyCommand: body.verifyCommand,
      status: "pending",
      discoveredInRunId: body.runId,
    },
  };
};

export const putPrerequisite: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(PrerequisiteWriteBodySchema, request.body);
  const scope = programScopeFrom(params);
  const id = prerequisiteIdFrom(params);
  if (body.kind === "check") assertCheckSite(principal, body);
  await requireProgram(deps.stores, scope);
  if (body.kind === "discovered") {
    const run = await deps.stores.runs.get(scope, body.runId);
    if (run === undefined) {
      throw new HttpError(404, "not_found", `run ${body.runId} does not exist in this program`);
    }
  }
  const checkedAt = nowIso(deps.clock);

  // One atomic change to the stored contract, applied again to whatever another
  // writer left if one got in between: a laptop check and a machine check that
  // overlap both land, and neither undoes the other (P16, D-08). So everything
  // below is decided from `current`, never from an earlier read.
  let outcome: PrerequisiteWrite | undefined;
  const stored = await deps.stores.programContracts.update(
    scope.projectId,
    scope.programId,
    (current) => {
      const all = [...prerequisitesOf(current)];
      const index = all.findIndex((candidate) => candidate.id === id);
      const existing = all[index];
      if (body.kind === "check") {
        if (existing === undefined) {
          throw new HttpError(
            404,
            "not_found",
            `program ${scope.programId} has no prerequisite ${id}`,
          );
        }
        const next = checked(existing, body, checkedAt);
        all[index] = next;
        outcome = { status: 200, body: next };
      } else {
        outcome = discovered(existing, id, body);
        // A hurdle met twice is one hurdle: nothing to write.
        if (existing !== undefined) return undefined;
        all.push(outcome.body);
      }
      // Neither write touches what was ratified: statuses, checks and discovered
      // hurdles are outside the plan hash, so the contract stays ratified as it was.
      return ProgramContractSchema.parse({ ...current, prerequisites: all });
    },
  );
  if (stored === undefined || outcome === undefined) {
    // Gone between the first read and the change.
    throw new HttpError(404, "not_found", `program ${scope.programId} does not exist`);
  }
  return outcome;
};
