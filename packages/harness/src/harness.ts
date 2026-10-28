/**
 * The harness adapter contract, version 1 (P3 §4.6 and D-P3-03; finalised by P5,
 * D-P5-01, A-37).
 *
 * ## What this is for
 *
 * The execution layer drives a worker through this interface and nothing else.
 * It never learns which provider it has, what that provider's command line looks
 * like, how it is authenticated, how its output is framed, or how its tool
 * permissions are expressed. Every one of those lives behind `start`.
 *
 * Version 0 (P3) existed so the execution layer was written against an
 * interface rather than a process. Version 1 (P5) is that contract finalised
 * against two local adapters and the shape P10's remote one needs. Two things
 * were added and nothing removed: the worker operations arrive as functions
 * (`tools`, see `tools.ts`) beside the MCP launch, and an adapter says whether
 * it reports `usage` and carries it on the exit.
 *
 * ## Rules for anyone implementing this
 *
 * 1. **The identity is given to you, never invented.** `input.agent` already
 *    exists in the control plane before `start` is called (A-04). Put its
 *    `agentId` on the handle; do not mint one.
 * 2. **Emit the lifecycle without the worker's help** (D-P3-09). `agent.started`
 *    and exactly one of `agent.completed` / `agent.failed` / `agent.cancelled` /
 *    `agent.interrupted` must reach the sink for every run, including a worker
 *    that calls no tool and exits non-zero. If the provider's output stream
 *    cannot tell you something, configure a provider hook and read that; do not
 *    ask the worker to report it, and do not skip the event.
 * 3. **`exit` settles exactly once.** It never rejects: a failure to launch is
 *    `failed` with an exit code, not a rejected promise, because the execution
 *    layer has a node to move to a durable status either way.
 * 4. **Nothing provider-specific escapes.** Not in a type, not in an event name,
 *    not in a payload key that only means something to one provider.
 * 5. **The worker never gets git write access** (D-P3-15, A-29). Nightshift owns
 *    every commit; an adapter that granted a `git commit` tool would let a worker
 *    author history Nightshift did not.
 * 6. **One transport per worker.** A worker's four operations reach `WorkerTools`
 *    either through the MCP server in `input.mcp` or through `input.tools`
 *    directly, never both: two transports are two ways to report one job.
 * 7. **Every exit variant carries the usage the adapter saw.** `cancelled` and
 *    `interrupted` too: what was spent before the stop was still spent. An
 *    adapter that cannot say leaves `coverage` unknown rather than claim
 *    completeness. `RouteUsage.inputIncludesCache` states the adapter's input
 *    convention, so a reader never has to guess whether cache is in the input.
 */

import type {
  Agent,
  AgentId,
  AgentStatus,
  ExaminationFinding,
  ExaminationId,
  ExaminationQuestion,
  ExaminationRuling,
  ExecutionNode,
  JobContract,
  MeasurementCounters,
  ProgramContract,
  RiskLevel,
  RouteTarget,
  RouteUsage,
  VerificationCommandResult,
} from "@nightshift/contracts";
import type { HookSink } from "./hooks.js";
import type { MeasurementSink } from "./measurement.js";
import type { RunAs } from "./run-as.js";
import type { WorkerTools } from "./tools.js";

/** A span of time. Milliseconds, named so a call site cannot mistake the unit. */
export interface Duration {
  readonly ms: number;
}

export const millis = (ms: number): Duration => ({ ms });

/**
 * How to launch the worker's own Nightshift MCP server.
 *
 * The execution layer builds this: the command is the `nightshift-mcp` binary,
 * and `env` carries the seven identity variables of contract §4.2 plus
 * `NIGHTSHIFT_ROLE=worker`. An adapter translates it into whatever configuration
 * format its provider expects and passes it through unchanged. It must not add,
 * remove or rewrite an entry: the identity a worker carries is fixed by the party
 * that spawned it, which is the whole of D-P3-01.
 */
