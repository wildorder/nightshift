/**
 * A remote run's last word on publication (2026-10-14).
 *
 * A run on a machine lands on the machine's clone; GitHub's copy moves only
 * when the publisher pushes each landing. A run once finished `succeeded` with
 * seventeen of its twenty landings refused by GitHub, and nothing said so. So
 * before `run.finish` gives a run its ending, this:
 *
 * 1. asks once more for the program branch's head, in case the last landing's
 *    request did not get out (the queue then carries it, as it carries any
 *    earlier failed request);
 * 2. waits while the publisher still has intents pending, up to a deadline;
 * 3. answers what GitHub has, for `run.finish` to refuse `succeeded` when it is
 *    not everything.
 */
import type { Dispatch } from "@nightshift/contracts";
import { type PublicationState, publicationStateOf } from "@nightshift/core";

/** How long `run.finish` waits for the publisher: each push takes seconds. */
export const SETTLE_DEADLINE_MS = 10 * 60_000;
export const SETTLE_POLL_MS = 5_000;

export interface SettleDeps {
  /** The run's dispatch as the plane has it now. */
  readonly read: () => Promise<Dispatch | undefined>;
  /** Raise an intent for the program branch's head if one was not raised. */
  readonly republishHead: () => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly pollMs?: number;
}

/**
 * What GitHub has once the publisher is done, or at the deadline. `undefined`
 * when the dispatch could not be read at all, which is not a confirmation.
 */
export const settlePublication = async (
  deps: SettleDeps,
): Promise<PublicationState | undefined> => {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  await deps.republishHead().catch(() => undefined);
  const deadline = now() + (deps.deadlineMs ?? SETTLE_DEADLINE_MS);
  let state: PublicationState | undefined;
  for (;;) {
    const dispatch = await deps.read().catch(() => undefined);
    if (dispatch !== undefined) state = publicationStateOf(dispatch.publication);
    if (state !== undefined && state.kind !== "pending") return state;
    if (now() >= deadline) return state;
    await sleep(deps.pollMs ?? SETTLE_POLL_MS);
  }
};

/**
 * Whether GitHub has everything the run landed, and `head` when one is given:
 * a record with every intent published but not `head` (its request never
 * recorded, or refused) lacks it.
 */
export const fullyPublished = (state: PublicationState | undefined, head?: string): boolean =>
  state !== undefined &&
  (state.kind === "published" || state.kind === "none") &&
  (head === undefined || state.head === head);

/** Why a run whose work GitHub lacks did not succeed, and what brings it there. */
export const unpublishedReason = (state: PublicationState | undefined, head?: string): string => {
  const recovery =
    "Every landing is on the machine's program branch and in the run's stored bundles; " +
    "once the cause is fixed, `nightshift resume` for the program publishes them without a machine.";
  if (state === undefined) {
    return `GitHub may not have this run's work: its publication could not be read. ${recovery}`;
  }
  if (head !== undefined && (state.kind === "published" || state.kind === "none")) {
    return (
      `GitHub does not have this run's final documentation commit ${head.slice(0, 12)}: its publication was not recorded or was refused. ` +
      "The documents are the control plane's records; `nightshift resume` for the program rebuilds them in your checkout and pushes them."
    );
  }
  const count = state.unpublished.length;
  const landings = `${count} landing${count === 1 ? "" : "s"}`;
  if (state.kind === "pending") {
    return `GitHub does not yet have this run's work: ${landings} still waited for the publisher after ${SETTLE_DEADLINE_MS / 60_000} minutes. ${recovery}`;
  }
  return `GitHub does not have this run's work: ${landings} could not be published. ${state.blocked ?? ""} ${recovery}`.replace(
    /\s+/g,
    " ",
  );
};
