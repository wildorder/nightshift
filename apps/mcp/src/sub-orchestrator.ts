/**
 * The sub-orchestrator role's tools (P6, D-P6-03, D-P6-04).
 *
 * A sub-program's orchestrator plans and delegates inside the subtree under its
 * own node. It holds a **delegating execution token** and nothing else, and what
 * is missing here is, as in the worker role, the point:
 *
 * - **It starts nothing.** `delegate` writes a Job Contract and a `validated`
 *   node through the control plane and returns. The run's one engine, in the
 *   human's orchestrator's process, finds the record and does the rest
 *   (D-P6-01). There is no execution layer in this process and no route to the
 *   program branch.
 * - **It writes no code.** There is no `complete` that snapshots anything: its
 *   directory is a checkout to read, and nothing in it is ever collected.
 * - **It sees its subtree.** Every read is of its own node or something under
 *   it; the API refuses the rest (`ORCHESTRATOR_ACCESS`).
 *
 * `job.cancel` and `job.retry` are requests, made the only way this role can
 * make one: by asking for a status. `cancelled` asks the engine to stop a node;
 * `queued` is the table's own `retry` edge from a failure.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CommitSha,
  type Decision,
  type ExecutionNode,
  type ExecutionNodeId,
  type JobContractId,
  JobContractSchema,
  type JobKind,
  ReversibilitySchema,
  type RiskLevel,
  type Testability,
  type Verification,
} from "@nightshift/contracts";
import {
  adjustmentDecisionsOf,
  type IdGenerator,
  isDoneForNow,
  isSettled,
  markImplemented,
  nowIso,
  RETRYABLE_STATUSES,
  transition,
} from "@nightshift/core";
import {
  continuedByNightshift,
  contractGatesAt,
  fixOf,
  git,
  latestExamination,
  MAX_PLAN_REVIEWS,
  PlannedJobSchema,
  planProblems,
  planStateOf,
  recordStepSkip,
  recordStepTimeout,
  recordWorkerDecision,
  renderPlan,
  reportProgress,
  runDecisions,
  STRAND_PLAN_CONTEXT,
  strandContinuing,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { NoCheckpointError } from "@nightshift/harness";
import { z } from "zod";
import { CLASSIFICATION_INPUTS } from "./classification.js";
import { guarded, ok, ToolRefusal, waitForFirstSettled } from "./results.js";
import { DEFAULT_CONTRACT_FILE } from "./session.js";
import {
  asStepRefusal,
  refuseAdjustmentContext,
  STEP_SKIP_TOOL,
  STEP_TIMEOUT_TOOL,
  skipAnswer,
  timeoutAnswer,
} from "./step-tools.js";

export interface SubOrchestratorDeps {
  readonly identity: WorkerIdentity;
  readonly environment: WorkerEnvironment;
  readonly ids: IdGenerator;
  /** The cap on one `job.wait`, in seconds. Below a harness's own tool timeout. */
  readonly waitCapSeconds: number;
  /** The server's environment: `NIGHTSHIFT_CONTRACT_FILE` names the single contract file. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const WAIT_POLL_MS = 500;

/**
 * What a delegated job says about itself (D-P8-01), with the conservative
 * default for anything left unsaid: this sub-program's own risk, medium
 * ambiguity, no testability claimed, and `orchestrate` for a sub-program.
 */
const classificationFor = (
  input: {
    readonly risk?: RiskLevel | undefined;
    readonly ambiguity?: RiskLevel | undefined;
    readonly testability?: Testability | undefined;
    readonly jobKind?: JobKind | undefined;
    readonly kind?: "job" | "sub-program" | undefined;
  },
  inherited: RiskLevel | undefined,
): Record<string, unknown> => {
  const kind = input.kind === "sub-program" ? "orchestrate" : input.jobKind;
  return {
    risk: input.risk ?? inherited ?? "medium",
    ambiguity: input.ambiguity ?? "medium",
    ...(input.testability === undefined ? {} : { testability: input.testability }),
    ...(kind === undefined ? {} : { kind }),
  };
};

