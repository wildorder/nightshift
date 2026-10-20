/**
 * The measurement journal (P20): the durable receipt boundary.
 *
 * An append-only NDJSON file with ONE writer. `append` resolves only after the
 * bytes were written AND fsynced, and that resolution is the receipt: an
 * observation the journal has acknowledged survives a crash of this process.
 * Nothing here talks to the control plane; publication is the recorder's.
 */
import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AgentIdSchema,
  AgentRoleSchema,
  ArtifactIdSchema,
  ExecutionNodeIdSchema,
  IsoTimestampSchema,
  LaunchRefSchema,
  MeasurementCountersSchema,
  MeasurementObservationSchema,
  MeasurementSummaryIdSchema,
  RouteTargetSchema,
  RoutingDecisionIdSchema,
} from "@nightshift/contracts";
import { z } from "zod";

/** The write and fsync a journal needs, over any descriptor type, so a test can inject a facade. */
export interface JournalFs<Fd> {
  /** Writes up to `data.length` bytes and says how many were written. */
  write(fd: Fd, data: Uint8Array): Promise<number>;
  fsync(fd: Fd): Promise<void>;
}

/** The real file system, over a `FileHandle` opened for append. */
export const nodeJournalFs: JournalFs<FileHandle> = {
  write: async (handle, data) => (await handle.write(data)).bytesWritten,
  fsync: (handle) => handle.sync(),
};

/**
 * Writes all of `text`, then fsyncs, then resolves. A rejection means the line
 * is not known to be durable. The fsync is awaited before this resolves: that
 * ordering is the whole contract.
 */
export const durableAppend = async <Fd>(fs: JournalFs<Fd>, fd: Fd, text: string): Promise<void> => {
  const data = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < data.length) {
    const written = await fs.write(fd, data.subarray(offset));
    if (written <= 0) throw new Error("journal write made no progress");
    offset += written;
  }
  await fs.fsync(fd);
};

/** What a rebuilt summary needs when the stored one is missing. Optional so older journals still read. */
export const JournalContextSchema = z.strictObject({
  measurementSummaryId: MeasurementSummaryIdSchema,
  executionNodeId: ExecutionNodeIdSchema,
  role: AgentRoleSchema,
  route: RouteTargetSchema,
  routingDecisionId: RoutingDecisionIdSchema.nullable(),
  createdAt: IsoTimestampSchema,
  segment: LaunchRefSchema,
  sessionId: z.string().optional(),
  resumedSession: z.boolean(),
  baseline: MeasurementCountersSchema.optional(),
});
export type JournalContext = z.infer<typeof JournalContextSchema>;

export const JournalLineSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("opened"),
    pid: z.int().min(0),
    startedAt: IsoTimestampSchema,
    agentId: AgentIdSchema,
    launchId: z.string().min(1),
    context: JournalContextSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("heartbeat"), at: IsoTimestampSchema }),
  z.strictObject({
    kind: z.literal("observation"),
    sequence: z.int().min(1),
    observation: MeasurementObservationSchema,
  }),
  /** Intent, written before the upload. */
  z.strictObject({
    kind: z.literal("publishing"),
    chunk: z.int().min(0),
    artifactId: ArtifactIdSchema,
    segment: LaunchRefSchema,
    fromSequence: z.int().min(1),
    toSequence: z.int().min(1),
  }),
  /** Written after the summary put that records the chunk succeeded. */
  z.strictObject({
    kind: z.literal("published"),
    chunk: z.int().min(0),
    artifactId: ArtifactIdSchema,
  }),
  z.strictObject({ kind: z.literal("closed"), at: IsoTimestampSchema }),
]);
export type JournalLine = z.infer<typeof JournalLineSchema>;
export type JournalLineKind = JournalLine["kind"];

export interface JournalOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly agentId: z.infer<typeof AgentIdSchema>;
  readonly launchId: string;
  readonly context?: JournalContext;
}

export interface Journal {
  readonly path: string;
  /** Resolves only after the line was written and fsynced. Appends are serialized. */
  append(line: JournalLine): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens (creating, with its directory) the journal at `path` for append and
 * writes the `opened` line. Rejects when the file cannot be opened or written.
 */
export const openJournal = async (
  path: string,
  owner: JournalOwner,
  fs: JournalFs<FileHandle> = nodeJournalFs,
): Promise<Journal> => {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const journal: Journal = {
    path,
    append: (line) => {
      const run = async () => {
        if (closed) throw new Error("journal is closed");
        await durableAppend(fs, handle, `${JSON.stringify(line)}\n`);
      };
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
    close: async () => {
      await tail;
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
  try {
    await journal.append({
      kind: "opened",
      pid: owner.pid,
      startedAt: owner.startedAt,
      agentId: owner.agentId,
      launchId: owner.launchId,
      ...(owner.context === undefined ? {} : { context: owner.context }),
    });
  } catch (error) {
    await journal.close().catch(() => {});
    throw error;
  }
  return journal;
};

/**
 * Reads a journal. A line that does not parse (typically the last, cut short by
 * a crash) is skipped and reported as `torn`; every complete line is returned.
 * A missing file reads as empty.
 */
export const readJournal = async (
  path: string,
): Promise<{ lines: JournalLine[]; torn: boolean }> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], torn: false };
    throw error;
  }
  const lines: JournalLine[] = [];
  let torn = false;
  const parts = text.split("\n");
  parts.forEach((part) => {
    if (part === "") return;
    try {
      const parsed = JournalLineSchema.safeParse(JSON.parse(part));
      if (parsed.success) lines.push(parsed.data);
      else torn = true;
    } catch {
      torn = true;
    }
  });
  return { lines, torn };
};

/** Appends one line to an existing journal by a short-lived handle (recovery's writes). Durable on return. */
export const appendJournalLine = async (
  path: string,
  line: JournalLine,
  fs: JournalFs<FileHandle> = nodeJournalFs,
): Promise<void> => {
  const handle = await open(path, "a");
  try {
    await durableAppend(fs, handle, `${JSON.stringify(line)}\n`);
  } finally {
    await handle.close();
  }
};
