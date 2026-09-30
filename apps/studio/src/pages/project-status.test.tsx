/** A program's card shows its latest run's status; the runs table filters (P13; SC-P13-06, SC-P13-10). */
import { makeProgramContract, makeProject, makeRootNode, makeRun } from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio } from "../test-support.js";

const P = "proj_00000000000000000000000001";

describe("the project page's program status", () => {
  it("puts the latest run's status on the program's card, with what waits on you", async () => {
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: P as never, name: "keyart" }));
      await stores.programContracts.put(
        makeProgramContract(f, {
          projectId: P as never,
          objective: "Add billing",
          costPolicy: { maxUsd: 25 },
          status: "ratified",
          planHash: "c".repeat(64),
          planDocument: { uri: "s3://b/x", sha256: "b".repeat(64), sizeBytes: 1 },
          strands: [
            {
              id: "S-01",
              name: "The store",
              scope: { summary: "s", includes: ["src/**"], excludes: [] },
              acceptance: ["It works"],
              successCriteria: ["SC-01"],
              dependsOn: [],
              prerequisites: ["HP-01"],
            },
          ],
          prerequisites: [
            {
              id: "HP-01",
              description: "The deploy key is in the store",
              remediation: "gh secret set KEY",
              verifyCommand: "true",
              status: "pending",
            },
          ],
          ratifications: [
            {
              planHash: "c".repeat(64),
              planDocument: { uri: "s3://b/x", sha256: "b".repeat(64), sizeBytes: 1 },
              ratifiedAt: "2026-09-28T10:00:00.000Z",
            },
          ],
        }),
      );
      await stores.runs.put(makeRun(f, { projectId: P as never, status: "running" }));
      await stores.executionNodes.put(makeRootNode(f, { projectId: P as never }));
    }, `/projects/${P}`);
    const status = await screen.findByTestId("program-status");
    await waitFor(() => expect(status.textContent).toContain("waiting on you"));
    expect(within(status).getByText("HP-01")).toBeTruthy();
    expect(status.textContent).toContain("The deploy key is in the store");
    expect(status.textContent).toContain("of $25");
    expect(screen.getByRole("link", { name: /Open run/ })).toBeTruthy();
  });

  it("filters the runs table by status", async () => {
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: P as never }));
      await stores.programContracts.put(makeProgramContract(f, { projectId: P as never }));
      await stores.runs.put(
        makeRun(f, { projectId: P as never, runId: f.ids.next("run"), status: "succeeded" }),
      );
      await stores.runs.put(
        makeRun(f, { projectId: P as never, runId: f.ids.next("run"), status: "failed" }),
      );
    }, `/projects/${P}`);
    const table = await screen.findByRole("table", { name: "Runs" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    await userEvent.click(screen.getByRole("combobox", { name: "Filter by status" }));
    await userEvent.click(await screen.findByRole("option", { name: "failed" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("failed");
  });
});
