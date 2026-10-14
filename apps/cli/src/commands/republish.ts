/**
 * Publishing a remote run's landings that never reached GitHub (2026-10-14).
 *
 * A machine lands on its own clone; the publisher moves GitHub's copy from the
 * bundles the engine stored after every landing. When the publisher was
 * refused (the App lacked a permission, a rule refused, someone moved the
 * branch), the landings wait on the plane, held in order. Once the human has
 * fixed the cause, `nightshift resume` asks the plane to retry: every
 * unpublished landing goes back to the publisher, which pushes them from their
 * bundles. No machine is needed, and nothing is forced.
 */
import type { Dispatch, PublicationIntent, Run } from "@nightshift/contracts";
import { type PublicationState, publicationStateOf, type RunScope } from "@nightshift/core";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import type { Session } from "../session.js";

/** How long the CLI waits for the publisher to push what it was given back. */
export const REPUBLISH_DEADLINE_MS = 10 * 60_000;
const POLL_MS = 3_000;

export type RepublishOutcome = "nothing" | "published" | "blocked" | "pending";

const scopeOf = (run: Run): RunScope => ({
  projectId: run.projectId,
  programId: run.programId,
  runId: run.runId,
});

/** The run's landings GitHub lacks, or none for a local run or a fully published one. */
export const unpublishedOf = async (
  session: Session,
  run: Run,
): Promise<readonly PublicationIntent[]> => {
  const dispatch = await session.stores.dispatches.get(scopeOf(run)).catch(() => undefined);
  return dispatch === undefined ? [] : publicationStateOf(dispatch.publication).unpublished;
};

const landings = (count: number): string => `${count} landing${count === 1 ? "" : "s"}`;

/** Polls the run's publication until nothing is pending, or the deadline. */
const waitForPublisher = async (
  environment: CliEnvironment,
  session: Session,
  scope: RunScope,
): Promise<PublicationState | undefined> => {
  const deadline = environment.clock.now() + REPUBLISH_DEADLINE_MS;
  let state: PublicationState | undefined;
  for (;;) {
    const dispatch: Dispatch | undefined = await session.stores.dispatches.get(scope);
    if (dispatch !== undefined) state = publicationStateOf(dispatch.publication);
    if (state?.kind !== "pending" && state !== undefined) return state;
    if (environment.clock.now() >= deadline) return state;
    await environment.sleep(POLL_MS);
  }
};

/**
 * Asks the plane to retry the run's unpublished landings, then waits for the
 * publisher to settle and says what GitHub has. `branch` is for the messages.
 */
export const republishRun = async (
  environment: CliEnvironment,
  session: Session,
  run: Run,
  branch: string,
): Promise<RepublishOutcome> => {
  const scope = scopeOf(run);
  const before = await unpublishedOf(session, run);
  if (before.length === 0) return "nothing";
  environment.out(
    `run ${run.runId}: ${landings(before.length)} not on GitHub's ${branch}; asking the publisher to push them from the run's bundles`,
  );
  await send(session.transport, { method: "POST", path: routes.publicationRetry(scope) });
  const state = await waitForPublisher(environment, session, scope);

  if (state === undefined || state.kind === "pending") {
    environment.err(
      `the publisher has not finished after ${REPUBLISH_DEADLINE_MS / 60_000} minutes: ` +
        `${landings(state?.unpublished.length ?? before.length)} still waiting. Run this again to see where it got to.`,
    );
    return "pending";
  }
  if (state.kind === "blocked") {
    const published = before.length - state.unpublished.length;
    environment.err(
      `${landings(state.unpublished.length)} still not on GitHub` +
        (published > 0 ? ` (${landings(published)} were published)` : "") +
        `: ${state.blocked ?? "publication is blocked"}`,
    );
    environment.err("Fix that, then run this again. Nothing was forced, and nothing is lost.");
    return "blocked";
  }
  environment.out(
    `GitHub has every landing: ${branch} is at ${state.head?.slice(0, 12) ?? state.tip?.slice(0, 12) ?? "?"}`,
  );
  return "published";
};
