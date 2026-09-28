import { defaultOrgConfig } from "@nightshift/contracts";
import { makeProject } from "@nightshift/core";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio } from "../test-support.js";

describe("organisation settings", () => {
  it("edits the examination policy and a ladder, and saves as the next version", async () => {
    const { stores, orgId } = await mountStudio(async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
    }, "/settings");
    await waitFor(() => expect(screen.getByText(/configuration version 0/)).toBeTruthy());

    await userEvent.click(screen.getByLabelText("low required"));
    const model = screen.getAllByLabelText("model")[0];
    if (model === undefined) throw new Error("no route row");
    await userEvent.clear(model);
    await userEvent.type(model, "claude-haiku-next");
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    const stored = await stores.orgConfigs.get(orgId);
    expect(stored?.version).toBe(1);
    expect(stored?.examinationPolicy.low.required).toBe(true);
    expect(stored?.routingPolicy.ladders.claude?.[0]?.routes[0]?.model).toBe("claude-haiku-next");
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
    const rules = screen.getByLabelText("Rules");
    await userEvent.clear(rules);
    await userEvent.type(rules, "[[]");
    await userEvent.click(screen.getByRole("button", { name: /Save as version 1/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/routing policy/));
  });
});
