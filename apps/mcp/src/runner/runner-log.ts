/**
 * The runner's own log, kept as an artifact (S-02).
 *
 * The runner appends every line it says to a file on the machine; this module
 * uploads that file under the run's root node every ten minutes while the
 * runner works and once more at every ending. An upload that fails is logged
 * and swallowed: the log is evidence, never a reason to fail the run.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const RUNNER_LOG_INTERVAL_MS = 10 * 60_000;
export const RUNNER_LOG_FINAL_TIMEOUT_MS = 20_000;

/** Records the log's bytes as a `runner-log` artifact. */
export type RunnerLogRecorder = (bytes: Uint8Array) => Promise<void>;

/** Appends a line to the file, creating its directory; a failed write is dropped. */
export const appendRunnerLog = async (file: string, line: string): Promise<void> => {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`);
  } catch {
    // The log must never break the runner.
  }
};

export interface RunnerLogOptions {
  readonly file: string;
  /** Said where the runner says things; never the log itself. */
  readonly log: (line: string) => void;
  readonly intervalMs?: number;
  readonly finalTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly read?: (file: string) => Promise<Uint8Array>;
}

export interface RunnerLog {
  /** Where uploads go, once the run's runtime exists; until then nothing is uploaded. */
  attach(record: RunnerLogRecorder): void;
  /** Begins the periodic upload. */
  start(): void;
  /** Stops the periodic upload and uploads once more, within the timeout. Never rejects. */
  finish(): Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export const createRunnerLog = (options: RunnerLogOptions): RunnerLog => {
  const sleep = options.sleep ?? realSleep;
  const read = options.read ?? ((file: string) => readFile(file));
  let record: RunnerLogRecorder | undefined;
  let started = false;
  let stopped = false;

  const upload = async (): Promise<void> => {
    if (record === undefined) return;
    try {
      const bytes = await read(options.file);
      if (bytes.byteLength === 0) return;
      await record(bytes);
    } catch (error) {
      options.log(
        `the runner log could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    attach: (recorder) => {
      record = recorder;
    },
    start: () => {
      if (started) return;
      started = true;
      void (async () => {
        for (;;) {
          await sleep(options.intervalMs ?? RUNNER_LOG_INTERVAL_MS);
          if (stopped) return;
          await upload();
        }
      })();
    },
    finish: async () => {
      stopped = true;
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        upload(),
        sleep(options.finalTimeoutMs ?? RUNNER_LOG_FINAL_TIMEOUT_MS).then(() => timedOut),
      ]);
      if (result === timedOut) options.log("the final runner log upload timed out");
    },
  };
};
