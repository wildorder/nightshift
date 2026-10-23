/**
 * What ratifying checks, shared by every way of asking for it (P7, P21).
 *
 * See `plans.ts` for why the control plane hashes and checks what it holds
 * rather than what it was told.
 */
import { createHash } from "node:crypto";
import {
  MAX_RATIFICATION_HISTORY,
  type Prerequisite,
  type ProgramContract,
  ProgramContractSchema,
  type Ratification,
} from "@nightshift/contracts";
import {
  checkPlan,
  explainCorrection,
  isPlanned,
  nowIso,
  type PlanDocumentStore,
  type ProgramScope,
  parseConversation,
  planHash,
  prerequisitesOf,
  splitPlanSections,
} from "@nightshift/core";
import { type ApiDeps, HttpError } from "../http.js";

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

export const planStore = (deps: ApiDeps): PlanDocumentStore => {
  if (deps.plans === undefined) {
    throw new HttpError(
      501,
      "plans_unavailable",
      "this control plane was wired without a plan document store",
    );
  }
  return deps.plans;
};

/** The stored bytes as text, held to the name they were stored under. */
export const readPlanDocument = async (
  deps: ApiDeps,
  scope: ProgramScope,
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

/** What a ratification is made from, whichever way it was asked for. */
export interface RatificationInput {
  readonly scope: ProgramScope;
  readonly contract: ProgramContract;
  /** The hash the caller says the contract and plan make. */
  readonly planHash: string;
  readonly planSha256: string;
  readonly conversationSha256?: string | undefined;
}

/**
 * The checks and the record of a ratification, shared by the contract-in-body
 * form and the draft-version form so the two cannot drift: the same documents
 * are held to the same hash, the same readiness and the same correction rules,
 * and the same `ProgramContract` is recorded.
 */
export const ratifyContract = async (
  deps: ApiDeps,
  input: RatificationInput,
): Promise<{ readonly status: 200 | 201; readonly body: ProgramContract }> => {
  const { scope, contract } = input;
  if (!isPlanned(contract)) {
    throw new HttpError(
      422,
      "plan_not_ready",
      "the contract has no strands, so there is no plan to ratify; it runs as it is",
    );
  }

  const document = await readPlanDocument(deps, scope, input.planSha256);
  const computed = planHash(contract, document.text, sha256Hex);
  if (computed.plan !== input.planSha256) {
    // Only a document stored with CRLF line endings gets here: it is hashed as
    // stored above, and as normalised by `planHash`.
    throw new HttpError(
      422,
      "plan_document_mismatch",
      "the plan document must be uploaded with LF line endings, as it is hashed",
    );
  }
  if (computed.hash !== input.planHash) {
    throw new HttpError(
      422,
      "plan_hash_mismatch",
      `the plan hash is ${computed.hash} for this contract and document, not ${input.planHash}`,
    );
  }

  // P14 (D-P14-04, D-P14-06): the kept conversation is read from the store like
  // the plan, and the stories' quotes are held to the bytes held here.
  const conversation =
    input.conversationSha256 === undefined
      ? undefined
      : await readPlanDocument(deps, scope, input.conversationSha256);
  const readiness = checkPlan(
    contract,
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

  await assertCorrectable(deps, contract);

  const existing = await deps.stores.programContracts.get(scope.projectId, scope.programId);
  const conversationRef =
    conversation === undefined || input.conversationSha256 === undefined
      ? undefined
      : {
          uri: conversation.uri,
          sha256: input.conversationSha256,
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
  const prerequisites = carryPrerequisites(existing, contract);
  const { conversation: _stale, ...rest } = contract;
  const ratified = ProgramContractSchema.parse({
    ...rest,
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
