/**
 * A run's dispatch: its machine, its lease and its generation (P10, D-P10-18,
 * D-P10-19, D-P10-20, D-P10-23).
 *
 * The routes here write the record and apply `core`'s rules; what happens to
 * actual machines is the dispatch Lambda's and the reconciler's (T3, T6),
 * which read the same record. A run has one dispatch, keyed by the run, so a
 * retried `POST` under the same idempotency key finds the one it made.
 *
 * The heartbeat is the engine's one exchange with the plane: it extends the
 * lease, folds the machine's utilization, meters the spend, renews the engine's
 * token, and carries back the org's provider keys, once, into memory.
 */
import {
  COMPUTE_TIERS,
  calendarMonthOf,
  DEFAULT_COMPUTE_CEILINGS,
  type Dispatch,
  DispatchBodySchema,
  type DispatchStatus,
  emptyComputeUsage,
  type GitHubInstallation,
  HeartbeatBodySchema,
  type HeartbeatResponse,
  HeartbeatResponseSchema,
  type OrgComputeUsage,
  type OrgId,
  PROVIDERS,
  type Provider,
  type RunId,
} from "@nightshift/contracts";
import {
  attemptsExhausted,
  beginReplacement,
  createUlidIdGenerator,
  emptyUtilization,
  estimateUsd,
  foldUtilization,
  isDispatchTerminal,
  isPlanned,
  leaseExpiryFrom,
  mayDispatch,
  mayResume,
  meterUsd,
  nowIso,
  type RunScope,
  repositoryNameOf,
  runHoursOf,
  transitionDispatch,
} from "@nightshift/core";
import { type ApiDeps, HttpError, parseBody } from "../http.js";
import { runScopeFrom } from "../params.js";
import type { Handler, RouteContext } from "../router.js";
import { EngineTokenExpiredError, mintEngineToken } from "../tokens/mint.js";
import { requireProgram, requireProject, requireRun } from "./common.js";

export const requireDispatch = async (deps: ApiDeps, scope: RunScope): Promise<Dispatch> => {
  const dispatch = await deps.stores.dispatches.get(scope);
  if (dispatch === undefined) {
    throw new HttpError(404, "not_found", `run ${scope.runId} has no dispatch`);
  }
  return dispatch;
};

/** The org's ledger for this month, as it stands, or empty. */
const usageOf = async (deps: ApiDeps, orgId: OrgId, at: string): Promise<OrgComputeUsage> =>
  (await deps.stores.computeLedger.get(orgId, calendarMonthOf(at))) ??
  emptyComputeUsage(orgId, calendarMonthOf(at), at);

const withLiveRun = (usage: OrgComputeUsage, runId: RunId, live: boolean, at: string) => ({
  ...usage,
  liveRuns: live
    ? usage.liveRuns.includes(runId)
      ? usage.liveRuns
      : [...usage.liveRuns, runId]
    : usage.liveRuns.filter((candidate) => candidate !== runId),
  updatedAt: at,
});

/**
 * `POST …/runs/{runId}/dispatch` — authorise a machine for a run.
 *
 * Refused before anything is provisioned (SC-P10-02): the run must be remote
 * and pending, the program planned and ratified, the plan hash the ratified
 * one, and the tier and the month within the org's ceilings. The CLI checked
 * the checkout and the branch; the plane checks the records, and T3's dispatch
 * Lambda checks GitHub. Nothing a client claimed is trusted.
 */
