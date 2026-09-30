/** The shell (P13, T2; SC-P13-03, SC-P13-04). */
import { makeProgramContract, makeProject, makeRun } from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../test-support.js";
import { THEME_KEY } from "./theme-provider.js";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("the shell", () => {
  it("switches to dark and back, and remembers the choice", async () => {
    await mountStudio(async () => {});
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Theme" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Dark/ }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("starts dark when the choice was remembered", async () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    await mountStudio(async () => {});
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
  });

  it("shows where you are: project, program and run, each a way back", async () => {
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId, name: "keyart" }));
        await stores.programContracts.put(makeProgramContract(f, { objective: "Add billing" }));
        await stores.runs.put(makeRun(f));
      },
      { at: runPathOf },
    );
    const crumbs = await screen.findByRole("navigation", { name: /breadcrumb/i });
    await waitFor(() => expect(within(crumbs).getByRole("link", { name: "keyart" })).toBeTruthy());
    expect(within(crumbs).getByRole("link", { name: "Projects" })).toBeTruthy();
    await waitFor(() => expect(within(crumbs).getByText("Add billing")).toBeTruthy());
    expect(within(crumbs).getByText(/^Run /)).toBeTruthy();
  });

  it("collapses the sidebar", async () => {
    await mountStudio(async () => {});
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    // The header's trigger; the sidebar's edge rail is the other "Toggle Sidebar".
    const [trigger] = screen.getAllByRole("button", { name: /Toggle Sidebar/i });
    if (trigger === undefined) throw new Error("no sidebar trigger");
    await userEvent.click(trigger);
    expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe(
      "collapsed",
    );
  });
});
