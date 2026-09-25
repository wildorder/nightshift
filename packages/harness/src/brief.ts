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

/**
 * How a strand's orchestrator marks a decision as a departure from its plan
 * section's approach. `@nightshift/execution`'s report restates it as
 * `DEPARTURE_PREFIX` and finds departures by it; a test holds the two equal.
 */
export const STRAND_DEPARTURE_PREFIX = "DEPARTURE:";

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
  // A sub-program's node is started by the same adapters with the same input
  // (D-P6-03). What it is told is different, and that difference belongs here,
  // where no adapter has to know there is one.
  if (input.node.kind === "sub-program") return renderSubOrchestratorBrief(input);
  // The program node itself, run headless from a ratified plan (P7, D-P7-09).
  if (isPlanRoot(input.node.kind, input.program)) return renderPlanFollowingBrief(input);
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
      "YOUR CREDENTIAL — keep it to yourself",
      "",
      "  Your environment carries an execution token that proves you are this agent.",
      "  Never print, echo, log or copy your environment, and never include it in a",
      "  summary or a progress message. Anyone holding that token is you until it",
      "  expires.",
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
      "  These are Nightshift's operations, and they are the same however they reach",
      "  you: as the tools of a server named nightshift, under whatever prefix your",
      "  environment gives a server's tools, or as functions with these names. Report",
      "  progress when you start and whenever what you are doing changes; it is how",
      "  anyone watching knows the job is alive.",
      "",
      "  Exiting without calling job.complete or job.fail fails the job with no",
      "  explanation attached. That is the one outcome nobody can act on.",
    ].join("\n"),
  );

  return `${sections.join("\n\n")}\n`;
};

/**
 * The Nightshift tools a node's agent is given, by what kind of node it is. An
 * adapter that has to tell its model how those names are spelled to it (Claude
 * Code prefixes and rewrites them) maps this list, and never keeps its own.
 */
export const nightshiftToolNames = (
  kind: ExecutionNode["kind"],
  /** The run's contract. Only the program node **of a planned run** is a root orchestrator. */
  program?: ProgramContract,
): readonly string[] => {
  if (isPlanRoot(kind, program)) return ROOT_ORCHESTRATOR_TOOLS;
  return kind === "sub-program"
    ? [
        "subprogram.get",
        "delegate",
        "job.wait",
        "job.get",
        "job.cancel",
        "job.retry",
        "decision.record",
        "subprogram.progress",
        "subprogram.refresh",
        "subprogram.complete",
        "subprogram.fail",
      ]
    : ["job.complete", "job.fail", "job.progress", "job.get", "decision.record"];
};

/**
 * Whether a node is the root orchestrator of a planned run: the program node of
 * a contract that has strands. A program node is started as an agent in no other
 * case, and anything else keeps the brief and the tools it always had.
 */
const isPlanRoot = (kind: ExecutionNode["kind"], program: ProgramContract | undefined): boolean =>
  kind === "program" && (program?.strands?.length ?? 0) > 0;

/** What the headless root of a planned run is given: strands in, a finished run out. */
const ROOT_ORCHESTRATOR_TOOLS: readonly string[] = [
  "run.attach",
  "program.get",
  "program.status",
  "execution.status",
  "run.activity",
  "strand.delegate",
  "job.wait",
  "job.get",
  "job.cancel",
  "job.retry",
  "decision.record",
  "checkpoint.create",
  "run.finish",
];

/**
 * The brief for a sub-program's orchestrator (P6, D-P6-03).
 *
 * Provider-neutral like the worker's. The thing it has to get across, above all,
 * is a role a coding model does not assume by default: **it is not here to write
 * the code.** It decides how the work divides, delegates each piece, reads what
 * came back, and says when the whole is done.
 */
