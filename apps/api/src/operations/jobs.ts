/**
 * Job Contracts: create, read, list (T2).
 *
 * A Job Contract is persisted *before* execution (A-03) and read back by the
 * worker's `job.get`, which is the only reason `GET` exists here. Create
 * semantics throughout: a job contract is immutable once written, because it is
 * the authority a worker's result is judged against. An orchestrator that wants
 * different work delegates a different job.
 */
import { JobContractSchema } from "@nightshift/contracts";
import { HttpError, parseBody } from "../http.js";
import {
  assertChainMatches,
  assertIdentifierMatches,
  parsePageQuery,
  pathId,
  runScopeFrom,
} from "../params.js";
import type { Handler } from "../router.js";
import { createOrConfirm, pageBody, requireRun, withCursor } from "./common.js";

export const putJobContract: Handler = async ({ deps, request, params }) => {
  const contract = parseBody(JobContractSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, contract);
  assertIdentifierMatches(
    "jobContractId",
    pathId("job", params, "jobContractId"),
    contract.jobContractId,
  );
  await requireRun(deps.stores, scope);

  const existing = await deps.stores.jobContracts.get(scope, contract.jobContractId);
  return createOrConfirm(existing, contract, () => deps.stores.jobContracts.put(contract));
};

export const getJobContract: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const jobContractId = pathId("job", params, "jobContractId");
  const contract = await deps.stores.jobContracts.get(scope, jobContractId);
  if (contract === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `job contract ${jobContractId} does not exist in this run`,
    );
  }
  return { status: 200, body: contract };
};

export const listJobContracts: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireRun(deps.stores, scope);
  const result = await withCursor(() => deps.stores.jobContracts.listByRun(scope, page));
  return { status: 200, body: pageBody(result) };
};
