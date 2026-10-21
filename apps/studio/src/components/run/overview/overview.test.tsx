/**
 * The run's Overview over the fixture scenarios (P20, US-05): what the headline
 * tiles say, the charts and their text twins, the evidence sheet and the way it
 * leads to the Work tab and the decision pages, and what survives a live poll.
 */
import {
  createCountingIdGenerator,
  gatherReport,
  METRIC_DEFINITIONS,
  makeEvent,
} from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { runPath, SCENARIOS, type ScenarioName, type Seeded } from "../../../preview/scenarios.js";
import { mountStudio } from "../../../test-support.js";

const mount = async (name: ScenarioName, pollMs = 60_000) => {
  let seeded: Seeded | undefined;
  const mounted = await mountStudio(
    async (stores) => {
      seeded = await SCENARIOS[name](
        stores,
        createCountingIdGenerator(),
        () => "2026-09-28T12:00:00.000Z",
      );
    },
    {
      at: () => runPath((seeded as Seeded).scope),
      pollMs,
      serve: (stores) => (seeded as Seeded).stores ?? stores,
      artifacts: { downloadUrl: async (_scope, id) => `https://signed.example/${id}` },
    },
  );
  const served = (seeded as Seeded).stores ?? mounted.stores;
  return { ...mounted, served, seeded: seeded as Seeded };
};

const tile = async (id: string): Promise<HTMLElement> => {
  const group = await screen.findByRole("group", { name: "Headline summaries for this run" });
  const found = group.querySelector(`[data-tile="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${id} tile`);
  return found;
};

