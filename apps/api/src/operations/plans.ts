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
  type PrerequisiteWriteBody,
  PrerequisiteWriteBodySchema,
  type Principal,
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
  parseConversation,
  planHash,
  prerequisitesOf,
  splitPlanSections,
  withLaptopCheck,
  withMachineCheck,
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
 * A prerequisite keeps the checks it already has, the laptop's and the
 * machines', only while its `verifyCommand` is the one that was run; anything a
 * client says about status or checks is dropped. Hurdles the engine discovered (D-P7-10) are the control plane's
 * own record and survive a re-ratification.
 */
const carryPrerequisites = (
  existing: ProgramContract | undefined,
  next: ProgramContract,
): Prerequisite[] | undefined => {
  const before = existing === undefined ? [] : prerequisitesOf(existing);
  const planned = prerequisitesOf(next)
    .filter((prerequisite) => prerequisite.discoveredInRunId === undefined)
    .map(
      ({
        status: _status,
        lastCheck: _lastCheck,
        machineChecks: _machineChecks,
        ...prerequisite
      }): Prerequisite => {
        const was = before.find((candidate) => candidate.id === prerequisite.id);
        return was !== undefined && was.verifyCommand === prerequisite.verifyCommand
          ? {
              ...prerequisite,
              status: was.status,
              ...(was.lastCheck === undefined ? {} : { lastCheck: was.lastCheck }),
              ...(was.machineChecks === undefined ? {} : { machineChecks: was.machineChecks }),
            }
          : { ...prerequisite, status: "pending" };
      },
    );
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

  // P14 (D-P14-04, D-P14-06): the kept conversation is read from the store like
  // the plan, and the stories' quotes are held to the bytes held here.
  const conversation =
    body.conversationSha256 === undefined
      ? undefined
      : await readPlanDocument(deps, scope, body.conversationSha256);
  const readiness = checkPlan(
    body.contract,
    splitPlanSections(document.text),
    conversation === undefined ? undefined : parseConversation(scope.programId, conversation.text),
  );
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
  const conversationRef =
    conversation === undefined || body.conversationSha256 === undefined
      ? undefined
      : {
          uri: conversation.uri,
          sha256: body.conversationSha256,
          sizeBytes: conversation.sizeBytes,
        };
  // Ratifying what is already ratified is a retry, not a second ratification.
  if (
    existing?.status === "ratified" &&
    existing.planHash === computed.hash &&
    existing.conversation?.sha256 === conversationRef?.sha256
  ) {
    return { status: 200, body: existing };
  }

  const ratification: Ratification = {
    planHash: computed.hash,
    planDocument: { uri: document.uri, sha256: computed.plan, sizeBytes: document.sizeBytes },
    ...(conversationRef === undefined ? {} : { conversation: conversationRef }),
    ratifiedAt: nowIso(deps.clock),
  };
  const prerequisites = carryPrerequisites(existing, body.contract);
  const { conversation: _stale, ...contract } = body.contract;
  const ratified = ProgramContractSchema.parse({
    ...contract,
    ...(conversationRef === undefined ? {} : { conversation: conversationRef }),
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
