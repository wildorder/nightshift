/**
 * `nightshift report` (P9, P20): report.md every time; with `--json`, the
 * versioned export beside it, its attempts narrowed by the filters.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MeasurementSummarySchema,
  type ReportExport,
  ReportExportSchema,
  RoutingDecisionSchema,
} from "@nightshift/contracts";
import { makeAgent, makeNode, makeRootNode } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import {
  createWorld,
  finishedRun,
  PROGRAM_DIRECTORY,
  type World,
} from "../testing/feedback-plane.js";

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

const AT = "2026-09-15T10:00:00.000Z";

/** A finished run with a work attempt (measured, claude/m1) and an examiner attempt (unmeasured, codex/m2). */
const seeded = async (): Promise<World> => {
  const world = await createWorld();
  worlds.push(world);
  const { f } = world;
  world.runs.push(finishedRun(f));
  const root = makeRootNode(f);
  const job = makeNode(f, root.executionNodeId, { status: "integrated" });
  const agent = makeAgent(f, job.executionNodeId, {
    harness: "claude",
    model: "m1",
    startedAt: AT,
    endedAt: "2026-09-15T10:00:30.000Z",
  });
  const route = (id: string, over: Record<string, unknown>) =>
    RoutingDecisionSchema.parse({
      schemaVersion: 1,
      ...f.scope,
      routingDecisionId: id,
      executionNodeId: job.executionNodeId,
      attempt: 1,
      eligibleOptions: [
        { target: { harness: "claude", provider: "anthropic", model: "m1" }, eligible: true },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "m1" },
      ruleId: "r",
      wasOverride: false,
      usage: {},
      outcome: "verified",
      previousRouteId: null,
      createdAt: AT,
      ...over,
    });
  const work = route(f.ids.next("route"), { role: "implementer" });
  const exam = route(f.ids.next("route"), {
    purpose: "examine",
    role: "examiner",
    chosen: { harness: "codex", provider: "openai", model: "m2" },
  });
  const summary = MeasurementSummarySchema.parse({
    schemaVersion: 1,
    measurementVersion: 1,
    ...f.scope,
    measurementSummaryId: f.ids.next("meas"),
    executionNodeId: job.executionNodeId,
    agentId: agent.agentId,
    role: "worker",
    routingDecisionId: work.routingDecisionId,
    route: { harness: "claude", provider: "anthropic", model: "m1" },
    observedModels: ["m1"],
    segments: [],
    totals: { inputTokens: 100, outputTokens: 20, inputIncludesCache: true },
    coverage: "complete",
    gaps: [],
    ledger: {
      chunks: 1,
      artifactIds: [f.ids.next("art")],
      observationCount: 1,
      publishedCount: 1,
    },
    valuation: { source: "unknown" },
    createdAt: AT,
    updatedAt: AT,
  });
  world.records.nodes.push(root, job);
  world.records.agents.push(agent);
  world.records.routes.push(work, exam);
  world.records.measurements.push(summary);
  return world;
};

const report = (world: World, ...args: string[]): Promise<number> =>
  runCli(world.created.environment, ["report", PROGRAM_DIRECTORY, ...args]);

const directory = (world: World): string =>
  join(world.created.environment.cwd, "docs", "programs", PROGRAM_DIRECTORY);

const exported = async (world: World): Promise<ReportExport> =>
  ReportExportSchema.parse(
    JSON.parse(await readFile(join(directory(world), "report.json"), "utf8")),
  );

describe("nightshift report", () => {
  it("writes report.md and no export without --json", async () => {
    const world = await seeded();
    expect(await report(world), world.created.err.join("\n")).toBe(0);
    const md = await readFile(join(directory(world), "report.md"), "utf8");
    expect(md).toContain("## Completion histories");
    expect(md).toContain("## Usage");
    await expect(readFile(join(directory(world), "report.json"), "utf8")).rejects.toThrow();
    expect(world.created.out.join("\n")).not.toContain("report.json");
  });

  it("--json writes a parseable export beside report.md and prints its path", async () => {
    const world = await seeded();
    expect(await report(world, "--json"), world.created.err.join("\n")).toBe(0);
    expect(world.created.out).toContainEqual(
      expect.stringMatching(/^export for run run_\w+: .*report\.json$/),
    );
    const out = await exported(world);
    expect(out.reportExportVersion).toBe(1);
    expect(out.scope.runId).toBe(world.f.scope.runId);
    expect(out.attempts.map((a) => a.model).sort()).toEqual(["m1", "m2"]);
    expect(out.sampleSize).toEqual({ matched: 2, total: 2 });
    const measured = out.attempts.find((a) => a.model === "m1");
    expect(measured?.ledgerArtifactIds).toHaveLength(1);
    expect(measured?.agentMs).toBe(30_000);
  });

  it("--role and --model narrow the export's attempts, and the sample size says so", async () => {
    const world = await seeded();
    expect(await report(world, "--json", "--role", "examiner"), world.created.err.join("\n")).toBe(
      0,
    );
    let out = await exported(world);
    expect(out.attempts.map((a) => a.model)).toEqual(["m2"]);
    expect(out.sampleSize).toEqual({ matched: 1, total: 2 });
    expect(out.filters).toEqual({ role: "examiner" });

    expect(await report(world, "--json", "--model", "m1")).toBe(0);
    out = await exported(world);
    expect(out.attempts.map((a) => a.role)).toEqual(["implementer"]);
    expect(out.filters).toEqual({ model: "m1" });
  });

  it("--since and --until narrow by time", async () => {
    const world = await seeded();
    expect(await report(world, "--json", "--since", "2026-09-15T09:00:00Z")).toBe(0);
    expect((await exported(world)).attempts.map((a) => a.model)).toEqual(["m1"]);
    expect(await report(world, "--json", "--since", "2026-09-16T00:00:00Z")).toBe(0);
    expect((await exported(world)).sampleSize).toEqual({ matched: 0, total: 2 });
    expect(await report(world, "--json", "--until", "2026-09-14T00:00:00Z")).toBe(0);
    expect((await exported(world)).sampleSize.matched).toBe(0);
    const out = await exported(world);
    expect(out.filters).toEqual({ to: "2026-09-14T00:00:00Z" });
  });

  it("refuses a filter without --json, and a timestamp that is not one", async () => {
    const world = await seeded();
    expect(await report(world, "--role", "examiner")).not.toBe(0);
    expect(world.created.err.join("\n")).toContain("add --json");
    world.created.err.length = 0;
    expect(await report(world, "--json", "--since", "yesterday")).not.toBe(0);
    expect(world.created.err.join("\n")).toContain("--since takes an ISO timestamp");
  });
});
