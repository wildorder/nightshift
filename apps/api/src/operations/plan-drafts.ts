/**
 * A program's plan draft (P21): content-hashed versions, each with the author the
 * caller's principal names, and the owner's acts on them.
 *
 * The documents (contract, plan, conversation) are uploaded through the
 * plan-documents upload and named by sha256; a version holds only references.
 * The plane reads them back to compute the plan hash and the `checkPlan` result
 * itself, so what a reader is told is what the plane holds. A version is never
 * changed: an edit or an answer appends the next one, and a write based on
 * anything but the latest is a 409.
 *
 * Who may do what is `authorize`'s: reads, writing a version and marking the
 * draft for the owner are open to the project's people and to every execution in
 * its project; answering, requesting changes, declining and ratifying are a
 * person's, and no execution role holds them.
 */
import {
  PLAN_DOCUMENT_CONTENT_TYPE,
  type PlanDocumentRef,
  type PlanDraft,
  PlanDraftActBodySchema,
  PlanDraftAnswerBodySchema,
  type PlanDraftCheck,
  PlanDraftPutVersionBodySchema,
  PlanDraftRequestChangesBodySchema,
  type PlanDraftVersion,
  PlanDraftVersionSchema,
  type Principal,
  type ProgramContract,
  ProgramContractSchema,
} from "@nightshift/contracts";
import {
  applyPlanDraftAct,
  checkPlan,
  type NightshiftStores,
  nowIso,
  type PlanDraftActKind,
  PlanDraftError,
  type ProgramScope,
  parseConversation,
  planHash,
  reconcilePlanDraftWrite,
  splitPlanSections,
} from "@nightshift/core";
import { type ApiDeps, type ApiResponse, HttpError, parseBody } from "../http.js";
import { assertChainMatches, parsePageQuery, programScopeFrom, projectIdFrom } from "../params.js";
import type { Handler } from "../router.js";
import { pageBody, requireProject, withCursor } from "./common.js";
import {
  planStore,
  prepareRatification,
  readPlanDocument,
  sha256Hex,
  writeRatification,
} from "./ratification.js";

/** A stored document, as the reference a version keeps. A missing one is the writer's mistake, so 422. */
const documentRef = async (
  deps: ApiDeps,
  scope: ProgramScope,
  what: string,
  sha256: string,
): Promise<{ readonly ref: PlanDocumentRef; readonly text: string }> => {
  let document: Awaited<ReturnType<typeof readPlanDocument>>;
  try {
    document = await readPlanDocument(deps, scope, sha256);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new HttpError(
        422,
        "document_not_uploaded",
        `the ${what} ${sha256} has not been uploaded for program ${scope.programId}`,
      );
    }
    throw error;
  }
  return {
    ref: { uri: document.uri, sha256, sizeBytes: document.sizeBytes },
    text: document.text,
  };
};

/** The contract as JSON, or the reasons it is not a contract. */
const parseContract = (
  text: string,
):
  | { readonly ok: true; readonly contract: ProgramContract }
  | { readonly ok: false; readonly reasons: { kind: string; message: string }[] } => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reasons: [{ kind: "contract_invalid", message: "the contract is not JSON" }],
    };
  }
  const parsed = ProgramContractSchema.safeParse(json);
  if (parsed.success) return { ok: true, contract: parsed.data };
  return {
    ok: false,
    reasons: parsed.error.issues.map((issue) => ({
      kind: "contract_invalid",
      message: `${issue.path.length === 0 ? "(contract)" : issue.path.join(".")}: ${issue.message}`,
    })),
  };
};

/** What `checkPlan` says of a version's stored documents, computed now by the plane. */
const checkOf = async (
  deps: ApiDeps,
  scope: ProgramScope,
  version: PlanDraftVersion,
): Promise<PlanDraftCheck> => {
  const contract = parseContract(
    (await readPlanDocument(deps, scope, version.contract.sha256)).text,
  );
  if (!contract.ok) return { ready: false, reasons: contract.reasons };
  const plan = await readPlanDocument(deps, scope, version.plan.sha256);
  const conversation =
    version.conversation === undefined
      ? undefined
      : await readPlanDocument(deps, scope, version.conversation.sha256);
  const readiness = checkPlan(
    contract.contract,
    splitPlanSections(plan.text),
    conversation === undefined ? undefined : parseConversation(scope.programId, conversation.text),
  );
  return readiness.ready ? { ready: true } : { ready: false, reasons: [...readiness.reasons] };
};

