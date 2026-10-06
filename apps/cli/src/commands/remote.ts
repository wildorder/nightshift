/**
 * `nightshift run <program> --remote [--compute <tier>]` and `nightshift remote
 * status|cancel|resume <program>` (P10, D-P10-02, D-P10-09, D-P10-14, D-P10-18).
 *
 * Remote dispatch is refused before anything is written unless the checkout is
 * clean, the program branch's head is the one at `origin`, and the plan is
 * ratified on the control plane; the plane then checks the records and GitHub
 * for itself. What is
 * printed at dispatch is what the customer is buying: the tier, its class and
 * its price per hour, and what the run could cost at its ceiling.
 */
import {
  COMPUTE_TIERS,
  type ComputeTier,
  ComputeTierSchema,
  DEFAULT_COMPUTE_CEILINGS,
  type Dispatch,
  DispatchSchema,
  OrgConfigSchema,
  type ProgramContract,
  ProjectSchema,
} from "@nightshift/contracts";
import {
  chooseTier,
  estimateUsd,
  isPlanned,
  mayDispatch,
  type RunScope,
  runHoursOf,
} from "@nightshift/core";
import { currentBranch, isDirty, type StartedRun, tryRevParse } from "@nightshift/execution";
import { ControlPlaneError, routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { type ProgramFiles, readConfig, readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";

/** What `--remote` says for a contract that is not a ratified planned program (D-P10-09). */
/**
 * Not about ratification, which the plane answers: this is the argument. A
 * remote run takes a planned program's directory name under `docs/programs/`,
 * run from the repository root; a path, a contract file, or an id the checkout
 * has no directory for is refused before anything is read.
 */
export const REMOTE_NEEDS_PLAN =
  "remote execution runs a planned program: pass the program's directory name under docs/programs/ (not a path or a contract file), from the repository root";

export interface RemoteReadiness {
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly tier: ComputeTier;
  readonly source: string;
}

const parseTier = (value: string | undefined): ComputeTier | undefined => {
  if (value === undefined) return undefined;
  const parsed = ComputeTierSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`--compute must be one of ${ComputeTierSchema.options.join(", ")}`);
  }
  return parsed.data;
};

/**
 * The CLI's half of SC-P10-02: nothing dirty, nothing unpublished, a stated or
 * recommended tier. `contract` is the control plane's record of the program,
 * the one `requireRatifiedPlan` held the checkout to: ratification is recorded
 * there and never written back to `contract.json`, whose `status` stays
 * `planning` on disk. Everything else here is answered from the checkout; the
 * plane then refuses on its own evidence.
 */
export const assertRemoteReady = async (
  environment: CliEnvironment,
  contract: ProgramContract,
  repoPath: string,
  computeFlag: string | undefined,
): Promise<RemoteReadiness> => {
  if (!isPlanned(contract) || contract.status !== "ratified") {
    throw new UsageError(
      `program ${contract.programId} is not ratified; remote execution needs a ratified plan (D-P10-09)`,
      "Run `nightshift plan check` and `nightshift plan ratify` first.",
    );
  }
  if (await isDirty(environment.git, repoPath)) {
    throw new UsageError(
      "the checkout has uncommitted changes; remote dispatch needs a clean tree",
      "Commit or stash them: the machine checks out exactly what is pushed, and a dirty tree means the plan was made against something else.",
    );
  }
  const branch = contract.repository.programBranch;
  const head = await tryRevParse(environment.git, repoPath, branch);
  if (head === undefined) {
    throw new UsageError(`the program branch ${branch} does not exist in ${repoPath}`);
  }
  const pushed = await tryRevParse(environment.git, repoPath, `refs/remotes/origin/${branch}`);
  if (pushed === undefined) {
    throw new UsageError(
      `${branch} has not been pushed: origin has no such branch`,
      `Push it (\`git push -u origin ${branch}\`); the machine clones from GitHub, never from this checkout.`,
    );
  }
  if (pushed !== head) {
    throw new UsageError(
      `${branch} is at ${head.slice(0, 12)} here and ${pushed.slice(0, 12)} at origin`,
      "Push (or pull) so the two agree; what is dispatched is what is at GitHub.",
    );
  }
  const onBranch = await currentBranch(environment.git, repoPath);
  if (onBranch !== branch) {
    environment.err(
      `note: the checkout is on ${onBranch}; the run dispatches ${branch} at ${head.slice(0, 12)} regardless`,
    );
  }
  const config = await readConfig(repoPath);
  const choice = chooseTier(parseTier(computeFlag), contract.compute, config?.compute);
  return {
    repositoryUrl: contract.repository.url,
    branch,
    baseSha: head,
    tier: choice.tier,
    source: choice.source,
  };
};