export const createDispatch: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const body = parseBody(DispatchBodySchema, request.body);
  const run = await requireRun(deps.stores, scope);
  const program = await requireProgram(deps.stores, scope);
  const project = await requireProject(deps.stores, scope.projectId);
  const at = nowIso(deps.clock);

  const existing = await deps.stores.dispatches.get(scope);
  if (existing !== undefined) {
    if (existing.idempotencyKey === body.idempotencyKey) return { status: 200, body: existing };
    throw new HttpError(
      409,
      "conflict",
      `run ${scope.runId} already has a dispatch under another idempotency key`,
    );
  }

  if (run.location !== "remote") {
    throw new HttpError(
      409,
      "run_not_remote",
      `run ${scope.runId} was started for local execution`,
    );
  }
  if (run.status !== "pending") {
    throw new HttpError(409, "run_not_pending", `run ${scope.runId} is ${run.status}`);
  }
  if (!isPlanned(program) || program.status !== "ratified") {
    throw new HttpError(
      409,
      "plan_not_ratified",
      `program ${scope.programId} is not a ratified planned program; remote execution needs one (D-P10-09)`,
    );
  }
  if (program.planHash !== body.input.planHash) {
    throw new HttpError(
      409,
      "plan_changed",
      "the plan hash dispatched is not the one ratified; the plan changed since",
    );
  }

  const dispatcher = deps.dispatcher;
  if (dispatcher === undefined) {
    throw new HttpError(
      501,
      "dispatch_unavailable",
      "this control plane was wired without a dispatcher; no machine would be provisioned",
    );
  }

  const orgConfig = await deps.stores.orgConfigs.get(project.orgId);
  // Nothing the client claimed about GitHub is trusted (SC-P10-02): the org's
  // recorded installation must grant the repository, and the branch's head at
  // GitHub must be the SHA dispatched.
  await assertGithubInput(deps, orgConfig?.github, body.input);

  const ceilings = orgConfig?.compute ?? DEFAULT_COMPUTE_CEILINGS;
  const runHours = runHoursOf(program.costPolicy.maxWallClockSeconds, ceilings);
  const estimatedUsd = estimateUsd(body.tier, runHours);
  const usage = await usageOf(deps, project.orgId, at);
  const refusal = mayDispatch({
    ceilings,
    tier: body.tier,
    runHours,
    estimatedUsd,
    monthSpentUsd: usage.meteredUsd,
    concurrentRuns: usage.liveRuns.length,
  });
  if (refusal !== undefined) throw new HttpError(409, refusal.reason, refusal.detail);

  const spec = COMPUTE_TIERS[body.tier];
  const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
  const dispatch: Dispatch = {
    schemaVersion: 1,
    ...scope,
    status: "requested",
    tier: body.tier,
    instanceType: spec.instanceType,
    usdPerHour: spec.usdPerHour,
    amiVersion: deps.runner?.amiVersion ?? "none",
    generation: 1,
    idempotencyKey: body.idempotencyKey,
    engineAgentId: ids.next("agent"),
    input: body.input,
    attempts: [{ generation: 1, reason: "dispatch", startedAt: at }],
    spend: { estimatedUsd, meteredUsd: 0, meteredSeconds: 0 },
    publication: { intents: [] },
    cleanup: { volumeDeleted: false, failures: [] },
    requestedAt: at,
    updatedAt: at,
  };
  await deps.stores.dispatches.put(dispatch);
  await deps.stores.computeLedger.put(withLiveRun(usage, scope.runId, true, at));
  // Recorded first, then provisioned: an invocation that fails leaves a
  // `requested` dispatch the reconciler picks up within its grace.
  await dispatcher.provision(scope).catch((error: unknown) => {
    console.error(`dispatch ${scope.runId}: the dispatcher could not be invoked`, error);
  });
  return { status: 201, body: dispatch };
};

/**
 * The GitHub half of SC-P10-02, through the App: the repository must be one the
 * org's installation grants, and the branch must stand at the SHA dispatched.
 * Without the App wired in, nothing can be verified and nothing is accepted.
 */
