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
import type {
  AgentRole,
  ExaminationFinding,
  ExaminationRuling,
  ExecutionNode,
  FindingEvidence,
  JobContract,
  ProgramContract,
} from "@nightshift/contracts";
import { MAX_EXAMINATION_QUESTIONS } from "@nightshift/contracts";
import { grantedPermissions, PERMISSION_SHELL_EXEC } from "@nightshift/core";
import { GATE_STANDARD } from "./gate-standard.js";
import type {
  AgentTask,
  CarriedOverWork,
  ExaminationEvidence,
  HarnessStartInput,
} from "./harness.js";

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
  /** P8: what an examiner, arbiter, answerer or fix is there to do. */
  readonly task?: AgentTask;
  /** The last attempt's unfinished work, when this attempt starts from it. */
  readonly carriedOver?: CarriedOverWork;
}

/**
 * Every agent Nightshift starts runs unattended: nobody will prompt it again.
 * Whether a background command can wake it depends on the harness, so that is
 * the adapter's to say; what holds everywhere is said here, to every role, with
 * the calls that end that role's work.
 */
const headlessSession = (finish: string): string =>
  [
    "NOBODY WILL PROMPT YOU AGAIN",
    "",
    "  You are running unattended. Do not end your turn until you have called",
    `  ${finish}: a session that ends without one has not finished, whatever it did.`,
    "  When your session closes, anything you left running in the background is",
    "  stopped with it.",
  ].join("\n");

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
  // P8: an examiner, an arbiter and an answering builder are started by the same
  // adapters on the same node, and told what they are there to do here.
  switch (input.task?.kind) {
    case "examine":
      return renderExaminerBrief(input, input.task);
    case "arbitrate":
      return renderArbiterBrief(input, input.task);
    case "answer":
      return renderAnswerBrief(input.task);
    case "continue":
      return renderContinueBrief(input, input.task);
    default:
      break;
  }
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

  // P8 (D-P8-13): a fix is the job again, with what an independent examiner found.
  if (input.task?.kind === "retry_failed_check") {
    sections.push(renderFailedChecks(input.task.failed));
  }
  if (input.task?.kind === "fix") {
    sections.push(
      input.task.rulings === undefined
        ? renderFindingsToFix(input.task.findings)
        : renderRulingsToCarryOut(input.task.rulings),
    );
  }
  if (input.carriedOver !== undefined) sections.push(renderCarriedOver(input.carriedOver));

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
      ...((program.setup ?? []).length === 0
        ? []
        : [
            "  Before you started, Nightshift prepared this worktree with the program's",
            "  setup, and it runs setup again before verifying:",
            bullets((program.setup ?? []).map((step) => `${step.id}: ${step.command}`)),
            "",
          ]),
      "  After you report completion, Nightshift runs these commands on a clean",
      "  checkout of your work and the result is what counts:",
      bullets(program.verification.map((step) => `${step.id}: ${step.command}`)),
      "",
      mayRunCommands
        ? "  Run them yourself before reporting. Reporting completion on work that fails\n  them wastes a full verification cycle and the node ends verification_failed."
        : "  You cannot run commands, so you cannot check them yourself. Be correspondingly\n  careful, and say in your summary what you could not verify.",
    ].join("\n"),
  );

  sections.push(headlessSession("job.complete or job.fail"));

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
  /** P8: an examiner's, an arbiter's and an answerer's surfaces are their own. */
  role?: AgentRole,
): readonly string[] => {
  if (role === "examiner") return ["examination.ask", "examination.submit"];
  if (role === "arbiter") return ["finding.rule"];
  if (role === "answerer") return [];
  if (isPlanRoot(kind, program)) return ROOT_ORCHESTRATOR_TOOLS;
  return kind === "sub-program"
    ? [
        "subprogram.get",
        "delegate",
        "job.wait",
        "job.get",
        "job.cancel",
        "job.retry",
        "finding.dispute",
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

/** What the headless root of a planned run is given: strands (and repairs) in, a finished run out. */
const ROOT_ORCHESTRATOR_TOOLS: readonly string[] = [
  "run.attach",
  "program.get",
  "program.status",
  "execution.status",
  "run.activity",
  "strand.delegate",
  // P15 (D-P15-04): for a repair of a gate alone. The tool refuses anything else
  // on a planned run as plan_fixes_strands.
  "delegate",
  "job.wait",
  "job.get",
  "job.cancel",
  "job.retry",
  "finding.dispute",
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
      "SAY WHAT EACH JOB IS — it decides the model, and who examines it",
      "",
      "  delegate takes risk, ambiguity, testability and jobKind. Nightshift, not you,",
      "  picks the model from them, and risk decides whether an independent examiner",
      "  checks the work before it lands. Say them honestly, job by job:",
      "    risk         low: a mistake is cheap and local. medium: it breaks something",
      "                 users or other code rely on. high: data, money, security,",
      "                 authorization, anything hard to undo.",
      "    ambiguity    low when your objective and acceptance say exactly what to change",
      "                 and how to know it is done: a copy change, a rename, a deletion,",
      "                 a function whose behaviour and tests you specified. medium when",
      "                 some choices are the worker's. Unset is medium.",
      "    testability  strong when the program's checks exercise the change.",
      "    jobKind      implement, fix, refactor, test or docs.",
      "  A job that is low risk, low ambiguity and strongly tested runs on the cheapest",
      "  model, and that is most of the saving: split work so the mechanical parts are",
      "  such jobs, and say so. Never lower risk to skip an examiner.",
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
      "    examination_failed    an independent examiner found a material problem, with",
      "                          evidence, and stopped it landing. Fix it with job.retry:",
      "                          the findings go into the worker's brief and the fix is",
      "                          examined again, at most twice. If the examiner is wrong,",
      "                          say why with finding.dispute and an arbiter rules. Do NOT",
      "                          delegate the same work again as a new job: that throws",
      "                          away the findings, the fix limit and the arbiter.",
      "    examination_upheld    an arbiter ruled the finding stands. The ruling is final",
      "                          and Nightshift is already running the attempt that",
      "                          carries it out: wait for it with job.wait.",
      "    examination_ruling_unmet  two attempts could not carry the ruling out. Now,",
      "                          and only now, delegate the work differently.",
      "    failed                read the reason. A scope violation means the job needed",
      "                          more than you gave it. A worker that died or stopped",
      "                          without reporting is worth a job.retry: the retry starts",
      "                          from whatever it left unfinished, kept by Nightshift, so",
      "                          do not save its work or describe it in a new job.",
      "",
      "  A job that lands can still carry minor findings from its examiner. They are",
      "  reported; decide whether one is worth a follow-up job.",
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
      "    nightshift delegate { objective, scope, acceptance, risk, ambiguity, testability, jobKind }",
      "    nightshift job.wait { jobIds }       — returns when the first of them settles.",
      "    nightshift job.get / job.cancel / job.retry { jobId }",
      "    nightshift finding.dispute { jobId, reason } — when an examiner is wrong.",
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
    headlessSession("subprogram.complete or subprogram.fail"),
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
/**
 * What the root of a planned run does when a gate breaks (P15, D-P15-03,
 * D-P15-04, D-P15-06): it repairs, it never re-plans, and every repair carries
 * its decision. `skills/run-program/SKILL.md` says the same to an interactive root.
 */
const REPAIRING_GATES = [
  "WHEN A GATE BREAKS — repair it; never re-plan",
  "",
  "  A gate is a setup or verification step. The run repairs a broken one itself, with a",
  "  repair job: the one job you add outside the strands. It has the program's whole scope,",
  "  may change anything (setup and gate commands included), and is examined at high risk.",
  "",
  "    nightshift delegate { objective, acceptance,",
  "      repair: { cause, gates, decision: { context, alternatives, choice, rationale,",
  "                                          reversibility } } }",
  "",
  "  Every repair carries its decision, recorded in the same call; without one it is refused",
  "  (repair_needs_decision). Say which gates broke, how, and what the repair will do.",
  "",
  "  A RED BASE (`gate.red`): the base this run started from fails its gates. Your first act",
  "    is a repair { cause: red_base } naming the failing gates, before anything else. The",
  "    strands are held until it lands; wait for it with job.wait.",
  "  A FLAKE (`gate.flaked`): a check failed and passed when rerun on the same commit. The",
  "    work landed and nothing is blocked. Open one repair { cause: flaky } per flaky gate,",
  "    off the blocking path: no strand waits on it, and you carry on with the strands.",
  "",
  "  The fix must keep each gate at least as strong. A weakened gate (a retry wrapper, a",
  "  looser assertion, a deleted or skipped test, a removed check) is a blocking finding",
  "  unless the decision says why. Do not run.finish while a repair is still in flight.",
].join("\n");

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
      "  0. If the run started red (a `gate.red` line: the base fails its own gates), your first",
      "     act is a repair, before any strand: see WHEN A GATE BREAKS. The strands are held",
      "     until it lands.",
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
      "  6. When every strand has succeeded, is deferred, or is parked, and no repair is still",
      "     in flight:",
      "       nightshift run.finish { outcome, reason }",
      '     "succeeded" only if every strand succeeded. "deferred" when nothing failed and some',
      '     work is deferred: name the prerequisites it waits on. Otherwise "failed", with a',
      "     reason that names what was parked and why. A human reads it in the morning.",
    ].join("\n"),
    [
      "YOU DO NOT WRITE CODE, AND YOU DO NOT PLAN JOBS",
      "",
      "  Every change is made by a worker a strand's orchestrator delegates. Nothing you edit",
      "  is ever collected, and the plain delegate tool is refused to you, but for a repair",
      "  (below). Your working",
      `  directory is a checkout to read: ${worktree}`,
      "",
      "  Record what you decide (a retry, giving up on a strand) with decision.record: the",
      "  report lists the run's own decisions.",
    ].join("\n"),
    REPAIRING_GATES,
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
    headlessSession("run.finish"),
  ].join("\n\n")}\n`;
};

// ---------------------------------------------------------------------------
// P8: the examiner, the arbiter, the answering builder, and a fix
// ---------------------------------------------------------------------------

const describeEvidence = (evidence: FindingEvidence): string => {
  switch (evidence.kind) {
    case "location":
      return `${evidence.path}:${evidence.startLine}-${evidence.endLine}${evidence.note === undefined ? "" : ` (${evidence.note})`}`;
    case "command":
      return `\`${evidence.command}\` exited ${evidence.exitCode}: ${evidence.output.slice(0, 400)}`;
    case "contract":
      return `the contract: ${evidence.clause}`;
  }
};

