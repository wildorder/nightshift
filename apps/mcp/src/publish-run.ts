/**
 * The publication of a planned run's documents and report onto its program
 * branch (P21, D-03), from the control plane's records alone. Shared by
 * `run.finish` and by `nightshift resume`, so every ending of a planned run
 * publishes: a run that ends again commits the updated report as a new
 * publication commit, and one whose files have not changed commits nothing.
 */
import type { ExecutionNodeId, ProgramContract, Run } from "@nightshift/contracts";
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
  /**
   * The ending the report states, when the run has not been given it yet
   * (`run.finish` publishes before it ends the run): the run's status and
   * reason as the report should read them.
   */
  readonly ending?: { readonly status: Run["status"]; readonly reason?: string };
}

export interface PublishedRun {
  readonly published?: Published;
  /** The commit exists on the program branch but its publication was not recorded. */
  readonly committed?: Published;
  readonly failure?: string;
}

export const publishPlannedRun = async (
  runtime: Runtime,
  input: PublishRunInput,
): Promise<PublishedRun> => {
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
    const gathered = await gatherReport(stores, scope);
    const { ending } = input;
    const report = renderReport(
      ending === undefined
        ? gathered
        : {
            ...gathered,
            run: {
              ...gathered.run,
              status: ending.status,
              ...(ending.reason === undefined ? {} : { outcomeReason: ending.reason }),
            },
          },
    );
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
    const where = { head: result.head, directory };
    if (result.published) {
      const raised = await input.publish?.({
        head: result.head,
        programBranch: program.repository.programBranch,
        repoPath: input.repoPath,
      });
      // The hook swallows what it cannot request; a head whose intent was not
      // recorded is not published, whatever the commit says.
      if (raised !== undefined && raised.requested === false) {
        return {
          committed: where,
          failure: `the publication of ${result.head.slice(0, 12)} was not requested${raised.detail === undefined ? "" : `: ${raised.detail}`}`,
        };
      }
    }
    return { published: where };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
};
