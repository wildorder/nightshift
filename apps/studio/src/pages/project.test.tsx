import {
  makePlanDraft,
  makePlanDraftVersion,
  makeProgramContract,
  makeProject,
  makeRun,
} from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio } from "../test-support.js";

const PROJECT_ID = "proj_00000000000000000000000001";

describe("the project page", () => {
  it("lists programs with their plan state and every run across them, latest first", async () => {
    const { stores } = await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: PROJECT_ID, name: "keyart" }));
      const a = makeProgramContract(f, { projectId: PROJECT_ID, objective: "Program A" });
      const b = makeProgramContract(f, {
        projectId: PROJECT_ID,
        programId: f.ids.next("prog"),
        objective: "Program B (planned)",
        status: "ratified",
        planHash: "c".repeat(64),
        planDocument: { uri: "s3://b/plans/x", sha256: "b".repeat(64), sizeBytes: 10 },
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
            description: "A key in the store",
            remediation: "gh secret set KEY",
            verifyCommand: "gh secret list | grep KEY",
            status: "pending",
          },
        ],
        ratifications: [
          {
            planHash: "a".repeat(64),
            planDocument: { uri: "s3://b/plans/x", sha256: "b".repeat(64), sizeBytes: 10 },
            ratifiedAt: "2026-09-27T10:00:00.000Z",
          },
        ],
      });
      await stores.programContracts.put(a);
      await stores.programContracts.put(b);
      await stores.runs.put(
        makeRun(f, {
          projectId: PROJECT_ID,
          programId: a.programId,
          runId: f.ids.next("run"),
          status: "succeeded",
          startedAt: "2026-09-27T09:00:00.000Z",
          endedAt: "2026-09-27T09:10:00.000Z",
        }),
      );
      await stores.runs.put(
        makeRun(f, {
          projectId: PROJECT_ID,
          programId: b.programId,
          runId: f.ids.next("run"),
          status: "failed",
          startedAt: "2026-09-27T12:00:00.000Z",
          outcomeReason: "a strand was parked",
        }),
      );
    }, `/projects/${PROJECT_ID}`);

    await waitFor(() => expect(screen.getByRole("heading", { name: "keyart" })).toBeTruthy());
    const rows = within(screen.getByRole("list", { name: "Programs" })).getAllByTestId(
      "program-row",
    );
    expect(rows).toHaveLength(2);
    // The most recently active first; each row slim, its objective beneath.
    expect(rows[0]?.textContent).toContain("Program B (planned)");
    expect(rows[0]?.textContent).toContain("failed");
    expect(rows[0]?.textContent).toContain("1 prerequisite pending");
    expect(rows[0]?.textContent).toMatch(/last run Sep 27, .*ago/);
    expect(rows[0]?.textContent).not.toContain("2026-09-27T");
    expect(rows[1]?.textContent).toContain("Program A");
    expect(rows[1]?.textContent).toContain("succeeded");
    // A program's runs are under it, shown when it is opened.
    expect(screen.queryByRole("list", { name: "Runs" })).toBeNull();
    await userEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: /1 run/ }));
    expect(
      within(rows[0] as HTMLElement).getByRole("list", { name: "Runs" }).textContent,
    ).toContain("a strand was parked");
    await userEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: /1 run/ }));
    expect(
      within(rows[1] as HTMLElement).getByRole("list", { name: "Runs" }).textContent,
    ).toContain("took 10.0 min");

    // Editing the name writes the project back.
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "keyart (renamed)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "keyart (renamed)" })).toBeTruthy(),
    );
    expect((await stores.projects.get(PROJECT_ID as never))?.name).toBe("keyart (renamed)");
  });

  it("shows the contract's policies and a run's effective policy, read-only", async () => {
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: PROJECT_ID, name: "keyart" }));
      const a = makeProgramContract(f, { projectId: PROJECT_ID, objective: "Program A" });
      await stores.programContracts.put(a);
      await stores.runs.put(
        makeRun(f, {
          projectId: PROJECT_ID,
          runId: f.ids.next("run"),
          policy: {
            routingPolicy: {
              roles: {
                orchestrator: [{ harness: "claude", model: "m" }],
                implementer: [{ harness: "claude", model: "m" }],
                examiner: [{ harness: "claude", model: "m" }],
                arbiter: [{ harness: "claude", model: "m" }],
              },
              unavailable: [],
              prices: {},
            },
            examinationPolicy: a.examinationPolicy,
            orgConfigVersion: 3,
          },
        }),
      );
    }, `/projects/${PROJECT_ID}/settings`);
    await waitFor(() => expect(screen.getByText(/Contract policies/)).toBeTruthy());
    expect(screen.getByLabelText(/policies of prog_/).textContent).toContain('"maxConcurrency": 4');
    expect(screen.getByText(/org config v3/)).toBeTruthy();
  });

  it("links every program to its plan page, and lists drafts with no contract or runs", async () => {
    let contractProgram = "";
    let draftOnly = "";
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: PROJECT_ID, name: "keyart" }));
      const a = makeProgramContract(f, { projectId: PROJECT_ID, objective: "Program A" });
      contractProgram = a.programId;
      await stores.programContracts.put(a);
      draftOnly = f.ids.next("prog");
      const version = makePlanDraftVersion(f, { projectId: PROJECT_ID, programId: draftOnly });
      await stores.planDrafts.appendVersion(version, () =>
        makePlanDraft(f, { projectId: PROJECT_ID, programId: draftOnly, state: "awaiting_owner" }),
      );
    }, `/projects/${PROJECT_ID}`);

    const programs = await screen.findByRole("list", { name: "Programs" });
    const draft = within(programs).getByRole("link", { name: draftOnly });
    expect(draft.getAttribute("href")).toBe(`/projects/${PROJECT_ID}/programs/${draftOnly}/plan`);
    expect(programs.textContent).toContain("awaiting owner");
    expect(within(programs).getByRole("link", { name: contractProgram }).getAttribute("href")).toBe(
      `/projects/${PROJECT_ID}/programs/${contractProgram}/plan`,
    );
  });

  it("names a program by the name it was planned under, and puts the one being built first", async () => {
    let running = "";
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: PROJECT_ID, name: "keyart" }));
      const old = makeProgramContract(f, { projectId: PROJECT_ID, objective: "The old one" });
      const building = makeProgramContract(f, {
        projectId: PROJECT_ID,
        programId: f.ids.next("prog"),
        objective: "The one being built",
      });
      running = building.programId;
      for (const program of [old, building]) await stores.programContracts.put(program);
      const version = makePlanDraftVersion(f, {
        projectId: PROJECT_ID,
        programId: building.programId,
      });
      await stores.planDrafts.appendVersion(version, () =>
        makePlanDraft(f, {
          projectId: PROJECT_ID,
          programId: building.programId,
          state: "ratified",
          name: "p22-the-build",
        }),
      );
      await stores.runs.put(
        makeRun(f, {
          projectId: PROJECT_ID,
          programId: old.programId,
          runId: f.ids.next("run"),
          status: "succeeded",
          startedAt: "2026-10-23T09:00:00.000Z",
          endedAt: "2026-10-23T10:00:00.000Z",
        }),
      );
      await stores.runs.put(
        makeRun(f, {
          projectId: PROJECT_ID,
          programId: building.programId,
          runId: f.ids.next("run"),
          status: "running",
          startedAt: "2026-10-20T09:00:00.000Z",
        }),
      );
    }, `/projects/${PROJECT_ID}`);
    const rows = within(await screen.findByRole("list", { name: "Programs" })).getAllByTestId(
      "program-row",
    );
    expect(rows[0]?.textContent).toContain("p22-the-build");
    expect(rows[0]?.textContent).toContain("running");
    expect(rows[0]?.textContent).not.toContain(running);
    expect(rows[1]?.textContent).toContain("The old one");
  });

  it("has no separate plans or runs sections: both are programs' rows", async () => {
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId, projectId: PROJECT_ID, name: "keyart" }));
    }, `/projects/${PROJECT_ID}`);
    await screen.findByRole("heading", { name: "keyart" });
    expect(screen.queryByRole("heading", { name: "Plans" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Runs" })).toBeNull();
    expect(screen.getByText("No programs yet.")).toBeTruthy();
  });

  it("keeps the page when the draft read fails", async () => {
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId, projectId: PROJECT_ID, name: "keyart" }));
      },
      {
        at: `/projects/${PROJECT_ID}`,
        serve: (stores) => ({
          ...stores,
          planDrafts: {
            ...stores.planDrafts,
            listByProject: async () => {
              throw new Error("drafts down");
            },
          },
        }),
      },
    );
    expect((await screen.findByText(/Could not list plan drafts/)).textContent).toContain(
      "drafts down",
    );
    expect(screen.getByRole("heading", { name: "keyart" })).toBeTruthy();
  });
});