const describeFinding = (finding: ExaminationFinding): string =>
  [
    `  ${finding.id} (${finding.severity}): ${finding.summary}`,
    ...finding.evidence.map((evidence) => `      evidence: ${describeEvidence(evidence)}`),
  ].join("\n");

/** The last attempt's unfinished work: where it is, and that it is a draft to judge, not a result. */
const renderCarriedOver = (work: CarriedOverWork): string =>
  [
    "THE LAST ATTEMPT'S UNFINISHED WORK — start from it",
    "",
    `  Attempt ${work.fromAttempt} at this job ended without handing its work in. What it had`,
    "  changed was kept, and this attempt starts from it rather than from nothing:",
    bullets(work.paths),
    "",
    ...(work.applied
      ? [
          "  Those changes are already in your working directory, uncommitted, on top of",
          "  the current program head. Review them critically against the acceptance",
          "  criteria: they are a draft that was never verified. Keep what is right, fix",
          "  what is not, finish the job, then verify it.",
        ]
      : [
          "  The program head has moved since, and they did not apply cleanly, so your",
          "  working directory is the current head without them. These paths conflicted:",
          bullets(work.conflicts),
          "",
          `  The whole change is in ${work.patchPath}. Read it, and bring over what is`,
          "  still right by hand; resolve the conflicting parts against the current code.",
        ]),
  ].join("\n");

