/** The actual machine baseline is diagnostic evidence, never a laptop-parity prerequisite. */
import {
  type CheckDispatch,
  type CommitSha,
  MAX_PROGRESS_GATES,
  type MachineAuditVerdict,
  type MachineGateProgress,
  type Prerequisite,
  type RunnerProgress,
} from "@nightshift/contracts";
import {
  nowIso,
  parseRuntimeVersion,
  prerequisitesOf,
  unmetPrerequisitesAt,
} from "@nightshift/core";
import {
  auditGates,
  compareWithReference,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  deferralOf,
  type ExecutionEnvironment,
  type GateAudit,
  type GateComparison,
  gateVerdictOf,
  recordRedBase,
  runPreflight,
  stepsAs,
} from "@nightshift/execution";
import { runVerificationSteps, type StepResult, setupAsStep } from "@nightshift/verification";
import type { Runtime } from "../compose.js";
import type { RunnerContext, RunnerWorkEnd } from "./main.js";
import { projectEnvironment } from "./workspace.js";

export type MachineAuditRuntime = Pick<
  Runtime,
  "git" | "stores" | "bodies" | "ids" | "clock" | "runAs" | "reclaim" | "paths" | "prerequisites"
>;

export type MachineAuditContext = Pick<RunnerContext, "scope" | "layout" | "dispatch" | "program"> &
  Partial<Pick<RunnerContext, "projectEnv">> & {
    /** Told where the audit has got to (P16 S-03); the runner hands it to its heartbeat. */
    readonly onProgress?: (progress: RunnerProgress) => void;
  };

/** What a replacement machine says of the audit it does not run. */
export const SKIPPED_AUDIT_DETAIL = "a replacement machine; the first one's audit stands";

/**
 * One finished step of the audit as the heartbeat carries it: its gate's id
 * and kind (`setup:<id>`) and the actual machine's verdict.
 */
export const gateProgressOf = (
  result: StepResult,
  context: Pick<MachineAuditContext, "dispatch" | "program">,
): MachineGateProgress => {
  const setup = new Set((context.program.setup ?? []).map((step) => setupAsStep(step).id));
  return {
    id: result.stepId,
    kind: setup.has(result.stepId) ? "setup" : "check",
    machine: gateVerdictOf(result),
  };
};

/** The actual machine's baseline verdict. */
export const auditVerdictOf = (comparison: GateComparison): MachineAuditVerdict => {
  return comparison.red.length > 0 ? "red" : "agrees";
};

/** The final `audit` progress: every gate, unrun and waiting ones too, and the verdict. */
export const auditProgressOf = (comparison: GateComparison): RunnerProgress => ({
  stage: "audit",
  gates: comparison.gates.slice(0, MAX_PROGRESS_GATES).map(
    (gate): MachineGateProgress => ({
      id: gate.id,
      kind: gate.kind,
      machine: gate.machine,
      ...(gate.reference === undefined ? {} : { reference: gate.reference }),
    }),
  ),
  verdict: auditVerdictOf(comparison),
});

/** What the audit found; absent on a replacement machine, which does not audit. A red one does not stop the root. */
export interface MachineAuditResult {
  readonly audit?: GateAudit;
  /** The actual machine's results in the progress representation. */
  readonly comparison?: GateComparison;
}

/** What the runner says of a red base: the red gates, by id and command. */
export const redReason = (audit: GateAudit): string => {
  const named = audit.gates
    .filter((gate) => gate.verdict === "failed")
    .map((gate) => `${gate.id} (\`${gate.command}\`)`)
    .join(", ");
  return (
    `the gate audit on ${audit.base.slice(0, 8)} found ${named} failing; the run starts, and its ` +
    "baseline evidence is on the program node for diagnosis and authorized repair."
  );
};

/**
 * The project environment setup ran in (P16 S-01): the pinned runtimes and the
 * stores. Built here only when the runner did not hand one over, and then, as
 * `prepareWorkspace` builds it, with the runner's own PATH after the image's,
 * so a runtime the project does not pin is found where the runner finds it.
 */
const environmentOf = (context: MachineAuditContext): Readonly<Record<string, string>> =>
  context.projectEnv ??
  projectEnvironment(context.layout, context.dispatch.input.toolchain, undefined, process.env.PATH);

/** As verification on this machine runs its steps (D-P10-25): a worker user. */
const asWorker = (runtime: MachineAuditRuntime, context: MachineAuditContext) =>
  stepsAs(runtime as Pick<ExecutionEnvironment, "runAs">, {
    agentId: `${context.dispatch.engineAgentId}-gates`,
    role: "worker",
  });

/**
 * Every prerequisite's `verifyCommand`, run on this machine as a worker user in
 * the project environment, each recorded as a machine check under this
 * dispatch (P16, D-08). Returns the ids unmet here: those whose check, this
 * dispatch's own, did not exit zero. The laptop's status plays no part.
 */
