/**
 * The publisher (P10, D-P10-22): fetches a run's bundle and pushes the program
 * branch with a lease at the Git transport, holding the GitHub App's key that
 * never reaches a machine (T4).
 *
 * T2 deploys the function and its IAM with a handler that does nothing but say
 * which intent it was handed.
 */
import { loadConfig } from "../config.js";

const config = loadConfig(process.env);

export interface PublishEvent {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
  readonly head: string;
}

export const handler = async (event: PublishEvent): Promise<{ readonly published: false }> => {
  console.warn(
    `publisher (${config.stage}) received intent ${event.head} for run ${event.runId}; the push arrives in T4`,
  );
  return { published: false };
};
