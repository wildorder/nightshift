/**
 * The gate audit: a program's setup and verification, run on the commit a run
 * would start from, before any agent works on it.
 *
 * Until a run starts, nothing runs the gates under Nightshift's conditions, so
 * the first time they meet a fresh checkout is the first job's verification,
 * hours in and with nobody watching. A gate that cannot pass there fails every
 * job for a reason none of them caused. The audit moves that moment to before
 * the run, where the human is.
 *
 * It runs exactly what verification runs, the same way, once: a new checkout
 * of the base, setup (seeded from the program checkout when the lockfiles
 * match, D-P10-24), then each check in the contract's order.
 *
 * Deterministic: no model is asked anything, and the audit decides nothing on
 * its own. It reports; the caller decides what a red base means for its run.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha, ProgramContract, VerificationStep } from "@nightshift/contracts";
import {
  type DeferSignal,
  deferSignalOf,
  LOCKFILES,
  type RunVerificationInput,
  runSetupSteps,
  runVerificationSteps,
  type StepResult,
  setupAsStep,
  setupFailed,
} from "@nightshift/verification";
import { addDetachedWorktree, type GitRunner, pruneWorktrees, tryGit } from "./git/index.js";
import { discardScratch, freshScratch, type ScratchPaths, scratchEnv } from "./scratch.js";

/**
 * - `passed`: it exited 0.
 * - `failed`: it did not. A failed check means the base cannot pass this gate.
 * - `deferred`: it said it could not run for want of something only a human
 *   can supply (exit 75 and a `NIGHTSHIFT_DEFER` line, D-P7-10), as
 *   verification would defer it. Not a failure: the base is not red for it.
 * - `waiting`: it needs a human prerequisite nobody has met, so it did not run.
 * - `unrun`: an earlier setup step failed or deferred, so it did not run.
 */
export type GateVerdict = "passed" | "failed" | "deferred" | "waiting" | "unrun";

export interface AuditedGate {
  readonly id: string;
  readonly command: string;
  readonly kind: "setup" | "check";
  /** What it did, when it ran. */
  readonly result?: StepResult;
  readonly verdict: GateVerdict;
  /** The unmet prerequisites, when `waiting`. */
  readonly waitingOn: readonly string[];
  /** What it said it was missing, when `deferred`. */
  readonly deferral?: DeferSignal;
}

export interface GateAudit {
  readonly base: CommitSha;
  readonly gates: readonly AuditedGate[];
  /** True when some gate failed: no job can pass verification on this base. */
  readonly red: boolean;
  readonly failing: readonly string[];
  /** The gates that deferred: not red, but not proven to pass either. */
  readonly deferred: readonly string[];
  /**
   * Lockfiles at the base when the program declares no setup. Every
   * verification then starts with nothing installed, and only an install folded
   * into the gates, if there is one, makes them pass.
   */
  readonly lockfilesWithoutSetup: readonly string[];
}

export interface GateAuditInput {
  readonly git: GitRunner;
  /** The program checkout: the worktree is added from it, and its installed tree seeds setup. */
  readonly repoPath: string;
  readonly base: CommitSha;
  readonly program: Pick<ProgramContract, "setup" | "verification">;
  /** Prerequisite ids not yet satisfied. A check that requires one is `waiting`. */
  readonly unmet: ReadonlySet<string>;
  /** A directory to make the audit's checkout in. A temporary one when absent. */
  readonly workDir?: string;
  readonly timeoutMs: number;
  /** Where the audit's scratch goes (`LocalPaths.scratch`): short, so sockets fit in it. */
  readonly paths: ScratchPaths;
  /** Added to every step's environment, as verification's are on this machine. */
  readonly env?: Readonly<Record<string, string>>;
  /** Who each step runs as, as verification's do on a machine (D-P10-25). Absent, as this process. */
  readonly as?: RunVerificationInput["as"];
  /** After each step, for a caller that shows progress. */
  readonly onStep?: (result: StepResult) => void;
}

/** The deferral a step declared, read as verification reads it (`deferSignalOf`). */
export const deferralOf = (result: StepResult): DeferSignal | undefined =>
  deferSignalOf(result.exitCode, new TextDecoder().decode(result.output));

/** What one step's result makes of its gate. */
export const gateVerdictOf = (result: StepResult | undefined): GateVerdict => {
  if (result === undefined) return "unrun";
  if (result.exitCode === 0) return "passed";
  return deferralOf(result) === undefined ? "failed" : "deferred";
};

const judged = (result: StepResult | undefined): Pick<AuditedGate, "verdict" | "deferral"> => {
  const deferral = result === undefined ? undefined : deferralOf(result);
  return {
    verdict: gateVerdictOf(result),
    ...(deferral === undefined ? {} : { deferral }),
  };
};

