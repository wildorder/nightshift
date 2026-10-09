/**
 * The attached display (P16 S-03, D-09): `nightshift run --remote` after its
 * dispatch, and `nightshift remote status <program> --watch`.
 *
 * It polls the dispatch and shows WAIT while the machine comes up and audits
 * the gates against the laptop's reference, then OK GO once the machine agrees:
 * that is the moment the developer may walk away. An environment fault, any
 * other failure, or a dispatch stopped from elsewhere ends it with exit 1.
 * Ctrl-C only detaches: nothing is ever cancelled from here.
 *
 * On a terminal each poll redraws the frame in place. Anywhere else (a pipe, a
 * CI log) there are no escape codes: one plain line per stage change, per
 * finished gate and for the verdict.
 */
import type {
  Dispatch,
  DispatchProgress,
  EnvironmentFaultPayload,
  MachineGateProgress,
  RunnerStage,
} from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import type { CliEnvironment } from "../environment.js";
import type { Session } from "../session.js";
import { environmentFaultLines, environmentFaultOfRun } from "./remote.js";

/** How often the dispatch is read. */
export const POLL_MS = 3_000;
/** Polls that fail in a row before the display gives up and says how to reattach. */
export const MAX_POLL_FAILURES = 10;
/** Polls an environment fault's events are tried on before the cause line stands alone. */
const FAULT_READS = 3;
/** The exit code of a Ctrl-C detach. */
export const EXIT_DETACHED = 130;

/** The banner while the machine has not yet agreed. */
export const WAIT_BANNER: readonly string[] = [
  "#   #   ###   ###  #####",
  "#   #  #   #   #     #",
  "# # #  #####   #     #",
  "## ##  #   #   #     #",
  "#   #  #   #  ###    #",
];

/** The banner once it has. */
export const OK_GO_BANNER: readonly string[] = [
  " ###   #   #      ####   ###",
  "#   #  #  #      #      #   #",
  "#   #  ###       #  ##  #   #",
  "#   #  #  #      #   #  #   #",
  " ###   #   #      ####   ###",
];

/** Each runner stage, in words. */
export const STAGE_WORDS: Readonly<Record<RunnerStage, string>> = {
  up: "the machine is up",
  workspace: "workspace",
  toolchain: "the project's runtimes",
  setup: "setup",
  prerequisites: "prerequisite checks",
  audit: "the machine's gate audit, against your laptop's",
};

const LIVE: ReadonlySet<Dispatch["status"]> = new Set([
  "requested",
  "provisioning",
  "ready",
  "running",
]);

const NO_ANSWER = "the control plane did not answer; trying again";
const FAULT_PENDING = "environment fault: ending the dispatch";

