import type { CommitSha, LineBatch } from "@nightshift/contracts";
import type { LineBatchOutcome, LineComposerPorts } from "./ports.js";

export const composeLineBatch = async (
  _ports: LineComposerPorts,
  _input: { lineHead: CommitSha; mainHead: CommitSha; batch: LineBatch },
): Promise<LineBatchOutcome> => {
  throw new Error("not implemented");
};

export const drainLine = async (
  _ports: LineComposerPorts,
  _heads: () => Promise<{ lineHead: CommitSha; mainHead: CommitSha }>,
): Promise<LineBatchOutcome[]> => {
  throw new Error("not implemented");
};
