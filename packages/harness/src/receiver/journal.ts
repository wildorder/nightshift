import { readFile } from "node:fs/promises";
import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean()]);
export const receiverRecordSchema = z.object({
  kind: z.enum(["log", "metric", "span"]),
  timeUnixNano: z.string().optional(),
  observedTimeUnixNano: z.string().optional(),
  startTimeUnixNano: z.string().optional(),
  endTimeUnixNano: z.string().optional(),
  severityText: z.string().optional(),
  eventName: z.string().optional(),
  name: z.string().optional(),
  unit: z.string().optional(),
  value: z.number().optional(),
  sum: z.number().optional(),
  count: z.number().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  statusCode: z.number().optional(),
  attributes: z.record(z.string(), scalar),
  resourceAttributes: z.record(z.string(), scalar),
  droppedAttributeCount: z.number().int().nonnegative(),
});
export type { ReceiverRecord } from "./reduce.js";

/** One accepted export request, reduced to metadata; never raw bytes. */
export const receiverEnvelopeSchema = z.object({
  receivedAt: z.string(),
  path: z.string(),
  contentType: z.string(),
  signal: z.enum(["logs", "metrics", "traces"]),
  records: z.array(receiverRecordSchema),
  droppedRecordCount: z.number().int().nonnegative(),
});
export type ReceiverEnvelope = z.infer<typeof receiverEnvelopeSchema>;

/** A journal line that is not a payload: a cap reached, a clean close, or an unreadable line. */
export const receiverGapSchema = z.union([
  z.object({
    gap: z.enum(["journal_full", "torn_line", "records_truncated"]),
    receivedAt: z.string().optional(),
  }),
  z.object({ closed: z.literal(true), receivedAt: z.string() }),
]);
export type ReceiverGap = z.infer<typeof receiverGapSchema>;

const parseLine = (line: string): ReceiverEnvelope | ReceiverGap | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const envelope = receiverEnvelopeSchema.safeParse(json);
  if (envelope.success) return envelope.data;
  const gap = receiverGapSchema.safeParse(json);
  return gap.success ? gap.data : undefined;
};

/** Yields the journal's lines in order; an unreadable line (a torn tail) is yielded as a `torn_line` gap. */
export async function* readReceiverJournal(
  path: string,
): AsyncIterable<ReceiverEnvelope | ReceiverGap> {
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    if (line === "") continue;
    yield parseLine(line) ?? { gap: "torn_line" };
  }
}