const versionResponse = async (
  deps: ApiDeps,
  scope: ProgramScope,
  version: PlanDraftVersion,
  status: 200 | 201,
): Promise<ApiResponse> => ({
  status,
  body: { version, check: await checkOf(deps, scope, version) },
});

const requireDraft = async (stores: NightshiftStores, scope: ProgramScope): Promise<PlanDraft> => {
  const draft = await stores.planDrafts.get(scope.projectId, scope.programId);
  if (draft === undefined) {
    throw new HttpError(404, "not_found", `program ${scope.programId} has no plan draft`);
  }
  return draft;
};

const requireVersion = async (
  stores: NightshiftStores,
  scope: ProgramScope,
  version: number,
): Promise<PlanDraftVersion> => {
  const found = await stores.planDrafts.getVersion(scope.projectId, scope.programId, version);
  if (found === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `program ${scope.programId} has no plan draft version ${version}`,
    );
  }
  return found;
};

const versionFrom = (raw: string | undefined): number => {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, "invalid_path", "path parameter version must be a positive integer");
  }
  return Number.parseInt(raw, 10);
};

export const getPlanDraft: Handler = async ({ deps, params }) => {
  const scope = programScopeFrom(params);
  await requireProject(deps.stores, scope.projectId);
  return { status: 200, body: await requireDraft(deps.stores, scope) };
};

export const listPlanDraftsByProject: Handler = async ({ deps, request, params }) => {
  const projectId = projectIdFrom(params);
  const page = parsePageQuery(request.query);
  await requireProject(deps.stores, projectId);
  const result = await withCursor(() => deps.stores.planDrafts.listByProject(projectId, page));
  return { status: 200, body: pageBody(result) };
};

export const listPlanDraftVersions: Handler = async ({ deps, request, params }) => {
  const scope = programScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireProject(deps.stores, scope.projectId);
  const result = await withCursor(() =>
    deps.stores.planDrafts.listVersions(scope.projectId, scope.programId, page),
  );
  return { status: 200, body: pageBody(result) };
};

export const getPlanDraftVersion: Handler = async ({ deps, params }) => {
  const scope = programScopeFrom(params);
  const number = versionFrom(params.version);
  await requireProject(deps.stores, scope.projectId);
  return versionResponse(deps, scope, await requireVersion(deps.stores, scope, number), 200);
};

export const getLatestPlanDraftVersion: Handler = async ({ deps, params }) => {
  const scope = programScopeFrom(params);
  await requireProject(deps.stores, scope.projectId);
  const draft = await requireDraft(deps.stores, scope);
  return versionResponse(
    deps,
    scope,
    await requireVersion(deps.stores, scope, draft.latestVersion),
    200,
  );
};

export const putPlanDraftVersion: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(PlanDraftPutVersionBodySchema, request.body);
  const scope = programScopeFrom(params);
  await requireProject(deps.stores, scope.projectId);

  const contract = await documentRef(deps, scope, "contract", body.contractSha256);
  const plan = await documentRef(deps, scope, "plan", body.planSha256);
  const conversation =
    body.conversationSha256 === undefined
      ? undefined
      : await documentRef(deps, scope, "conversation", body.conversationSha256);

  // A contract that is not JSON naming this project and program is refused; one
  // that merely fails the schema is kept, and its check says why it is not ready.
  let json: unknown;
  try {
    json = JSON.parse(contract.text);
  } catch {
    throw new HttpError(422, "contract_not_json", "the contract document is not JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new HttpError(422, "contract_not_json", "the contract document is not a JSON object");
  }
  assertChainMatches(scope, json as { projectId?: string; programId?: string });
  const parsed = parseContract(contract.text);

  const at = nowIso(deps.clock);
  const stored = await deps.stores.planDrafts.get(scope.projectId, scope.programId);
  const next = reconcilePlanDraftWrite({
    ...(stored === undefined ? {} : { stored }),
    scope,
    basedOn: body.basedOn,
    at,
  });
  const version = PlanDraftVersionSchema.parse({
    schemaVersion: 1,
    projectId: scope.projectId,
    programId: scope.programId,
    version: next.version,
    contract: contract.ref,
    plan: plan.ref,
    ...(conversation === undefined ? {} : { conversation: conversation.ref }),
    ...(parsed.ok ? { planHash: planHash(parsed.contract, plan.text, sha256Hex).hash } : {}),
    author: principal,
    act: { kind: "write" },
    createdAt: at,
  });
  // Reconciled again against the draft as stored inside the append, so an act
  // recorded since the read above is kept and a decline refuses the write.
  await deps.stores.planDrafts.appendVersion(
    version,
    (current) =>
      reconcilePlanDraftWrite({
        ...(current === undefined ? {} : { stored: current }),
        scope,
        basedOn: body.basedOn,
        at,
      }).draft,
  );
  return versionResponse(deps, scope, version, 201);
};