const orgOf = async (session: Session, projectId: string): Promise<string> =>
  ProjectSchema.parse(
    await send(session.transport, { method: "GET", path: routes.project(projectId as never) }),
  ).orgId;

/**
 * After `startRun` has made the remote run: the dispatch itself, and what it
 * will cost. The ceilings are read so the refusal, when there is one, is the
 * CLI's as well as the plane's.
 */
export const dispatchRun = async (
  environment: CliEnvironment,
  session: Session,
  started: StartedRun,
  readiness: RemoteReadiness,
  allowRedGates = false,
): Promise<Dispatch> => {
  const contract: ProgramContract = started.program;
  const scope: RunScope = {
    projectId: started.run.projectId,
    programId: started.run.programId,
    runId: started.run.runId,
  };
  const orgId = await orgOf(session, scope.projectId);
  const orgConfig = OrgConfigSchema.parse(
    await send(session.transport, { method: "GET", path: routes.orgConfig(orgId as never) }),
  );
  const ceilings = orgConfig.compute ?? DEFAULT_COMPUTE_CEILINGS;
  const hours = runHoursOf(contract.costPolicy.maxWallClockSeconds, ceilings);
  const estimated = estimateUsd(readiness.tier, hours);
  const refusal = mayDispatch({
    ceilings,
    tier: readiness.tier,
    runHours: hours,
    estimatedUsd: estimated,
    monthSpentUsd: 0,
    concurrentRuns: 0,
  });
  if (refusal !== undefined) throw new UsageError(refusal.detail);
  if (contract.planHash === undefined) throw new UsageError(REMOTE_NEEDS_PLAN);

  const spec = COMPUTE_TIERS[readiness.tier];
  const dispatch = DispatchSchema.parse(
    await send(session.transport, {
      method: "POST",
      path: routes.dispatch(scope),
      body: {
        tier: readiness.tier,
        idempotencyKey: `${scope.runId}:${readiness.baseSha}:${contract.planHash}`,
        input: {
          repositoryUrl: readiness.repositoryUrl,
          branch: readiness.branch,
          baseSha: readiness.baseSha,
          planHash: contract.planHash,
          ...(allowRedGates ? { allowRedGates: true } : {}),
        },
      },
    }),
  );
  environment.out(
    `dispatched on ${readiness.tier} (${spec.instanceType}, ${spec.vcpu} vCPU, ${spec.memoryGiB} GiB, ` +
      `$${spec.usdPerHour.toFixed(4)}/h, chosen by ${readiness.source}); ` +
      `up to $${estimated.toFixed(2)} at the run's ${hours}-hour ceiling`,
  );
  environment.out(
    `dispatch ${dispatch.status}: the machine is provisioned without you. ` +
      `\`nightshift remote status ${contract.programId}\` follows it; you can close the laptop.`,
  );
  return dispatch;
};

