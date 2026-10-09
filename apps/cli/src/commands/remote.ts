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
  type DispatchToolchain,
  OrgConfigSchema,
  type ProgramContract,
  ProjectSchema,
} from "@nightshift/contracts";
import {
  chooseTier,
  dispatchToolchain,
  estimateUsd,
  isPlanned,
  mayDispatch,
  PIN_FILES,
  PINNED_RUNTIMES,
  type Pin,
  type PinnedRuntime,
  parseRuntimeVersion,
  RUNTIME_VERSION_COMMANDS,
  type RunScope,
  resolvePins,
  runHoursOf,
} from "@nightshift/core";
import {
  currentBranch,
  type GitRunner,
  isDirty,
  type StartedRun,
  tryRevParse,
} from "@nightshift/execution";
import { ControlPlaneError, routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment, Exec } from "../environment.js";
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
  /**
   * The runtimes the machine installs, at the laptop's exact versions (P16
   * D-03). Absent when the project pins none: every runtime is then the image's.
   */
  readonly toolchain?: DispatchToolchain;
}

/** What measuring the laptop's runtimes needs: git, to read the pins, and a way to run `node --version`. */
export interface ToolchainDeps {
  readonly git: GitRunner;
  /** Absent where the CLI can run nothing; a pinned runtime is then unmeasured, and refused. */
  readonly exec?: Exec | undefined;
}

export type MeasuredToolchain =
  | {
      readonly ok: true;
      /** One entry per pinned runtime, at the version measured here. */
      readonly toolchain: DispatchToolchain;
      /** The runtimes Nightshift installs that the project does not pin: the image's. */
      readonly unpinned: readonly PinnedRuntime[];
      /** Pinned tools Nightshift cannot measure or install (a `.tool-versions` line for `terraform`). */
      readonly unmeasurable: readonly Pin[];
    }
  | { readonly ok: false; readonly conflict: boolean; readonly message: string };

const isMeasurable = (runtime: string): runtime is PinnedRuntime =>
  (PINNED_RUNTIMES as readonly string[]).includes(runtime);

/** The pin files as committed at `sha`; a file the commit lacks is not there. */
const pinFilesAt = async (
  git: GitRunner,
  repoPath: string,
  sha: string,
): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const file of PIN_FILES) {
    const shown = await git(["show", `${sha}:${file}`], { cwd: repoPath });
    if (shown.exitCode === 0) files[file] = shown.stdout;
  }
  return files;
};

type Measurement =
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

/** One runtime's `--version` on this machine. */
const measureRuntime = async (
  exec: Exec | undefined,
  repoPath: string,
  runtime: PinnedRuntime,
): Promise<Measurement> => {
  const [file, ...args] = RUNTIME_VERSION_COMMANDS[runtime];
  if (exec === undefined || file === undefined) return { kind: "missing" };
  const command = [file, ...args].join(" ");
  let result: Awaited<ReturnType<Exec>>;
  try {
    result = await exec(file, args, { cwd: repoPath });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return { kind: "missing" };
    return {
      kind: "refused",
      message: `\`${command}\` could not be run: ${(error as Error).message}`,
    };
  }
  if (result.exitCode !== 0) {
    const said = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      kind: "refused",
      message: `\`${command}\` failed with exit code ${result.exitCode}${said === "" ? "" : `: ${said}`}`,
    };
  }
  // `java -version` writes to stderr.
  const version = parseRuntimeVersion(runtime, `${result.stdout}\n${result.stderr}`);
  if (version === undefined) {
    const said = firstLine(result.stdout) || firstLine(result.stderr);
    return {
      kind: "refused",
      message: `\`${command}\` printed no exact ${runtime} version${said === "" ? "" : ` (it said "${said}")`}`,
    };
  }
  return { kind: "version", version };
};

/**
 * The versions a dispatch carries (P16 S-01, D-03): the pins as committed at
 * `baseSha`, never the working tree, each met by the version of the runtime
 * this machine runs. Refused when pin files disagree, a pinned runtime is not
 * installed here, or its version does not satisfy its pin. The reference
 * audit (S-02) records the same measurement.
 */
export const measureToolchain = async (
  deps: ToolchainDeps,
  repoPath: string,
  baseSha: string,
): Promise<MeasuredToolchain> => {
  const resolution = resolvePins(await pinFilesAt(deps.git, repoPath, baseSha));
  if (!resolution.ok) return { ok: false, conflict: true, message: resolution.message };

  const pins = resolution.pins.filter((pin) => isMeasurable(pin.runtime));
  const unmeasurable = resolution.pins.filter((pin) => !isMeasurable(pin.runtime));
  const measured: Record<string, string | undefined> = {};
  const refusals: string[] = [];
  const carried: Pin[] = [];
  for (const pin of pins) {
    const measurement = await measureRuntime(deps.exec, repoPath, pin.runtime as PinnedRuntime);
    if (measurement.kind === "refused") {
      refusals.push(
        `this project pins ${pin.runtime} ${pin.spec} (${pin.source}) but ${measurement.message}`,
      );
      continue;
    }
    if (measurement.kind === "version") measured[pin.runtime] = measurement.version;
    carried.push(pin);
  }
  const resolved = dispatchToolchain(carried, measured);
  if (!resolved.ok || refusals.length > 0) {
    const message = [...(resolved.ok ? [] : [resolved.message]), ...refusals].join("\n");
    return { ok: false, conflict: false, message };
  }
  return {
    ok: true,
    toolchain: resolved.toolchain,
    unpinned: PINNED_RUNTIMES.filter((runtime) => !pins.some((pin) => pin.runtime === runtime)),
    unmeasurable,
  };
};

/** One line: what the machine will run, and that the rest is the image's. */
const describeToolchain = (toolchain: DispatchToolchain | undefined): string => {
  if (toolchain === undefined || toolchain.length === 0) {
    return "runtimes: this project pins none, so the machine runs the image's";
  }
  const pinned = toolchain
    .map(
      (entry) =>
        `${entry.runtime} ${entry.version}${entry.source.kind === "pin" ? ` (${entry.source.file})` : " (the image's)"}`,
    )
    .join(", ");
  return `runtimes: the machine runs ${pinned}, as measured here; any runtime the project does not pin is the image's`;
};

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
  // P16 S-01: the pins at the commit dispatched, met by this laptop's runtimes,
  // before anything is written to the plane or a machine is paid for.
  const measured = await measureToolchain(environment, repoPath, head);
  if (!measured.ok) {
    throw new UsageError(
      measured.message,
      measured.conflict
        ? "Make the pin files agree, then commit and push; the machine installs one version of each runtime."
        : "Switch to the pinned version with your version manager (nvm, mise, asdf, pyenv, rbenv…) and audit again, " +
            "or change the pin and commit it; the machine runs exactly the versions your audit ran on.",
    );
  }
  for (const pin of measured.unmeasurable) {
    environment.err(
      `note: ${pin.source} pins ${pin.runtime} ${pin.spec}; Nightshift does not install ${pin.runtime}, so the machine runs the image's, if it has one`,
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
    // Absent rather than empty: the dispatch then says nothing it did not measure.
    ...(measured.toolchain.length === 0 ? {} : { toolchain: measured.toolchain }),
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
          ...(readiness.toolchain === undefined ? {} : { toolchain: readiness.toolchain }),
        },
      },
    }),
  );
  // Here, not in readiness: the run id stays the first line of stdout.
  environment.out(describeToolchain(readiness.toolchain));
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
