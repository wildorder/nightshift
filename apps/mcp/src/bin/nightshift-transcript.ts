#!/usr/bin/env node
/**
 * A planning session's conversation, as a process (P14, D-P14-07).
 *
 *   nightshift-transcript [--session <path>]
 *
 * `nightshift plan conversation` starts this and reads its stdout: one
 * `ConversationSession` as JSON, the human's messages and the assistant's
 * visible replies, numbered. A separate binary for the reason
 * `nightshift-resume` is one: reading a harness's transcript is that harness's
 * code, and only this package's composition root may name a harness. Exit 0
 * with the session; 2 when there is none to read.
 */
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { transcriptSources } from "../compose.js";
import { readTranscript, TranscriptNotFound } from "../transcript.js";

const main = async (): Promise<number> => {
  const { values } = parseArgs({ options: { session: { type: "string" } }, strict: true });
  const session = await readTranscript({
    sources: transcriptSources(),
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    ...(values.session === undefined ? {} : { session: values.session }),
  });
  process.stdout.write(`${JSON.stringify(session)}\n`);
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `[nightshift-transcript] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof TranscriptNotFound ? 2 : 1;
  },
);
