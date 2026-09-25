/**
 * Routing and examination, for real (P8 T5, SC-P8-17).
 *
 *   AWS_PROFILE=nightshift npm run routing
 *
 * Real Claude Code and Codex workers, examiners and arbiters, the org's own
 * ladders, and the deployed control plane. The test is the orchestrator: it
 * drives the real MCP server over stdio and delegates exactly what each phase
 * needs, so a phase proves one thing and says what it cost.
 *
 * Two runs, because a run fixes its policy when it starts (D-P8-03):
 *
 * - **Run A**, under an org configuration whose Claude cheap rung is a model
 *   that does not exist: a bounded job falls back across ladders to Codex's
 *   cheap rung, the unavailable attempt recorded.
 * - **Run B**, under the default ladders: a bounded job on the cheap rung; a
 *   pinned override; a job whose first verification fails on purpose and whose
 *   retry climbs; a medium-risk job examined by a different model; and two
 *   high-risk jobs with a planted defect, examined by the other provider's
 *   frontier model: one is fixed, one is disputed before an arbiter.
 *
 * A real model decides what a real examiner finds, so the defect phases report
 * what happened and assert the machinery around it: who examined, that every
 * finding carried evidence, that a blocked job was stopped, that a fix was
 * examined again, and that a ruling is a decision with its checkpoints.
 *
 * Never part of `npm test`, never in CI.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Examination,
  type RoutingDecision,
  type RoutingPolicy,
} from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { send } from "@nightshift/persistence/http";
import { type Orchestrator, startOrchestrator } from "@nightshift/test/slice";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DeployedSlice, openDeployedSlice } from "./deployed-slice.js";

/** Fails the first verification of the escalation job, once, on purpose. */
const FAIL_ONCE = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!existsSync("src/escalate.js")) process.exit(0);
const { projectId } = JSON.parse(readFileSync("nightshift.program.json", "utf8"));
const marker = join(tmpdir(), \`nightshift-fail-once-\${projectId}\`);
if (existsSync(marker)) process.exit(0);
writeFileSync(marker, "failed once");
console.error("the escalation job's first verification fails on purpose (P8, SC-P8-17)");
process.exit(1);
`;

const SCOPE = { includes: ["src/**", "test/**"] };
const lines: string[] = [];
const startedAt = Date.now();
let slice: DeployedSlice;

const say = (line: string): void => {
  lines.push(line);
  slice?.say(line);
};

beforeAll(async () => {
  slice = await openDeployedSlice({
    label: "routing",
    modelPolicy: {
      allowedProviders: ["anthropic", "openai"],
      allowedModels: [],
      forbiddenModels: [],
    },
    verification: [
      { id: "test", command: "node --test" },
      { id: "once", command: "node scripts/fail-once.mjs" },
    ],
    files: { "scripts/fail-once.mjs": FAIL_ONCE },
  });
});

afterAll(async () => {
  try {
    await slice?.cleanup();
  } finally {
    process.stdout.write(
      `\n[routing] summary\n${lines.map((line) => `  ${line}`).join("\n")}\n` +
        `[routing] total ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`,
    );
  }
});

// --- helpers ------------------------------------------------------------------------

const orgConfigPath = () => `/orgs/${slice.orgId}/config`;

const writeOrgConfig = async (routingPolicy: RoutingPolicy, replacesVersion: number) =>
  send(slice.context.transport, {
    method: "PUT",
    path: orgConfigPath(),
    body: { routingPolicy, examinationPolicy: DEFAULT_EXAMINATION_POLICY, replacesVersion },
  });

/**
 * What a headless CLI printed, run outside the repository so no project file
 * shapes it. Standard input is closed: `codex exec` given an open pipe waits to
 * read its prompt from it, which is what the first two live runs saw.
 */
const answers = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve(`ERROR ${error.message}`));
    child.on("close", (code) =>
      resolve(code === 0 ? out : `ERROR exit ${code} ${err.slice(-400)}`),
    );
  });

interface Started {
  readonly mcp: Orchestrator;
  readonly scope: RunScope;
}

