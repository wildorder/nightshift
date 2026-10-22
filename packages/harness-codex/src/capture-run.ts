/**
 * The I/O around one launch's measurement capture (P20 S-03): the pre-spawn
 * boundary, the loopback receiver, and, once the child has closed, reading the
 * journal and the rollouts and handing the pure `reconcileCapture` what it
 * found. Every step is failure-tolerant and every await is bounded: a failure
 * becomes a named gap and a lower coverage, never a failed launch or a late
 * exit.
 */
import { join, type PlatformPath } from "node:path";
import type { Clock } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
import {
  type LocalReceiver,
  type LocalReceiverOptions,
  type MeasurementSink,
  millis,
  type ReceiverEnvelope,
  type ReceiverGap,
  type RunAs,
  readReceiverJournal,
} from "@nightshift/harness";
import {
  boundedGaps,
  childThreadIds,
  codexCoverage,
  parentThreadId,
  reconcileCapture,
} from "./capture.js";
import type { CodexOtelTarget } from "./command.js";
import type { AdapterFileSystem } from "./process.js";
import {
  type LaunchBoundary,
  locateRollout,
  type RolloutRecord,
  readRolloutMetadata,
} from "./rollout.js";
import type { StreamOutcome } from "./stream.js";
import {
  CODEX_OTEL_ATTRIBUTES,
  CODEX_OTEL_RECORD_FILTER,
  type CodexTelemetryEvidence,
  decodeCodexTelemetry,
} from "./telemetry.js";

export type StartReceiver = (options: LocalReceiverOptions) => Promise<LocalReceiver>;

/** The receiver's own stop grace; the longest the exit can wait on it. */
const STOP_GRACE_MS = 2000;
const READ_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 8000;

export interface CaptureRunDeps {
  readonly fs: AdapterFileSystem;
  readonly startReceiver: StartReceiver;
  readonly clock: Clock;
  /** The adapter's sanitized environment, before `commandAs` applies `runAs`. */
  readonly env: Readonly<Record<string, string>>;
  /** Who the child runs as; its environment, not the engine's, says where rollouts are. */
  readonly runAs?: RunAs | undefined;
  readonly sink: MeasurementSink;
  /** The thread a resume continues. */
  readonly resumeSessionId: string | undefined;
  /**
   * How the platform Codex runs on joins paths, for finding its rollouts: the
   * adapter's `platform`, not the host's (2026-10-22). On a Windows CI leg the
   * adapter told it runs on Linux looked for `\project\codex\sessions`.
   */
  readonly join: PlatformPath["join"];
}

export interface CaptureSummary {
  readonly coverage: "complete" | "partial" | "unknown";
  readonly observedModel?: string;
  /** Merged into the ending hook payload. */
  readonly hook: Readonly<Record<string, unknown>>;
}

export interface CaptureRun {
  /** Absent when the receiver could not start. */
  readonly otel: CodexOtelTarget | undefined;
  finish(ended: {
    readonly outcome: StreamOutcome;
    readonly exitKind: "completed" | "failed" | "interrupted" | "cancelled";
  }): Promise<CaptureSummary>;
  /** The launch never ran: stop the receiver and remove its files. */
  discard(): Promise<void>;
}

/**
 * The environment rollout discovery must use: what the launched worker sees.
 * `runAs.env` wins, and under `runAs` the engine's `HOME`/`USERPROFILE` are
 * dropped (`sudo -H` replaces them with the user's own, which the engine must
 * not guess), so only an explicit `CODEX_HOME` names the session directory.
 */
