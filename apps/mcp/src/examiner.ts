/**
 * The examiner's tools (P8, D-P8-10, D-P8-12, D-P8-15), and the arbiter's
 * (D-P8-13).
 *
 * An examiner has two, and an arbiter one. What is missing matters as much as
 * what is here: neither can report a job, delegate, touch a node, or write
 * anything but its own verdict; the tools are not registered, and its token's
 * table forbids the routes besides.
 *
 * The frame of the task (which examination, which commit and patch, which
 * finding) is the execution layer's, fixed before the agent started, and read
 * from the environment. The model supplies only its judgement.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Decision,
  type Examination,
  ExaminationSchema,
  FindingEvidenceSchema,
  FindingSeveritySchema,
  MAX_EXAMINATION_QUESTIONS,
} from "@nightshift/contracts";
import { type IdGenerator, nowIso } from "@nightshift/core";
import {
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  RULING_CHOICES,
  RULING_CONTEXT_ENV,
  type RulingContext,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { z } from "zod";
import { guarded, ok, ToolRefusal } from "./results.js";
import type { Env } from "./role.js";

export interface HelperDeps {
  readonly identity: WorkerIdentity;
  readonly environment: WorkerEnvironment;
  readonly ids: IdGenerator;
  readonly env: Env;
}

const contextFrom = <T>(env: Env, name: string): T => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    throw new Error(
      `${name} is missing: this server was not launched by the execution layer for this task`,
    );
  }
  return JSON.parse(raw) as T;
};

/** An examiner: ask the builder, once; submit a verdict, once. */
export const registerExaminerTools = (server: McpServer, deps: HelperDeps): void => {
  const { identity, environment } = deps;
  const context = contextFrom<ExaminationContext>(deps.env, EXAMINATION_CONTEXT_ENV);
  let asked = context.round === 2;
  let submitted = false;

  server.registerTool(
    "examination.ask",
    {
      title: "Ask the builder",
      description:
        `Put up to ${MAX_EXAMINATION_QUESTIONS} questions to the builder, once, before you submit. ` +
        "Ask only what the code and the checks cannot tell you: why something that looks wrong " +
        "might be deliberate. Then end your turn; you are resumed with the answers.",
      inputSchema: { questions: z.array(z.string().min(1)).min(1).max(MAX_EXAMINATION_QUESTIONS) },
    },
    async ({ questions }) =>
      guarded(async () => {
        if (asked) {
          throw new ToolRefusal(
            "validation_failed",
            "you have had your one round of questions. Submit your verdict with examination.submit.",
          );
        }
        asked = true;
        environment.outbox.emit({
          type: "examination.asked",
          source: "mcp",
          payload: { examinationId: context.examinationId, questions },
          executionNodeId: identity.executionNodeId,
          agentId: identity.agentId,
        });
        await environment.outbox.flush(5_000);
        return ok(
          "Your questions are with the builder. End your turn now, without submitting: you will " +
            "be resumed with the answers, and submit then.",
          { questions },
        );
      }),
  );

  server.registerTool(
    "examination.submit",
    {
      title: "Submit your verdict",
      description:
        "Your verdict on the work, once. outcome: passed (no findings), findings_raised, or failed. " +
        "Every finding needs at least one piece of evidence a reader can check, or it is refused.",
      inputSchema: {
        outcome: z.enum(["passed", "findings_raised", "failed"]),
        findings: z
          .array(
            z.object({
              severity: FindingSeveritySchema,
              summary: z.string().min(1),
              evidence: z.array(FindingEvidenceSchema).min(1),
            }),
          )
          .default([]),
      },
    },
    async ({ outcome, findings }) =>
      guarded(async () => {
        if (submitted)
          throw new ToolRefusal("validation_failed", "your verdict is already recorded");
        const examination: Examination = ExaminationSchema.parse({
          schemaVersion: 1,
          ...identity.scope,
          examinationId: context.examinationId,
          executionNodeId: identity.executionNodeId,
          verificationId: context.verificationId,
          commitSha: context.commitSha,
          patchId: context.patchId,
          implementerAgentId: context.implementerAgentId,
          examinerAgentId: identity.agentId,
          examinerRoute: context.examinerRoute,
          requiredByRisk: context.requiredByRisk,
          blocking: context.blocking,
          fixAttempt: context.fixAttempt,
          questions: context.questions,
          outcome: findings.length === 0 && outcome === "findings_raised" ? "passed" : outcome,
          findings: findings.map((finding, index) => ({
            id: `F-${String(index + 1).padStart(2, "0")}`,
            severity: finding.severity,
            summary: finding.summary,
            evidence: finding.evidence,
            resolution: "unresolved",
          })),
          createdAt: nowIso(environment.clock),
        });
        await environment.stores.examinations.put(examination);
        submitted = true;
        return ok(
          `Recorded: ${examination.outcome}, with ${examination.findings.length} finding(s). You are done; end your turn.`,
          { examinationId: examination.examinationId, outcome: examination.outcome },
        );
      }),
  );
};

/** An arbiter: rule on the one finding it was given, once. */
export const registerArbiterTools = (server: McpServer, deps: HelperDeps): void => {
  const { identity, environment } = deps;
  const context = contextFrom<RulingContext>(deps.env, RULING_CONTEXT_ENV);
  let ruled = false;

  server.registerTool(
    "finding.rule",
    {
      title: "Rule on the disputed finding",
      description:
        'Your ruling, once: "overturn" when the finding is wrong or does not matter as stated, ' +
        '"uphold" when it is right and the work should not land as it is. Say why.',
      inputSchema: {
        findingId: z.string().min(1),
        ruling: z.enum([RULING_CHOICES.overturn, RULING_CHOICES.uphold]),
        rationale: z.string().min(1),
      },
    },
    async ({ findingId, ruling, rationale }) =>
      guarded(async () => {
        if (ruled) throw new ToolRefusal("validation_failed", "your ruling is already recorded");
        if (findingId !== context.findingId) {
          throw new ToolRefusal(
            "validation_failed",
            `you were asked to rule on ${context.findingId}, not ${findingId}`,
          );
        }
        const other =
          ruling === RULING_CHOICES.overturn ? RULING_CHOICES.uphold : RULING_CHOICES.overturn;
        const decision: Decision = {
          schemaVersion: 1,
          ...identity.scope,
          decisionId: deps.ids.next("dec"),
          executionNodeId: identity.executionNodeId,
          agentId: identity.agentId,
          context: `The arbiter's ruling on finding ${context.findingId} of examination ${context.examinationId}.`,
          alternatives: [{ summary: other, rejectedBecause: `the arbiter chose to ${ruling}` }],
          choice: ruling,
          rationale,
          reversibility: "reversible",
          checkpointBefore: context.checkpointBefore,
          affectedNodes: [identity.executionNodeId],
          authority: "agent",
          supersedesDecisionId: null,
          createdAt: nowIso(environment.clock),
        };
        await environment.stores.decisions.put(decision);
        ruled = true;
        environment.outbox.emit({
          type: "decision.recorded",
          source: "mcp",
          payload: { decisionId: decision.decisionId, choice: ruling, findingId },
          executionNodeId: identity.executionNodeId,
          agentId: identity.agentId,
        });
        await environment.outbox.flush(5_000);
        return ok(`Recorded: ${ruling}. You are done; end your turn.`, {
          decisionId: decision.decisionId,
        });
      }),
  );
};