/** A session resumed because it ended its turn without reporting. */
const renderContinueBrief = (
  input: WorkerBriefInput,
  task: Extract<AgentTask, { kind: "continue" }>,
): string => {
  const finish =
    input.node.kind === "sub-program"
      ? "subprogram.complete or subprogram.fail"
      : isPlanRoot(input.node.kind, input.program)
        ? "run.finish"
        : "job.complete or job.fail";
  return `${[
    "Your session ended, but you have not reported how your work ended.",
    "",
    "Anything you left running in the background was stopped when it did, so its result",
    "is lost: run it again and wait for it. Your working directory is exactly as you",
    "left it.",
    "",
    `Carry on from where you were, and do not end your turn until you have called ${finish}.`,
    `This is reminder ${task.reminder} of ${task.of}; after the last, the work is failed as unreported.`,
  ].join("\n")}\n`;
};

const renderFindingsToFix = (findings: readonly ExaminationFinding[]): string =>
  [
    "WHAT AN INDEPENDENT EXAMINER FOUND — fix these",
    "",
    "  This job was done once and examined by a different model, which found the",
    "  problems below in that attempt. This attempt starts clean from the current",
    "  program head: do the job again, and make sure none of these is true of what",
    "  you hand in. The new work is examined again.",
    "",
    ...findings.map(describeFinding),
  ].join("\n");

