/**
 * Every preview scenario mounts the run page without throwing, and the worlds
 * hold what their names promise (P20, S-04).
 */
import { createCountingIdGenerator, gatherReport } from "@nightshift/core";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mountStudio } from "../test-support.js";
import { runPath, SCENARIO_NAMES, SCENARIOS, type ScenarioName, type Seeded } from "./scenarios.js";

const NOW = "2026-09-28T12:00:00.000Z";

const mount = async (name: ScenarioName) => {
  let seeded: Seeded | undefined;
  const mounted = await mountStudio(
    async (stores) => {
      seeded = await SCENARIOS[name](stores, createCountingIdGenerator(), () => NOW);
    },
    {
      at: () => runPath((seeded as Seeded).scope),
      pollMs: 60_000,
      serve: (stores) => (seeded as Seeded).stores ?? stores,
    },
  );
  return { ...mounted, seeded: seeded as Seeded };
};

describe("the preview scenarios", () => {
  it("names every scenario the entry accepts", () => {
    expect(SCENARIO_NAMES).toEqual(["complete", "sparse", "running", "failed", "error", "loading"]);
  });

  for (const name of SCENARIO_NAMES) {
    it(`mounts ${name} on the run page`, async () => {
      await mount(name);
      if (name === "loading") {
        expect(await screen.findByText(/Building the report/)).toBeTruthy();
      } else {
        expect(await screen.findByRole("heading", { name: /Run/ })).toBeTruthy();
      }
    });
  }

  it("complete reports a completion and measurements", async () => {
    const { stores, seeded } = await mount("complete");
    const report = await gatherReport(stores, seeded.scope);
    expect(report.completions.length).toBeGreaterThanOrEqual(1);
    expect(report.completions[0]?.members).toHaveLength(3);
    expect(report.feedback?.verdict).toBe("worked");
    expect(report.strands.map((s) => s.outcome)).toEqual(["succeeded", "succeeded"]);
    expect(report.strands.flatMap((s) => s.jobs)).toHaveLength(4);
    const summaries = await stores.measurements.listByRun(seeded.scope);
    expect(summaries.items.length).toBeGreaterThan(4);
    expect(summaries.items.some((s) => s.coverage === "partial" && s.gaps.length > 0)).toBe(true);
    expect(new Set(summaries.items.map((s) => s.route.model)).size).toBeGreaterThan(2);
    expect(report.infrastructure).toBeTruthy();
  });

  it("sparse has routes with usage and no summaries, events or verdict", async () => {
    const { stores, seeded } = await mount("sparse");
    const report = await gatherReport(stores, seeded.scope);
    expect((await stores.measurements.listByRun(seeded.scope)).items).toHaveLength(0);
    expect(report.completions).toHaveLength(0);
    expect(report.feedback?.verdict).toBe("not_rated");
    const events = (await stores.events.listByRun(seeded.scope)).items;
    expect(events.some((event) => event.type === "lifecycle.observed")).toBe(false);
    const routes = report.strands.flatMap((s) => s.jobs.flatMap((j) => j.routes));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.usage.inputTokens !== undefined)).toBe(true);
  });

  it("failed has a node that failed after two attempts and no success", async () => {
    const { stores, seeded } = await mount("failed");
    const report = await gatherReport(stores, seeded.scope);
    const jobs = report.strands.flatMap((s) => s.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("failed");
    expect(jobs[0]?.attempts).toBe(2);
    expect(report.strands.some((s) => s.outcome === "succeeded")).toBe(false);
  });

  it("running has open work, a waiting node and no verdict", async () => {
    const { stores, seeded } = await mount("running");
    const report = await gatherReport(stores, seeded.scope);
    expect(report.run.status).toBe("running");
    expect(report.feedback?.verdict).toBe("not_rated");
    const summaries = (await stores.measurements.listByRun(seeded.scope)).items;
    expect(summaries.some((s) => s.segments.some((segment) => segment.open))).toBe(true);
  });

  it("error rejects the report's reads and loading never answers them", async () => {
    for (const name of ["error", "loading"] as const) {
      const stores = (await import("@nightshift/persistence/memory")).createInMemoryStores();
      const seeded = await SCENARIOS[name](stores, createCountingIdGenerator(), () => NOW);
      const served = seeded.stores ?? stores;
      const read = gatherReport(served, seeded.scope);
      if (name === "error") {
        await expect(read).rejects.toThrow(/503/);
      } else {
        const settled = await Promise.race([
          read.then(() => "settled"),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
        ]);
        expect(settled).toBe("pending");
      }
    }
  });
});
