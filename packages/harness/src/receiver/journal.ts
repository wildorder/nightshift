import { readFile } from "node:fs/promises";
import { z } from "zod";

export const receiverEnvelopeSchema = z.object({
  receivedAt: z.string(),
  path: z.string(),
  contentType: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  body: z.string(),
});
export type ReceiverEnvelope = z.infer<typeof receiverEnvelopeSchema>;

/** A journal line that is not a payload: a cap reached, a clean close, or an unreadable line. */
export const receiverGapSchema = z.union([
  z.object({ gap: z.enum(["journal_full", "torn_line"]), receivedAt: z.string().optional() }),
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