/** The program's most recent run that was dispatched, or the named run. */
const dispatchOf = async (
  environment: CliEnvironment,
  session: Session,
  files: ProgramFiles,
  runId: string | undefined,
): Promise<{ scope: RunScope; dispatch: Dispatch | undefined }> => {
  const programScope = { projectId: files.contract.projectId, programId: files.contract.programId };
  if (runId !== undefined) {
    const scope = { ...programScope, runId: runId as never };
    return { scope, dispatch: await session.stores.dispatches.get(scope) };
  }
  const runs = (await session.stores.runs.listByProgram(programScope)).items;
  for (const run of [...runs].reverse()) {
    if (run.location !== "remote") continue;
    const scope = { ...programScope, runId: run.runId };
    const dispatch = await session.stores.dispatches.get(scope);
    if (dispatch !== undefined) return { scope, dispatch };
  }
  environment.err(`program ${files.contract.programId} has no remote run; name one with --run`);
  return { scope: { ...programScope, runId: "" as never }, dispatch: undefined };
};

const describe = (dispatch: Dispatch): string[] => {
  const lines = [
    `run ${dispatch.runId}: ${dispatch.status}, generation ${dispatch.generation}, ` +
      `${dispatch.tier} (${dispatch.instanceType}) at $${dispatch.usdPerHour.toFixed(4)}/h`,
    `  machine ${dispatch.instanceId ?? "none yet"}${dispatch.availabilityZone === undefined ? "" : ` in ${dispatch.availabilityZone}`}, ` +
      `volume ${dispatch.volumeId ?? "none yet"}, image ${dispatch.amiVersion}`,
    `  metered ${Math.round(dispatch.spend.meteredSeconds / 60)} min, $${dispatch.spend.meteredUsd.toFixed(2)} of an estimated $${dispatch.spend.estimatedUsd.toFixed(2)}` +
      (dispatch.leaseExpiresAt === undefined ? "" : `; lease to ${dispatch.leaseExpiresAt}`),
  ];
  for (const attempt of dispatch.attempts) {
    lines.push(
      `  attempt ${attempt.generation} (${attempt.reason}) from ${attempt.startedAt}${attempt.endedAt === undefined ? "" : ` to ${attempt.endedAt}`}`,
    );
  }
  if (dispatch.publication.head !== undefined)
    lines.push(`  published ${dispatch.publication.head}`);
  if (dispatch.publication.blocked !== undefined)
    lines.push(`  publication blocked: ${dispatch.publication.blocked}`);
  if (dispatch.failure !== undefined)
    lines.push(`  ${dispatch.failure.code}: ${dispatch.failure.message}`);
  if (dispatch.cleanup.snapshotId !== undefined) {
    lines.push(
      `  snapshot ${dispatch.cleanup.snapshotId}${dispatch.cleanup.volumeDeleted ? ", volume deleted" : ""}`,
    );
  }
  for (const failure of dispatch.cleanup.failures) lines.push(`  cleanup: ${failure}`);
  return lines;
};

export interface RemoteOptions {
  readonly id: string;
  readonly repo?: string;
  readonly run?: string;
}

const openFor = async (environment: CliEnvironment, options: RemoteOptions) => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment);
  return { files, session };
};

export const remoteStatus = async (
  environment: CliEnvironment,
  options: RemoteOptions,
): Promise<number> => {
  const { files, session } = await openFor(environment, options);
  const { dispatch } = await dispatchOf(environment, session, files, options.run);
  if (dispatch === undefined) return 1;
  for (const line of describe(dispatch)) environment.out(line);
  return 0;
};

const post = async (
  environment: CliEnvironment,
  options: RemoteOptions,
  verb: "cancel" | "resume",
): Promise<number> => {
  const { files, session } = await openFor(environment, options);
  const { scope, dispatch } = await dispatchOf(environment, session, files, options.run);
  if (dispatch === undefined) return 1;
  try {
    const next = DispatchSchema.parse(
      await send(session.transport, {
        method: "POST",
        path: verb === "cancel" ? routes.dispatchCancel(scope) : routes.dispatchResume(scope),
      }),
    );
    for (const line of describe(next)) environment.out(line);
    return 0;
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      environment.err(`${verb} refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
};

export const remoteCancel = (environment: CliEnvironment, options: RemoteOptions) =>
  post(environment, options, "cancel");
export const remoteResume = (environment: CliEnvironment, options: RemoteOptions) =>
  post(environment, options, "resume");