/** Setup, then, when it passed, each runnable check, in `checkout`. */
const runOnce = async (
  input: GateAuditInput,
  checkout: string,
  runnable: readonly VerificationStep[],
): Promise<Map<string, StepResult>> => {
  const results = new Map<string, StepResult>();
  const record = (result: StepResult): void => {
    results.set(result.stepId, result);
    input.onStep?.(result);
  };
  // A temp directory of its own, as a verification gets (scratch.ts).
  const scratch = await freshScratch(input.paths, checkout, input.as);
  const how = {
    timeoutMs: input.timeoutMs,
    env: { ...(input.env ?? {}), ...scratchEnv(scratch) },
    ...(input.as === undefined ? {} : { as: input.as }),
  };
  const prepared = await runSetupSteps({
    setup: input.program.setup ?? [],
    cwd: checkout,
    reference: input.repoPath,
    ...how,
  });
  for (const result of prepared) record(result);
  if (setupFailed(prepared)) return results;
  for (const step of runnable) {
    const [result] = await runVerificationSteps({ steps: [step], cwd: checkout, ...how });
    if (result !== undefined) record(result);
  }
  return results;
};

/** The lockfiles committed at `base`, when the program declares no setup. */
const lockfilesWithoutSetupAt = async (input: GateAuditInput): Promise<readonly string[]> => {
  if ((input.program.setup ?? []).length > 0) return [];
  const found: string[] = [];
  for (const lockfile of LOCKFILES) {
    const present = await tryGit(input.git, ["cat-file", "-e", `${input.base}:${lockfile}`], {
      cwd: input.repoPath,
    });
    if (present.exitCode === 0) found.push(lockfile);
  }
  return found;
};

/** Runs the audit. The checkout it makes is removed before it returns, whatever happened. */
export const auditGates = async (input: GateAuditInput): Promise<GateAudit> => {
  const waitingOn = (step: VerificationStep): readonly string[] =>
    (step.requires ?? []).filter((id) => input.unmet.has(id));
  const runnable = input.program.verification.filter((step) => waitingOn(step).length === 0);

  const temporary = input.workDir === undefined;
  const parent = temporary ? await mkdtemp(join(tmpdir(), "nightshift-gates-")) : input.workDir;
  await mkdir(parent, { recursive: true });
  const checkout = join(parent, `audit-${input.base.slice(0, 12)}`);
  await rm(checkout, { recursive: true, force: true });
  await pruneWorktrees(input.git, input.repoPath);
  await addDetachedWorktree(input.git, { repo: input.repoPath, path: checkout, base: input.base });

  let results: Map<string, StepResult>;
  try {
    results = await runOnce(input, checkout, runnable);
  } finally {
    await discardScratch(input.paths, checkout, input.as);
    await tryGit(input.git, ["worktree", "remove", "--force", checkout], {
      cwd: input.repoPath,
    }).catch(() => undefined);
    await rm(temporary ? parent : checkout, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await pruneWorktrees(input.git, input.repoPath).catch(() => undefined);
  }

  const gates: AuditedGate[] = [
    ...(input.program.setup ?? []).map((step): AuditedGate => {
      const id = setupAsStep(step).id;
      const result = results.get(id);
      return {
        id,
        command: step.command,
        kind: "setup",
        ...(result === undefined ? {} : { result }),
        ...judged(result),
        waitingOn: [],
      };
    }),
    ...input.program.verification.map((step): AuditedGate => {
      const waiting = waitingOn(step);
      const result = results.get(step.id);
      return {
        id: step.id,
        command: step.command,
        kind: "check",
        ...(result === undefined ? {} : { result }),
        ...(waiting.length > 0 ? { verdict: "waiting" as const } : judged(result)),
        waitingOn: waiting,
      };
    }),
  ];
  // A failed setup step is what left the checks `unrun`; it is the one named.
  const failing = gates.filter((gate) => gate.verdict === "failed").map((gate) => gate.id);
  // A deferred one leaves them `unrun` too, and is named here, not as red.
  const deferred = gates.filter((gate) => gate.verdict === "deferred").map((gate) => gate.id);
  return {
    base: input.base,
    gates,
    red: failing.length > 0,
    failing,
    deferred,
    lockfilesWithoutSetup: await lockfilesWithoutSetupAt(input),
  };
};

/** The tail of a step's output, for a person reading why it failed. */
export const outputTail = (result: StepResult, chars = 3000): string => {
  const text = new TextDecoder().decode(result.output).trimEnd();
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
};