export const renderSubOrchestratorBrief = (input: WorkerBriefInput): string => {
  const { job, node, program, worktree } = input;
  const scope = node.scope;
  return `${[
    [
      "You are a Nightshift orchestrator for one sub-program: a bounded region of a larger",
      "program, handed to you to get done by delegating it.",
      "",
      "OBJECTIVE",
      `  ${job.objective}`,
    ].join("\n"),
    ["ACCEPTANCE CRITERIA", numbered(job.acceptance)].join("\n"),
    ...(job.strandId === undefined
      ? []
      : [
          [
            `YOU ARE STRAND ${job.strandId} OF A PLAN A HUMAN RATIFIED`,
            "",
            "  Your objective above opens with your section of that plan, word for word. What it",
            "  says will exist, and your scope, hold. HOW is medium fidelity on purpose: with the",
            "  code in front of you, you may find the approach is wrong. Then depart from it, and",
            "  say so, before you build on the departure:",
            "",
            `    nightshift decision.record { context: "${STRAND_DEPARTURE_PREFIX} <what the plan said, and what you are doing instead>", ... }`,
            "",
            "  The report a human reads in the morning lists every departure first. How the strand",
            "  divides into jobs is yours alone: the plan names none, and nobody will check them",
            "  against one.",
          ].join("\n"),
        ]),
    ["THE PROGRAM THIS IS PART OF", `  ${program.objective}`].join("\n"),
    [
      "YOU DO NOT WRITE THE CODE",
      "",
      "  You plan, delegate, and judge. Every change to the repository is made by a job",
      "  you delegate: a separate worker, in its own isolated worktree, whose work",
      "  Nightshift verifies and integrates. There is no other way for anything to reach",
      "  the program, and nothing you edit yourself is ever collected.",
      "",
      "  Your working directory is a checkout to READ:",
      `    ${worktree}`,
      "  Read it to understand the code before you divide the work. Call",
      "  subprogram.refresh to see what your jobs have integrated since.",
    ].join("\n"),
    [
      "WHAT YOU MAY DELEGATE — authority, not advice",
      "",
      "  Every job's scope must sit inside yours:",
      bullets(scope.includes.map((pattern) => `may change: ${pattern}`)),
      ...(scope.excludes.length === 0
        ? []
        : [bullets(scope.excludes.map((pattern) => `never: ${pattern}`))]),
      "",
      "  Ask for more and the delegation is refused, listing what was not covered. Scope",
      "  each job to what it needs, and give it what it needs: a job that must add a",
      "  test needs the test directory.",
    ].join("\n"),
    [
      "HOW TO DELEGATE WELL",
      "",
      "  - One bounded outcome per job, with acceptance criteria somebody could check.",
      "  - Delegate independent jobs together, then wait for them together: they run at",
      "    the same time, as many as the program's concurrency limit allows, and the rest",
      "    queue.",
      "  - Jobs that change the same lines will conflict. Give overlapping work to one",
      "    job, or run it one after the other.",
      "  - Every job is verified by these commands, on top of everything integrated",
      "    before it. Two jobs that each pass alone and break each other cannot both land:",
      bullets(program.verification.map((step) => `${step.id}: ${step.command}`)),
    ].join("\n"),
    [
      "WHEN A JOB DOES NOT INTEGRATE",
      "",
      "  job.get tells you why, in outcomeReason.",
      "    integration_conflict  its changes conflict with work integrated since it",
      "                          started. Nothing was resolved for you. job.retry runs it",
      "                          again from the current code, which is usually right.",
      "    verification_failed   it broke the program's checks, alone or together with",
      "                          what landed before it. Retry it as it was, or delegate a",
      "                          better-specified job instead.",
      "    failed                read the reason. A scope violation means the job needed",
      "                          more than you gave it.",
    ].join("\n"),
    [
      "SAY WHAT YOU ARE DOING — a human is following along",
      "",
      "  Your reasoning is not visible outside this process. The session that delegated",
      "  you relays your progress notes to a person as the run goes, and they are all",
      "  that person sees of you. Call subprogram.progress with one plain sentence:",
      "    - once you have read the code: how you are dividing the work, and why;",
      "    - when a job comes back: what happened, and what you will do about it;",
      "    - whenever you change course, and just before you finish.",
      "  A sentence each, in words a developer would use. Not a log of tool calls.",
    ].join("\n"),
    [
      "HOW TO FINISH — you must call exactly one of these",
      "",
      "  nightshift subprogram.complete { summary }",
      "    When your objective is met. Refused while anything you delegated is still in",
      "    flight: wait for it, or cancel it, first.",
      "",
      "  nightshift subprogram.fail { reason }",
      "    When it cannot be met. Whatever is still running under you is cancelled. A",
      "    clear reason is worth far more than a guess: a human reads it.",
      "",
      "  While you work:",
      "    nightshift subprogram.get            — your objective, scope, and what you have delegated.",
      "    nightshift delegate { objective, scope, acceptance }",
      "    nightshift job.wait { jobIds }       — returns when the first of them settles.",
      "    nightshift job.get / job.cancel / job.retry { jobId }",
      "    nightshift subprogram.progress { message }",
      "    nightshift decision.record { ... }   — how you divided the work, and why.",
      "",
      "  These are Nightshift's operations, and they are the same however they reach",
      "  you: as the tools of a server named nightshift, under whatever prefix your",
      "  environment gives a server's tools, or as functions with these names.",
      "",
      "  Exiting without calling subprogram.complete or subprogram.fail fails the",
      "  sub-program and cancels its jobs, with no explanation attached.",
    ].join("\n"),
  ].join("\n\n")}\n`;
};

const describeStrand = (strand: NonNullable<ProgramContract["strands"]>[number]): string =>
  [
    `  ${strand.id} ${strand.name}`,
    `    depends on: ${strand.dependsOn.length === 0 ? "nothing" : strand.dependsOn.join(", ")}`,
    `    needs: ${strand.prerequisites.length === 0 ? "no human prerequisite" : strand.prerequisites.join(", ")}`,
  ].join("\n");

