/**
 * The harness conformance suite, version 1 (P5 §4.2, D-P5-03).
 *
 * `harness.ts` beside this file is the version 0 seed: it asserts about a
 * `Harness` handle and its lifecycle, with no job behind it. This is the rest of
 * the specification — the nine Stage 4 items, per adapter — and it asserts about
 * a **job**: three fixture Job Contracts, delegated through the real server
 * binary, executed by whichever adapter the caller wired in.
 *
 * The suite does not know which adapter that is. It is given a way to start an
 * orchestrator and a statement of what the adapter claims (`expects`), and
 * everything else is the same for the scripted harness in `npm test` and for a
 * real model in `npm run conformance`. That sameness is SC-P5-10.
 *
 * **Every assertion reads the control plane**, never process memory and never an
 * adapter's return value: what a harness did is what Nightshift recorded.
 */
import type { AgentId, Event, ExecutionNodeId } from "@nightshift/contracts";
import { isSequenced, type RunScope } from "@nightshift/core";
import {
  ControlPlaneError,
  createFetchTransport,
  createHttpExecutionTokenMinter,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import type { Orchestrator, SliceContext } from "../slice/context.js";
import { waitFor } from "../slice/context.js";
import { CANCELLED_JOB, COMPLETING_JOB, type ConformanceJob, FAILING_JOB } from "./fixture.js";

export interface AdapterConformanceOptions {
  /** A control plane with the fixture repository materialised: local or deployed. */
  open(): Promise<SliceContext>;
  close(context: SliceContext): Promise<void>;
  /** Starts the real server binary with the adapter under test wired in. */
  orchestrate(context: SliceContext, job: ConformanceJob): Promise<Orchestrator>;
  /** The orchestrator's own model, which the human picks (D-P5-05). */
  readonly orchestratorModel: string;
  /** What the adapter's `RouteTarget.harness` must read as on the agent record. */
  readonly harnessId?: string;
  readonly expects: {
    /** `Harness.capabilities.usage`. */
    readonly usage: boolean;
    /** Whether the adapter keeps a transcript. */
    readonly transcript: boolean;
  };
  /** How long a cancel may take: the adapter's grace, plus the record catching up. */
  readonly cancelWithinMs: number;
  /** How long to wait for a worker's first progress report. */
  readonly firstProgressWithinMs?: number;
  /** Told each job's identifiers and wall clock, for `npm run conformance` to print. */
  report?(line: string): void;
}

interface Delegated {
  readonly driver: Orchestrator;
  readonly scope: RunScope;
  readonly rootNodeId: ExecutionNodeId;
  readonly jobId: string;
  readonly nodeId: ExecutionNodeId;
  readonly agentId: AgentId;
  readonly startedAtMs: number;
}

const sequenced = async (context: SliceContext, scope: RunScope): Promise<readonly Event[]> => {
  await context.settle();
  const events = (await context.stores.events.listByRun(scope)).items;
  return events.filter(isSequenced).sort((a, b) => a.sequence - b.sequence);
};

const ENDINGS = ["agent.completed", "agent.failed", "agent.cancelled", "agent.interrupted"];

export const describeAdapterConformance = (
  name: string,
  options: AdapterConformanceOptions,
): void => {
  describe(`harness conformance v1: ${name}`, () => {
    let context: SliceContext | undefined;
    let driver: Orchestrator | undefined;

    afterEach(async () => {
      await driver?.close().catch(() => {});
      driver = undefined;
      if (context !== undefined) await options.close(context).catch(() => {});
      context = undefined;
    });

    const delegate = async (job: ConformanceJob): Promise<Delegated & { ctx: SliceContext }> => {
      const ctx = await options.open();
      context = ctx;
      driver = await options.orchestrate(ctx, job);
      const started = await driver.call("run.start", {
        programContractPath: "nightshift.program.json",
        model: options.orchestratorModel,
      });
      expect(started.ok, JSON.stringify(started)).toBe(true);

      const startedAtMs = Date.now();
      const delegated = await driver.call("delegate", { ...job.delegation });
      expect(delegated.ok, JSON.stringify(delegated)).toBe(true);

      const scope: RunScope = {
        projectId: ctx.program.projectId,
        programId: ctx.program.programId,
        runId: String(started.runId) as never,
      };
      options.report?.(
        `${job.script}: run ${scope.runId} node ${String(delegated.nodeId)} agent ${String(delegated.agentId)}`,
      );
      return {
        ctx,
        driver,
        scope,
        rootNodeId: String(started.rootNodeId) as ExecutionNodeId,
        jobId: String(delegated.jobId),
        nodeId: String(delegated.nodeId) as ExecutionNodeId,
        agentId: String(delegated.agentId) as AgentId,
        startedAtMs,
      };
    };

    const settled = async (job: Delegated) => {
      let report = await job.driver.call("job.wait", { jobId: job.jobId });
      while (report.timedOut === true) {
        report = await job.driver.call("job.wait", { jobId: job.jobId });
      }
      options.report?.(`  ${String(report.status)} after ${Date.now() - job.startedAtMs} ms`);
      return report;
    };

    it("runs the completing job: spawn, identity, tools, progress, decision, exit, verification, artifacts", async () => {
      const job = await delegate(COMPLETING_JOB);
      const { ctx, scope } = job;
      const report = await settled(job);

      // --- verification (SC-P5-08): verified, then integrated --------------------
      expect(report.status, JSON.stringify(report)).toBe("integrated");
      const verifications = await ctx.stores.verifications.listByNode(scope, job.nodeId);
      expect(verifications).toHaveLength(1);
      expect(verifications[0]?.outcome).toBe("passed");

      const events = await sequenced(ctx, scope);
      const ofNode = events.filter((event) => event.executionNodeId === job.nodeId);
      const indexOf = (type: string): number => ofNode.findIndex((event) => event.type === type);

      // --- spawn (SC-P5-01) ------------------------------------------------------
      // The handle's agent is the one Nightshift created before the process
      // existed, and the adapter said so without the worker's help.
      const agents = await ctx.stores.agents.listByNode(scope, job.nodeId);
      expect(agents.map((agent) => agent.agentId)).toEqual([job.agentId]);
      if (options.harnessId !== undefined) expect(agents[0]?.harness).toBe(options.harnessId);
      const startedEvent = ofNode.find((event) => event.type === "agent.started");
      expect(startedEvent?.source).toBe("hook");
      expect(startedEvent?.agentId).toBe(job.agentId);

      // --- identity propagation (SC-P5-02), first half ---------------------------
      const progress = ofNode.filter((event) => event.type === "node.progress");
      expect(progress.length).toBeGreaterThanOrEqual(1);
      expect(progress[0]?.executionNodeId).toBe(job.nodeId);
      expect(progress[0]?.agentId).toBe(job.agentId);

      // --- Nightshift tool access (SC-P5-03) --------------------------------------
      for (const type of ["node.progress", "decision.recorded", "node.implemented"]) {
        const event = ofNode.find((candidate) => candidate.type === type);
        expect(event, type).toBeDefined();
        expect(event?.source, type).toBe("mcp");
        expect(event?.agentId, type).toBe(job.agentId);
      }

      // --- progress visibility (SC-P5-04) ------------------------------------------
      const implementedAt = ofNode[indexOf("node.implemented")]?.sequence ?? -1;
      expect(progress.every((event) => event.source === "mcp")).toBe(true);
      expect(progress.some((event) => (event.sequence ?? 0) < implementedAt)).toBe(true);
      // And the claim came before the verdict (A-05).
      expect(indexOf("verification.completed")).toBeGreaterThan(indexOf("node.implemented"));
      expect(indexOf("node.integrated")).toBeGreaterThan(indexOf("verification.completed"));

      // --- decision recording (SC-P5-05) -------------------------------------------
      const decisions = (await ctx.stores.decisions.listByRun(scope)).items.filter(
        (decision) => decision.executionNodeId === job.nodeId,
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.agentId).toBe(job.agentId);
      expect(decisions[0]?.authority).toBe("agent");
      const checkpoints = (await ctx.stores.checkpoints.listByRun(scope)).items;
      expect(checkpoints.map((checkpoint) => checkpoint.checkpointId)).toContain(
        decisions[0]?.checkpointBefore,
      );

      // --- exit and result collection (SC-P5-07) -----------------------------------
      const endings = ofNode.filter((event) => ENDINGS.includes(event.type));
      expect(endings.map((event) => event.type)).toEqual(["agent.completed"]);
      expect(agents[0]?.status).toBe("completed");
      const routing = await ctx.stores.routingDecisions.listByNode(scope, job.nodeId);
      expect(routing).toHaveLength(1);
      // The route's ending, and Nightshift's own wall clock, for every adapter;
      // tokens where the adapter says it reports them (SC-P5-14).
      expect(routing[0]?.outcome).toBe("verified");
      expect(routing[0]?.usage.wallClockMs).toBeGreaterThanOrEqual(0);
      if (options.expects.usage) {
        expect(routing[0]?.usage.inputTokens).toBeGreaterThan(0);
        expect(routing[0]?.usage.outputTokens).toBeGreaterThan(0);
      }
      options.report?.(`  usage ${JSON.stringify(routing[0]?.usage)}`);

      // --- artifact collection (SC-P5-09) -------------------------------------------
      const artifacts = (await ctx.stores.artifacts.listByRun(scope)).items.filter(
        (artifact) => artifact.executionNodeId === job.nodeId,
      );
      expect(artifacts.some((artifact) => artifact.kind === "verification-log")).toBe(true);
      if (options.expects.transcript) {
        const transcript = artifacts.find((artifact) => artifact.kind === "transcript");
        expect(transcript).toBeDefined();
        expect(transcript?.sizeBytes).toBeGreaterThan(0);
      }

      // --- the run's own ending (SC-P5-15) -------------------------------------------
      // The program node ends `succeeded`, which is not a job's status and not
      // `integrated`: a program node integrates nothing.
      const finished = await job.driver.call("run.finish", { outcome: "succeeded" });
      expect(finished.ok, JSON.stringify(finished)).toBe(true);
      expect((await ctx.stores.executionNodes.get(scope, job.rootNodeId))?.status).toBe(
        "succeeded",
      );
      expect((await ctx.stores.executionNodes.get(scope, job.nodeId))?.status).toBe("integrated");
    });

    it("runs the deterministic failure: the worker reports success and verification disagrees", async () => {
      const job = await delegate(FAILING_JOB);
      const { ctx, scope } = job;
      const report = await settled(job);

      expect(report.status, JSON.stringify(report)).toBe("verification_failed");
      const node = await ctx.stores.executionNodes.get(scope, job.nodeId);
      expect(node?.outcomeReason).toBeTruthy();

      const verifications = await ctx.stores.verifications.listByNode(scope, job.nodeId);
      expect(verifications).toHaveLength(1);
      expect(verifications[0]?.outcome).toBe("failed");
      const failing = verifications[0]?.commands.find((command) => command.exitCode !== 0);
      expect(failing?.stepId).toBe("test");
      // The failing step's log is an artifact, and it says what failed (A-08).
      const log = await ctx.readArtifact(scope, String(failing?.logArtifactId));
      expect(log).toContain("# fail");

      // The worker's claim is on the record too, before the verdict.
      const events = (await sequenced(ctx, scope)).filter(
        (event) => event.executionNodeId === job.nodeId,
      );
      const types = events.map((event) => event.type);
      expect(types).toContain("node.implemented");
      expect(types.indexOf("verification.completed")).toBeGreaterThan(
        types.indexOf("node.implemented"),
      );
      expect(types).not.toContain("node.integrated");
      const routing = await ctx.stores.routingDecisions.listByNode(scope, job.nodeId);
      expect(routing[0]?.outcome).toBe("verification_failed");
    });

    it("cancels a running worker, and refuses that worker any node but its own", async () => {
      const job = await delegate(CANCELLED_JOB);
      const { ctx, scope } = job;

      // Genuinely running: the worker has said something through its own tools.
      await waitFor(
        "the worker's first progress report",
        async () => {
          const progress = (await ctx.stores.events.listByRun(scope)).items.find(
            (event) => event.type === "node.progress" && event.executionNodeId === job.nodeId,
          );
          return progress;
        },
        options.firstProgressWithinMs ?? 60_000,
      );

      // --- identity propagation (SC-P5-02), second half ---------------------------
      // A token for this worker's agent, as the execution layer mints one, pointed
      // at a node it was not issued for. P4's `authorize` is what refuses it.
      const endpoint = ctx.serverEnv.NIGHTSHIFT_API_ENDPOINT ?? "";
      const { token } = await createHttpExecutionTokenMinter({ transport: ctx.transport }).mint(
        scope,
        job.agentId,
      );
      const asWorker = createHttpStores({
        transport: createFetchTransport({ endpoint, tokens: staticTokenProvider(token) }),
      });
      const root = await ctx.stores.executionNodes.get(scope, job.rootNodeId);
      if (root === undefined) throw new Error("the run has no root node");
      const refusal = await asWorker.executionNodes
        .put({ ...root, status: "failed" })
        .then(() => undefined)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ControlPlaneError);
      expect((refusal as ControlPlaneError).code).toBe("execution_out_of_scope");
      // Its own node, it can read.
      expect((await asWorker.executionNodes.get(scope, job.nodeId))?.executionNodeId).toBe(
        job.nodeId,
      );

      // --- cancellation (SC-P5-06) -------------------------------------------------
      const cancelAt = Date.now();
      const cancelled = await job.driver.call("job.cancel", { jobId: job.jobId });
      expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
      const report = await settled(job);
      expect(Date.now() - cancelAt).toBeLessThan(options.cancelWithinMs);
      expect(report.status).toBe("cancelled");

      const agents = await ctx.stores.agents.listByNode(scope, job.nodeId);
      expect(agents[0]?.status).toBe("cancelled");
      const node = await ctx.stores.executionNodes.get(scope, job.nodeId);
      expect(node?.status).toBe("cancelled");

      const endings = (await sequenced(ctx, scope)).filter(
        (event) => event.executionNodeId === job.nodeId && ENDINGS.includes(event.type),
      );
      expect(endings.map((event) => event.type)).toEqual(["agent.cancelled"]);
      const routing = await waitFor("the route's ending", async () => {
        const decisions = await ctx.stores.routingDecisions.listByNode(scope, job.nodeId);
        return decisions[0]?.outcome === "pending" ? undefined : decisions[0];
      });
      expect(routing.outcome).toBe("cancelled");
    });
  });
};
