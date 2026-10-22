/**
 * The Studio's read path over the SC-12 history (P20, criterion 10): the committed
 * fixture of records the engine-driven story left (test/src/execution/sc12-history.test.ts)
 * is loaded through the contract schemas, seeded into the memory stores and read through
 * the Overview. Every figure asserted here is a literal copied from that test, with the
 * assertion it comes from named beside it; none is recomputed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CompletionHistorySchema,
  ExaminationSchema,
  ExecutionNodeSchema,
  MeasurementSummarySchema,
  ProgramContractSchema,
  RoutingDecisionSchema,
  RunFeedbackSchema,
  RunSchema,
  VerificationSchema,
} from "@nightshift/contracts";
import { makeProject } from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mountStudio } from "../../../test-support.js";

const FIXTURE = resolve(
  import.meta.dirname,
  "../../../../../../test/fixtures/sc12-history/records.json",
);

const records = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown[]>;

const parsed = {
  programs: records.programs?.map((r) => ProgramContractSchema.parse(r)) ?? [],
  runs: records.runs?.map((r) => RunSchema.parse(r)) ?? [],
  executionNodes: records.executionNodes?.map((r) => ExecutionNodeSchema.parse(r)) ?? [],
  routingDecisions: records.routingDecisions?.map((r) => RoutingDecisionSchema.parse(r)) ?? [],
  measurements: records.measurements?.map((r) => MeasurementSummarySchema.parse(r)) ?? [],
  feedback: records.feedback?.map((r) => RunFeedbackSchema.parse(r)) ?? [],
  completionHistories:
    records.completionHistories?.map((r) => CompletionHistorySchema.parse(r)) ?? [],
  verifications: records.verifications?.map((r) => VerificationSchema.parse(r)) ?? [],
  examinations: records.examinations?.map((r) => ExaminationSchema.parse(r)) ?? [],
};

const history = parsed.completionHistories[0];
if (history === undefined) throw new Error("the fixture has no completion history");
const anchor = history.members.find((m) => m.role === "anchor");
if (anchor === undefined) throw new Error("the fixture's history has no anchor");
const { projectId } = history;

/** Feedback and histories are stored one version at a time: replay each, ending on the stored one. */
const replay = async (
  records: readonly { revisions: readonly { version: number }[] }[],
  put: (record: never) => Promise<void>,
  partial: (record: never, version: number) => unknown,
): Promise<void> => {
  for (const record of records) {
    for (const revision of record.revisions.slice(0, -1)) {
      await put(partial(record as never, revision.version) as never);
    }
    await put(record as never);
  }
};

const mount = async (
  query = "",
  artifacts?: { downloadUrl: (...args: never[]) => Promise<string> },
) =>
  mountStudio(
    async (stores, f, orgId) => {
      // The fixture's own project, owned by this mount's organization.
      await stores.projects.put(makeProject(f, { projectId, orgId, name: "sc12" } as never));
      for (const p of parsed.programs) await stores.programContracts.put(p);
      for (const r of parsed.runs) await stores.runs.put(r);
      for (const n of parsed.executionNodes) await stores.executionNodes.put(n);
      for (const r of parsed.routingDecisions) await stores.routingDecisions.put(r);
      for (const m of parsed.measurements) await stores.measurements.put(m);
      for (const v of parsed.verifications) await stores.verifications.put(v);
      for (const x of parsed.examinations) await stores.examinations.put(x);
      await replay(
        parsed.feedback,
        (r) => stores.feedback.put(r),
        (fb: (typeof parsed.feedback)[number], version) => ({
          ...fb,
          ...fb.revisions[version - 1],
          revisions: fb.revisions.slice(0, version),
        }),
      );
      await replay(
        parsed.completionHistories,
        (r) => stores.completionHistories.put(r),
        (h: (typeof parsed.completionHistories)[number], version) => ({
          ...h,
          version,
          checkpoints: [],
          revisions: h.revisions.slice(0, version),
        }),
      );
    },
    {
      at: `/projects/${projectId}/programs/${anchor.programId}/runs/${anchor.runId}${query}`,
      pollMs: 60_000,
      ...(artifacts === undefined ? {} : { artifacts: artifacts as never }),
    },
  );

