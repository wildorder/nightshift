/**
 * What tone every status is (P13, D-P13-03): the one table.
 *
 * A tone is a meaning, not a colour: `theme.css` says what each tone looks like.
 * Statuses from every record the Studio shows are here (nodes, runs, agents,
 * routes, verifications, examinations, strand outcomes, decision places), so a
 * status the contracts add is one row, and nothing else in the Studio decides
 * how a status looks.
 */
export const TONES = ["success", "warning", "danger", "info", "neutral"] as const;
export type Tone = (typeof TONES)[number];

const TONE_OF: Readonly<Record<string, Tone>> = {
  // Landed, passed, done.
  succeeded: "success",
  verified: "success",
  integrated: "success",
  sealed: "success",
  passed: "success",
  completed: "success",
  met: "success",
  // In motion.
  running: "info",
  started: "info",
  verifying: "info",
  examining: "info",
  implemented: "info",
  queued: "info",
  validated: "info",
  // Waiting on someone, or not settled.
  pending: "neutral",
  created: "neutral",
  "not delegated": "neutral",
  deferred: "warning",
  provisional: "warning",
  parked: "warning",
  blocked: "warning",
  findings_raised: "warning",
  escalated: "warning",
  unavailable: "warning",
  "needs you": "warning",
  // Went wrong.
  failed: "danger",
  verification_failed: "danger",
  examination_failed: "danger",
  cancelled: "danger",
  interrupted: "danger",
  discarded: "danger",
  "not met": "danger",
  // Decision places, which are kinds rather than states.
  plan: "neutral",
  run: "neutral",
  strand: "neutral",
  job: "neutral",
  ruling: "warning",
};

/** The tone of a status; anything the table does not know is neutral. */
export const toneOf = (status: string): Tone => TONE_OF[status] ?? "neutral";

/** Every status the table names, for the test that holds it total over the contracts. */
export const KNOWN_STATUSES: readonly string[] = Object.keys(TONE_OF);