/**
 * One decision answered: the plane sets the answer in the latest version's
 * contract, stores that contract itself, and appends a version that carries the
 * answer and the answerer.
 */
export const answerPlanDraftDecision: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(PlanDraftAnswerBodySchema, request.body);
  const scope = programScopeFrom(params);
  await requireProject(deps.stores, scope.projectId);
  const draft = await requireDraft(deps.stores, scope);
  if (body.basedOn !== undefined && body.basedOn !== draft.latestVersion) {
    throw new PlanDraftError(
      "stale_base",
      `the answer is based on version ${body.basedOn}, but the latest is ${draft.latestVersion}`,
    );
  }
  const latest = await requireVersion(deps.stores, scope, draft.latestVersion);

  const current = parseContract((await readPlanDocument(deps, scope, latest.contract.sha256)).text);
  if (!current.ok) {
    throw new HttpError(
      422,
      "contract_invalid",
      `the latest contract does not parse: ${current.reasons.map((reason) => reason.message).join("; ")}`,
      current.reasons,
    );
  }
  const decisions = current.contract.decisions ?? [];
  if (!decisions.some((decision) => decision.id === body.decisionId)) {
    throw new HttpError(
      404,
      "not_found",
      `version ${latest.version} of the contract has no decision ${body.decisionId}`,
    );
  }
  const answered = ProgramContractSchema.parse({
    ...current.contract,
    decisions: decisions.map((decision) => {
      if (decision.id !== body.decisionId) return decision;
      const { rationale: _old, ...rest } = decision;
      return {
        ...rest,
        answer: body.answer,
        ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
      };
    }),
  });

  const at = nowIso(deps.clock);
  const next = reconcilePlanDraftWrite({ stored: draft, scope, basedOn: draft.latestVersion, at });
  const bytes = new TextEncoder().encode(`${JSON.stringify(answered, null, 2)}\n`);
  const sha256 = sha256Hex(bytes);
  const put = await planStore(deps).put(scope, sha256, bytes, PLAN_DOCUMENT_CONTENT_TYPE);
  const plan = await readPlanDocument(deps, scope, latest.plan.sha256);
  const version = PlanDraftVersionSchema.parse({
    schemaVersion: 1,
    projectId: scope.projectId,
    programId: scope.programId,
    version: next.version,
    contract: { uri: put.uri, sha256, sizeBytes: bytes.length },
    plan: latest.plan,
    ...(latest.conversation === undefined ? {} : { conversation: latest.conversation }),
    planHash: planHash(answered, plan.text, sha256Hex).hash,
    author: principal,
    act: {
      kind: "answer",
      decisionId: body.decisionId,
      answer: body.answer,
      ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
    },
    createdAt: at,
  });
  await deps.stores.planDrafts.appendVersion(
    version,
    (current) =>
      reconcilePlanDraftWrite({
        ...(current === undefined ? {} : { stored: current }),
        scope,
        basedOn: draft.latestVersion,
        at,
      }).draft,
  );
  return versionResponse(deps, scope, version, 201);
};