export const checkPrerequisitesOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
): Promise<ReadonlySet<string>> => {
  const prerequisites = prerequisitesOf(context.program);
  if (prerequisites.length === 0) return new Set();
  const dispatch: CheckDispatch = {
    runId: context.scope.runId,
    generation: context.dispatch.generation,
  };
  const book = runtime.prerequisites;
  log(`prerequisites: checking ${prerequisites.length} on this machine`);
  context.onProgress?.({ stage: "prerequisites", detail: `checking ${prerequisites.length}` });
  const result = await runPreflight({
    contract: context.program,
    cwd: context.layout.checkout,
    site: { where: "machine", dispatch },
    env: environmentOf(context),
    ...asWorker(runtime, context),
    clock: runtime.clock,
    record: async (scope, prerequisiteId, exitCode): Promise<Prerequisite> => {
      if (book !== undefined) {
        return book.recordMachineCheck(scope, prerequisiteId, exitCode, dispatch);
      }
      // No control plane to tell (a suite's runtime): the check stands as run.
      const prerequisite = prerequisites.find((candidate) => candidate.id === prerequisiteId);
      if (prerequisite === undefined) throw new Error(`no prerequisite ${prerequisiteId}`);
      return {
        ...prerequisite,
        machineChecks: [
          { where: "machine", ...dispatch, exitCode, checkedAt: nowIso(runtime.clock) },
        ],
      };
    },
  });
  for (const check of result.checks) {
    log(
      `prerequisites: ${check.prerequisite.id} ${
        check.exitCode === 0
          ? "met"
          : check.timedOut
            ? "unmet (timed out)"
            : `unmet (exited ${check.exitCode})`
      } on this machine`,
    );
  }
  // Judged from the checks as recorded, this dispatch's alone.
  return unmetPrerequisitesAt(
    result.checks.map((check) => check.prerequisite),
    { where: "machine", dispatch },
  );
};

/**
 * `node --version` on this machine, exact and without the `v`, as a worker
 * user in the project environment: the Node the gates ran on. `undefined` when
 * there is none.
 */
export const nodeOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
): Promise<string | undefined> => {
  try {
    const [result] = await runVerificationSteps({
      steps: [{ id: "node", command: "node --version" }],
      cwd: context.layout.checkout,
      env: environmentOf(context),
      ...asWorker(runtime, context),
      timeoutMs: 60_000,
    });
    if (result === undefined || result.exitCode !== 0) return undefined;
    return parseRuntimeVersion("node", new TextDecoder().decode(result.output));
  } catch {
    return undefined;
  }
};

export const auditOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
): Promise<MachineAuditResult> => {
  if (context.dispatch.generation > 1) {
    context.onProgress?.({ stage: "audit", verdict: "skipped", detail: SKIPPED_AUDIT_DETAIL });
    return {};
  }
  const unmet = await checkPrerequisitesOnMachine(runtime, context, log);
  const base = context.dispatch.input.baseSha.slice(0, 8);
  log(`gate audit: setup and every check, on ${base}`);
  context.onProgress?.({ stage: "audit", detail: `setup and every check, on ${base}` });
  // Each gate as it finishes on this machine.
  const finished: MachineGateProgress[] = [];
  const audit = await auditGates({
    git: runtime.git,
    repoPath: context.layout.checkout,
    base: context.dispatch.input.baseSha as CommitSha,
    program: context.program,
    unmet,
    workDir: `${context.layout.run}/gate-audit`,
    timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    paths: runtime.paths,
    // The project environment setup ran in (P16 S-01): the pinned runtimes and the stores.
    env: environmentOf(context),
    // As verification on this machine runs its steps (D-P10-25), and taken
    // back by the engine before it goes (D-P10-29).
    ...asWorker(runtime, context),
    ...(runtime.reclaim === undefined ? {} : { reclaim: runtime.reclaim }),
    onStep: (result) => {
      log(
        `gate audit: ${result.stepId} ${
          result.exitCode === 0
            ? "ok"
            : deferralOf(result) === undefined
              ? `exited ${result.exitCode}`
              : "deferred"
        } in ${(result.durationMs / 1000).toFixed(1)}s`,
      );
      if (finished.length < MAX_PROGRESS_GATES) finished.push(gateProgressOf(result, context));
      context.onProgress?.({ stage: "audit", gates: [...finished] });
    },
  });
  // Deferred is not red (D-P7-10): it is said, with what it waits for, and the root starts.
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "deferred")) {
    log(
      `gate audit: ${gate.id} deferred` +
        (gate.deferral === undefined
          ? ""
          : `: ${gate.deferral.prerequisiteId} ${gate.deferral.description}`),
    );
  }
  const comparison = compareWithReference(undefined, audit);
  // Report the machine's own baseline; historical references do not affect execution.
  context.onProgress?.(auditProgressOf(comparison));
  if (!audit.red) return { audit, comparison };

  const run = await runtime.stores.runs.get(context.scope, context.scope.runId);
  if (run !== undefined) {
    await recordRedBase(runtime, {
      scope: context.scope,
      nodeId: run.rootNodeId,
      audit,
      writerId: `${context.dispatch.engineAgentId}-gates`,
      event: true,
    });
  }
  log(`gate audit: red (${audit.failing.join(", ")}); ${redReason(audit)}`);
  return { audit, comparison };
};

/** Record the machine baseline and start the root, including when checks are red. */
export const auditThenRoot = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
  root: () => Promise<void>,
): Promise<{ readonly audited: MachineAuditResult; readonly ended?: RunnerWorkEnd }> => {
  const audited = await auditOnMachine(runtime, context, log);
  await root();
  return { audited };
};
