/**
 * The Overview's scope (D-05): this run or a completion history, kept in the URL,
 * with the history's figures and none of the run's own tiles, and the budget
 * evaluation's cue on the run's Consumed tile.
 */
import type { ProgramId, Run, RunId } from "@nightshift/contracts";
import { createCountingIdGenerator, makeEvent, type ProjectStores } from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { runPath, SCENARIOS, type ScenarioName, type Seeded } from "../../../preview/scenarios.js";
import { mountStudio } from "../../../test-support.js";

const TITLE = "Invoices persist and webhooks deliver once";

interface Options {
  readonly name?: ScenarioName;
  /** A fourth member: a finished run that has no measurement at all and is not rated. */
  readonly unmeasured?: boolean;
  /** The correction run's measurements cannot be read. */
  readonly unavailable?: boolean;
  readonly query?: (historyId: string) => string;
  readonly pollMs?: number;
  readonly maxUsd?: number;
  /** Routes lose their usage, so the spend cannot be evaluated completely. */
  readonly wipeUsage?: boolean;
  /** The run is still running, so the page polls. */
  readonly live?: boolean;
}

interface Facts {
  historyId: string;
  correction: { programId: string; runId: string };
  extra?: string;
}

const mount = async (options: Options = {}) => {
  let seeded: Seeded | undefined;
  const facts = {} as Facts;
  const mounted = await mountStudio(
    async (stores) => {
      seeded = await SCENARIOS[options.name ?? "complete"](
        stores,
        createCountingIdGenerator(),
        () => "2026-09-28T12:00:00.000Z",
      );
      const { scope } = seeded;
      if (options.maxUsd !== undefined) {
        const program = await stores.programContracts.get(scope.projectId, scope.programId);
        if (program === undefined) throw new Error("no program");
        await stores.programContracts.put({
          ...program,
          costPolicy: { ...program.costPolicy, maxUsd: options.maxUsd },
        });
      }
      if (options.wipeUsage) {
        for (const node of (await stores.executionNodes.listByRun(scope)).items) {
          for (const route of await stores.routingDecisions.listByNode(
            scope,
            node.executionNodeId,
          )) {
            await stores.routingDecisions.put({ ...route, usage: {} });
          }
        }
      }
      if (options.live) {
        const { endedAt: _ended, ...open } = (await stores.runs.get(scope, scope.runId)) as Run;
        await stores.runs.put({ ...open, status: "running" });
      }
      const history = (await stores.completionHistories.listByProject(scope.projectId)).items[0];
      if (history === undefined) return;
      facts.historyId = history.completionHistoryId;
      const correction = history.members.find((m) => m.role === "correction");
      facts.correction = correction as Facts["correction"];
      if (options.unmeasured) {
        const source = await stores.runs.get(
          { projectId: scope.projectId, programId: correction?.programId as ProgramId },
          correction?.runId as RunId,
        );
        if (source === undefined) throw new Error("no correction run");
        const extra = createCountingIdGenerator(7000).next("run");
        await stores.runs.put({ ...source, runId: extra });
        facts.extra = extra;
        await stores.completionHistories.put({
          ...history,
          version: history.version + 1,
          revisions: [
            ...history.revisions,
            {
              version: history.version + 1,
              actor: (history.revisions[0] as (typeof history.revisions)[number]).actor,
              recordedAt: history.updatedAt,
              added: [{ programId: source.programId, runId: extra, role: "contributing" }],
              removed: [],
            },
          ],
          members: [
            ...history.members,
            { programId: source.programId, runId: extra, role: "contributing" },
          ],
        });
      }
    },
    {
      at: () =>
        `${runPath((seeded as Seeded).scope)}${options.query === undefined ? "" : `?${options.query(facts.historyId)}`}`,
      pollMs: options.pollMs ?? 60_000,
      serve: (stores): ProjectStores => {
        const served = (seeded as Seeded).stores ?? stores;
        if (!options.unavailable) return served;
        return {
          ...served,
          measurements: {
            ...served.measurements,
            listByRun: async (scope, page) => {
              if (scope.runId === facts.correction.runId) throw new Error("measurements refused");
              return served.measurements.listByRun(scope, page);
            },
          },
        } as ProjectStores;
      },
    },
  );
  return { ...mounted, seeded: seeded as Seeded, facts };
};

const runTiles = () => screen.queryByRole("group", { name: "Headline summaries for this run" });
const historyTiles = () =>
  screen.queryByRole("group", { name: "Headline summaries for this completion history" });
const decoded = (location: { current: string }) => decodeURIComponent(location.current);