/** `m:ss` from `fromIso` to `nowMs`; never negative. */
export const elapsed = (fromIso: string, nowMs: number): string => {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The stage in words, with its detail. */
export const stageWords = (progress: DispatchProgress): string =>
  `${STAGE_WORDS[progress.stage]}${progress.detail === undefined ? "" : `: ${progress.detail}`}`;

/** Passed on the reference, failed on the machine: the disagreement an environment fault is. */
const disagrees = (gate: MachineGateProgress): boolean =>
  gate.reference === "passed" && gate.machine === "failed";

const gateLine = (gate: MachineGateProgress): string =>
  `${gate.id}: machine ${gate.machine}, reference ${gate.reference ?? "none"}` +
  (disagrees(gate) ? "  << disagrees: passed on your laptop, failed on the machine" : "");

const verdictLine = (progress: DispatchProgress): string | undefined => {
  switch (progress.verdict) {
    case undefined:
      return undefined;
    case "fault":
      return FAULT_PENDING;
    case "agrees":
      return "verdict: the machine agrees with your laptop";
    case "red":
      return "verdict: the base is red on both, as on your laptop";
    case "skipped":
      return "verdict: a replacement machine, which does not audit again";
  }
};

const provisioningLine = (dispatch: Dispatch): string =>
  `dispatch ${dispatch.status}: the machine is being provisioned`;

/** Both durations: this stage's, from `stageStartedAt`, and the whole wait's, from `requestedAt`. */
const timesOf = (dispatch: Dispatch, nowMs: number): string => {
  const total = elapsed(dispatch.requestedAt, nowMs);
  return dispatch.progress === undefined
    ? `total ${total}`
    : `stage ${elapsed(dispatch.progress.stageStartedAt, nowMs)}, total ${total}`;
};

/** The frame a terminal shows beneath WAIT. */
export const waitLines = (dispatch: Dispatch, nowMs: number, trouble: boolean): string[] => {
  const progress = dispatch.progress;
  const lines = [
    "",
    `  ${progress === undefined ? provisioningLine(dispatch) : stageWords(progress)}`,
    `  ${timesOf(dispatch, nowMs)}`,
  ];
  for (const gate of progress?.gates ?? []) lines.push(`    ${gateLine(gate)}`);
  const verdict = progress === undefined ? undefined : verdictLine(progress);
  if (verdict !== undefined) lines.push(`  ${verdict}`);
  if (trouble) lines.push(`  ${NO_ANSWER}`);
  lines.push("", "  Ctrl-C detaches; the machine carries on.");
  return lines;
};

/** What the loop tells a display about each poll. */
interface Display {
  show(dispatch: Dispatch, trouble: boolean): void;
  trouble(): void;
}

const terminalDisplay = (environment: CliEnvironment): Display => {
  let drawn = 0;
  let last: Dispatch | undefined;
  const draw = (lines: readonly string[]): void => {
    // Up over the last frame, then clear to the end of the screen.
    const reset = drawn === 0 ? "" : `\u001b[${drawn}A\u001b[0J`;
    lines.forEach((line, index) => {
      environment.out(index === 0 ? `${reset}${line}` : line);
    });
    drawn = lines.length;
  };
  const frame = (dispatch: Dispatch | undefined, trouble: boolean): string[] => [
    ...WAIT_BANNER,
    ...(dispatch === undefined
      ? ["", `  ${NO_ANSWER}`]
      : waitLines(dispatch, environment.clock.now(), trouble)),
  ];
  return {
    show: (dispatch, trouble) => {
      last = dispatch;
      draw(frame(dispatch, trouble));
    },
    trouble: () => draw(frame(last, true)),
  };
};

const plainDisplay = (environment: CliEnvironment): Display => {
  let bannered = false;
  let stageKey: string | undefined;
  let generation: number | undefined;
  let printedGates = new Set<string>();
  let printedVerdict: string | undefined;
  let troubled = false;
  const say = (line: string): void => environment.out(line);

  const sayStage = (dispatch: Dispatch, at: string): void => {
    const progress = dispatch.progress;
    const key =
      progress === undefined ? `status ${dispatch.status}` : `${generation} ${progress.stage}`;
    if (key === stageKey) return;
    stageKey = key;
    say(`${at} ${progress === undefined ? provisioningLine(dispatch) : stageWords(progress)}`);
  };

  const sayAudit = (progress: DispatchProgress, at: string): void => {
    for (const gate of progress.gates ?? []) {
      if (printedGates.has(gate.id)) continue;
      printedGates.add(gate.id);
      say(`  gate ${gateLine(gate)}`);
    }
    const verdict = verdictLine(progress);
    if (verdict === undefined || verdict === printedVerdict) return;
    printedVerdict = verdict;
    say(`${at} ${verdict}`);
  };

  return {
    show: (dispatch) => {
      troubled = false;
      if (!bannered) {
        for (const line of WAIT_BANNER) say(line);
        bannered = true;
      }
      const progress = dispatch.progress;
      // A replacement machine reports its own stages and gates.
      if (progress !== undefined && progress.generation !== generation) {
        generation = progress.generation;
        printedGates = new Set();
        printedVerdict = undefined;
      }
      // Both durations on every line: this stage's and the whole wait's.
      const at = `[${timesOf(dispatch, environment.clock.now())}]`;
      sayStage(dispatch, at);
      if (progress !== undefined) sayAudit(progress, at);
    },
    trouble: () => {
      if (troubled) return;
      troubled = true;
      say(NO_ANSWER);
    },
  };
};

/** How the wait ended, before it is said. */
type Ending =
  | { readonly kind: "go"; readonly verdict: "agrees" | "red" | "skipped" }
  | { readonly kind: "fault" }
  | { readonly kind: "failed" }
  | { readonly kind: "stopped" };

/** The dispatch's ending, if it has one; `undefined` while it is still worth waiting. */
export const endingOf = (dispatch: Dispatch): Ending | undefined => {
  if (dispatch.status === "failed") {
    return dispatch.failure?.code === "environment_fault" ? { kind: "fault" } : { kind: "failed" };
  }
  if (!LIVE.has(dispatch.status)) return { kind: "stopped" };
  const verdict = dispatch.progress?.verdict;
  if (verdict === "agrees" || verdict === "red" || verdict === "skipped") {
    return { kind: "go", verdict };
  }
  return undefined;
};

export interface WatchTarget {
  /** As the developer names it to `nightshift remote`. */
  readonly program: string;
  readonly scope: RunScope;
}

const reattach = (program: string): string => `\`nightshift remote status ${program} --watch\``;

const goLines = (program: string, verdict: "agrees" | "red" | "skipped"): string[] => [
  ...OK_GO_BANNER,
  "",
  "the machine agrees with your laptop: you can close it now. " +
    `\`nightshift remote status ${program}\` follows the run.`,
  ...(verdict === "red"
    ? ["the base is red on both, so the run starts by repairing it."]
    : verdict === "skipped"
      ? ["a replacement machine carries on the audited run; it does not audit again."]
      : []),
];

const failedLines = (dispatch: Dispatch): string[] => [
  `the dispatch failed: ${dispatch.failure?.code ?? "unknown"}: ${dispatch.failure?.message ?? "no reason was recorded"}`,
];

const faultLines = (dispatch: Dispatch, fault: EnvironmentFaultPayload | undefined): string[] => [
  `environment fault: ${dispatch.failure?.message ?? "a gate green on your laptop failed on the machine"}`,
  ...environmentFaultLines(dispatch, fault),
];

const stoppedLines = (dispatch: Dispatch, program: string): string[] => [
  `the dispatch is ${dispatch.status} before the machine agreed with your laptop` +
    (dispatch.failure === undefined
      ? ""
      : ` (${dispatch.failure.code}: ${dispatch.failure.message})`) +
    `; \`nightshift remote status ${program}\` says more.`,
];

const detachLines = (program: string): string[] => [
  "detached: the machine carries on and nothing was cancelled. " +
    `${reattach(program)} reattaches; \`nightshift remote cancel ${program}\` stops it.`,
];

const deadLines = (program: string): string[] => [
  `the control plane did not answer ${MAX_POLL_FAILURES} times in a row; nothing was cancelled. ` +
    `${reattach(program)} reattaches.`,
];

/** What the loop knows between polls. */
interface WatchState {
  failures: number;
  faultReads: number;
  shown: boolean;
}

/** The lines and exit code that end the watch, or `undefined` to keep waiting. */
type Ended = { readonly lines: readonly string[]; readonly code: number } | undefined;

/** One answered poll: the dispatch shown, or its ending. */
const answered = async (
  session: Pick<Session, "stores">,
  target: WatchTarget,
  display: Display,
  state: WatchState,
  dispatch: Dispatch,
): Promise<Ended> => {
  state.failures = 0;
  const ending = endingOf(dispatch);
  switch (ending?.kind) {
    case "go":
      // The last of the wait, verdict and all, when there was a wait to see.
      if (state.shown) display.show(dispatch, false);
      return { lines: goLines(target.program, ending.verdict), code: 0 };
    case "failed":
      return { lines: failedLines(dispatch), code: 1 };
    case "stopped":
      return { lines: stoppedLines(dispatch, target.program), code: 1 };
    case "fault": {
      state.faultReads += 1;
      const fault = await environmentFaultOfRun(session, target.scope);
      // The events may land a moment after the dispatch fails: try again, then say the cause alone.
      if (fault !== undefined || state.faultReads >= FAULT_READS) {
        return { lines: faultLines(dispatch, fault), code: 1 };
      }
      break;
    }
    case undefined:
      break;
  }
  display.show(dispatch, false);
  state.shown = true;
  return undefined;
};

/** A poll the control plane did not answer: said, and counted. */
const unanswered = (target: WatchTarget, display: Display, state: WatchState): Ended => {
  state.failures += 1;
  if (state.failures >= MAX_POLL_FAILURES) return { lines: deadLines(target.program), code: 1 };
  display.trouble();
  return undefined;
};

const readDispatch = async (
  session: Pick<Session, "stores">,
  scope: RunScope,
): Promise<Dispatch | undefined> => {
  try {
    return await session.stores.dispatches.get(scope);
  } catch {
    return undefined;
  }
};

/**
 * Stays attached to the dispatch until it ends, and answers the exit code:
 * 0 at OK GO, 1 for a fault, a failure, a stopped dispatch or a control plane
 * that stopped answering, 130 for Ctrl-C. Never cancels anything.
 */
export const watchDispatch = async (
  environment: CliEnvironment,
  session: Pick<Session, "stores">,
  target: WatchTarget,
): Promise<number> => {
  let interrupted = false;
  let wake: (() => void) | undefined;
  const removeInterrupt = environment.onInterrupt(() => {
    interrupted = true;
    wake?.();
  });
  const pause = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
      environment.sleep(POLL_MS).then(resolve, resolve);
    }).finally(() => {
      wake = undefined;
    });
  const display = environment.stdoutIsTTY
    ? terminalDisplay(environment)
    : plainDisplay(environment);
  const end = (ended: NonNullable<Ended>): number => {
    for (const line of ended.lines) environment.out(line);
    return ended.code;
  };
  const detached = { lines: detachLines(target.program), code: EXIT_DETACHED };

  try {
    const state: WatchState = { failures: 0, faultReads: 0, shown: false };
    for (;;) {
      if (interrupted) return end(detached);
      const dispatch = await readDispatch(session, target.scope);
      if (interrupted) return end(detached);
      const ended =
        dispatch === undefined
          ? unanswered(target, display, state)
          : await answered(session, target, display, state, dispatch);
      if (ended !== undefined) return end(ended);
      await pause();
    }
  } finally {
    removeInterrupt();
  }
};
