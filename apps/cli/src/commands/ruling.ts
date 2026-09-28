/**
 * `nightshift ruling reverse <program> <decisionId> --reason <why> [--run <id>]`
 * (P8, D-P8-13).
 *
 * An arbiter's ruling on a disputed finding is a decision with authority
 * `agent`. The owner has the last word: this records a `human` decision that
 * supersedes it, with the opposite choice and the owner's reason, and prints the
 * rollback point the ruling was made against.
 *
 * It is `nightshift decision reverse` for a ruling (P9, D-P9-02): the reversal
 * is a record, and changes nothing else. Correcting the work under it is a plan,
 * started from `nightshift decision brief`. The checkpoint the ruling was made
 * against is printed as well, for a rollback by hand.
 */
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { findDecision, reverseDecision } from "./decision.js";

export interface RulingReverseOptions {
  readonly id: string;
  readonly decisionId: string;
  readonly reason: string;
  readonly run?: string;
  readonly repo?: string;
}

const RULINGS = ["overturn", "uphold"] as const;

export const reverseRuling = async (
  environment: CliEnvironment,
  options: RulingReverseOptions,
): Promise<number> => {
  const found = await findDecision(environment, {
    id: options.id,
    decisionId: options.decisionId,
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
  });
  const ruling = found.decision;
  if (ruling.authority !== "agent" || !(RULINGS as readonly string[]).includes(ruling.choice)) {
    throw new UsageError(
      `${ruling.decisionId} is not an arbiter's ruling: reverse any other decision with \`nightshift decision reverse\``,
    );
  }
  // The same verb as any decision (P9, D-P9-02), with the ruling's opposite as the choice.
  await reverseDecision(environment, {
    id: options.id,
    decisionId: options.decisionId,
    run: found.run.runId,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    choice: ruling.choice === "overturn" ? "uphold" : "overturn",
    reason: options.reason,
  });
  const checkpoint = await found.session.stores.checkpoints.get(
    { projectId: found.run.projectId, programId: found.run.programId, runId: found.run.runId },
    ruling.checkpointBefore,
  );
  if (checkpoint !== undefined) {
    environment.out(
      `The ruling was made against ${checkpoint.ref} (${checkpoint.commitSha}); to roll back by hand: git reset --hard ${checkpoint.ref}`,
    );
  }
  return 0;
};