describe("the scope control", () => {
  it("switches between this run and a history, replacing figures and keeping the scope in the URL", async () => {
    const { location, facts } = await mount();
    const select = (await screen.findByRole("combobox", { name: "Scope" })) as HTMLSelectElement;
    expect(select.value).toBe("run");
    expect(screen.getByTestId("scope-label").textContent).toBe("This run");
    await waitFor(() => expect(runTiles()?.textContent).toContain("1 of 4"));
    expect(historyTiles()).toBeNull();
    expect(screen.queryByText("Lead time:")).toBeNull();

    await userEvent.selectOptions(select, `history:${facts.historyId}`);
    await waitFor(() =>
      expect(screen.getByTestId("scope-label").textContent).toBe(`Completion history: ${TITLE}`),
    );
    expect(decoded(location)).toContain(`scope=history:${facts.historyId}`);
    expect(screen.getByTestId("history-counts").textContent).toBe(
      "3 runs: 1 anchor, 1 contributing, 1 correction",
    );
    expect(screen.getByTestId("history-version").textContent).toBe("2");
    expect(screen.getByTestId("as-of").textContent).toContain("As of");
    // The run-only value is gone and a history-only value is there.
    expect(runTiles()).toBeNull();
    expect(screen.queryByText(/1 of 4/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Tokens by role" })).toBeNull();
    expect(historyTiles()?.textContent).toContain("Lead time:");
    expect(screen.getByRole("table", { name: "Member runs" })).toBeTruthy();

    // The verdict control stays, for this run only.
    expect(screen.getByRole("group", { name: "Human acceptance (this run only)" })).toBeTruthy();

    await userEvent.selectOptions(select, "run");
    await waitFor(() => expect(runTiles()).not.toBeNull());
    expect(historyTiles()).toBeNull();
    expect(screen.queryByText("Lead time:")).toBeNull();
    expect(screen.getByTestId("scope-label").textContent).toBe("This run");
    expect(decoded(location)).toContain("scope=run");
  });

  it("restores a history scope from the URL on mount and keeps it across a tab change", async () => {
    const { location, facts } = await mount({ query: (id) => `tab=overview&scope=history:${id}` });
    expect((await screen.findByTestId("scope-label")).textContent).toBe(
      `Completion history: ${TITLE}`,
    );
    expect(
      ((await screen.findByRole("combobox", { name: "Scope" })) as HTMLSelectElement).value,
    ).toBe(`history:${facts.historyId}`);
    expect(runTiles()).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Work" }));
    await waitFor(() => expect(decoded(location)).toContain("tab=work"));
    expect(decoded(location)).toContain(`scope=history:${facts.historyId}`);
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect((await screen.findByTestId("scope-label")).textContent).toBe(
      `Completion history: ${TITLE}`,
    );
  });

  it("falls back to this run with a visible note for an id that is not a history of the run", async () => {
    await mount({ query: () => "scope=history:chist_nope" });
    expect((await screen.findByTestId("scope-label")).textContent).toBe("This run");
    expect(screen.getByTestId("scope-note").textContent).toContain("history:chist_nope");
    await waitFor(() => expect(runTiles()).not.toBeNull());
    expect(historyTiles()).toBeNull();
  });
});

describe("a completion history", () => {
  it("lists the members with role, status, verdict and a link to each run, across programs", async () => {
    const { facts, seeded } = await mount({ query: (id) => `scope=history:${id}` });
    const table = await screen.findByRole("table", { name: "Member runs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "anchor",
      "contributing",
      "correction",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("Worked")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Did not work")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Worked")).toBeTruthy();
    expect(rows[0]?.textContent).toContain("succeeded");
    expect(rows[0]?.textContent).toContain("(this run)");
    const link = within(rows[2] as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toBe(
      `/projects/${seeded.scope.projectId}/programs/${facts.correction.programId}/runs/${facts.correction.runId}`,
    );
    expect(facts.correction.programId).not.toBe(seeded.scope.programId);
    await userEvent.click(link);
    await waitFor(() =>
      expect(document.body.textContent).toContain(facts.correction.runId.slice(-8)),
    );
    // The other run's page opens on its own scope, not the history's.
    await waitFor(() => expect(screen.getByTestId("scope-label").textContent).toBe("This run"));
  });

  it("shows measured n of m, estimates apart, the rating denominators and the checkpoint", async () => {
    await mount({ query: (id) => `scope=history:${id}` });
    const tiles = await screen.findByRole("group", {
      name: "Headline summaries for this completion history",
    });
    const consumed = tiles.querySelector("[data-history-tile='consumed']") as HTMLElement;
    expect(consumed.textContent).toContain("measured 3 of 3 members");
    expect(consumed.textContent).toContain("Model API-equivalent estimate:");
    expect(consumed.textContent).toContain("Machine estimate:");
    expect(consumed.textContent).toContain("Combined estimate:");
    expect(consumed.textContent).toContain("Price provenance:");
    expect(consumed.textContent).toContain("never a bill");
    const rating = tiles.querySelector("[data-history-tile='rating']") as HTMLElement;
    expect(rating.textContent).toContain("3 of 3 rated");
    expect(rating.textContent).toContain("Worked: 2 of 3 rated");
    expect(rating.textContent).toContain("Did not work: 1 of 3 rated");
    expect(rating.textContent).toContain("Not rated: 0 of 3 eligible");
    const checkpoints = screen.getByTestId("history-checkpoints");
    expect(checkpoints.textContent).toContain("after the correction");
    expect(checkpoints.textContent).toContain("measured 3 of 3 members");
    expect((await screen.findByTestId("history-timeline")).querySelectorAll("li")).toHaveLength(3);
  });

  it("flags a lower bound, names unavailable members and never counts the unrated as either", async () => {
    const { facts } = await mount({
      unmeasured: true,
      unavailable: true,
      query: (id) => `scope=history:${id}`,
    });
    const tiles = await screen.findByRole("group", {
      name: "Headline summaries for this completion history",
    });
    await waitFor(() => expect(tiles.textContent).toContain("measured 2 of 4 members"));
    const consumed = tiles.querySelector("[data-history-tile='consumed']") as HTMLElement;
    expect(consumed.textContent).toContain(
      `${facts.correction.programId}/${facts.correction.runId}`,
    );
    expect(consumed.textContent).toContain("Unavailable");
    expect(consumed.textContent).toMatch(/Combined estimate: \$[\d.]+ · lower bound/);
    expect(consumed.textContent).not.toContain("every member measured");
    const rating = tiles.querySelector("[data-history-tile='rating']") as HTMLElement;
    expect(rating.textContent).toContain("3 of 4 rated");
    expect(rating.textContent).toContain("Worked: 2 of 3 rated");
    expect(rating.textContent).toContain("Did not work: 1 of 3 rated");
    expect(rating.textContent).toContain("Not rated: 1 of 4 eligible, counted as neither");
    const rows = screen
      .getAllByRole("row")
      .filter((r) => r.textContent?.includes(facts.extra?.slice(-8) ?? "?"));
    expect(rows[0]?.textContent).toContain("Not rated");
  });

  it("keeps the history scope selected while the live poll refreshes the report", async () => {
    const { stores, seeded } = await mount({
      live: true,
      pollMs: 25,
      query: (id) => `scope=history:${id}`,
    });
    expect((await screen.findByTestId("scope-label")).textContent).toBe(
      `Completion history: ${TITLE}`,
    );
    const before = screen.getAllByTestId("as-of")[0]?.textContent;
    await stores.events.append(
      makeEvent(
        { scope: seeded.scope, ids: createCountingIdGenerator(5000) } as never,
        {
          ...seeded.scope,
          sequence: 9999,
          type: "run.started",
          idempotencyKey: "live-history",
          occurredAt: "2026-09-28T11:45:00.000Z",
          recordedAt: "2026-09-28T11:45:00.000Z",
        } as never,
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId("as-of")[0]?.textContent).not.toBe(before), {
      timeout: 3000,
    });
    expect(screen.getByTestId("scope-label").textContent).toBe(`Completion history: ${TITLE}`);
    expect(historyTiles()).not.toBeNull();
    expect(runTiles()).toBeNull();
  });
});

describe("the budget evaluation", () => {
  it("says what cannot be evaluated when the figures are incomplete, and never 'within budget'", async () => {
    await mount({ name: "sparse", maxUsd: 50, wipeUsage: true });
    const group = await screen.findByRole("group", { name: "Headline summaries for this run" });
    const consumed = group.querySelector("[data-tile='consumed']") as HTMLElement;
    await waitFor(() => expect(consumed.textContent).toContain("cannot be evaluated completely"));
    expect(consumed.textContent).toMatch(
      /cannot be evaluated completely: \d+ unpriced, \d+ unmeasured/,
    );
    await userEvent.click(consumed);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("limit $50.00");
    expect(sheet.textContent).toMatch(/spent so far \$/);
    expect(sheet.textContent).toMatch(
      /Cannot be evaluated completely: \d+ unpriced, \d+ unmeasured/,
    );
    expect(sheet.textContent).not.toMatch(/within budget/i);
    expect(consumed.textContent).not.toMatch(/within budget/i);
  });

  it("states a complete evaluation against the limit, and no cue on the tile", async () => {
    await mount({ maxUsd: 500 });
    const group = await screen.findByRole("group", { name: "Headline summaries for this run" });
    const consumed = group.querySelector("[data-tile='consumed']") as HTMLElement;
    await userEvent.click(consumed);
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(sheet.textContent).toContain("limit $500.00"));
    expect(sheet.textContent).not.toContain("Cannot be evaluated");
    expect(sheet.textContent).toContain("Within budget.");
    expect(consumed.textContent).not.toContain("cannot be evaluated");
  });

  it("says no limit is configured when the program has none", async () => {
    await mount();
    await userEvent.click(
      (await screen.findByRole("group", { name: "Headline summaries for this run" })).querySelector(
        "[data-tile='consumed']",
      ) as HTMLElement,
    );
    expect((await screen.findByRole("dialog")).textContent).toContain("no limit is configured");
  });
});
