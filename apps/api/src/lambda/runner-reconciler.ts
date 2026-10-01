/**
 * The reconciler (P10, D-P10-18): every minute, for every live dispatch, the
 * lease, the ceilings, the replacement and the cleanup (T3, T6).
 *
 * T2 deploys the function, its schedule and its IAM with a handler that does
 * nothing but say it ran.
 */
import { loadConfig } from "../config.js";

const config = loadConfig(process.env);

export const handler = async (): Promise<{ readonly reconciled: number }> => {
  console.warn(`reconciler (${config.stage}) ran; the lease and cleanup rules arrive in T3 and T6`);
  return { reconciled: 0 };
};
