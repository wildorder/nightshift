import { defaultOrgConfig } from "@nightshift/contracts";
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
});
