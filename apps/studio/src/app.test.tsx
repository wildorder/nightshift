/**
 * The shell and the projects page over the memory stores (D-P11-07): the same
 * tree `main.tsx` mounts, with no browser session and no network.
 */
import { makeProject } from "@nightshift/core";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio as mount } from "./test-support.js";

describe("the Studio's shell", () => {
  it("shows who is signed in, lists their projects, and signs out", async () => {
    const { signedOut } = await mount(async (stores, f, orgId) => {
      await stores.projects.put(
        makeProject(f, { orgId, name: "keyart", description: "The trial" }),
      );
      await stores.projects.put(
        makeProject(f, { orgId, name: "foodfly", projectId: f.ids.next("proj") }),
      );
    });
    expect(screen.getByText("tim@example.test")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "keyart" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "foodfly" })).toBeTruthy();
    expect(screen.getByText("The trial")).toBeTruthy();
    // The switcher lists the same projects (P13: a menu in the sidebar, D-P13-05).
    await userEvent.click(screen.getByRole("button", { name: "Switch project" }));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("keyart");
    expect(menu.textContent).toContain("foodfly");
    await userEvent.keyboard("{Escape}");
    // Sign-out is in the account menu.
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Sign out/ }));
    expect(signedOut).toEqual([true]);
  });

  it("says so when there are no projects", async () => {
    await mount(async () => {});
    await waitFor(() => expect(screen.getByText(/No projects yet/)).toBeTruthy());
  });
});