export const registerSubOrchestratorTools = (
  server: McpServer,
  deps: SubOrchestratorDeps,
): void => {
  const { identity, environment, ids } = deps;
  const { stores, clock, outbox } = environment;
  const { scope } = identity;
  /** What this process delegated: Job Contract → node. */
  const delegated = new Map<JobContractId, ExecutionNodeId>();

  const own = async (): Promise<ExecutionNode> => {
    const node = await stores.executionNodes.get(scope, identity.executionNodeId);
    if (node === undefined)
      throw new ToolRefusal("not_found", "this sub-program's node is not readable");
    return node;
  };

  /** Every node under this one, read level by level: the only way this role may. */
  const descendants = async (): Promise<ExecutionNode[]> => {
    const found: ExecutionNode[] = [];
    const frontier: ExecutionNodeId[] = [identity.executionNodeId];
    while (frontier.length > 0) {
      const parent = frontier.pop() as ExecutionNodeId;
      for (const child of await stores.executionNodes.listChildren(scope, parent)) {
        found.push(child);
        if (child.kind !== "job") frontier.push(child.executionNodeId);
      }
    }
    return found;
  };

  const nodeOf = async (jobId: string): Promise<ExecutionNode> => {
    const known = delegated.get(jobId as JobContractId);
    const node =
      known === undefined
        ? (await descendants()).find((candidate) => candidate.jobContractId === jobId)
        : await stores.executionNodes.get(scope, known);
    if (node === undefined) {
      throw new ToolRefusal("not_found", `no node under this sub-program carries job ${jobId}`);
    }
    return node;
  };

  const report = async (jobId: string): Promise<Record<string, unknown>> => {
    const node = await nodeOf(jobId);
    const verification = (await stores.verifications.listByNode(scope, node.executionNodeId)).at(
      -1,
    );
    const agent = (await stores.agents.listByNode(scope, node.executionNodeId)).at(-1);
    // Not settled while Nightshift is still taking it further itself (examine.ts).
    const continuing =
      continuedByNightshift(
        node.status,
        await stores.examinations.listByNode(scope, node.executionNodeId),
      ) ??
      // A strand whose landing failed, being fixed by its own orchestrator (P18, D-P18-05).
      strandContinuing(
        node,
        (await stores.routingDecisions.listByNode(scope, node.executionNodeId)).filter(
          (decision) => decision.purpose === undefined,
        ).length,
      );
    return {
      jobContractId: jobId,
      nodeId: node.executionNodeId,
      kind: node.kind,
      status: node.status,
      settled: isDoneForNow(node.status) && continuing === undefined,
      ...(continuing === undefined ? {} : { continuing }),
      commitSha: node.commitSha,
      outcomeReason: node.outcomeReason ?? null,
      agent:
        agent === undefined
          ? null
          : { agentId: agent.agentId, status: agent.status, model: agent.model },
      verification:
        verification === undefined
          ? null
          : {
              outcome: verification.outcome,
              commands: verification.commands.map((command) => ({
                stepId: command.stepId,
                exitCode: command.exitCode,
                logArtifactId: command.logArtifactId ?? null,
              })),
            },
    };
  };

  const describe = (r: Readonly<Record<string, unknown>>): string =>
    `Job ${String(r.jobContractId)} is ${String(r.status)}.` +
    (r.outcomeReason === null ? "" : ` Reason: ${String(r.outcomeReason)}.`);

  server.registerTool(
    "subprogram.get",
    {
      title: "Read your sub-program",
      description: "Your objective, acceptance criteria, and what you have delegated so far.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const node = await own();
        const contract = await stores.jobContracts.get(scope, identity.jobContractId);
        const children = await descendants();
        return ok(
          `Objective: ${contract?.objective ?? "(unreadable)"}\n` +
            `Delegated so far: ${children.length === 0 ? "nothing" : children.map((child) => `${child.jobContractId} ${child.status}`).join("; ")}`,
          {
            objective: contract?.objective ?? null,
            acceptance: contract?.acceptance ?? [],
            status: node.status,
            checkout: identity.worktree,
            children: children.map((child) => ({
              jobId: child.jobContractId,
              nodeId: child.executionNodeId,
              kind: child.kind,
              status: child.status,
            })),
          },
        );
      }),
  );

  server.registerTool(
    "delegate",
    {
      title: "Delegate one bounded piece of work",
      description:
        "Record one job of your reviewed plan under your strand. Nightshift starts it as soon as " +
        "every job it dependsOn has merged onto your strand's branch and a slot is free, so " +
        "delegate every job of the plan at once, each with its dependsOn. When its worker hands " +
        "it in, its commit merges onto your branch: it is then `merged`. Returns at once; wait " +
        "with job.wait.",
      inputSchema: {
        kind: z
          .enum(["job", "sub-program"])
          .optional()
          .describe("Always a job: a strand's work is jobs (P18)."),
        objective: z.string().min(1),
        acceptance: z.array(z.string().min(1)).min(1),
        dependsOn: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "The jobIds, as delegate returned them, that must merge before this one starts. Only real dependencies: everything else runs at once.",
          ),
        // P8 (D-P8-01): what the job says about itself, so routing can place it.
        // Unset is the conservative choice, not the cheap one.
        ...CLASSIFICATION_INPUTS,
        // Accepted only to be refused by name: a repair is the program node's (D-P15-04).
        repair: z
          .unknown()
          .optional()
          .describe("Not yours: only the program node opens a repair of a gate."),
      },
    },
    async (input) =>
      guarded(async () => {
        if (input.repair !== undefined) {
          throw new ToolRefusal(
            "repair_not_yours",
            "only the program node delegates a repair of a gate (D-P15-04): a repair sits outside " +
              "every strand, and the root opens it. Report the broken or flaky gate with " +
              "subprogram.progress, or in subprogram.fail, and the root repairs it.",
          );
        }
        if (input.kind === "sub-program") {
          throw new ToolRefusal(
            "validation_failed",
            "a strand's work is jobs, not sub-programs (P18): delegate each job of your plan, with its dependsOn.",
          );
        }
        // Nothing is built before the plan is reviewed (D-P18-01).
        const state = await planStateOf(environment, scope, identity.executionNodeId);
        if (state.reviews.length === 0) {
          throw new ToolRefusal(
            "plan_not_reviewed",
            state.plans.length === 0
              ? "author your job plan with strand.plan first: it is reviewed before anything is built."
              : "your plan is being reviewed: end your turn, and this session is resumed with the review.",
          );
        }
        // Each dependency is a job of this strand, delegated already.
        const known = new Set(
          (await descendants()).map((child) => child.jobContractId).filter((id) => id !== null),
        );
        const unknown = (input.dependsOn ?? []).filter((id) => !known.has(id as JobContractId));
        if (unknown.length > 0) {
          throw new ToolRefusal(
            "validation_failed",
            `dependsOn names ${unknown.join(", ")}, which are not jobs of this strand: delegate a job before the jobs that depend on it.`,
          );
        }
        // The API checks depth and everything else this role cannot see. There is
        // no path scope to check: a job carries none (the owner's ruling, 2026-10-09).
        const parent = await own();

        // Unstated risk is this sub-program's own, which was the program's
        // default when nobody stated it either: never "low" by omission, which
        // would route to the cheapest rung and skip examination by accident
        // (D-P8-01). Unstated ambiguity is medium.
        const parentJob =
          parent.jobContractId === null
            ? undefined
            : await stores.jobContracts.get(scope, parent.jobContractId);
        const at = nowIso(clock);
        const job = JobContractSchema.parse({
          schemaVersion: 1,
          ...scope,
          jobContractId: ids.next("job"),
          objective: input.objective,
          acceptance: input.acceptance,
          dependencies: input.dependsOn ?? [],
          ...classificationFor(input, parentJob?.risk),
          createdAt: at,
        });
        await stores.jobContracts.put(job);

        const node: ExecutionNode = {
          schemaVersion: 1,
          ...scope,
          executionNodeId: ids.next("node"),
          kind: input.kind ?? "job",
          parentNodeId: parent.executionNodeId,
          depth: parent.depth + 1,
          status: "validated",
          jobContractId: job.jobContractId,
          commitSha: null,
          createdAt: at,
          updatedAt: at,
        };
        await stores.executionNodes.put(node);
        delegated.set(job.jobContractId, node.executionNodeId);
        outbox.emit({
          type: "node.delegated",
          source: "mcp",
          payload: { jobContractId: job.jobContractId, objective: job.objective, kind: node.kind },
          executionNodeId: node.executionNodeId,
          agentId: identity.agentId,
        });
        await outbox.flush(5_000);

        return ok(
          `Delegated ${node.kind} ${job.jobContractId} as node ${node.executionNodeId}. Nightshift ` +
            "starts it when a slot is free. Wait for it with job.wait.",
          {
            jobId: job.jobContractId,
            nodeId: node.executionNodeId,
            kind: node.kind,
            status: "validated",
          },
        );
      }),
  );

  server.registerTool(
    "job.get",
    {
      title: "Read a job you delegated",
      description: "Its status, commit, verification and outcome reason.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const r = await report(jobId);
        return ok(describe(r), r);
      }),
  );

  server.registerTool(
    "job.wait",
    {
      title: "Wait for jobs you delegated",
      description:
        "Block until the first of these jobs settles, or the cap elapses. Always returns: " +
        "`timedOut` says whether a job settled or the wait did. A failed job Nightshift is " +
        "still taking further (an arbiter ruling on it, or an upheld ruling about to be carried " +
        "out) is not settled, and `continuing` says why: wait for it, do not delegate it again.",
      inputSchema: {
        jobId: z.string().min(1).optional(),
        jobIds: z.array(z.string().min(1)).min(1).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
      },
    },
    async ({ jobId, jobIds, timeoutSeconds }) =>
      guarded(async () => {
        const wanted = [...(jobIds ?? []), ...(jobId === undefined ? [] : [jobId])];
        if (wanted.length === 0)
          throw new ToolRefusal("validation_failed", "name at least one job");
        const limit = Math.min(timeoutSeconds ?? deps.waitCapSeconds, deps.waitCapSeconds);
        const { reports, first, timedOut } = await waitForFirstSettled(
          () => Promise.all(wanted.map(report)),
          limit,
          WAIT_POLL_MS,
        );
        return first === undefined
          ? ok(`None of ${wanted.length} jobs settled within ${limit}s. Call job.wait again.`, {
              timedOut,
              waitedSeconds: limit,
              jobs: reports,
            })
          : ok(describe(first), { ...first, timedOut, jobs: reports });
      }),
  );

  server.registerTool(
    "job.cancel",
    {
      title: "Cancel a job you delegated",
      description: "Asks Nightshift to stop it. The node ends durably cancelled.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const node = await nodeOf(jobId);
        if (isSettled(node.status) && !RETRYABLE_STATUSES.includes(node.status)) {
          return ok(`Job ${jobId} is already ${node.status}.`, await report(jobId));
        }
        await stores.executionNodes.put(transition(node, "cancel", nowIso(clock)));
        return ok(`Asked Nightshift to cancel job ${jobId}.`, await report(jobId));
      }),
  );

  server.registerTool(
    "job.retry",
    {
      title: "Retry a job that failed",
      description:
        "Runs it again from the current program head, as a new attempt. For a job that ended failed, " +
        "verification_failed or interrupted; read its outcomeReason first. After a failure of the " +
        "work it runs on the next model on the role's preference list; after a conflict or an interrupt, on the same model.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const node = await nodeOf(jobId);
        if (!RETRYABLE_STATUSES.includes(node.status)) {
          throw new ToolRefusal(
            "validation_failed",
            node.status === "queued"
              ? `job ${jobId} is already queued: Nightshift requeues a job itself to carry out an arbiter's ruling`
              : `job ${jobId} is ${node.status}, which is not retryable`,
          );
        }
        // Two fixes of blocking findings, then an arbiter's ruling carried out (D-P8-13).
        const examinations = await environment.stores.examinations.listByNode(
          scope,
          node.executionNodeId,
        );
        const refused = fixOf(examinations).refused;
        if (refused !== undefined) throw new ToolRefusal("validation_failed", refused);
        const { outcomeReason: _previous, ...requeued } = transition(node, "retry", nowIso(clock));
        await stores.executionNodes.put({ ...requeued, commitSha: null });
        return ok(`Job ${jobId} is queued again. Wait for it with job.wait.`, await report(jobId));
      }),
  );

  server.registerTool(
    "finding.dispute",
    {
      title: "Dispute an examiner's finding",
      description:
        "For a job an independent examiner stopped: say why its blocking findings are wrong, and " +
        "an arbiter (a fresh invocation of the strongest model available) rules on them. Overturned, " +
        "the work that was examined lands as it is; upheld, the ruling is final and Nightshift starts " +
        "the next attempt to carry it out. Wait for it with " +
        "job.wait. Fix it instead with job.retry when the examiner is right.",
      inputSchema: { jobId: z.string().min(1), reason: z.string().min(1) },
    },
    async ({ jobId, reason }) =>
      guarded(async () => {
        const node = await nodeOf(jobId);
        const examination = await latestExamination(environment, scope, node.executionNodeId);
        if (node.status !== "failed" || examination === undefined) {
          throw new ToolRefusal(
            "validation_failed",
            `job ${jobId} was not stopped by an examination`,
          );
        }
        if (examination.followsRulings !== undefined) {
          throw new ToolRefusal(
            "validation_failed",
            "this examination checked an arbiter's ruling, and the ruling is final: it is carried out, not argued again",
          );
        }
        const open = examination.findings.filter(
          (finding) => finding.severity === "material" && finding.resolution === "unresolved",
        );
        if (open.length === 0) {
          throw new ToolRefusal(
            "validation_failed",
            "its last examination has no unresolved material finding",
          );
        }
        const at = nowIso(clock);
        // Written as a dispute and nothing else; the engine starts the arbiter.
        await stores.examinations.put({
          ...examination,
          findings: examination.findings.map((finding) =>
            open.includes(finding)
              ? {
                  ...finding,
                  resolution: "disputed",
                  resolvedBy: { authority: "agent", reason, at },
                }
              : finding,
          ),
        });
        outbox.emit({
          type: "finding.disputed",
          source: "mcp",
          payload: {
            examinationId: examination.examinationId,
            findings: open.map((finding) => finding.id),
            reason,
          },
          executionNodeId: node.executionNodeId,
          agentId: identity.agentId,
        });
        return ok(
          `Disputed ${open.map((finding) => finding.id).join(", ")}. An arbiter rules on them; wait for job ${jobId} with job.wait.`,
          { findings: open.map((finding) => finding.id) },
        );
      }),
  );

  server.registerTool(
    "strand.plan",
    {
      title: "Author your strand's job plan",
      description:
        "Your first act, before any job: the jobs that build your strand, each with its objective, " +
        "acceptance, the paths it expects to touch and the jobs it dependsOn. As parallel as the work " +
        "honestly allows: a job depends on another only when it cannot be built until that exists, " +
        "and jobs that run at once should not touch the same paths. Recorded as a decision, and " +
        "reviewed by an independent examiner while you wait in strand.review.wait.",
      inputSchema: {
        jobs: z.array(PlannedJobSchema).min(1),
        notes: z
          .string()
          .min(1)
          .describe("Why this split: what runs in parallel, what must wait, and what you weighed."),
      },
    },
    async ({ jobs, notes }) =>
      guarded(async () => {
        const problems = planProblems(jobs);
        if (problems.length > 0) {
          throw new ToolRefusal(
            "validation_failed",
            `the plan cannot be built as written: ${problems.join("; ")}.`,
            {
              problems,
            },
          );
        }
        const state = await planStateOf(environment, scope, identity.executionNodeId);
        const round = state.plans.length + 1;
        const independent = jobs.filter((job) => job.dependsOn.length === 0).length;
        const decision = await recordWorkerDecision(environment, identity, ids, {
          context: `${STRAND_PLAN_CONTEXT} round ${round} — ${jobs.length} job${jobs.length === 1 ? "" : "s"}, ${independent} starting at once`,
          alternatives: [
            { summary: "the plan as authored" },
            {
              summary: "one job for the whole strand",
              rejectedBecause: "it builds nothing in parallel and is reviewed as one",
            },
          ],
          choice: renderPlan(jobs),
          rationale: notes,
          reversibility: "reversible",
        }).catch((error: unknown) => {
          if (error instanceof NoCheckpointError) throw new ToolRefusal("not_found", error.message);
          throw error;
        });
        const reviewed = state.reviews.length < MAX_PLAN_REVIEWS;
        return ok(
          reviewed
            ? `Recorded your plan as decision ${decision.decisionId}. An independent examiner is ` +
                "reviewing it now: wait for the review with strand.review.wait."
            : `Recorded your plan as decision ${decision.decisionId}. Its reviews are spent: build it now — ` +
                "delegate every job, each with its dependsOn.",
          { decisionId: decision.decisionId, round, reviewed },
        );
      }),
  );

  server.registerTool(
    "strand.review.wait",
    {
      title: "Wait for your job plan's review",
      description:
        "Blocks until the independent review of your latest plan is recorded, or the cap elapses " +
        "(then call it again). Answers the verdict and each finding. Revise with strand.plan (it is " +
        "reviewed once more), or keep the plan and say why with decision.record; then build.",
      inputSchema: { timeoutSeconds: z.number().int().min(1).optional() },
    },
    async ({ timeoutSeconds }) =>
      guarded(async () => {
        const cap = Math.min(timeoutSeconds ?? deps.waitCapSeconds, deps.waitCapSeconds);
        const read = () => planStateOf(environment, scope, identity.executionNodeId);
        const deadline = clock.now() + cap * 1000;
        let state = await read();
        if (state.plans.length === 0) {
          throw new ToolRefusal("not_found", "you have no plan yet: author it with strand.plan.");
        }
        while (
          state.reviews.length < state.plans.length &&
          state.reviews.length < MAX_PLAN_REVIEWS
        ) {
          if (clock.now() >= deadline) {
            return ok(
              `Still reviewing after ${cap}s — this wait is capped below the harness's own tool ` +
                "timeout, so call strand.review.wait again.",
              { timedOut: true },
            );
          }
          await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
          state = await read();
        }
        const review = state.reviews.at(-1);
        if (review === undefined) {
          return ok("No review is recorded; build the plan.", { timedOut: false, verdict: null });
        }
        const verdict = review.context.endsWith("revise")
          ? "revise"
          : review.context.endsWith("sound")
            ? "sound"
            : null;
        const last = state.reviews.length >= MAX_PLAN_REVIEWS;
        return ok(
          `${review.context}\n\n${review.choice}\n\n` +
            (verdict === "revise" && !last
              ? "Revise the plan with strand.plan (it is reviewed once more), or keep it and say why " +
                "with decision.record; then build."
              : "Build it now: delegate every job of the plan, each with its dependsOn." +
                (verdict === "revise"
                  ? " Take what you agree with from the review into the jobs, and record why you leave the rest."
                  : "")),
          { timedOut: false, verdict, decisionId: review.decisionId, final: last },
        );
      }),
  );

  server.registerTool(
    "decision.record",
    {
      title: "Record a decision",
      description: "A choice about this sub-program a later reader would want the reasoning for.",
      inputSchema: {
        context: z.string().min(1),
        alternatives: z
          .array(z.object({ summary: z.string().min(1), rejectedBecause: z.string().optional() }))
          .min(1),
        choice: z.string().min(1),
        rationale: z.string().min(1),
        reversibility: ReversibilitySchema,
      },
    },
    async (input) =>
      guarded(async () => {
        refuseAdjustmentContext(input.context, "orchestrator");
        const decision = await recordWorkerDecision(environment, identity, ids, input).catch(
          (error: unknown) => {
            if (error instanceof NoCheckpointError)
              throw new ToolRefusal("not_found", error.message);
            throw error;
          },
        );
        return ok(`Recorded decision ${decision.decisionId}.`, { decisionId: decision.decisionId });
      }),
  );

  // --- A run's adjustments to a step's time (P19 S-02) ---------------------------

  /**
   * A strand's token may not read the program contract or another node's
   * verifications, so it reads what it may: the verification steps and
   * `costPolicy.maxWallClockSeconds` from the contract in its own checkout at
   * HEAD, and the fullest verification history it can see: its own subtree's
   * verifications plus every verification a `verification.completed` event of
   * the run names (the engine emits one for each record it writes), each read
   * with `verifications.get`. This is the best the strand can see; the engine
   * applies a skip only if the run's complete history agrees at the next
   * verification.
   */
  const contractGates = async () => {
    const gates = await contractGatesAt(
      environment.git,
      identity.worktree,
      "HEAD",
      scope.programId,
      deps.env?.NIGHTSHIFT_CONTRACT_FILE ?? DEFAULT_CONTRACT_FILE,
    ).catch(() => undefined);
    if (gates === undefined) {
      throw new ToolRefusal(
        "not_found",
        "the run's contract could not be read from this checkout at HEAD (neither the contract " +
          "file nor docs/programs/*/contract.json names this program), so its steps are unknown",
      );
    }
    return gates;
  };

  const readEvery = async <T>(
    list: (page: { cursor?: string }) => Promise<{ items: readonly T[]; cursor?: string }>,
  ): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(cursor === undefined ? {} : { cursor });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return items;
  };

  /**
   * The run's decisions an adjustment may come from, as far as this strand can
   * place them: its own node, its descendants' sub-program nodes, or a human.
   * A job node's decision, or one on a node it cannot read, is never one.
   */
  const adjustmentDecisions = async (): Promise<Decision[]> => {
    const nodes = [await own(), ...(await descendants())];
    const kinds = new Map(
      nodes.map((node) => [node.executionNodeId as string, node.kind] as const),
    );
    return adjustmentDecisionsOf(await runDecisions(stores, scope), (id) => kinds.get(id));
  };

  const visibleVerifications = async (): Promise<Verification[]> => {
    const found = new Map<string, Verification>();
    const nodes = [await own(), ...(await descendants())];
    for (const node of nodes) {
      for (const verification of await stores.verifications.listByNode(
        scope,
        node.executionNodeId,
      )) {
        found.set(verification.verificationId, verification);
      }
    }
    const events = await readEvery((page) => stores.events.listByRun(scope, page));
    for (const event of events) {
      if (event.type !== "verification.completed") continue;
      const id = (event.payload as { verificationId?: unknown } | undefined)?.verificationId;
      if (typeof id !== "string" || found.has(id)) continue;
      const verification = await stores.verifications.get(
        scope,
        id as Verification["verificationId"],
      );
      if (verification !== undefined) found.set(id, verification);
    }
    return [...found.values()];
  };

  const record = (input: Parameters<typeof recordWorkerDecision>[3]) =>
    recordWorkerDecision(environment, identity, ids, input).catch((error: unknown) => {
      if (error instanceof NoCheckpointError) throw new ToolRefusal("not_found", error.message);
      throw error;
    });
  const NEXT =
    "The next verification applies it. This check is the best this strand can see: the engine " +
    "applies a skip only if the run's complete history agrees, and a skip it does not apply is " +
    "announced on this strand's node.";

  server.registerTool("step.timeout", STEP_TIMEOUT_TOOL, async (input) =>
    guarded(async () => {
      const gates = await contractGates();
      const decisions = await adjustmentDecisions();
      const decision = await recordStepTimeout(record, {
        steps: gates.verification,
        decisions,
        maxWallClockSeconds: gates.maxWallClockSeconds,
        ...input,
      }).catch((error: unknown) => {
        throw asStepRefusal(error);
      });
      return ok(timeoutAnswer(decision.decisionId, input, NEXT), {
        decisionId: decision.decisionId,
        stepId: input.stepId,
      });
    }),
  );

  server.registerTool("step.skip", STEP_SKIP_TOOL, async (input) =>
    guarded(async () => {
      const gates = await contractGates();
      const [decisions, verifications] = await Promise.all([
        adjustmentDecisions(),
        visibleVerifications(),
      ]);
      const decision = await recordStepSkip(record, {
        steps: gates.verification,
        decisions,
        verifications,
        ...input,
      }).catch((error: unknown) => {
        throw asStepRefusal(error);
      });
      return ok(skipAnswer(decision.decisionId, input.stepId, NEXT), {
        decisionId: decision.decisionId,
        stepId: input.stepId,
      });
    }),
  );

  server.registerTool(
    "subprogram.progress",
    {
      title: "Report progress",
      description: "Say what you are doing. Recorded as intent, on the record, as you go.",
      inputSchema: {
        message: z.string().min(1),
        percent: z.number().int().min(0).max(100).optional(),
      },
    },
    async ({ message, percent }) =>
      guarded(async () => {
        reportProgress(environment, identity, message, percent);
        return ok("Noted.", { message });
      }),
  );

  server.registerTool(
    "subprogram.refresh",
    {
      title: "Bring your checkout up to date",
      description:
        "Says where your strand's branch stands. Your checkout **is** your strand's branch: every " +
        "job's commit is merged onto it as the job finishes, so it already holds everything your " +
        "jobs did. Never change files in it.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const head = (
          await git(environment.git, ["rev-parse", "HEAD"], { cwd: identity.worktree })
        ).trim();
        return ok(`Your strand's branch, checked out here, is at ${head}.`, { commitSha: head });
      }),
  );

  const end = async (
    status: "succeeded" | "failed",
    reason: string | undefined,
  ): Promise<ExecutionNode> => {
    const node = await own();
    if (node.status !== "running") {
      throw new ToolRefusal("validation_failed", `this sub-program is already ${node.status}`);
    }
    const ended: ExecutionNode = {
      ...node,
      status,
      updatedAt: nowIso(clock),
      ...(reason === undefined ? {} : { outcomeReason: reason }),
    };
    await stores.executionNodes.put(ended);
    outbox.emit({
      type: status === "succeeded" ? "node.succeeded" : "node.failed",
      source: "mcp",
      payload: reason === undefined ? {} : { reason },
      executionNodeId: node.executionNodeId,
      agentId: identity.agentId,
    });
    await outbox.flush(5_000);
    return ended;
  };

  server.registerTool(
    "subprogram.complete",
    {
      title: "Report the sub-program complete",
      description:
        "Call this when your objective is met. Refused while anything you delegated is still in " +
        "flight: wait for it, or cancel it, first.",
      inputSchema: { summary: z.string().min(1) },
    },
    async ({ summary }) =>
      guarded(async () => {
        const unsettled = (await descendants()).filter((child) => !isDoneForNow(child.status));
        if (unsettled.length > 0) {
          throw new ToolRefusal(
            "job_running",
            `${unsettled.length} of your jobs are still in flight: ` +
              `${unsettled.map((child) => `${child.jobContractId} ${child.status}`).join("; ")}. ` +
              "Wait for them with job.wait, or cancel them, before completing.",
            { unsettled: unsettled.map((child) => child.jobContractId) },
          );
        }
        reportProgress(environment, identity, summary.slice(0, 2_000), 100);
        // The strand lands once, whole (P18, D-P18-04): its node is implemented
        // at its branch's head, and the run's merge queue verifies, examines and
        // integrates it when this session ends.
        const node = await own();
        if (node.status !== "running") {
          throw new ToolRefusal("validation_failed", `this sub-program is already ${node.status}`);
        }
        const head = (
          await git(environment.git, ["rev-parse", "HEAD"], { cwd: identity.worktree })
        ).trim() as CommitSha;
        await stores.executionNodes.put(markImplemented(node, head, nowIso(clock)));
        outbox.emit({
          type: "node.implemented",
          source: "mcp",
          payload: { commitSha: head, summary: summary.slice(0, 2_000) },
          executionNodeId: node.executionNodeId,
          agentId: identity.agentId,
        });
        await outbox.flush(5_000);
        return ok(
          `Recorded at ${head.slice(0, 12)}. Stop now: when this session ends, Nightshift lands your ` +
            "strand — it brings in the program's latest work, runs the gates and examines the strand " +
            "against its acceptance, together. If anything fails, this session is resumed with exactly " +
            "what failed, to fix with jobs of its own.",
          { status: "implemented", commitSha: head },
        );
      }),
  );

  server.registerTool(
    "subprogram.fail",
    {
      title: "Report the sub-program failed",
      description:
        "Use this when the objective cannot be met. Whatever you delegated that is still running is " +
        "cancelled. A clear reason is worth far more than a guess.",
      inputSchema: { reason: z.string().min(1) },
    },
    async ({ reason }) =>
      guarded(async () => {
        await end("failed", reason);
        return ok("Recorded. Your sub-program has failed durably, with your reason attached.", {
          reason,
        });
      }),
  );
};