const renderFailedChecks = (
  failed: Extract<AgentTask, { kind: "retry_failed_check" }>["failed"],
): string =>
  [
    "WHAT FAILED — fix this",
    "",
    "  This job was done once, and the run went on without one of its checks,",
    "  which needed something only a human could supply. The human has supplied it,",
    "  the check has run, and it failed. This attempt starts clean from the current",
    "  program head: do the job again so that this check passes as well.",
    "",
    ...failed.map((step) =>
      [
        `  ${step.stepId}: \`${step.command}\` exited ${step.exitCode ?? "(no exit code)"}`,
        indent(step.output.slice(-2_000), 6),
      ].join("\n"),
    ),
  ].join("\n");

const describeRuling = (ruling: ExaminationRuling): string =>
  [`  ${ruling.findingId}: ${ruling.summary}`, `      the ruling: ${ruling.rationale}`].join("\n");

const renderRulingsToCarryOut = (rulings: readonly ExaminationRuling[]): string =>
  [
    "AN ARBITER HAS RULED — carry this out",
    "",
    "  This job was examined, the finding below was disputed or survived two fixes,",
    "  and an independent arbiter ruled that it stands. The ruling is final: it is",
    "  not open to argument, and this attempt exists to carry it out. Start clean",
    "  from the current program head, do the job again, and make what the ruling",
    "  says true of what you hand in. The next examination checks only that.",
    "",
    ...rulings.map(describeRuling),
  ].join("\n");

const renderRulingsToCheck = (rulings: readonly ExaminationRuling[]): string =>
  [
    "THE ARBITER'S RULING — judge only whether this attempt carries it out",
    "",
    "  An arbiter ruled that the findings below stand, and this attempt was built to",
    "  carry the ruling out. The ruling is final, so this examination is not a",
    "  fresh review: for each ruling, decide only whether the work now makes it",
    "  true. For one it does not, raise a material finding with `concerns` set to",
    "  the ruled finding's id, and evidence. Anything else you notice you may",
    "  record, without `concerns`; it is reported and does not stop the work.",
    "",
    ...rulings.map(describeRuling),
  ].join("\n");

const evidenceSections = (input: WorkerBriefInput, evidence: ExaminationEvidence): string[] => {
  const { job, program } = input;
  return [
    [
      "WHAT WAS ASKED FOR",
      `  ${job.objective}`,
      "",
      "  Acceptance criteria:",
      numbered(job.acceptance),
    ].join("\n"),
    [
      "THE PROGRAM IT BELONGS TO",
      `  ${program.objective}`,
      "",
      "  Constraints:",
      bullets(program.constraints),
      "",
      "  The job's scope:",
      bullets(input.node.scope.includes),
      input.node.scope.excludes.length === 0
        ? ""
        : `  never: ${input.node.scope.excludes.join(", ")}`,
    ].join("\n"),
    [
      "WHAT THE DETERMINISTIC CHECKS SAID (they all passed, or you would not be here)",
      ...evidence.verification.map(
        (step) =>
          `  ${step.stepId}: \`${step.command}\` exited ${step.exitCode ?? "(did not run)"}` +
          (step.logTail === undefined || step.logTail === "" ? "" : `\n${indent(step.logTail, 6)}`),
      ),
    ].join("\n"),
    [
      "THE CHANGE",
      evidence.changedTests.length === 0
        ? "  It changes no test file."
        : `  Test files it changes: ${evidence.changedTests.join(", ")}`,
      "",
      `  The diff${evidence.diffTruncated ? " (truncated; the whole change is in your working directory)" : ""}:`,
      "",
      indent(evidence.diff, 4),
    ].join("\n"),
  ];
};

const indent = (text: string, spaces: number): string =>
  text
    .split("\n")
    .map((line) => `${" ".repeat(spaces)}${line}`)
    .join("\n");

/**
 * What the examiner of a repair job judges it against (P15, D-P15-04,
 * D-P15-05): Nightshift's gate standard, and the rule that a weakened gate
 * stops the work unless the repair's decision says why. The decision itself
 * travels in the job's objective, which Nightshift wrote when the root
 * delegated the repair; an ordinary job gets none of this.
 */
