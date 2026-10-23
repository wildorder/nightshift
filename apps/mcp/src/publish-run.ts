/**
 * The publication of a planned run's documents and report onto its program
 * branch (P21, D-03), from the control plane's records alone. Shared by
 * `run.finish` and by `nightshift resume`, so every ending of a planned run
 * publishes: a run that ends again commits the updated report as a new
 * publication commit, and one whose files have not changed commits nothing.
 */
import type { ExecutionNodeId, ProgramContract } from "@nightshift/contracts";
import { gatherReport, nowIso, type RunScope, renderReport } from "@nightshift/core";
import { commitPublication, type PublishLanding } from "@nightshift/execution";
import type { Runtime } from "./compose.js";

export interface Published {
  /** The program branch's head after the publication commit. */
  readonly head: string;
  readonly directory: string;
}

export interface PublishRunInput {
  readonly scope: RunScope;
  readonly program: ProgramContract;
  readonly repoPath: string;
  /** The program's name on the plane; `undefined` publishes nothing. */
  readonly name: string | undefined;
  readonly rootNodeId: ExecutionNodeId;
  /** Raises the new head as a publication intent on a machine. */
  readonly publish?: PublishLanding;
}

export const publishPlannedRun = async (
  runtime: Runtime,
  input: PublishRunInput,
): Promise<{ readonly published?: Published; readonly failure?: string }> => {
  const { scope, program, name } = input;
  if (name === undefined) return {};
  try {
    const { stores, planText } = runtime;
    const sha256 = (await stores.executionNodes.get(scope, input.rootNodeId))?.plan?.planDocument
      .sha256;
    const stored = await stores.programContracts.get(scope.projectId, scope.programId);
    if (stored === undefined || sha256 === undefined || planText === undefined) {
      return { failure: "the control plane did not supply the contract and plan" };
    }
    const plan = await planText(scope, sha256);
    if (plan === undefined)
      return { failure: "the control plane did not supply the plan document" };
    const conversation =
      stored.conversation === undefined
        ? undefined
        : await planText(scope, stored.conversation.sha256);
    const report = renderReport(await gatherReport(stores, scope));
    const directory = `docs/programs/${name}`;
    const result = await commitPublication(runtime.git, {
      repo: input.repoPath,
      programBranch: program.repository.programBranch,
      name,
      files: {
        "contract.json": `${JSON.stringify(stored, null, 2)}\n`,
        "plan.md": plan,
        ...(conversation === undefined ? {} : { "conversation.md": conversation }),
        "report.md": report,
      },
      message: `Publish the plan, contract${conversation === undefined ? "" : ", conversation"} and report of ${name}`,
      atMs: Date.parse(nowIso(runtime.clock)),
    });
    if (result.published) {
      await input.publish?.({
        head: result.head,
        programBranch: program.repository.programBranch,
        repoPath: input.repoPath,
      });
    }
    return { published: { head: result.head, directory } };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
};