export interface McpLaunch {
  /** A server name for the provider's configuration file. Cosmetic. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The evidence an examiner is given (P8, D-P8-11): what was asked for, what was
 * changed, and what the checks said. Never the implementer's summary,
 * transcript or commit message.
 */
/** A finding of an earlier examination, with the examination that raised it. */
export type EarlierFinding = ExaminationFinding & { readonly examinationId: ExaminationId };

export interface ExaminationEvidence {
  /** The diff under examination, from the base the work was cut from. Possibly truncated. */
  readonly diff: string;
  readonly diffTruncated: boolean;
  /** Paths the diff touches that look like tests. */
  readonly changedTests: readonly string[];
  /** The candidate verification, step by step, with the tail of each log. */
  readonly verification: readonly (Pick<
    VerificationCommandResult,
    "stepId" | "command" | "exitCode"
  > & {
    readonly logTail?: string;
    /** The exit code of the step's automatic rerun, when it failed again. */
    readonly rerunExitCode?: number;
  })[];
  readonly risk: RiskLevel;
  /** Whether a material finding will stop this work landing (D-P8-13). */
  readonly blocking: boolean;
  /** 0 for the first attempt; 1 or 2 for a fix. */
  readonly fixAttempt: number;
  /**
   * A fix's examiner sees what the last examination found, so it can say
   * whether it is fixed. Each carries the examination it came from, which a
   * finding that is the same defect again names in `repeats`.
   */
  readonly previousFindings?: readonly EarlierFinding[];
  /**
   * The arbiter's rulings this attempt carried out (D-P8-13, as amended
   * 2026-09-25). Present, the examiner judges only whether each was.
   */
  readonly rulings?: readonly ExaminationRuling[];
}

/**
 * What an agent that is not a plain worker is there to do (P8). The brief is
 * rendered from it, and the adapter passes nothing else differently.
 */
export type AgentTask =
  /** Round 1: examine and submit, or ask the builder. Round 2: the answers, then submit. */
  | {
      readonly kind: "examine";
      readonly evidence: ExaminationEvidence;
      readonly round: 1 | 2;
      readonly answers?: readonly ExaminationQuestion[];
    }
  /** Answer an examiner's questions about work this session did (D-P8-15). */
  | {
      readonly kind: "answer";
      readonly questions: readonly string[];
      /** Present when the session could not be resumed: the builder's own transcript, to answer from. */
      readonly transcript?: string;
    }
  /** Rule on one disputed finding (D-P8-13). */
  | {
      readonly kind: "arbitrate";
      readonly finding: ExaminationFinding;
      readonly dispute: string;
      readonly questions: readonly ExaminationQuestion[];
      readonly diff: string;
    }
  /**
   * A fix: the job again, with what the examiner found (D-P8-13). With
   * `rulings`, the findings an arbiter upheld: final, and what this attempt
   * must carry out.
   */
  | {
      readonly kind: "fix";
      readonly findings: readonly ExaminationFinding[];
      readonly rulings?: readonly ExaminationRuling[];
    }
  /**
   * The same session again, because it ended its turn without reporting. A
   * headless session exits when its turn ends and nothing wakes it, so a worker
   * that stopped to wait for something, or simply forgot to report, is resumed
   * with a reminder rather than failed. `reminder` counts from 1.
   */
  | { readonly kind: "continue"; readonly reminder: number; readonly of: number }
  /**
   * P9 (D-P9-07): the job again after a check that could not run during the
   * run ran at `resume` and failed. What failed goes into the brief.
   */
  | {
      readonly kind: "retry_failed_check";
      readonly failed: readonly {
        readonly stepId: string;
        readonly command: string;
        readonly exitCode: number | null;
        readonly output: string;
      }[];
    }
  /** P18 (D-P18-01): review a strand's job plan before anything is built. */
  | {
      readonly kind: "review_plan";
      /** The plan as its orchestrator recorded it. */
      readonly plan: string;
      readonly round: number;
      readonly of: number;
    }
  /**
   * P18 (D-P18-05): a strand's orchestrator, its own session resumed, because
   * its strand's landing failed: what failed, to fix with jobs of its own. A
   * round of `of`; after the last the strand fails, for the root to decide.
   */
  | {
      readonly kind: "strand_fix";
      readonly round: number;
      readonly of: number;
      readonly failedChecks: readonly {
        readonly stepId: string;
        readonly command: string;
        readonly exitCode: number | null;
        readonly output: string;
        /** The exit code of the step's automatic rerun, when it failed again (D-P15-06). */
        readonly rerunExitCode?: number;
        /** The step's timeout killed it (exit 124), with the time it had (P19 S-02). */
        readonly timedOut?: boolean;
        readonly timeoutSeconds?: number;
        readonly cleanupSeconds?: number;
      }[];
      readonly findings: readonly ExaminationFinding[];
      /** An arbiter's upheld rulings on the strand's findings, which are final (D-P8-13). */
      readonly rulings?: readonly ExaminationRuling[];
      /** A conflict with the program head, said as the queue said it. */
      readonly conflict?: string;
    };

/**
 * What the last attempt at a job left unfinished, carried into this one. An
 * attempt that ends without handing its work in (it died, stopped reporting, or
 * gave up) leaves changes nobody collected; the next attempt starts from them
 * rather than from nothing.
 */
/**
 * A-60: a strand an earlier run of the same plan built part or all of and
 * never landed. Its branch is where this strand's branch starts, with the
 * program head merged in, so the orchestrator plans only what is left. When
 * the two would not merge, the strand starts from the program head and the
 * earlier branch is named for its jobs to draw on.
 */
export interface StrandContinuation {
  readonly fromRunId: string;
  /** The earlier strand's branch, at GitHub on a machine run. */
  readonly branch: string;
  readonly head: string;
  /** What is on it, newest first: each job merged there, by its subject. */
  readonly work: readonly string[];
  /** Why it could not be continued in place, when it could not. */
  readonly conflict?: string;
}

export interface CarriedOverWork {
  /** The attempt that left it. */
  readonly fromAttempt: number;
  /** A ref holding it as one commit on the base that attempt was cut from. */
  readonly ref: string;
  /** Every path it changes. */
  readonly paths: readonly string[];
  /** True when it is already in the new worktree, uncommitted. */
  readonly applied: boolean;
  /** When it could not be applied: the paths that conflicted with the moved program head. */
  readonly conflicts: readonly string[];
  /** The whole change as a patch file, outside the worktree, for when it was not applied. */
  readonly patchPath: string;
}

/**
 * An arbiter's upheld ruling, anywhere in the program, as later agents are
 * told it: the program's memory of what has been decided about how its code
 * must behave. A worker follows it where its work touches what it covers; an
 * examiner treats a change that contradicts it as material. Gathered from the
 * records when an agent starts; a ruling a human reversed is not among them.
 */
export interface ProgramRuling {
  readonly decisionId: string;
  readonly runId: string;
  readonly findingId: string;
  /** The finding the arbiter upheld. */
  readonly finding: string;
  /** Why the arbiter upheld it. */
  readonly rationale: string;
  /** The paths the finding cited. */
  readonly paths: readonly string[];
  /** The commit the finding was made against, and its change's patch id. */
  readonly commitSha: string;
  readonly patchId: string;
}

export interface HarnessStartInput {
  /** The execution identity, already persisted as `created` before this call (A-04). */
  readonly agent: Agent;
  /** The node the work belongs to. */
  readonly node: ExecutionNode;
  /** What to do: the objective and acceptance criteria. */
  readonly job: JobContract;
  /** For the brief: the program's constraints, forbidden actions and verification. */
  readonly program: ProgramContract;
  /** Absolute path to the isolated worktree. The worker's working directory. */
  readonly worktree: string;
  /**
   * The worktree's own temp directory, beside it (P15): the adapter sets
   * `TMPDIR`, `TEMP` and `TMP` to it in the agent's environment, so what the
   * agent's tools leave there goes with the worktree rather than into the
   * machine's shared `/tmp`. Absent, the agent inherits the engine's.
   */
  readonly tmpDir?: string;
  /**
   * Every upheld ruling in the program so far (P15): the context the brief
   * gives a worker, an orchestrator and an examiner. Absent or empty, none.
   */
  readonly rulings?: readonly ProgramRuling[];
  /** Harness, provider and model, as routing chose them (D-P3-08). */
  readonly model: RouteTarget;
  /**
   * The worker's Nightshift MCP server. Passed through unchanged. Absent for an
   * agent that reaches no Nightshift tool at all: an answering builder (D-P8-15).
   */
  readonly mcp?: McpLaunch;
  /** P8: what an examiner, an arbiter, an answerer or a fix is there to do. Absent for plain work. */
  readonly task?: AgentTask;
  /**
   * P8 (D-P8-15): continue this harness session rather than start one. The
   * adapter resumes it with the brief as the next message.
   */
  readonly resume?: { readonly sessionId: string };
  /** The last attempt's unfinished work, when there was some. See {@link CarriedOverWork}. */
  readonly carriedOver?: CarriedOverWork;
  /** A strand an earlier run left unlanded, continued here (A-60). See {@link StrandContinuation}. */
  readonly strandContinued?: StrandContinuation;
  /**
   * P18 (D-P18-03): the job is one of a strand's, and its work merges onto the
   * strand's branch, verified as part of the strand rather than on its own.
   */
  readonly landsOnStrand?: boolean;
  /**
   * The same four operations that server exposes, as functions, for a harness
   * that cannot be handed a process to spawn (rule 6). Built by the execution
   * layer over stores holding the worker's own token (A-35).
   */
  readonly tools: WorkerTools;
  /** Where lifecycle observations go, in order (D-P3-09). */
  readonly sink: HookSink;
  /**
   * Where the adapter should write the raw provider stream, if it keeps one.
   * Under the state directory, never in the program checkout (D-P3-10). The
   * execution layer uploads it as a `transcript` artifact after exit.
   */
  readonly transcriptPath?: string;
  /**
   * P10 (D-P10-25): run the agent's process as this operating-system user,
   * through `sudo`, with the adapter's configuration granted to it. Absent on
   * a laptop, where every process is the operator's.
   */
  readonly runAs?: RunAs;
  /**
   * The launch this start belongs to. The execution layer always supplies it.
   * An adapter puts it on nothing itself (the recorder stamps it onto each
   * observation), but may use `launchId` to scope its own files.
   */
  readonly launch?: { readonly launchId: string; readonly segment: number };
  /**
   * Where the adapter reports measurement observations. Absent, the adapter
   * emits none and keeps supplying its exit aggregate.
   */
  readonly measurements?: MeasurementSink;
}

/**
 * What a line agent is there to do. The brief is the line owner's own text (the
 * conflict, or the commit to examine); the prompt is rendered from it in
 * `brief.ts`.
 */
export type LineTask =
  | { readonly kind: "line_resolve"; readonly brief: string }
  | { readonly kind: "line_examine"; readonly brief: string };

/**
 * A launch for the line owner's resolver or examiner (strand S-04). The line
 * has no run: no persisted `Agent`, `ExecutionNode`, `JobContract` or
 * `ProgramContract`, and none is invented. The caller mints `agentId` with its
 * own IdGenerator and announces it durably before calling.
 */
export interface HarnessLineStartInput {
  /** An ordinary `agent_<ULID>` minted by the caller. Put on the handle; never minted here. */
  readonly agentId: AgentId;
  readonly role: "line_resolver" | "line_examiner";
  /** Absolute path to the worktree: the agent's working directory. */
  readonly worktree: string;
  /** The worktree's own temp directory; the adapter points `TMPDIR`, `TEMP` and `TMP` at it. */
  readonly tmpDir?: string;
  /** Harness, provider and model, as routing chose them. */
  readonly model: RouteTarget;
  /** The project user the process runs as, exactly as a worker's does. */
  readonly runAs?: RunAs;
  /**
   * The agent's whole environment: project env and provider credentials. The
   * adapter reads nothing from the engine's own environment for it.
   */
  readonly env: Readonly<Record<string, string>>;
  /** ISO 8601. At this instant the adapter stops the agent and `exit` settles `cancelled`. */
  readonly deadline: string;
  readonly task: LineTask;
}

/** Usage and its provenance, carried by every `HarnessExit` variant. */
export interface ExitMeasures {
  /** The usage seen, including before a stop (`cancelled`, `interrupted`). */
  readonly usage?: RouteUsage;
  /**
   * What `usage` covers. Absent means `launch`: this launch only. An adapter
   * whose provider reports session totals across a resume must say `session`.
   */
  readonly usageScope?: "launch" | "session";
  /**
   * The adapter's full measurement counters for the same population and scope
   * as `usage`. When present the recorder records them instead of deriving
   * counters from `usage`, so fields `RouteUsage` cannot carry (reasoningTokens,
   * and the absent-means-unknown distinction) survive the exit.
   */
  readonly counters?: MeasurementCounters;
  /** The model the provider actually answered with, distinct from `input.model`. */
  readonly observedModel?: string;
  /** The adapter's own statement of how complete its usage is for this launch. */
  readonly coverage?: "complete" | "partial" | "unknown";
  /**
   * What the exit's `usage` population covers. Absent means `self`, which is
   * what every adapter so far reports. An adapter whose exit aggregate includes
   * native children (Claude's whole-tree modelUsage) says `includes_children`.
   */
  readonly inclusion?: "self" | "includes_children" | "unknown";
}

/** Why a worker process stopped. Exactly one of these settles `HarnessHandle.exit`. */
type HarnessExitBody =
  /** The process ended cleanly and the provider reported a final result. */
  | {
      readonly kind: "completed";
      readonly usage?: RouteUsage;
      /** The harness's own session id, when it keeps one (P8, D-P8-15). */
      readonly sessionId?: string;
      /** The model's final message, where the harness reports one: an answerer's answers. */
      readonly result?: string;
    }
  /**
   * The process ended without completing: a non-zero exit, a stream that ended
   * with no result, or a launch that never got off the ground.
   */
  | {
      readonly kind: "failed";
      readonly exitCode: number;
      /**
       * The adapter's own words for why (2026-10-28): the tail of the agent's
       * stderr, or why the launch never got off the ground. An exit code alone
       * cannot tell an agent that ran and failed from one never started (both
       * can be 127), and a caller with no event sink had nothing else.
       */
      readonly detail?: string;
      readonly usage?: RouteUsage;
      readonly sessionId?: string;
      /**
       * P8 (D-P8-06): set when the route **could not start** — not signed in, the
       * model not offered, rate-limited — before any work began. Only the adapter
       * can tell that from a run that started and failed, so it says so here, with
       * the provider's own words. The execution layer falls back on it.
       *
       * Also set when a usage or rate limit stopped the route **after** work
       * began (the amendment to D-P8-06, 2026-10-12): the route cannot serve
       * now, whatever it had done, and `workBegan` says the worktree may hold
       * its partial change.
       */
      readonly unavailable?: string;
      /** When the provider said the limit resets, where it said (ISO 8601). */
      readonly availableAgainAt?: string;
      /** True when `unavailable` came after the agent had started working. */
      readonly workBegan?: boolean;
    }
  /**
   * The process was killed by a signal. Windows reports no signal for a killed
   * process, so an adapter on Windows returns `failed` with the exit code
   * instead; the proof SC-P3-11 wants is durable state, not the label.
   */
  | { readonly kind: "interrupted"; readonly signal: string }
  /** `cancel` was called and the process stopped because of it. */
  | { readonly kind: "cancelled" };

export type HarnessExit = HarnessExitBody & ExitMeasures;

/** The usage an exit carries, whichever variant it is. */
export const usageOfExit = (exit: HarnessExit): RouteUsage | undefined => exit.usage;

/** The full counters an exit carries, when the adapter supplied them. */
export const countersOfExit = (exit: HarnessExit): MeasurementCounters | undefined => exit.counters;

/** The adapter's coverage statement; `unknown` when it made none. */
export const coverageOfExit = (exit: HarnessExit): "complete" | "partial" | "unknown" =>
  exit.coverage ?? "unknown";

/** Whether the exit's usage includes native children; `self` when the adapter did not say. */
export const inclusionOfExit = (exit: HarnessExit): "self" | "includes_children" | "unknown" =>
  exit.inclusion ?? "self";

/** What the exit's usage covers; `launch` when the adapter did not say. */
export const usageScopeOfExit = (exit: HarnessExit): "launch" | "session" =>
  exit.usageScope ?? "launch";

export interface HarnessHandle {
  /** Always `input.agent.agentId`. */
  readonly agentId: AgentId;
  /** The operating-system process, where the adapter has one. */
  readonly pid?: number;
  /**
   * Settles exactly once, and never rejects. A launch failure is
   * `failed`, not a rejection: the caller has a node to move either way.
   */
  readonly exit: Promise<HarnessExit>;
  /** Path to the raw provider stream, when the adapter wrote one. */
  readonly transcript?: string;
}

/** What an adapter can do beyond the minimum, so nothing above it has to guess. */
export interface HarnessCapabilities {
  /**
   * Whether the harness reports token, cost or latency figures. When true, a
   * `completed` or `failed` exit carries `usage` whenever the provider supplied
   * any; the execution layer writes it to the job's `RoutingDecision` (A-13).
   */
  readonly usage: boolean;
  /**
   * True when the adapter emits request-level observations through
   * `HarnessStartInput.measurements`. Absent means false: such an adapter keeps
   * supplying its exit aggregate.
   */
  readonly observations?: boolean;
}

export interface Harness {
  /** Adapter identifier, matching `RouteTarget.harness`: `claude`, `codex`, `agentcore`. */
  readonly id: string;
  readonly capabilities: HarnessCapabilities;