const renderRepairStandard = (job: JobContract): string | undefined => {
  if (job.repair === undefined) return undefined;
  const { cause, gates, decisionId } = job.repair;
  return [
    "THIS IS A REPAIR — JUDGE IT AGAINST NIGHTSHIFT'S GATE STANDARD",
    "",
    `  The run opened this job to repair ${cause === "red_base" ? "a red base" : "a flaky gate"}: ${gates.join(", ")}.`,
    "  A repair may change anything it needs to, setup and gate commands included.",
    "  What it may not do is make a gate weaker to get it green. A weakened gate (a",
    "  retry wrapper, a looser assertion, a deleted or skipped test, a removed check,",
    "  a gate dropped from verification) is a blocking finding unless the repair's",
    `  decision says why. That decision, ${decisionId}, is quoted in full at the end of`,
    "  what was asked for above. Raise a weakened gate the decision does not account",
    "  for as material, with evidence; one it does account for, say so as minor.",
    "",
    "  The standard, as Nightshift ships it:",
    "",
    indent(GATE_STANDARD.trimEnd(), 4),
  ].join("\n");
};

/**
 * The examiner's brief (D-P8-10, D-P8-11, D-P8-12, D-P8-15). It is given the
 * evidence and nothing of the builder's reasoning; it may ask; every finding it
 * raises must point at something a reader can check.
 */
export const renderExaminerBrief = (
  input: WorkerBriefInput,
  task: Extract<AgentTask, { kind: "examine" }>,
): string => {
  const { evidence } = task;
  const sections: string[] = [
    [
      "You are a Nightshift examiner. Another model did the job below; you are an",
      "independent check on it before it lands. Judge the work against what was asked,",
      "from the evidence. You were deliberately not given the builder's own account of",
      "what it did, so that your judgement is yours.",
      "",
      `  Risk: ${evidence.risk}. ${
        evidence.blocking
          ? "A material finding stops this work landing until it is fixed or ruled on."
          : "Your findings are recorded and reported; they do not stop the work landing."
      }`,
      evidence.fixAttempt > 0
        ? `  This is fix attempt ${evidence.fixAttempt}: the job was redone after an earlier examination.`
        : "",
    ].join("\n"),
    ...evidenceSections(input, evidence),
  ];
  const repair = renderRepairStandard(input.job);
  if (repair !== undefined) sections.push(repair);
  if (evidence.rulings !== undefined && evidence.rulings.length > 0) {
    sections.push(renderRulingsToCheck(evidence.rulings));
  } else if (evidence.previousFindings !== undefined && evidence.previousFindings.length > 0) {
    sections.push(
      [
        "WHAT THE LAST EXAMINATION FOUND — say whether each is fixed",
        ...evidence.previousFindings.map(describeFinding),
      ].join("\n"),
    );
  }
  sections.push(
    [
      "YOUR WORKING DIRECTORY",
      `  ${input.worktree}`,
      "",
      "  A read-only checkout of exactly the commit under examination. Read the code,",
      "  run the tests, run anything you like. Change nothing: nothing you do here is",
      "  kept, and your verdict is the only thing that is.",
    ].join("\n"),
  );
  sections.push(
    [
      "WHAT A FINDING IS",
      "",
      "  material — the work does not do what was asked, or does it in a way that will",
      "    cause a real problem: a wrong result, a broken contract, a security or data",
      "    hazard, an acceptance criterion not met. Not a matter of taste.",
      "  minor — worth saying, not worth stopping for.",
      "",
      "  Every finding needs at least one piece of evidence a reader can check:",
      '    { kind: "location", path, startLine, endLine, note? } — lines in the commit',
      '    { kind: "command", command, exitCode, output } — something you ran, and what it printed',
      '    { kind: "contract", clause } — the acceptance criterion or constraint it breaks',
      "  A finding without evidence is refused. If you cannot point at it, do not raise it.",
    ].join("\n"),
  );
  if (task.round === 2) {
    sections.push(
      [
        "THE BUILDER'S ANSWERS TO YOUR QUESTIONS",
        ...(task.answers ?? []).map(
          (qa) =>
            `  Q: ${qa.question}\n  A: ${qa.answer}${qa.answeredBy === "transcript" ? "  (answered from the builder's transcript)" : ""}`,
        ),
        "",
        "  You have had your one round of questions. Now submit your verdict.",
      ].join("\n"),
    );
  }
  sections.push(
    [
      "HOW TO FINISH",
      "",
      "  nightshift examination.submit { outcome, findings }",
      "    outcome: passed (no findings), findings_raised, or failed (the work is wrong",
      "    in a way that needs no list). Call it exactly once.",
      ...(evidence.rulings === undefined
        ? []
        : ["    Each finding about a ruling carries `concerns`: the ruled finding's id."]),
      "",
      task.round === 1
        ? [
            "  nightshift examination.ask { questions }",
            `    Before you submit, you may ask the builder up to ${MAX_EXAMINATION_QUESTIONS} questions, once.`,
            "    Ask when something looks wrong but might be deliberate, and only the builder",
            "    knows why. Then end your turn: you will be resumed with the answers and",
            "    submit then. Do not ask what the code or the checks can tell you.",
          ].join("\n")
        : "",
    ].join("\n"),
  );
  return `${sections.filter((section) => section !== "").join("\n\n")}\n`;
};