export const captureEnvironment = (
  env: Readonly<Record<string, string>>,
  runAs: Pick<RunAs, "env"> | undefined,
): Readonly<Record<string, string>> => {
  if (runAs === undefined) return env;
  const merged: Record<string, string> = { ...env, ...(runAs.env ?? {}) };
  delete merged.HOME;
  delete merged.USERPROFILE;
  return merged;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const bounded = <T>(work: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    let running: Promise<T>;
    try {
      running = work();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    running.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export const beginCapture = async (deps: CaptureRunDeps): Promise<CaptureRun> => {
  const { fs, clock } = deps;
  const env = captureEnvironment(deps.env, deps.runAs);
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const homeKnown = env.CODEX_HOME !== undefined || home !== "";
  const homeGap =
    deps.runAs === undefined ? "rollout home unknown" : "rollout home unknown under runAs";
  const launchStart = nowIso(clock);
  const preGaps: string[] = [];

  // `locateRollout` treats an unlistable directory as empty; a root that
  // cannot be read is named, and never answered from anywhere else.
  let unreadable = false;
  const discoveryFs = {
    readdir: async (path: string, options: { readonly recursive: boolean }) => {
      try {
        return await fs.readdir(path, options);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (options.recursive || code === "EACCES" || code === "EPERM") unreadable = true;
        throw error;
      }
    },
  };
  const locate = async (threadId: string, around: string): Promise<string> => {
    if (!homeKnown) throw new Error(homeGap);
    unreadable = false;
    const path = await bounded(
      () => locateRollout({ threadId, env, home, around, fs: discoveryFs, join: deps.join }),
      READ_TIMEOUT_MS,
    );
    if (path === undefined)
      throw new Error(unreadable ? "rollout unreadable" : "rollout not found");
    return path;
  };

  const readRollout = async (threadId: string): Promise<RolloutRecord[]> => {
    const path = await locate(threadId, nowIso(clock));
    const text = await bounded(() => fs.readText(path), READ_TIMEOUT_MS);
    return [...readRolloutMetadata(text).records];
  };

  // 1. The launch boundary, fixed before the child can write to the rollout.
  let boundary: LaunchBoundary = { kind: "ordinal", fromOrdinal: 0 };
  if (deps.resumeSessionId !== undefined) {
    try {
      const path = await locate(deps.resumeSessionId, launchStart);
      const text = await bounded(() => fs.readText(path), READ_TIMEOUT_MS);
      boundary = { kind: "ordinal", fromOrdinal: readRolloutMetadata(text).nextOrdinal };
    } catch (error) {
      boundary = { kind: "time", notBefore: launchStart };
      preGaps.push("launch boundary by time");
      if (!homeKnown) preGaps.push(homeGap);
    }
  }

  // 2. The receiver. Unavailable is a coverage limit, never a launch failure.
  let receiver: LocalReceiver | undefined;
  let directory: string | undefined;
  try {
    directory = fs.makeTempDir("nightshift-codex-otel-");
    const journalPath = join(directory, "journal.jsonl");
    receiver = await bounded(
      () =>
        deps.startReceiver({
          journalPath,
          allowedAttributes: CODEX_OTEL_ATTRIBUTES,
          recordFilter: CODEX_OTEL_RECORD_FILTER,
        }),
      START_TIMEOUT_MS,
    );
  } catch (error) {
    preGaps.push(`receiver unavailable: ${messageOf(error).slice(0, 80)}`);
    if (directory !== undefined) fs.removeDir(directory);
    directory = undefined;
  }

  const stop = async (): Promise<{ gap?: string }> => {
    if (receiver === undefined) return {};
    try {
      return await bounded(
        () => (receiver as LocalReceiver).stop(millis(STOP_GRACE_MS)),
        STOP_GRACE_MS + 1000,
      );
    } catch (error) {
      return { gap: `stop failed: ${messageOf(error).slice(0, 60)}` };
    }
  };
  const tidy = (): void => {
    if (directory !== undefined) fs.removeDir(directory);
    directory = undefined;
  };

  const finish: CaptureRun["finish"] = async ({ outcome, exitKind }) => {
    try {
      // 3a. Stop the receiver, so the journal is whole.
      const stopped = await stop();
      const stopGap = stopped.gap;

      // 3b. The journal.
      let telemetry: CodexTelemetryEvidence | undefined;
      if (receiver !== undefined) {
        try {
          const lines = await bounded(async () => {
            const read: (ReceiverEnvelope | ReceiverGap)[] = [];
            for await (const line of readReceiverJournal(receiver.journalPath)) read.push(line);
            return read;
          }, READ_TIMEOUT_MS);
          telemetry = decodeCodexTelemetry(lines);
        } catch {
          telemetry = undefined;
        }
      }

      // 3c. The rollouts: the parent, then every other thread named.
      const threadId = deps.resumeSessionId ?? outcome.threadId;
      const parentId = parentThreadId(threadId, telemetry);
      let parent: RolloutRecord[] | undefined;
      const unread: string[] = [];
      if (parentId !== undefined) {
        try {
          parent = await readRollout(parentId);
        } catch (error) {
          const reason = messageOf(error);
          unread.push(
            reason === homeGap || reason === "rollout unreadable"
              ? reason
              : `rollout unread: ${reason.slice(0, 60)}`,
          );
        }
      }
      const children = new Map<string, readonly RolloutRecord[]>();
      await Promise.all(
        childThreadIds({ threadId, boundary, parent, telemetry }).map(async (id) => {
          try {
            children.set(id, await readRollout(id));
          } catch {
            // Named by the reconciliation as an unread rollout.
          }
        }),
      );

      const result = reconcileCapture({ threadId, boundary, parent, children, telemetry });
      for (const observation of result.observations) {
        try {
          deps.sink.observe(observation);
        } catch {
          // `observe` is specified not to throw; a sink that does is not the run.
        }
      }

      const loss = telemetry?.lossGaps ?? [];
      const verdict = codexCoverage({
        sources: {
          stream: outcome.usage !== undefined,
          otlp: result.facts.otlpSeen,
          rollout: result.observations.some((o) => o.observationId.startsWith("codex:rollout:")),
        },
        turnCompletedCleanly: exitKind === "completed",
        parentBoundary: result.facts.rolloutRead ? boundary.kind : undefined,
        receiver: {
          started: receiver !== undefined,
          stopGap: stopGap !== undefined,
          journalLoss: loss.length > 0,
          journalRead: telemetry !== undefined,
        },
        transports: result.transports,
        countsAgree: result.facts.countsAgree,
        telemetryOnly: result.facts.telemetryOnly,
        spawned: result.facts.spawned,
        otherConversations: result.facts.otherConversations,
      });
      const gaps = [
        ...preGaps,
        ...unread,
        ...(stopGap === undefined ? [] : [`receiver stop gap: ${stopGap}`]),
        ...loss.map((l) => `telemetry loss: ${l.reason} x${l.count}`),
        ...result.gaps,
        ...verdict.gaps,
      ];
      return {
        coverage: verdict.coverage,
        ...(result.model === undefined ? {} : { observedModel: result.model }),
        hook: {
          measurementSources: {
            stream: outcome.usage !== undefined,
            otlp: telemetry !== undefined,
            rollout: result.facts.rolloutRead,
          },
          requestCount: result.requestCount,
          excludedBeforeBoundary: result.excludedBeforeBoundary,
          excludedTelemetry: result.excludedTelemetry,
          childConversations: result.childConversations,
          transports: result.transports,
          measurementGaps: boundedGaps([...new Set(gaps)]),
        },
      };
    } catch (error) {
      return {
        coverage: outcome.usage === undefined ? "unknown" : "partial",
        hook: {
          measurementGaps: boundedGaps([...preGaps, `capture failed: ${messageOf(error)}`]),
        },
      };
    } finally {
      tidy();
    }
  };

  return {
    otel:
      receiver === undefined
        ? undefined
        : { endpoint: receiver.endpoint, capability: receiver.capability },
    finish,
    discard: async () => {
      await stop();
      tidy();
    },
  };
};