describe("the Overview tab", () => {
  it("is the first and default tab, with the run's identity, scope and separate states", async () => {
    await mount("complete");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs[0]?.textContent).toBe("Overview");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect((await screen.findByTestId("scope-label")).textContent).toBe("This run");
    const engine = screen.getByRole("group", { name: "Engine status" });
    expect(within(engine).getByText("succeeded").getAttribute("data-tone")).toBe("success");
    const human = screen.getByRole("group", { name: "Human acceptance" });
    expect(await within(human).findByText("Worked")).toBeTruthy();
    await waitFor(() =>
      expect(
        within(human).getByRole("button", { name: "Worked" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(within(human).getByRole("button", { name: "Did not work" })).toBeTruthy();
    expect(screen.getByText("Completion histories: 1")).toBeTruthy();
    expect(screen.getByTestId("as-of").textContent).toContain("2026-09-28 07:35:00Z");
    expect(screen.queryByTestId("stale")).toBeNull();
  });

  it("rates the run with one click from the header", async () => {
    const { served, seeded } = await mount("failed");
    const human = await screen.findByRole("group", { name: "Human acceptance" });
    await waitFor(() =>
      expect(
        (within(human).getByRole("button", { name: "Did not work" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await userEvent.click(within(human).getByRole("button", { name: "Did not work" }));
    await waitFor(async () =>
      expect((await served.feedback.get(seeded.scope))?.verdict).toBe("did_not_work"),
    );
    expect(await within(human).findByText("Did not work")).toBeTruthy();
  });

  it("shows x of n, time with wait share, tokens with labelled estimates, and rework with review", async () => {
    await mount("complete");
    const delivered = await tile("delivered");
    expect(delivered.textContent).toContain("1 of 4");
    expect(delivered.textContent).toContain("0 jobs, not in the denominator");
    expect(delivered.textContent).toContain("4 landed");

    const time = await tile("time");
    expect(time.textContent).toContain("1h 35m");
    expect(time.textContent).toContain("66% of elapsed");

    const consumed = await tile("consumed");
    await waitFor(() => expect(consumed.textContent).toContain("input tokens (incl. cache)"));
    expect(consumed.textContent).toContain("output tokens");
    expect(consumed.textContent).toContain("API-equivalent estimate:");
    expect(consumed.textContent).toContain("Machine estimate:");
    expect(consumed.textContent).toMatch(/\d+ of \d+ attempts valued/);

    const review = await tile("review");
    expect(review.textContent).toContain("3 rework attempts");
    expect(review.textContent).toContain("2 unique");
    expect(review.textContent).toContain("not causation");
    expect(review.textContent).not.toMatch(/quality score|better|worse|↑|↓/i);
  });

  it("renders 'not observed' for a sparse run, with no zero and no success tone on the tiles", async () => {
    await mount("sparse");
    const consumed = await tile("consumed");
    await waitFor(() => expect(consumed.textContent).toContain("API-equivalent"));
    expect(consumed.textContent).toContain("Machine estimate: not observed");
    const time = await tile("time");
    expect(time.textContent).toContain("Wait share: not observed");
    expect(screen.getByTestId("timeline-empty").textContent).toContain("not observed");
    expect(screen.getByRole("complementary", { name: "Missing evidence" })).toBeTruthy();
    const group = screen.getByRole("group", { name: "Headline summaries for this run" });
    expect(group.querySelector('[data-tone="success"]')).toBeNull();
    expect(group.innerHTML).not.toMatch(/text-status-success/);
  });

  it("never turns missing tokens or dollars into 0", async () => {
    let seeded: Seeded | undefined;
    await mountStudio(
      async (stores) => {
        seeded = await SCENARIOS.sparse(
          stores,
          createCountingIdGenerator(),
          () => "2026-09-28T12:00:00.000Z",
        );
        const served = seeded.stores ?? stores;
        for (const node of (await served.executionNodes.listByRun(seeded.scope)).items) {
          for (const route of await served.routingDecisions.listByNode(
            seeded.scope,
            node.executionNodeId,
          )) {
            await served.routingDecisions.put({ ...route, usage: {} });
          }
        }
      },
      {
        at: () => runPath((seeded as Seeded).scope),
        serve: (stores) => (seeded as Seeded).stores ?? stores,
        pollMs: 60_000,
      },
    );
    const consumed = await tile("consumed");
    await waitFor(() => expect(consumed.textContent).toContain("not observed"));
    expect(consumed.textContent).toContain("API-equivalent estimate: not observed");
    expect(consumed.textContent).not.toMatch(/(^|[^\d.])0(?![\d.])/);
    expect(consumed.textContent).not.toContain("$0");
  });

  it("gives a failed run no success tone", async () => {
    await mount("failed");
    await tile("delivered");
    const overview = screen.getByTestId("overview");
    expect(overview.querySelector('[data-tone="success"]')).toBeNull();
    expect(overview.innerHTML).not.toMatch(/text-status-success/);
    expect((await tile("delivered")).textContent).toContain("0 of 1");
    expect(
      screen.getByRole("group", { name: "Engine status" }).querySelector('[data-tone="danger"]'),
    ).toBeTruthy();
  });

  it("shows the live indicator and a stale cue for a report older than three polls", async () => {
    await mount("running");
    await screen.findByTestId("stale");
    expect(screen.getByTestId("stale").textContent).toContain("Stale");
    expect(screen.getByText("live")).toBeTruthy();
  });

  it("shows an alert with a retry when the report cannot be built", async () => {
    await mount("error");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not build the overview");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("the timeline and the bars", () => {
  it("names the nodes and total elapsed and lists every interval with blockers as text", async () => {
    const { served, seeded } = await mount("complete");
    const report = await gatherReport(served, seeded.scope);
    const chart = await screen.findByRole("img", { name: /^Timeline of 5 nodes/ });
    expect(chart.getAttribute("aria-label")).toContain("Total elapsed 1h 35m");
    expect(chart.getAttribute("aria-label")).toContain("program root");
    await userEvent.click(screen.getByRole("button", { name: "Show as text" }));
    const table = await screen.findByTestId("timeline-text");
    const body = within(table).getAllByRole("row").slice(1);
    expect(body).toHaveLength(report.operations.operations.length);
    expect(within(table).getAllByText(/^job /).length).toBeGreaterThan(0);
    expect(table.textContent).toContain("parent_slot");
    const phases = new Set(report.operations.operations.map((op) => op.phase));
    for (const phase of phases) expect(within(table).getAllByText(phase).length).toBeGreaterThan(0);
  });

  it("draws open intervals to the as-of time in a running run", async () => {
    await mount("running");
    await userEvent.click(await screen.findByRole("button", { name: "Show as text" }));
    expect(
      within(await screen.findByTestId("timeline-text")).getAllByText("still open").length,
    ).toBeGreaterThan(0);
  });

  it("states each bar and a total in text, and keeps tokens off the dollar scale", async () => {
    await mount("complete");
    const roles = await screen.findByRole("region", { name: "Tokens by role" });
    await waitFor(() => expect(within(roles).getAllByRole("button").length).toBeGreaterThan(1));
    expect(within(roles).getByTestId("bar-total").textContent).toMatch(/^Total: [\d,]+ tokens/);
    await userEvent.click(within(roles).getByRole("button", { name: /Show as text/ }));
    const table = within(roles).getByRole("table");
    expect(within(table).getByText("Total")).toBeTruthy();
    expect(within(table).getAllByRole("row").length).toBeGreaterThanOrEqual(3);
    const models = screen.getByRole("region", { name: "Tokens by model" });
    expect(within(models).getByTestId("bar-total").textContent).toContain("tokens");
    const rework = screen.getByRole("region", { name: "Rework by cause" });
    expect(within(rework).getByTestId("bar-total").textContent).toContain("3 rework attempts");
    expect(
      within(rework).getByRole("button", { name: /examination findings: 1 attempt/ }),
    ).toBeTruthy();
    expect(screen.getByTestId("overview").textContent).not.toMatch(/\$[\d.]+ tokens|tokens \$/);
  });
});

describe("the evidence sheet", () => {
  it("opens from a tile with the definition, denominator, sample size and partial coverage wording", async () => {
    await mount("complete");
    await userEvent.click(await tile("consumed"));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(METRIC_DEFINITIONS.tokens_input.definition)).toBeTruthy();
    expect(within(sheet).getAllByText(/Denominator and coverage:/).length).toBeGreaterThan(1);
    expect(sheet.textContent).toMatch(/Sample size: \d+ attempts/);
    expect(sheet.textContent).toMatch(/of \d+ attempts valued/);
    expect(sheet.textContent).toContain("Machine estimate:");
    expect(within(sheet).getAllByRole("button", { name: /request ledger/ }).length).toBeGreaterThan(
      0,
    );
  });

  it("leads from a tile to a node's sheet on the Work tab", async () => {
    await mount("complete");
    await userEvent.click(await tile("delivered"));
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText(METRIC_DEFINITIONS.first_attempt_success.definition),
    ).toBeTruthy();
    expect(sheet.textContent).toContain("Sample size: 4 settled jobs");
    const attempts = within(sheet).getByRole("region", { name: "Attempts" });
    await userEvent.click(within(attempts).getAllByRole("link")[0] as HTMLElement);
    // The Work tab's node sheet is now the only dialog; the definition sheet went with the Overview.
    await waitFor(() => expect(screen.queryByText(/Denominator and coverage/)).toBeNull());
    const node = await screen.findByRole("dialog");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(node.textContent).toMatch(/[0-9]{8}/);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true"),
    );
  });

  it("leads from the review tile to a decision page", async () => {
    await mount("complete");
    await userEvent.click(await tile("review"));
    const sheet = await screen.findByRole("dialog");
    const findings = within(sheet).getByRole("region", { name: "Findings" });
    await userEvent.click(
      within(findings).getAllByRole("link", { name: /^decision / })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(
        screen.getAllByText(/What it had to do|Record the reversal|Around it/).length,
      ).toBeGreaterThan(0),
    );
  });

  it("opens from a timeline segment and a bar", async () => {
    await mount("complete");
    await userEvent.click(
      (
        await screen.findAllByRole("button", { name: /: wait, .*waiting on job/ })
      )[0] as HTMLElement,
    );
    let sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(METRIC_DEFINITIONS.wait_time.definition)).toBeTruthy();
    expect(sheet.textContent).toContain("Blockers: job");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const roles = screen.getByRole("region", { name: "Tokens by role" });
    await userEvent.click(
      within(roles).getAllByRole("button", { name: /tokens$/ })[0] as HTMLElement,
    );
    sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(METRIC_DEFINITIONS.tokens_output.definition)).toBeTruthy();
  });
});

describe("a live run", () => {
  it("keeps the open sheet, the selection and the filter across polling invalidations", async () => {
    const { served, seeded } = await mount("running", 25);
    await userEvent.click(await tile("consumed"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(await screen.findByRole("button", { name: /^Attempts/ }));
    const select = (await screen.findByLabelText("Role")) as HTMLSelectElement;
    const role = (Array.from(select.options).find((o) => o.value !== "") as HTMLOptionElement)
      .value;
    await userEvent.selectOptions(select, role);
    const sample = screen.getByTestId("attempt-sample").textContent;
    expect(sample).toMatch(/Showing \d+ of \d+ attempts/);

    const segment = (await screen.findByRole("region", { name: "Tokens by role" })).querySelector(
      "li button",
    ) as HTMLElement;
    const segmentKey = segment.getAttribute("aria-label");
    await userEvent.click(segment);
    const dialog = await screen.findByRole("dialog");
    const selectedSegment = () =>
      Array.from(document.querySelectorAll("li button[aria-pressed='true']")).map((b) =>
        b.getAttribute("aria-label"),
      );
    expect(selectedSegment()).toEqual([segmentKey]);
    const before = screen.getAllByTestId("as-of")[0]?.textContent;

    await served.events.append(
      makeEvent(
        { scope: seeded.scope, ids: createCountingIdGenerator(5000) } as never,
        {
          ...seeded.scope,
          sequence: 9999,
          type: "run.started",
          idempotencyKey: "live-test",
          occurredAt: "2026-09-28T11:45:00.000Z",
          recordedAt: "2026-09-28T11:45:00.000Z",
        } as never,
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId("as-of")[0]?.textContent).not.toBe(before), {
      timeout: 3000,
    });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(selectedSegment()).toEqual([segmentKey]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector("[data-testid='attempt-sample']")?.textContent).toBe(sample);
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe(role);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