const assertGithubInput = async (
  deps: ApiDeps,
  installation: GitHubInstallation | undefined,
  input: Dispatch["input"],
): Promise<void> => {
  if (deps.github === undefined) {
    throw new HttpError(
      501,
      "github_unavailable",
      "this control plane was wired without the Nightshift GitHub App; a dispatch cannot be verified",
    );
  }
  if (installation === undefined) {
    throw new HttpError(
      409,
      "github_not_installed",
      "the org has recorded no GitHub App installation; run `nightshift org github install`",
    );
  }
  const repository = repositoryNameOf(input.repositoryUrl);
  if (repository === undefined || !installation.repositories.includes(repository)) {
    throw new HttpError(
      409,
      "repository_not_granted",
      `${input.repositoryUrl} is not among the repositories installation ${installation.installationId} grants`,
    );
  }
  const head = await deps.github.branchHead(installation.installationId, repository, input.branch);
  if (head === undefined) {
    throw new HttpError(
      409,
      "branch_missing",
      `${repository} has no branch ${input.branch} at GitHub; push the program branch first`,
    );
  }
  if (head !== input.baseSha) {
    throw new HttpError(
      409,
      "head_mismatch",
      `${repository}'s ${input.branch} stands at ${head.slice(0, 12)} at GitHub, not ${input.baseSha.slice(0, 12)}; push, or dispatch what is pushed`,
    );
  }
};

export const getDispatch: Handler = async ({ deps, params }) => ({
  status: 200,
  body: await requireDispatch(deps, runScopeFrom(params)),
});

/**
 * `POST …/dispatch/cancel` — stop the machine. A dispatch with no machine yet
 * is stopped outright; one with a machine is `stopping` until the runner, or
 * the reconciler, reports it gone.
 */
export const cancelDispatch: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const dispatch = await requireDispatch(deps, scope);
  const at = nowIso(deps.clock);
  if (isDispatchTerminal(dispatch.status)) return { status: 200, body: dispatch };
  if (dispatch.status === "stopping") return { status: 200, body: dispatch };
  let next = transitionDispatch(
    { ...dispatch, failure: { code: "cancelled", message: "cancelled by the operator" } },
    "stop",
    at,
  );
  if (dispatch.status === "requested") {
    next = transitionDispatch(next, "stopped", at);
    await settleLedger(deps, scope, at);
  }
  await deps.stores.dispatches.put(next);
  return { status: 200, body: next };
};

/**
 * `POST …/dispatch/resume` — a settled dispatch, from its retained snapshot,
 * within retention (D-P10-18): the same path as recovery, by hand.
 */
export const resumeDispatch: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const dispatch = await requireDispatch(deps, scope);
  const at = nowIso(deps.clock);
  const allowed = mayResume(dispatch, deps.clock.now());
  if (!allowed.ok) throw new HttpError(409, "cannot_resume", allowed.reason);
  const project = await requireProject(deps.stores, scope.projectId);
  const usage = await usageOf(deps, project.orgId, at);
  const ceilings =
    (await deps.stores.orgConfigs.get(project.orgId))?.compute ?? DEFAULT_COMPUTE_CEILINGS;
  if (usage.liveRuns.length >= ceilings.maxConcurrentRuns) {
    throw new HttpError(
      409,
      "concurrency_over_ceiling",
      `${usage.liveRuns.length} remote run(s) are live; the org's ceiling is ${ceilings.maxConcurrentRuns}`,
    );
  }
  const dispatcher = deps.dispatcher;
  if (dispatcher === undefined) {
    throw new HttpError(
      501,
      "dispatch_unavailable",
      "this control plane was wired without a dispatcher",
    );
  }
  const next = beginReplacement(dispatch, "resume", at);
  await deps.stores.dispatches.put(next);
  await deps.stores.computeLedger.put(withLiveRun(usage, scope.runId, true, at));
  await dispatcher.provision(scope).catch((error: unknown) => {
    console.error(
      `dispatch ${scope.runId}: the dispatcher could not be invoked for a resume`,
      error,
    );
  });
  return { status: 200, body: next };
};

/** A run left the org's live set. */
const settleLedger = async (deps: ApiDeps, scope: RunScope, at: string): Promise<void> => {
  const project = await requireProject(deps.stores, scope.projectId);
  const usage = await usageOf(deps, project.orgId, at);
  await deps.stores.computeLedger.put(withLiveRun(usage, scope.runId, false, at));
};