  /**
   * Starts a worker and returns as soon as the process exists. Does not wait for
   * the work: the caller awaits `handle.exit`.
   *
   * Rejects only when the adapter could not even attempt a launch (a missing
   * binary, an unwritable worktree). Anything that happens after the process
   * exists is reported through `exit`.
   */
  start(input: HarnessStartInput): Promise<HarnessHandle>;

  /**
   * Starts the line owner's resolver or examiner (strand S-04): the same handle
   * and exit as `start`, with no run-scoped records, no MCP server and no
   * worker tools. Git writes are denied as for a worker; an examiner may not
   * edit files. Optional: an adapter that cannot serve a line leaves it out.
   */
  startLine?(input: HarnessLineStartInput): Promise<HarnessHandle>;

  /**
   * Stops a running worker: a cooperative stop first, then a hard kill after
   * `grace`. Resolves once `exit` has settled. Settles `exit` as `cancelled`
   * when the cancel is what stopped it; a worker that finished on its own in the
   * meantime keeps the outcome it already had.
   *
   * Idempotent: cancelling a settled handle is a no-op.
   */
  cancel(handle: HarnessHandle, grace: Duration): Promise<void>;

  /**
   * The agent's current status.
   *
   * In P3 this is answered from the handle, which is why it looks redundant. It
   * exists because P10 asks a remote runner about an agent this process did not
   * spawn, and adding the method later would mean changing every adapter. It
   * must agree with `exit`: once `exit` settles, `status` reports the matching
   * terminal status forever.
   */
  status(handle: HarnessHandle): Promise<AgentStatus>;
}

/** The `AgentStatus` an exit implies. One place, so no adapter maps it differently. */
export const agentStatusForExit = (exit: HarnessExit): AgentStatus => {
  switch (exit.kind) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
  }
};

