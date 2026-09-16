/**
 * The worker brief: what every adapter tells a worker, in plain text.
 *
 * Shared here rather than written per adapter because the things a worker must
 * be told are properties of *Nightshift*, not of a provider: what it is allowed
 * to touch, that Nightshift collects its work rather than it committing, and
 * which tools end the job. An adapter appends whatever its provider needs (how
 * its tools are named to it, for instance) and changes nothing above.
 *
 * Deliberately plain text with no markup beyond headings. It is read by a model,
 * not rendered, and every provider accepts a string.
 *
 * ## What this is not
 *
 * It is not enforcement. Everything the brief asks for is also enforced
 * structurally: scope containment at commit time (A-29), tool policy inside the
 * adapter (D-P3-15), and the worker MCP role registering no delegation tool
 * (D-P3-01). The brief exists so a competent worker does not trip the fences,
 * not so the fences can be removed.
 */
import type { ExecutionNode, JobContract, ProgramContract } from "@nightshift/contracts";
import { grantedPermissions, PERMISSION_SHELL_EXEC } from "@nightshift/core";

export interface WorkerBriefInput {
  readonly job: JobContract;
  /** The node whose `scope` is the effective authority, after narrowing (A-11). */
  readonly node: ExecutionNode;
  readonly program: ProgramContract;
  readonly worktree: string;
}

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "  (none)" : items.map((item) => `  - ${item}`).join("\n");

const numbered = (items: readonly string[]): string =>
  items.map((item, index) => `  ${index + 1}. ${item}`).join("\n");

/**
 * Renders the provider-neutral brief.
 *
 * The order is deliberate: what to do, what it will be judged by, what may be
 * touched, then how to finish. A model that reads only the first paragraph still
 * has the objective; a model that reads only the last still knows to call
 * `job.complete`.
 */
export const renderWorkerBrief = (input: WorkerBriefInput): string => {
  const { job, node, program, worktree } = input;
  const scope = node.scope;
  const permissions = grantedPermissions(scope);
  const mayRunCommands = permissions.includes(PERMISSION_SHELL_EXEC);

  const sections: string[] = [];

  sections.push(
    [
      "You are a Nightshift worker. You have been delegated one bounded job.",
      "",
      "OBJECTIVE",
      `  ${job.objective}`,
    ].join("\n"),
  );

  sections.push(["ACCEPTANCE CRITERIA", numbered(job.acceptance)].join("\n"));

  sections.push(
    [
      "PROGRAM OBJECTIVE (context; not your job)",
      `  ${program.objective}`,
      "",
      "PROGRAM CONSTRAINTS",
      bullets(program.constraints),
    ].join("\n"),
  );

  sections.push(
    [
      "SCOPE — this is authority, not advice",
      "",
      "  You may create, edit and delete files matching these patterns, and nothing else:",
      bullets(scope.includes),
      "",
      "  Excluded even when an include above would otherwise match them:",
      bullets(scope.excludes),
      "",
      "  Permissions granted to you:",
      bullets(permissions.length === 0 ? [] : [...permissions]),
      "",
      "  Actions forbidden to you:",
      bullets(scope.forbiddenActions),
      "",
      "  Nightshift checks the files you changed against this scope when you finish.",
      "  A single change outside it fails the whole job, durably, and nothing you did",
      "  is integrated. If the work genuinely requires touching something outside the",
      "  scope, do not do it: call job.fail and say which path and why.",
    ].join("\n"),
  );

  sections.push(
    [
      "WORKING DIRECTORY",
      `  ${worktree}`,
      "",
      "  This is an isolated git worktree cut for you alone. It is not the operator's",
      "  checkout, and no one else is working in it.",
    ].join("\n"),
  );

  sections.push(
    [
      "HOW YOUR WORK IS COLLECTED — do not commit",
      "",
      "  Nightshift owns every commit. Do not run git commit, git add, git checkout,",
      "  git branch, git merge, git rebase, git reset, git push, or any other command",
      "  that writes git state. You have no authority to do so and it will not help:",
      "  when you call job.complete, Nightshift snapshots whatever is in the worktree",
      "  into a single commit it authors itself. Leave your changes in the working",
      "  tree and report.",
    ].join("\n"),
  );

  sections.push(
    [
      "VERIFICATION — you do not decide whether the work passed",
      "",
      "  After you report completion, Nightshift runs these commands on a clean",
      "  checkout of your work and the result is what counts:",
      bullets(program.verification.map((step) => `${step.id}: ${step.command}`)),
      "",
      mayRunCommands
        ? "  Run them yourself before reporting. Reporting completion on work that fails\n  them wastes a full verification cycle and the node ends verification_failed."
        : "  You cannot run commands, so you cannot check them yourself. Be correspondingly\n  careful, and say in your summary what you could not verify.",
    ].join("\n"),
  );

  sections.push(
    [
      "HOW TO FINISH — you must call exactly one of these",
      "",
      "  nightshift job.complete { summary }",
      "    Call this when the acceptance criteria are met. Your summary should say",
      "    what you changed and why, in a few sentences.",
      "",
      "  nightshift job.fail { reason }",
      "    Call this when you are stuck, the job is impossible as specified, or",
      "    finishing it would require going outside your scope. A clear reason is",
      "    worth far more than a guess: a human reads it.",
      "",
      "  While you work:",
      "    nightshift job.progress { message }  — report what you are doing.",
      "    nightshift job.get                   — re-read this job's contract.",
      "    nightshift decision.record { ... }   — record a choice a later reader",
      "                                           would want the reasoning for.",
      "",
      "  Exiting without calling job.complete or job.fail fails the job with no",
      "  explanation attached. That is the one outcome nobody can act on.",
    ].join("\n"),
  );

  return `${sections.join("\n\n")}\n`;
};