const startRun = async (label: string): Promise<Started> => {
  const mcp = await startOrchestrator({ context: slice.context, harness: "claude" });
  const run = await mcp.call("run.start", {
    programContractPath: "nightshift.program.json",
    model: "claude-opus-5-5",
  });
  expect(run.ok, JSON.stringify(run)).toBe(true);
  const scope: RunScope = {
    projectId: slice.projectId,
    programId: slice.context.program.programId,
    runId: String(run.runId) as never,
  };
  slice.track(scope);
  say(`${label}: run ${scope.runId}`);
  return { mcp, scope };
};

const delegate = async (started: Started, input: Record<string, unknown>) => {
  const result = await started.mcp.call("delegate", { scope: SCOPE, ...input });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return { jobId: String(result.jobId), nodeId: String(result.nodeId) };
};

const wait = async (started: Started, jobId: string): Promise<Record<string, unknown>> => {
  for (;;) {
    const result = await started.mcp.call("job.wait", { jobId });
    if (result.settled === true) return result;
  }
};

const routesOf = async (started: Started, nodeId: string): Promise<RoutingDecision[]> => {
  const all = await slice.context.stores.routingDecisions.listByNode(
    started.scope,
    nodeId as never,
  );
  return [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const examinationsOf = async (started: Started, nodeId: string): Promise<Examination[]> =>
  [...(await slice.context.stores.examinations.listByNode(started.scope, nodeId as never))].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt),
  );

const describeRoutes = (routes: readonly RoutingDecision[]): string =>
  routes
    .map(
      (route) =>
        `${route.purpose ?? "work"} ${route.chosen.model} [${route.ladder ?? "-"}/${route.rung?.tier ?? "-"} ${route.ruleId}] ${route.outcome}` +
        (route.usage.actualCostUsd !== undefined
          ? ` $${route.usage.actualCostUsd.toFixed(3)}`
          : route.usage.estimatedCostUsd !== undefined
            ? ` ~$${route.usage.estimatedCostUsd.toFixed(3)}`
            : ""),
    )
    .join("; ");

const settled = async (
  started: Started,
  jobId: string,
  nodeId: string,
  phase: string,
  began: number,
) => {
  const result = await wait(started, jobId);
  // A node settles when the worker says so; its route's outcome is written when
  // the worker's process has exited, a moment later. Read it once it is.
  let routes = await routesOf(started, nodeId);
  for (
    let tries = 0;
    tries < 30 && routes.some((route) => route.outcome === "pending");
    tries += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    routes = await routesOf(started, nodeId);
  }
  say(
    `${phase}: ${String(result.status)} in ${((Date.now() - began) / 1000).toFixed(1)} s` +
      `${result.outcomeReason === null || result.outcomeReason === undefined ? "" : ` (${String(result.outcomeReason).slice(0, 200)})`}; routes: ${describeRoutes(routes)}`,
  );
  return { result, routes };
};

const finish = async (started: Started): Promise<void> => {
  const finished = await started.mcp.call("run.finish", {
    outcome: "succeeded",
    reason: "the routing suite is done",
  });
  if (finished.ok !== true) {
    await started.mcp.call("run.finish", {
      outcome: "failed",
      reason: "the routing suite ended with work not landed",
    });
  }
  await started.mcp.close().catch(() => {});
};

/**
 * An upheld ruling, followed to its end (D-P8-13, as amended 2026-09-25): the
 * engine starts the next attempt itself; its examination checks only the
 * ruling; the job lands.
 */