/** The builder, resumed to answer an examiner's questions (D-P8-15). */
export const renderAnswerBrief = (task: Extract<AgentTask, { kind: "answer" }>): string =>
  [
    task.transcript === undefined
      ? "An independent examiner is reviewing the work you just did, and has questions only you can answer."
      : "An independent examiner is reviewing work a builder did, and has questions only the builder can answer. The builder's session could not be resumed, so here is its transcript; answer as the builder, from it.",
    "",
    "Answer each question directly and briefly, from what you know about why the work is the way it is.",
    "Do not change any file, and do not run anything that writes: this is a conversation, not more work.",
    "",
    "The questions:",
    ...task.questions.map((question, index) => `  ${index + 1}. ${question}`),
    "",
    'Reply with only a JSON array, one entry per question, in order: [{"question": "...", "answer": "..."}]',
    ...(task.transcript === undefined ? [] : ["", "THE BUILDER'S TRANSCRIPT", task.transcript]),
    "",
  ].join("\n");

/** The arbiter's brief (D-P8-13): one disputed finding, both sides, and the change. */
export const renderArbiterBrief = (
  input: WorkerBriefInput,
  task: Extract<AgentTask, { kind: "arbitrate" }>,
): string =>
  `${[
    [
      "You are a Nightshift arbiter. An examiner raised a finding against a piece of work,",
      "and the orchestrator that delegated the work disputes it (or two fixes have not",
      "resolved it). You rule, once, and the run moves on: an overturned finding lets the",
      "work land; an upheld one fails the job. Your ruling is recorded as a decision a",
      "human can reverse later.",
    ].join("\n"),
    [
      "WHAT WAS ASKED FOR",
      `  ${input.job.objective}`,
      "",
      "  Acceptance criteria:",
      numbered(input.job.acceptance),
    ].join("\n"),
    ["THE FINDING", describeFinding(task.finding)].join("\n"),
    ["THE DISPUTE", `  ${task.dispute}`].join("\n"),
    task.questions.length === 0
      ? ""
      : [
          "WHAT THE EXAMINER ASKED THE BUILDER, AND WHAT IT SAID",
          ...task.questions.map((qa) => `  Q: ${qa.question}\n  A: ${qa.answer}`),
        ].join("\n"),
    [
      "THE CHANGE",
      `  A read-only checkout of it is your working directory: ${input.worktree}`,
      "",
      indent(task.diff, 4),
    ].join("\n"),
    [
      "HOW TO RULE",
      "",
      "  nightshift finding.rule { findingId, ruling, rationale }",
      '    ruling: "overturn" when the finding is wrong or does not matter as stated;',
      '    "uphold" when it is right and the work should not land as it is.',
      "    Rule on the evidence, check it in the code if you need to, and say why in the",
      "    rationale: a human reads it. Call it exactly once.",
    ].join("\n"),
  ]
    .filter((section) => section !== "")
    .join("\n\n")}\n`;

/**
 * The whole prompt for a start (P8): the provider-neutral brief for the agent's
 * role and task, and, when it has a Nightshift server, the adapter's own
 * addendum naming that server's tools. An agent with no server (an answering
 * builder, D-P8-15) is told nothing about tools it does not have.
 */
export const promptFor = (
  input: Pick<
    HarnessStartInput,
    "job" | "node" | "program" | "worktree" | "task" | "mcp" | "agent" | "carriedOver"
  >,
  withAddendum: (brief: string, mcpServerName: string, tools: readonly string[]) => string,
): string => {
  const brief = renderWorkerBrief({
    job: input.job,
    node: input.node,
    program: input.program,
    worktree: input.worktree,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.carriedOver === undefined ? {} : { carriedOver: input.carriedOver }),
  });
  return input.mcp === undefined
    ? brief
    : withAddendum(
        brief,
        input.mcp.name,
        nightshiftToolNames(input.node.kind, input.program, input.agent.role),
      );
};
