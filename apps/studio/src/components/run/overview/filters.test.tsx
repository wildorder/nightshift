/**
 * The attempt filters (P20, US-05): they narrow the attempts list and its sample
 * size, and never the headline summaries, which describe the whole scope.
 */

import { createCountingIdGenerator } from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { runPath, SCENARIOS, type Seeded } from "../../../preview/scenarios.js";
import { mountStudio } from "../../../test-support.js";

const mountComplete = async () => {
  let seeded: Seeded | undefined;
  await mountStudio(
    async (stores) => {
      seeded = await SCENARIOS.complete(
        stores,
        createCountingIdGenerator(),
        () => "2026-09-28T12:00:00.000Z",
      );
    },
    {
      at: () => runPath((seeded as Seeded).scope),
      pollMs: 60_000,
      serve: (stores) => (seeded as Seeded).stores ?? stores,
    },
  );
};

const sampleOf = (): { matched: number; total: number } => {
  const match = /Showing (\d+) of (\d+) attempts/.exec(
    screen.getByTestId("attempt-sample").textContent ?? "",
  );
  if (!match) throw new Error("no sample size text");
  return { matched: Number(match[1]), total: Number(match[2]) };
};

const rowCount = () => within(screen.getByTestId("attempt-table")).getAllByRole("row").length - 1;

describe("the attempt filters", () => {
  it("narrow only the attempts list and its sample size, never the headline summaries", async () => {
    await mountComplete();
    const headline = await screen.findByRole("group", { name: "Headline summaries for this run" });
    await waitFor(() => expect(headline.textContent).not.toContain("reading attempts"));
    const headlineBefore = headline.textContent;

    await userEvent.click(await screen.findByRole("button", { name: /^Attempts/ }));
    const select = (await screen.findByLabelText("Role")) as HTMLSelectElement;
    expect(screen.getByTestId("attempt-filter-note").textContent).toMatch(
      /narrow the attempts list and its sample size.*whole scope/,
    );
    const all = sampleOf();
    expect(rowCount()).toBe(all.total);

    const roles = Array.from(select.options)
      .map((option) => option.value)
      .filter((value) => value !== "");
    expect(roles.length).toBeGreaterThan(0);
    // Pick a role that does not cover every attempt.
    let narrowed: { matched: number; total: number } | undefined;
    let chosen = "";
    for (const role of roles) {
      await userEvent.selectOptions(select, role);
      const sample = sampleOf();
      if (sample.matched < sample.total) {
        narrowed = sample;
        chosen = role;
        break;
      }
    }
    expect(narrowed).toBeDefined();
    expect(narrowed?.total).toBe(all.total);
    expect(rowCount()).toBe(narrowed?.matched);
    const body = within(screen.getByTestId("attempt-table")).getAllByRole("row").slice(1);
    for (const row of body) expect(within(row).getAllByRole("cell")[1]?.textContent).toBe(chosen);
    expect(screen.getByRole("group", { name: "Headline summaries for this run" }).textContent).toBe(
      headlineBefore,
    );

    await userEvent.selectOptions(select, "");
    expect(sampleOf()).toEqual(all);
    expect(rowCount()).toBe(all.total);
    expect(screen.getByRole("group", { name: "Headline summaries for this run" }).textContent).toBe(
      headlineBefore,
    );
  });
});