/** The hook event an exit implies, so every adapter reports an ending the same way. */
export const hookTypeForExit = (
  exit: HarnessExit,
): "agent.completed" | "agent.failed" | "agent.cancelled" | "agent.interrupted" => {
  switch (exit.kind) {
    case "completed":
      return "agent.completed";
    case "failed":
      return "agent.failed";
    case "interrupted":
      return "agent.interrupted";
    case "cancelled":
      return "agent.cancelled";
  }
};

/** A one-line human description of an exit, for an `outcomeReason`. */
export const describeExit = (exit: HarnessExit): string => {
  switch (exit.kind) {
    case "completed":
      return "the worker process completed";
    case "failed":
      return `the worker process exited ${exit.exitCode}`;
    case "interrupted":
      return `the worker process was killed by ${exit.signal}`;
    case "cancelled":
      return "the worker process was cancelled";
  }
};

/**
 * Whether a provider error before any work began means the **route** could not
 * start (P8, D-P8-06): not signed in or not entitled (401, 403), the model not
 * offered (404, or a 400 that says the model is not supported), or no capacity
 * for it (429, 529). Shared so every adapter draws the line in the same place;
 * each finds the status and the message in its own stream. `undefined` when the
 * error is anything else, or work had already begun: that is a failure.
 *
 * A usage or rate limit (429) is the exception (amending D-P8-06, 2026-10-12):
 * it says nothing about the work or the model, only that this route has no
 * capacity now, so it is a route that cannot serve whenever it arrives.
 */
export const routeUnavailableReason = (input: {
  readonly status: number | undefined;
  readonly message: string;
  readonly workBegan: boolean;
}): string | undefined => {
  if (input.status === 429) {
    const when = input.workBegan ? "after work began" : "before any work began";
    return `the provider answered 429 ${when}: ${input.message}`.slice(0, 600);
  }
  if (input.workBegan || input.status === undefined) return undefined;
  const always = [401, 403, 404, 429, 529];
  const aboutTheModel = input.status === 400 && /\bmodel\b/i.test(input.message);
  if (!always.includes(input.status) && !aboutTheModel) return undefined;
  return `the provider answered ${input.status} before any work began: ${input.message}`.slice(
    0,
    600,
  );
};

/**
 * A provider's reset time, given in epoch seconds, as ISO 8601; `undefined`
 * when it is not a plausible time. Both harnesses report resets this way.
 */
export const isoFromEpochSeconds = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const at = new Date(value * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
};