/**
 * The brief for the **root orchestrator of a planned run**, started headless by
 * `nightshift run {id}` with nobody watching (P7, D-P7-09).
 *
 * Its job is narrow on purpose. A human already fixed the seams, the approach
 * and the expensive decisions, and each strand's own orchestrator decides that
 * strand's jobs. What is left for the root is to get every strand delegated,
 * wait, retry what is worth retrying, and end the run truthfully. The rules that
 * matter are structural as well as stated: the root of a planned run *cannot*
 * delegate anything but a strand, and a strand's brief is built from the plan,
 * not from anything the root writes.
 *
 * `job.objective` carries the plan document, so the adapter contract is the one
 * every other node is started through.
 */
export const renderPlanFollowingBrief = (input: WorkerBriefInput): string => {
  const { job, program, worktree, node } = input;
  const strands = program.strands ?? [];
  const decisions = (program.decisions ?? []).filter((decision) => decision.answer !== undefined);
  return `${[
    [
      "You are the Nightshift orchestrator for a whole program. A human planned it with care,",
      "ratified the plan, and has gone. Nobody is watching and nobody will answer a question:",
      "run the plan to the end, and leave a truthful record.",
      "",
      "THE PROGRAM",
      `  ${program.objective}`,
    ].join("\n"),
    [
      "START HERE",
      "",
      `  nightshift run.attach { runId: "${node.runId}", model: "<the model you are>" }`,
      "    Binds you to the run that was started for you. Do this first; nothing else works",
      "    until you have.",
    ].join("\n"),
    [
      "THE STRANDS — fixed by the plan; you neither add nor drop one",
      "",
      strands.map(describeStrand).join("\n\n"),
    ].join("\n"),
    [
      "WHAT YOU DO",
      "",
      "  1. Delegate EVERY strand, now, all of them, in any order:",
      "       nightshift strand.delegate { strandId }",
      "     You say which strand and nothing else. Its orchestrator is handed its section of",
      "     the plan verbatim, the human's decisions that touch it, and the other strands'",
      "     scopes. Nightshift holds a strand until the strands it depends on have succeeded,",
      "     and runs as many at once as the program's limits allow, so you do not sequence them.",
      '     A strand that is one small bounded change may be delegated with kind: "job".',
      "  2. Wait:  nightshift job.wait { jobIds }  returns when the first of them settles. Call",
      "     it again for the rest.",
      "  3. When a strand does not succeed, read why with job.get. Retry it with job.retry when",
      "     the reason is one a second attempt from the current code can fix (a conflict, a",
      "     flaky check, a worker that gave up early). Do not retry more than twice, and do not",
      "     retry a strand whose own orchestrator said the objective cannot be met.",
      "  4. A strand that stays failed is PARKED, with every strand that depends on it.",
      "     strand.delegate refuses those as strand_blocked. That is correct: leave them, and",
      "     let every other strand finish. A parked cone costs the cone, not the night.",
      "  5. A job whose status is DEFERRED is done for now: one of its checks needs something only",
      "     a human can supply. It is not a failure and there is nothing to retry. Its work is",
      "     kept on a provisional line, later strands build on it, and job.wait treats it as",
      "     settled. Carry on with everything else.",
      "  6. When every strand has succeeded, is deferred, or is parked:",
      "       nightshift run.finish { outcome, reason }",
      '     "succeeded" only if every strand succeeded. "deferred" when nothing failed and some',
      '     work is deferred: name the prerequisites it waits on. Otherwise "failed", with a',
      "     reason that names what was parked and why. A human reads it in the morning.",
    ].join("\n"),
    [
      "YOU DO NOT WRITE CODE, AND YOU DO NOT PLAN JOBS",
      "",
      "  Every change is made by a worker a strand's orchestrator delegates. Nothing you edit",
      "  is ever collected, and the plain delegate tool is refused to you. Your working",
      `  directory is a checkout to read: ${worktree}`,
      "",
      "  Record what you decide (a retry, giving up on a strand) with decision.record: the",
      "  report lists the run's own decisions.",
    ].join("\n"),
    ...(decisions.length === 0
      ? []
      : [
          [
            "DECISIONS A HUMAN ALREADY MADE — settled; each reaches the strands it touches",
            "",
            bullets(
              decisions.map(
                (decision) => `${decision.id}: ${decision.question} → ${decision.answer}`,
              ),
            ),
          ].join("\n"),
        ]),
    ["THE PLAN, AS RATIFIED", "", job.objective].join("\n"),
    [
      "These are Nightshift's operations, and they are the same however they reach you: as the",
      "tools of a server named nightshift, under whatever prefix your environment gives a",
      "server's tools, or as functions with these names.",
      "",
      "Exiting without calling run.finish leaves the run interrupted, with no explanation.",
    ].join("\n"),
  ].join("\n\n")}\n`;
};
