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
 * It runs exactly what verification runs, the same way: a new checkout of the
 * base, setup (seeded from the program checkout when the lockfiles match,
 * D-P10-24), then each check in the contract's order. Then it does it again in
 * the same checkout after `pristineCheckout`, which is what a re-verification in
 * a worker's reused worktree sees. Two runs tell a gate that is broken from one
 * that is flaky, and catch a gate that depends on state outside the checkout.
 *
 * Deterministic: no model is asked anything, and the audit decides nothing on
 * its own. It reports; the caller decides what a red base means for its run.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha, ProgramContract, VerificationStep } from "@nightshift/contracts";
import {
  LOCKFILES,
  type RunVerificationInput,
  runSetupSteps,
  runVerificationSteps,
  type StepResult,
  setupAsStep,
  setupFailed,
} from "@nightshift/verification";
import {
  addDetachedWorktree,
  type GitRunner,
  pristineCheckout,
  pruneWorktrees,
  tryGit,
} from "./git/index.js";

/** Two passes: the second is a re-verification in the same checkout. */
export const GATE_AUDIT_PASSES = 2;

/**
 * - `passed`: every run of it passed.
 * - `failed`: every run of it failed. The base cannot pass this gate.
 * - `flaky`: it passed and failed on the same commit.
 * - `waiting`: it needs a human prerequisite nobody has met, so it did not run.
 * - `unrun`: setup failed in every pass, so no check ran.
 */
export type GateVerdict = "passed" | "failed" | "flaky" | "waiting" | "unrun";

export interface AuditedGate {
  readonly id: string;
  readonly command: string;
  readonly kind: "setup" | "check";
  /** One per pass the step ran in, in order. */
  readonly runs: readonly StepResult[];
  readonly verdict: GateVerdict;
  /** The unmet prerequisites, when `waiting`. */
  readonly waitingOn: readonly string[];
}

export interface GateAudit {
  readonly base: CommitSha;
  readonly gates: readonly AuditedGate[];
  /** True when some gate failed every run: no job can pass verification on this base. */
  readonly red: boolean;
  readonly failing: readonly string[];
  readonly flaky: readonly string[];
  /**
   * Lockfiles at the base when the program declares no setup. Every
   * verification then starts with nothing installed, and only an install folded
   * into the gates, if there is one, makes them pass.
   */
  readonly lockfilesWithoutSetup: readonly string[];
}

export interface GateAuditProgress {
  readonly pass: number;
  readonly result: StepResult;
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
  /** Added to every step's environment, as verification's are on this machine. */
  readonly env?: Readonly<Record<string, string>>;
  /** Who each step runs as, as verification's do on a machine (D-P10-25). Absent, as this process. */
  readonly as?: RunVerificationInput["as"];
  /** After each step, for a caller that shows progress. */
  readonly onStep?: (progress: GateAuditProgress) => void;
}

/** A gate's verdict from its runs. */
export const verdictOf = (runs: readonly StepResult[]): GateVerdict => {
  if (runs.length === 0) return "unrun";
  const passed = runs.filter((run) => run.exitCode === 0).length;
  if (passed === runs.length) return "passed";
  return passed === 0 ? "failed" : "flaky";
};

type RunsById = Map<string, StepResult[]>;

/** Both passes in `checkout`: setup, then each runnable check, the second pass after a pristine clean. */
const runPasses = async (
  input: GateAuditInput,
  checkout: string,
  runnable: readonly VerificationStep[],
): Promise<RunsById> => {
  const runs: RunsById = new Map();
  const record = (pass: number, result: StepResult): void => {
    runs.set(result.stepId, [...(runs.get(result.stepId) ?? []), result]);
    input.onStep?.({ pass, result });
  };
  const how = {
    timeoutMs: input.timeoutMs,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.as === undefined ? {} : { as: input.as }),
  };
  for (let pass = 1; pass <= GATE_AUDIT_PASSES; pass += 1) {
    if (pass > 1) await pristineCheckout(input.git, checkout, input.base);
    const prepared = await runSetupSteps({
      setup: input.program.setup ?? [],
      cwd: checkout,
      reference: input.repoPath,
      ...how,
    });
    for (const result of prepared) record(pass, result);
    if (setupFailed(prepared)) continue;
    for (const step of runnable) {
      const [result] = await runVerificationSteps({
        steps: [step],
        cwd: checkout,
        ...how,
      });
      if (result !== undefined) record(pass, result);
    }
  }
  return runs;
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

  let runs: RunsById;
  try {
    runs = await runPasses(input, checkout, runnable);
  } finally {
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
      const ran = runs.get(id) ?? [];
      return {
        id,
        command: step.command,
        kind: "setup",
        runs: ran,
        verdict: verdictOf(ran),
        waitingOn: [],
      };
    }),
    ...input.program.verification.map((step): AuditedGate => {
      const waiting = waitingOn(step);
      const ran = runs.get(step.id) ?? [];
      return {
        id: step.id,
        command: step.command,
        kind: "check",
        runs: ran,
        verdict: waiting.length > 0 ? "waiting" : verdictOf(ran),
        waitingOn: waiting,
      };
    }),
  ];
  // A setup step that failed every pass is what left the checks `unrun`; it is
  // the one named.
  const failing = gates.filter((gate) => gate.verdict === "failed").map((gate) => gate.id);
  return {
    base: input.base,
    gates,
    red: failing.length > 0,
    failing,
    flaky: gates.filter((gate) => gate.verdict === "flaky").map((gate) => gate.id),
    lockfilesWithoutSetup: await lockfilesWithoutSetupAt(input),
  };
};

/** The tail of a step's output, for a person reading why it failed. */
export const outputTail = (result: StepResult, chars = 3000): string => {
  const text = new TextDecoder().decode(result.output).trimEnd();
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
};