const STOP_STATUSES: readonly DispatchStatus[] = ["stopping", "stopped", "failed"];

/**
 * `POST …/dispatch/heartbeat` — the engine's exchange (D-P10-18, D-P10-20,
 * D-P10-23). `enforce` has already held an engine's token to the dispatch's
 * generation; a human's call is held to the body's.
 */
export const heartbeat: Handler = async (context) => {
  const { deps, request, params } = context;
  const scope = runScopeFrom(params);
  const body = parseBody(HeartbeatBodySchema, request.body);
  let dispatch = await requireDispatch(deps, scope);
  const at = nowIso(deps.clock);

  if (body.generation !== dispatch.generation) {
    throw new HttpError(
      409,
      "stale_generation",
      `this heartbeat is from generation ${body.generation}; the dispatch is at ${dispatch.generation}`,
    );
  }
  if (dispatch.status === "requested") {
    throw new HttpError(409, "no_machine", "the dispatch has no machine yet to heartbeat from");
  }

  // Where the runner has got to.
  if (body.report === "ready" && dispatch.status === "provisioning") {
    dispatch = transitionDispatch(dispatch, "ready", at);
  } else if (body.report === "running" && dispatch.status === "ready") {
    dispatch = transitionDispatch(dispatch, "start", at);
  } else if (body.report === "stopped" && dispatch.status === "stopping") {
    dispatch = transitionDispatch(dispatch, "stopped", at);
    await settleLedger(deps, scope, at);
  }

  // The machine's use and its cost.
  const previousUsd = dispatch.spend.meteredUsd;
  const attempts = dispatch.attempts.map((attempt) =>
    attempt.generation === dispatch.generation
      ? { ...attempt, meteredSeconds: Math.max(attempt.meteredSeconds ?? 0, body.meteredSeconds) }
      : attempt,
  );
  const meteredSeconds = attempts.reduce(
    (total, attempt) => total + (attempt.meteredSeconds ?? 0),
    0,
  );
  const meteredUsd = meterUsd(dispatch.tier, meteredSeconds);
  const utilization = foldUtilization(
    (await deps.stores.computeUtilizations.get(scope)) ?? emptyUtilization(scope, dispatch.tier),
    body.samples,
    meteredSeconds,
    body.setupSeconds,
    at,
  );
  await deps.stores.computeUtilizations.put(utilization);

  const live = !STOP_STATUSES.includes(dispatch.status);
  dispatch = {
    ...dispatch,
    attempts,
    spend: { ...dispatch.spend, meteredSeconds, meteredUsd },
    ...(live ? { leaseExpiresAt: leaseExpiryFrom(deps.clock.now()) } : {}),
    ...(body.rootSessionId === undefined ? {} : { rootSessionId: body.rootSessionId }),
    ...(body.lockfileHashes === undefined ? {} : { lockfileHashes: body.lockfileHashes }),
    updatedAt: at,
  };
  await deps.stores.dispatches.put(dispatch);

  const project = await requireProject(deps.stores, scope.projectId);
  if (meteredUsd !== previousUsd) {
    const usage = await usageOf(deps, project.orgId, at);
    await deps.stores.computeLedger.put({
      ...usage,
      meteredUsd: usage.meteredUsd + (meteredUsd - previousUsd),
      updatedAt: at,
    });
  }

  // A ceiling met mid-run stops the machine (D-P10-19). The reconciler terminates.
  let stop = !live;
  const ceilings =
    (await deps.stores.orgConfigs.get(project.orgId))?.compute ?? DEFAULT_COMPUTE_CEILINGS;
  const program = await requireProgram(deps.stores, scope);
  const hours = runHoursOf(program.costPolicy.maxWallClockSeconds, ceilings);
  if (live && (meteredSeconds > hours * 3600 || meteredUsd > ceilings.maxUsdPerRun)) {
    const code = meteredUsd > ceilings.maxUsdPerRun ? "run_cap" : "wall_clock";
    dispatch = transitionDispatch(
      {
        ...dispatch,
        failure: {
          code,
          message:
            code === "run_cap"
              ? `metered $${meteredUsd.toFixed(2)} crossed the $${ceilings.maxUsdPerRun.toFixed(2)} cap per run`
              : `metered ${Math.round(meteredSeconds / 60)} minutes crossed the ${hours}-hour wall clock`,
        },
      },
      "stop",
      at,
    );
    await deps.stores.dispatches.put(dispatch);
    stop = true;
  }
  if (live && attemptsExhausted(dispatch) && dispatch.status === "provisioning") {
    // A replacement past the limit should never have launched; say so loudly.
    stop = true;
  }

  const response: HeartbeatResponse = {
    generation: dispatch.generation,
    status: dispatch.status,
    leaseExpiresAt: dispatch.leaseExpiresAt ?? at,
    stop,
    ...(await renewedToken(context, dispatch, stop)),
    ...(await credentialsFor(deps, project.orgId, dispatch, stop)),
  };
  return { status: 200, body: HeartbeatResponseSchema.parse(response) };
};