/** Records an act on the draft, on the version it names, by the caller. */
const recordAct = async (
  deps: ApiDeps,
  scope: ProgramScope,
  principal: Principal,
  act: { kind: PlanDraftActKind; version: number; note?: string | undefined },
): Promise<ApiResponse> => {
  await requireProject(deps.stores, scope.projectId);
  const at = nowIso(deps.clock);
  const updated = await deps.stores.planDrafts.update(scope.projectId, scope.programId, (current) =>
    applyPlanDraftAct(current, {
      kind: act.kind,
      version: act.version,
      by: principal,
      ...(act.note === undefined ? {} : { note: act.note }),
      at,
    }),
  );
  if (updated === undefined) {
    throw new HttpError(404, "not_found", `program ${scope.programId} has no plan draft`);
  }
  return { status: 200, body: updated };
};

export const markPlanDraftAwaitingOwner: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(PlanDraftActBodySchema, request.body);
  return recordAct(deps, programScopeFrom(params), principal, {
    kind: "awaiting_owner",
    ...body,
  });
};

export const requestPlanDraftChanges: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(PlanDraftRequestChangesBodySchema, request.body);
  return recordAct(deps, programScopeFrom(params), principal, {
    kind: "changes_requested",
    ...body,
  });
};

export const declinePlanDraft: Handler = async ({ deps, request, params, principal }) => {
  const body = parseBody(PlanDraftActBodySchema, request.body);
  return recordAct(deps, programScopeFrom(params), principal, { kind: "declined", ...body });
};

/**
 * `program.ratify` with a plan hash instead of a contract: the plane ratifies the
 * latest version's stored documents with exactly the contract-in-body checks and
 * record. The act is noted on the draft before the contract is written, so a
 * retry completes a write that failed between the two.
 */
export const ratifyDraftVersion = async (
  deps: ApiDeps,
  scope: ProgramScope,
  hash: string,
  principal: Principal,
): Promise<ApiResponse> => {
  await requireProject(deps.stores, scope.projectId);
  const draft = await requireDraft(deps.stores, scope);
  if (draft.state === "declined") {
    throw new PlanDraftError("declined", "the draft was declined; ratifying changes nothing");
  }
  const latest = await requireVersion(deps.stores, scope, draft.latestVersion);
  if (latest.planHash !== hash) {
    // A hash that names an earlier version is a stale ratification, not an unknown one.
    const earlier = await readAllVersions(deps.stores, scope);
    if (earlier.some((version) => version.planHash === hash)) {
      throw new PlanDraftError(
        "not_latest_version",
        `plan hash ${hash} is not the latest version's (version ${latest.version})`,
      );
    }
    throw new HttpError(404, "not_found", `no version of this draft has plan hash ${hash}`);
  }

  const contract = parseContract(
    (await readPlanDocument(deps, scope, latest.contract.sha256)).text,
  );
  if (!contract.ok) {
    throw new HttpError(
      422,
      "plan_not_ready",
      `the plan is not ready: ${contract.reasons.map((reason) => reason.message).join("; ")}`,
      contract.reasons,
    );
  }
  // Every check first, writing nothing; then the act, which the plane refuses
  // (409) if a version or a decline landed meanwhile; only then the contract.
  const prepared = await prepareRatification(deps, {
    scope,
    contract: contract.contract,
    planHash: hash,
    planSha256: latest.plan.sha256,
    conversationSha256: latest.conversation?.sha256,
  });
  const at = nowIso(deps.clock);
  await deps.stores.planDrafts.update(scope.projectId, scope.programId, (current) => {
    // A retry of a ratification already recorded leaves the draft as it is.
    const last = current.acts.at(-1);
    if (
      current.state === "ratified" &&
      last?.kind === "ratified" &&
      last.version === latest.version &&
      last.planHash === hash
    ) {
      return undefined;
    }
    return applyPlanDraftAct(current, {
      kind: "ratified",
      version: latest.version,
      by: principal,
      planHash: hash,
      at,
    });
  });
  return writeRatification(deps, prepared);
};

const readAllVersions = async (
  stores: NightshiftStores,
  scope: ProgramScope,
): Promise<PlanDraftVersion[]> => {
  const all: PlanDraftVersion[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.planDrafts.listVersions(scope.projectId, scope.programId, {
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return all;
};