const rulingCarriedOut = async (
  started: Started,
  job: { readonly jobId: string; readonly nodeId: string },
  ruledId: string | undefined,
  began: number,
): Promise<void> => {
  const deadline = Date.now() + 1_800_000;
  let check: Examination | undefined;
  for (;;) {
    check = (await examinationsOf(started, job.nodeId)).find(
      (candidate) => candidate.followsRulings !== undefined,
    );
    const node = await slice.context.stores.executionNodes.get(started.scope, job.nodeId as never);
    if (check !== undefined && ["integrated", "failed"].includes(String(node?.status))) break;
    if (Date.now() > deadline) throw new Error("the ruling was not carried out");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const after = await settled(started, job.jobId, job.nodeId, "dispute, ruling carried out", began);
  const findings = check.findings
    .map(
      (finding) =>
        `${finding.id} ${finding.severity}${finding.concerns === undefined ? "" : ` concerns ${finding.concerns}`}: ${finding.summary}`,
    )
    .join(" | ");
  say(`ruling check: ${check.examinerRoute.model}: ${check.outcome}; ${findings || "no findings"}`);
  expect(check.followsRulings?.[0]?.findingId).toBe(ruledId);
  expect(after.result.status).toBe("integrated");
};

// --- the suite ----------------------------------------------------------------------

describe("routing and examination, with real models, against the deployed control plane", () => {
  it("preflight: every route on the org's ladders answers a one-line prompt headless", async () => {
    const routes = Object.values(DEFAULT_ROUTING_POLICY.ladders).flatMap((ladder) =>
      ladder.flatMap((rung) => rung.routes),
    );
    for (const route of routes) {
      const out =
        route.harness === "claude"
          ? await answers("claude", [
              "-p",
              "Reply with exactly: OK",
              "--model",
              route.model,
              "--no-session-persistence",
            ])
          : await answers("codex", [
              "exec",
              "--skip-git-repo-check",
              "--ephemeral",
              "-m",
              route.model,
              "Reply with exactly: OK",
            ]);
      const ok = /\bOK\b/.test(out);
      say(
        `preflight ${route.harness}/${route.model}: ${ok ? "answers" : `DID NOT ANSWER: ${out.slice(0, 200)}`}`,
      );
      expect(ok, `${route.harness}/${route.model}`).toBe(true);
    }
  });

  it("run A: a route that cannot start falls back across ladders (SC-P8-05)", async () => {
    const broken: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      ladders: {
        ...DEFAULT_ROUTING_POLICY.ladders,
        claude: [
          { tier: "cheap", routes: [{ harness: "claude", model: "claude-nonexistent-9" }] },
          ...(DEFAULT_ROUTING_POLICY.ladders.claude ?? []).slice(1),
        ],
      },
    };
    await writeOrgConfig(broken, 0);
    const started = await startRun("run A (a Claude cheap rung that cannot start)");
    try {
      const began = Date.now();
      const job = await delegate(started, {
        objective:
          "Add src/square.js exporting square(n) that returns n * n, and test/square.test.js testing square(4) === 16.",
        acceptance: ["square(4) returns 16", "node --test passes"],
        risk: "low",
        ambiguity: "low",
        testability: "strong",
        jobKind: "implement",
      });
      const { result, routes } = await settled(started, job.jobId, job.nodeId, "fallback", began);
      expect(result.status).toBe("integrated");
      const work = routes.filter((route) => route.purpose === undefined);
      expect(work[0]).toMatchObject({
        outcome: "unavailable",
        chosen: { model: "claude-nonexistent-9" },
      });
      expect(work.at(-1)).toMatchObject({
        outcome: "verified",
        ladder: "codex",
        rung: { tier: "cheap" },
      });
    } finally {
      await finish(started);
      await writeOrgConfig(DEFAULT_ROUTING_POLICY, 1);
    }
  });

  describe("run B, under the default ladders", () => {
    let started: Started;

    beforeAll(async () => {
      started = await startRun("run B (the default ladders)");
    });

    afterAll(async () => {
      if (started !== undefined) await finish(started);
    });

    it("lands a bounded job on the cheap rung (SC-P8-17)", async () => {
      const began = Date.now();
      const job = await delegate(started, {
        objective:
          "Add src/cube.js exporting cube(n) that returns n * n * n, and test/cube.test.js testing cube(3) === 27.",
        acceptance: ["cube(3) returns 27", "node --test passes"],
        risk: "low",
        ambiguity: "low",
        testability: "strong",
        jobKind: "implement",
      });
      const { result, routes } = await settled(started, job.jobId, job.nodeId, "cheap rung", began);
      expect(result.status).toBe("integrated");
      expect(routes[0]).toMatchObject({
        ladder: "claude",
        rung: { tier: "cheap" },
        ruleId: "R-bounded",
      });
    });

    it("honours a pinned model as an override (SC-P8-04)", async () => {
      const began = Date.now();
      const job = await delegate(started, {
        objective:
          "Add src/negate.js exporting negate(n) that returns -n, and test/negate.test.js testing negate(5) === -5.",
        acceptance: ["negate(5) returns -5", "node --test passes"],
        risk: "low",
        ambiguity: "low",
        testability: "strong",
        model: "gpt-6-sol",
      });
      const { result, routes } = await settled(
        started,
        job.jobId,
        job.nodeId,
        "pinned override",
        began,
      );
      expect(result.status).toBe("integrated");
      expect(routes[0]).toMatchObject({ wasOverride: true, chosen: { model: "gpt-6-sol" } });
    });

    it("climbs one rung when a retry follows a failed verification (SC-P8-06)", async () => {
      const began = Date.now();
      const job = await delegate(started, {
        objective:
          "Add src/escalate.js exporting half(n) that returns n / 2, and test/escalate.test.js testing half(8) === 4.",
        acceptance: ["half(8) returns 4", "node --test passes"],
        risk: "low",
        ambiguity: "low",
        testability: "strong",
      });
      const first = await settled(
        started,
        job.jobId,
        job.nodeId,
        "escalation, first attempt",
        began,
      );
      expect(first.result.status).toBe("verification_failed");
      const retried = await started.mcp.call("job.retry", { jobId: job.jobId });
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      const second = await settled(started, job.jobId, job.nodeId, "escalation, retry", began);
      expect(second.result.status).toBe("integrated");
      const work = second.routes.filter((route) => route.purpose === undefined);
      expect(work.map((route) => route.rung?.tier)).toEqual(["cheap", "standard"]);
      expect(work[1]?.previousRouteId).toBe(work[0]?.routingDecisionId);
    });

    it("examines medium-risk work by a different model, advisory (SC-P8-09)", async () => {
      const began = Date.now();
      const job = await delegate(started, {
        objective:
          "Add src/clamp.js exporting clamp(n, lo, hi) that returns n limited to [lo, hi], and test/clamp.test.js covering below, inside and above.",
        acceptance: ["clamp(5, 0, 3) returns 3", "clamp(-1, 0, 3) returns 0", "node --test passes"],
        risk: "medium",
        ambiguity: "low",
        testability: "strong",
      });
      const { result, routes } = await settled(
        started,
        job.jobId,
        job.nodeId,
        "medium, examined",
        began,
      );
      expect(result.status).toBe("integrated");
      const [examination] = await examinationsOf(started, job.nodeId);
      const builder = routes.find((route) => route.purpose === undefined);
      say(
        `medium examination: ${examination?.examinerRoute.model} on ${builder?.chosen.model}: ${examination?.outcome}, ` +
          `${examination?.findings.length ?? 0} finding(s), ${examination?.questions.length ?? 0} question(s)`,
      );
      expect(examination?.blocking).toBe(false);
      expect(examination?.examinerRoute.model).not.toBe(builder?.chosen.model);
    });

    const plantedDefect = {
      // The first live run asked for the defect as the implementation, and Opus
      // failed the job as self-contradictory before any examiner saw it. So the
      // builder is told what this is: it plants the defect knowingly, and fixes
      // it only when an examiner's findings are in its brief.
      objective:
        "This job exercises Nightshift's independent examiner, on purpose. On your first attempt, " +
        "write src/divide.js containing exactly `export const divide = (a, b) => a / b;` (with no " +
        "zero check) and test/divide.test.js testing only divide(6, 3) === 2, then complete the " +
        "job. The missing zero check is the defect the examiner is meant to find: do not add it, " +
        "and do not fail the job over it. If your brief hands you an examiner's findings, fix them.",
      acceptance: [
        "divide(6, 3) returns 2",
        "divide throws a RangeError when the divisor is zero",
        "node --test passes",
      ],
      risk: "high",
      ambiguity: "low",
      testability: "weak",
    };

    it("examines high-risk work by the other provider's frontier model, and a fix is examined again (SC-P8-11, SC-P8-12)", async () => {
      const began = Date.now();
      const job = await delegate(started, plantedDefect);
      const first = await settled(started, job.jobId, job.nodeId, "high, first examination", began);
      const [examination] = await examinationsOf(started, job.nodeId);
      say(
        `high examination: ${examination?.examinerRoute.model}: ${examination?.outcome}, findings ` +
          `${examination?.findings.map((finding) => `${finding.id} ${finding.severity} (${finding.evidence.length} evidence): ${finding.summary}`).join(" | ")}; ` +
          `questions ${examination?.questions.map((qa) => `${qa.question} -> ${qa.answer} (${qa.answeredBy})`).join(" | ") ?? "none"}`,
      );
      const builder = first.routes.find((route) => route.purpose === undefined);
      expect(examination?.blocking).toBe(true);
      expect(examination?.examinerRoute.provider).not.toBe(builder?.chosen.provider);
      expect(examination?.examinerRoute.model).toMatch(/opus|astra/);
      for (const finding of examination?.findings ?? [])
        expect(finding.evidence.length).toBeGreaterThan(0);
      // Stopped beside the queue, where the node is still `implemented` and P1's
      // table lets it only fail: `failed`, the examination named in the reason.
      expect(first.result.status).toBe("failed");
      expect(String(first.result.outcomeReason)).toMatch(/^examination_failed: /);
      const retried = await started.mcp.call("job.retry", { jobId: job.jobId });
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      const second = await settled(started, job.jobId, job.nodeId, "high, the fix", began);
      const examinations = await examinationsOf(started, job.nodeId);
      say(
        `high fix: ${examinations.map((e) => `fix ${e.fixAttempt}: ${e.outcome}`).join(", ")}; ended ${String(second.result.status)}`,
      );
      expect(examinations.map((e) => e.fixAttempt)).toContain(1);
    });

    it("sends a disputed finding to an arbiter, whose ruling is a decision with its checkpoints (SC-P8-12, SC-P8-13)", async () => {
      const began = Date.now();
      const job = await delegate(started, {
        ...plantedDefect,
        objective: plantedDefect.objective.replaceAll("divide", "ratio"),
        acceptance: plantedDefect.acceptance.map((line) => line.replaceAll("divide", "ratio")),
      });
      const first = await settled(
        started,
        job.jobId,
        job.nodeId,
        "dispute, first examination",
        began,
      );
      // Stopped beside the queue, where the node is still `implemented` and P1's
      // table lets it only fail: `failed`, the examination named in the reason.
      expect(first.result.status).toBe("failed");
      expect(String(first.result.outcomeReason)).toMatch(/^examination_failed: /);
      const disputed = await started.mcp.call("finding.dispute", {
        jobId: job.jobId,
        reason:
          "The objective asks for exactly this implementation on the first attempt and says not to add the zero check, so the missing check is what was asked for.",
      });
      say(`dispute: ${String(disputed.ruling ?? disputed.message)}`);
      const [examination] = await examinationsOf(started, job.nodeId);
      const ruled = examination?.findings.find(
        (finding) => finding.resolvedBy?.decisionId !== undefined,
      );
      expect(ruled?.resolution === "overturned" || ruled?.resolution === "upheld").toBe(true);
      const decision = await slice.context.stores.decisions.get(
        started.scope,
        ruled?.resolvedBy?.decisionId as never,
      );
      const arbiter = (await routesOf(started, job.nodeId)).find(
        (route) => route.purpose === "arbitrate",
      );
      say(
        `arbiter ${arbiter?.chosen.model}: ${ruled?.resolution}: ${decision?.rationale.slice(0, 200)}; ` +
          `checkpoints ${decision?.checkpointBefore} -> ${decision?.checkpointAfter ?? "(not landed)"}`,
      );
      expect(decision).toMatchObject({ authority: "agent" });
      expect(decision?.checkpointBefore).toBeDefined();
      if (ruled?.resolution === "overturned") {
        const landed = await settled(
          started,
          job.jobId,
          job.nodeId,
          "dispute, after the ruling",
          began,
        );
        expect(landed.result.status).toBe("integrated");
        return;
      }
      // Upheld: the ruling is final and carried out (D-P8-13, as amended
      // 2026-09-25), by an attempt the engine starts itself.
      await rulingCarriedOut(started, job, ruled?.id, began);
    });
  });
});