/** The engine's renewed token, when the plane can mint one and the runner should carry on. */
const renewedToken = async (
  { deps, params, principal }: RouteContext,
  dispatch: Dispatch,
  stop: boolean,
): Promise<Pick<HeartbeatResponse, "token" | "tokenExpiresAt">> => {
  if (stop || deps.tokens === undefined) return {};
  if (principal.kind === "execution" && principal.role !== "engine") return {};
  const scope = runScopeFrom(params);
  try {
    const minted = await mintEngineToken(deps.tokens.signer, {
      dispatch,
      run: await requireRun(deps.stores, scope),
      program: await requireProgram(deps.stores, scope),
      issuer: deps.tokens.issuer,
      now: deps.clock.now(),
    });
    return { token: minted.token, tokenExpiresAt: minted.expiresAt };
  } catch (error) {
    if (error instanceof EngineTokenExpiredError) return {};
    throw error;
  }
};

/**
 * The org's provider keys, opened for the run's own engine (D-P10-23): only
 * while the dispatch is `running` and the runner is to carry on. Absent when
 * the plane has no envelope or no credentials table.
 */
const credentialsFor = async (
  deps: ApiDeps,
  orgId: OrgId,
  dispatch: Dispatch,
  stop: boolean,
): Promise<Pick<HeartbeatResponse, "credentials">> => {
  // Keys travel only to a machine that is past `ready`: the clone needs GitHub
  // while provisioning; the workers need their providers once running.
  if (
    stop ||
    (dispatch.status !== "running" &&
      dispatch.status !== "provisioning" &&
      dispatch.status !== "ready")
  ) {
    return {};
  }
  const providersWanted = dispatch.status === "running" && deps.envelope !== undefined;
  const credentials: Record<string, string> = {};
  // The clone's credential (D-P10-02): a short-lived read token for the one
  // repository, from the org's installation, when the App is wired in.
  const installation = (await deps.stores.orgConfigs.get(orgId))?.github;
  const repository = repositoryNameOf(dispatch.input.repositoryUrl);
  if (deps.github !== undefined && installation !== undefined && repository !== undefined) {
    try {
      credentials.github = (
        await deps.github.readToken(installation.installationId, [repository])
      ).token;
    } catch (error) {
      console.error(`dispatch ${dispatch.runId}: no GitHub read token for the machine`, error);
    }
  }
  for (const provider of providersWanted ? PROVIDERS : []) {
    let sealed: Awaited<ReturnType<typeof deps.stores.credentials.sealed>>;
    try {
      sealed = await deps.stores.credentials.sealed(orgId, provider as Provider);
    } catch (error) {
      if (error instanceof Error && error.name === "CredentialsTableUnavailableError") return {};
      throw error;
    }
    if (sealed === undefined || deps.envelope === undefined) continue;
    credentials[provider] = await deps.envelope.open(orgId, provider as Provider, sealed);
  }
  return Object.keys(credentials).length === 0 ? {} : { credentials };
};
