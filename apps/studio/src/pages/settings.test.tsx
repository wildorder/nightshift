import { DEFAULT_COMPUTE_CEILINGS, defaultOrgConfig } from "@nightshift/contracts";
import { makeProject } from "@nightshift/core";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio } from "../test-support.js";

describe("organisation settings", () => {
  it("edits the examination policy and a role's list, and saves as the next version", async () => {
    const { stores, orgId } = await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 0/)).toBeTruthy());

    await userEvent.click(screen.getByLabelText("low required"));
    // The implementer's first choice becomes Fable, and Astra moves to the top of the examiner's list.
    await userEvent.selectOptions(
      screen.getByLabelText("Implementer choice 1"),
      "claude-fable-5-1",
    );
    await userEvent.click(screen.getByLabelText("Move Examiner choice 2 up"));
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    const stored = await stores.orgConfigs.get(orgId);
    expect(stored?.version).toBe(1);
    expect(stored?.examinationPolicy.low.required).toBe(true);
    expect(stored?.routingPolicy.roles.implementer[0]).toEqual({
      harness: "claude",
      model: "claude-fable-5-1",
    });
    expect(stored?.routingPolicy.roles.examiner.slice(0, 2).map((route) => route.model)).toEqual([
      "claude-opus-5-5",
      "gpt-6-astra",
    ]);
    await waitFor(() => expect(screen.getByText(/configuration version 1/)).toBeTruthy());
  });

  it("refuses a save over a newer version and says so", async () => {
    const { stores, orgId } = await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 0/)).toBeTruthy());
    // Somebody else writes version 1 after the page read version 0.
    await stores.orgConfigs.put({
      ...defaultOrgConfig(orgId, "2026-09-28T00:00:00.000Z"),
      version: 1,
    });

    await userEvent.click(screen.getByLabelText("high required"));
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/changed since you read it/),
    );
    expect((await stores.orgConfigs.get(orgId))?.examinationPolicy.high.required).toBe(true);
    expect((await stores.orgConfigs.get(orgId))?.version).toBe(1);
  });

  it("shows why a draft cannot be saved", async () => {
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 0/)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Add a model to Orchestrator" }));
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Orchestrator has a row with no model/),
    );
  });

  it("shows the compute ceilings, the shipped defaults until the org sets its own, and saves them", async () => {
    const { stores, orgId } = await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 0/)).toBeTruthy());
    expect(screen.getByText(/the shipped defaults apply/)).toBeTruthy();
    const machines = screen.getByLabelText("Machines at once") as HTMLInputElement;
    expect(machines.value).toBe("2");

    await userEvent.clear(machines);
    await userEvent.type(machines, "4");
    await userEvent.selectOptions(screen.getByLabelText("Largest machine"), "better");
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect((await stores.orgConfigs.get(orgId))?.compute).toEqual({
      ...DEFAULT_COMPUTE_CEILINGS,
      maxConcurrentRuns: 4,
      maxTier: "better",
    });
  });

  it("keeps the org's ceilings through a save that changes something else, and leaves defaults unset", async () => {
    const compute = { ...DEFAULT_COMPUTE_CEILINGS, maxConcurrentRuns: 5 };
    const { stores, orgId } = await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
      await stores.orgConfigs.put({
        ...defaultOrgConfig(orgId, "2026-10-28T00:00:00.000Z"),
        compute,
        version: 1,
      });
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 1/)).toBeTruthy());
    await userEvent.click(screen.getByLabelText("low required"));
    await userEvent.click(screen.getByRole("button", { name: /Save as version 2/ }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect((await stores.orgConfigs.get(orgId))?.compute).toEqual(compute);
  });

  it("says which compute field cannot be saved", async () => {
    await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 0/)).toBeTruthy());
    // The browser refuses a number below its minimum itself; an empty field reaches the page.
    await userEvent.clear(screen.getByLabelText("Machines at once"));
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /Machines at once must be a whole number of at least 1/,
      ),
    );
  });
});
