/**
 * The dispatch Lambda (P10, D-P10-18): takes a `requested` dispatch to
 * `provisioning` by creating the run's volume from the project's warm snapshot
 * and launching its machine (T3).
 *
 * T2 deploys the function with the IAM it will need and a handler that only
 * says what it was asked, so the stack, its role and its wiring are proven
 * before any machine is launched by code.
 */
import { loadConfig } from "../config.js";

const config = loadConfig(process.env);

export interface DispatchEvent {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
}

export const handler = async (event: DispatchEvent): Promise<{ readonly accepted: false }> => {
  console.warn(
    `dispatch Lambda (${config.stage}) received run ${event.runId}; provisioning arrives in T3`,
  );
  return { accepted: false };
};
