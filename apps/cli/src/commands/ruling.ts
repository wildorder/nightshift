/**
 * `nightshift ruling reverse <program> <decisionId> --reason <why> [--run <id>]`
 * (P8, D-P8-13).
 *
 * An arbiter's ruling on a disputed finding is a decision with authority
 * `agent`. The owner has the last word: this records a `human` decision that
 * supersedes it, with the opposite choice and the owner's reason, and prints the
 * rollback point the ruling was made against.
 *
 * **It replays nothing.** Reversing an overturn does not unland the work, and
 * reversing an uphold does not restart the strand; the minimum-cone replay a
 * reversal needs is P9's (SC-13). Until then the reversal is recorded and
 * reported, and the checkpoint is where to reset to by hand. The command says so
 * every time it runs.
 */
import type { Decision, DecisionId, Run } from "@nightshift/contracts";
import { DecisionIdSchema } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

export interface RulingReverseOptions {
  readonly id: string;
  readonly decisionId: string;
  readonly reason: string;
  readonly run?: string;
  readonly repo?: string;
}

const RULINGS = ["overturn", "uphold"] as const;

/** The run named, or every run of the program, latest first. */
const runsOf = async (
  session: Awaited<ReturnType<typeof openSession>>,
  program: { readonly projectId: Run["projectId"]; readonly programId: Run["programId"] },
  named: string | undefined,
): Promise<Run[]> => {
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.stores.runs.listByProgram(
      program,
      cursor === undefined ? {} : { cursor },
    );
    runs.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return runs
    .filter((run) => named === undefined || run.runId === named)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};

export const reverseRuling = async (
  environment: CliEnvironment,
  options: RulingReverseOptions,
): Promise<number> => {
  const parsed = DecisionIdSchema.safeParse(options.decisionId);
  if (!parsed.success) throw new UsageError(`\`${options.decisionId}\` is not a decision id`);
  const decisionId: DecisionId = parsed.data;
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment);
  const program = { projectId: files.contract.projectId, programId: files.contract.programId };

  const candidates = await runsOf(session, program, options.run);

  for (const run of candidates) {
    const scope = { ...program, runId: run.runId };
    const ruling = await session.stores.decisions.get(scope, decisionId);
    if (ruling === undefined) continue;
    if (ruling.authority !== "agent" || !(RULINGS as readonly string[]).includes(ruling.choice)) {
      throw new UsageError(
        `${decisionId} is not an arbiter's ruling: only an arbiter's ruling is reversed here`,
      );
    }
    const reversed = ruling.choice === "overturn" ? "uphold" : "overturn";
    const reversal: Decision = {
      schemaVersion: 1,
      ...scope,
      decisionId: environment.ids.next("dec"),
      executionNodeId: ruling.executionNodeId,
      agentId: null,
      context: `The owner reversed the arbiter's ruling ${decisionId} (${ruling.context})`,
      alternatives: [{ summary: ruling.choice, rejectedBecause: options.reason }],
      choice: reversed,
      rationale: options.reason,
      reversibility: "reversible",
      checkpointBefore: ruling.checkpointBefore,
      affectedNodes: ruling.affectedNodes,
      authority: "human",
      supersedesDecisionId: decisionId,
      createdAt: nowIso(environment.clock),
    };
    await session.stores.decisions.put(reversal);
    const checkpoint = await session.stores.checkpoints.get(scope, ruling.checkpointBefore);
    environment.out(
      `Recorded ${reversal.decisionId}: the arbiter's "${ruling.choice}" is reversed to "${reversed}", on your authority.`,
    );
    environment.out(
      "Nothing is replayed: " +
        (ruling.choice === "overturn"
          ? "the work the ruling let land is still on the program branch."
          : "the job the ruling failed is not restarted.") +
        " Replaying what a reversal changes arrives with the decision graph (P9).",
    );
    if (checkpoint !== undefined) {
      environment.out(
        `The ruling was made against ${checkpoint.ref} (${checkpoint.commitSha}); to roll back by hand: git reset --hard ${checkpoint.ref}`,
      );
    }
    return 0;
  }
  throw new UsageError(
    `no run of \`${options.id}\`${options.run === undefined ? "" : ` named ${options.run}`} holds decision ${decisionId}`,
  );
};