const runTile = async (id: string): Promise<HTMLElement> => {
  const group = await screen.findByRole("group", { name: "Headline summaries for this run" });
  const found = group.querySelector(`[data-tile="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${id} tile`);
  return found;
};

const historyTile = async (id: string): Promise<HTMLElement> => {
  const group = await screen.findByRole("group", {
    name: "Headline summaries for this completion history",
  });
  const found = group.querySelector(`[data-history-tile="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${id} history tile`);
  return found;
};

describe("the SC-12 history in the Studio", () => {
  it("loads the committed fixture through the contract schemas", () => {
    expect(
      Object.fromEntries(Object.entries(parsed).map(([name, items]) => [name, items.length])),
    ).toEqual({
      // "keeps the committed fixture of the records it left"
      programs: 2,
      runs: 3,
      executionNodes: 9,
      routingDecisions: 11,
      measurements: 11,
      feedback: 2,
      completionHistories: 1,
      verifications: 8,
      examinations: 2,
    });
  });

  it("reads program A's first run: delivered, consumed, rework and findings", async () => {
    const downloadUrl = vi.fn(async () => "https://signed.example/never");
    await mount("", { downloadUrl });

    // "runs two jobs at once, and reworks the three that did not land first time":
    // delivery.firstAttempt succeeded 1 of denominator 4; 4 landed; rework.attempts 3.
    const delivered = await runTile("delivered");
    await waitFor(() => expect(delivered.textContent).toContain("1 of 4"));
    expect(delivered.textContent).toContain("1 of 4 settled jobs");
    expect(delivered.textContent).toContain("4 landed");

    // "measures each attempt: ...": run 1 is 73,000 in and 14,400 out (RUN1), the API-equivalent
    // estimate 0.425 (budget.usd); the usage rows' estimate is the sum of the 7 + 2 valued attempts.
    const consumed = await runTile("consumed");
    await waitFor(() => expect(consumed.textContent).toContain("73K"));
    expect(consumed.textContent).toContain("73Kinput tokens (incl. cache)");
    expect(consumed.textContent).toContain("14Koutput tokens");
    expect(consumed.textContent).toContain("API-equivalent estimate: $0.4250");

    const roles = await screen.findByRole("region", { name: "Tokens by role" });
    await waitFor(() =>
      expect(within(roles).getByTestId("bar-total").textContent).toContain("87,400 tokens"),
    );

    // "runs two jobs at once ...": rework byCause examination_findings 1, integration_conflict 1,
    // verification_failed 1 (rework.attempts 3).
    const rework = await screen.findByRole("region", { name: "Rework by cause" });
    expect(within(rework).getByTestId("bar-total").textContent).toContain("3 rework attempts");
    expect(
      within(rework).getByRole("button", { name: /^examination findings: 1 attempt$/ }),
    ).toBeTruthy();
    expect(
      within(rework).getByRole("button", { name: /^integration conflict: 1 attempt$/ }),
    ).toBeTruthy();
    expect(
      within(rework).getByRole("button", { name: /^verification failed: 1 attempt$/ }),
    ).toBeTruthy();

    // "runs two jobs at once ...": review.findings has length 1, latest "fixed".
    const review = await runTile("review");
    expect(review.textContent).toContain("3 rework attempts");
    expect(review.textContent).toContain("1 unique — 1 fixed");

    // The evidence sheet from the Consumed tile: this fixture's measurements carry request-ledger
    // artifact ids, listed as links; opening the sheet never asks for a download URL.
    await userEvent.click(consumed);
    const sheet = await screen.findByRole("dialog");
    const evidence = within(sheet).getByRole("region", { name: "Request evidence" });
    const ledgerIds = parsed.measurements
      .filter((m) => m.runId === anchor.runId)
      .flatMap((m) => m.ledger.artifactIds);
    if (ledgerIds.length === 0) {
      expect(evidence.textContent).toMatch(/none/i);
    } else {
      expect(within(evidence).getAllByRole("button", { name: /^request ledger \d+$/ }).length).toBe(
        ledgerIds.length,
      );
    }
    expect(downloadUrl).not.toHaveBeenCalled();
  });

  it("reads the history: members, rating, estimate label and the final effective verdict", async () => {
    const downloadUrl = vi.fn(async () => "https://signed.example/never");
    await mount(`?scope=history:${history.completionHistoryId}`, { downloadUrl });
    await waitFor(() =>
      expect(screen.getByTestId("scope-label").textContent).toBe(
        "Completion history: Ordered modules",
      ),
    );

    // "names each member's program and run ...": anchor, contributing (the failed run) and the
    // correction in program B; verdicts from "reads the same history through the rendered
    // report, the export and the CLI": anchor did_not_work, contributing not_rated, correction worked.
    const members = await screen.findByRole("table", { name: /member/i });
    const rows = within(members)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell"));
    expect(
      rows.map((cells) => [cells[0]?.textContent, cells[1]?.textContent, cells[3]?.textContent]),
    ).toEqual(
      history.members.map((member, index) => [
        member.role,
        `run ${member.runId.slice(-8)} in ${member.programId}${index === 0 ? " (this run)" : ""}`,
        ["Did not work", "Not rated", "Worked"][index],
      ]),
    );
    expect(new Set(history.members.map((m) => m.programId)).size).toBe(2);

    // "keeps one effective verdict per run ...": completion coverage eligible 3, rated 2,
    // positive 1, negative 1, unrated 1.
    const rating = await historyTile("rating");
    expect(rating.textContent).toContain("2 of 3 rated");
    expect(rating.textContent).toContain("Worked: 1 of 2 rated");
    expect(rating.textContent).toContain("Did not work: 1 of 2 rated");
    expect(rating.textContent).toContain("Not rated: 1 of 3 eligible");

    // "counts every attempt once across the history ...": tokens input 80,000, output 15,800.
    const consumed = await historyTile("consumed");
    expect(consumed.textContent).toContain("80Kinput tokens (incl. cache)");
    expect(consumed.textContent).toContain("16Koutput tokens");
    expect(consumed.textContent).toContain("measured 3 of 3 members");
    // "reads the same history ...": `completion show` prints "combined API-equivalent estimate
    // lower bound $0.4670" because the three root launches are unmeasured (D-02); the Studio says
    // the same, with the same figure.
    expect(consumed.textContent).toContain("Model API-equivalent estimate: $0.4670");
    expect(consumed.textContent).toContain("Combined estimate: $0.4670 · lower bound");
    expect(consumed.textContent).not.toContain("every member measured");

    // "keeps one effective verdict per run ...": the run was rated, cleared and rated again, and
    // the control shows the final effective verdict (revision 3, did_not_work).
    const human = screen.getByRole("group", { name: "Human acceptance (this run only)" });
    await waitFor(() =>
      expect(
        within(human).getByRole("button", { name: "Did not work" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(within(human).getByRole("button", { name: "Worked" }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    // The history's evidence sheet lists no request ledgers and never fetches a download URL.
    await userEvent.click(consumed);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(downloadUrl).not.toHaveBeenCalled();
  });
  it("reads history-wide delivery, rework, review and bottlenecks, matching the per-member rows", async () => {
    await mount(`?scope=history:${history.completionHistoryId}`);
    await waitFor(() =>
      expect(screen.getByTestId("scope-label").textContent).toBe(
        "Completion history: Ordered modules",
      ),
    );
    // No run-scope tile stays beside the history's.
    expect(screen.queryByRole("group", { name: "Headline summaries for this run" })).toBeNull();

    // "reads history-wide delivery, rework, review and bottlenecks the same through the report,
    // the export and the CLI": delivery succeededFirstAttempt 2 of denominator 6, unfinished 0,
    // carriedFromOutside 0, coverage 3 of 3 members.
    const delivered = await historyTile("delivered");
    expect(delivered.textContent).toContain("2 of 6");
    expect(delivered.textContent).toContain("2 of 6 unique work items");
    expect(delivered.textContent).toContain("Unfinished: 0 work items");
    expect(delivered.textContent).toContain("across 3 of 3 member runs");
    expect(delivered.textContent).not.toContain("Carried from outside");

    // Same assertion: rework attempts 3, byCause examination_findings 1, integration_conflict 1,
    // verification_failed 1; review dispositions upheld 0, overturned 0, risk_accepted 0 and
    // uniqueFindings 1.
    const repair = await historyTile("review");
    expect(repair.textContent).toContain("3 rework attempts");
    expect(repair.textContent).toContain("examination findings 1");
    expect(repair.textContent).toContain("integration conflict 1");
    expect(repair.textContent).toContain("verification failed 1");
    expect(repair.textContent).toContain("upheld 0, overturned 0, risk accepted 0");
    expect(repair.textContent).toContain("1 unique");
    expect(repair.textContent).toContain("across 3 of 3 member runs");

    const bars = await screen.findByRole("region", { name: "Rework by cause" });
    expect(
      within(bars).getByRole("button", { name: /^examination findings: 1 attempt$/ }),
    ).toBeTruthy();
    expect(
      within(bars).getByRole("button", { name: /^integration conflict: 1 attempt$/ }),
    ).toBeTruthy();
    expect(
      within(bars).getByRole("button", { name: /^verification failed: 1 attempt$/ }),
    ).toBeTruthy();
    expect(within(bars).getByTestId("bar-total").textContent).toContain("3 rework attempts");

    // Same assertion: operations.members elapsedMs 1_800_000 / 1_200_000 / 600_000. The committed
    // fixture holds no lifecycle events, so the summed integration 45_000 and work 405_000 of that
    // assertion cannot be rebuilt from it: the Studio says "not observed" for them, never 0.
    const table = await screen.findByRole("table", {
      name: "Elapsed and summed bottleneck time by run",
    });
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      );
    expect(rows.map((cells) => cells.slice(1))).toEqual([
      ["30m", "not observed", "not observed", "not observed", "not observed"],
      ["20m", "not observed", "not observed", "not observed", "not observed"],
      ["10m", "not observed", "not observed", "not observed", "not observed"],
      ["not summed", "not observed", "not observed", "not observed", "not observed"],
    ]);
    const text = screen.getByTestId("history-time-text").textContent ?? "";
    expect(text).toContain("integration not observed");
    expect(text).toContain("not elapsed");

    // Same assertion, `completion?.members.map((m) => m.summary)`: each member's own row is
    // 1 of 4 / 0 of 1 / 1 of 1 first attempts, 3 / 0 / 0 rework attempts, 1 / 0 / 0 findings;
    // the history-wide 2 of 6 and 3 and 1 are their sums.
    await userEvent.click(delivered);
    let sheet = await screen.findByRole("dialog");
    const memberRows = within(within(sheet).getByRole("region", { name: "Member runs" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(memberRows).toHaveLength(3);
    expect(memberRows[0]).toContain("succeeded 1 of 4 settled");
    expect(memberRows[1]).toContain("succeeded 0 of 1 settled");
    expect(memberRows[2]).toContain("succeeded 1 of 1 settled");
    expect(sheet.textContent).toContain("counted once across the member runs");
    expect(within(sheet).getByRole("region", { name: "Coverage" }).textContent).toContain(
      "across 3 of 3 member runs",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(await historyTile("review"));
    sheet = await screen.findByRole("dialog");
    const reviewRows = within(within(sheet).getByRole("region", { name: "Member runs" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(reviewRows[0]).toContain("3 rework attempts, 1 unique finding");
    expect(reviewRows[1]).toContain("0 rework attempts, 0 unique findings");
    expect(reviewRows[2]).toContain("0 rework attempts, 0 unique findings");
  });
});
