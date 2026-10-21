/**
 * The one-click run verdict (D-04) over the memory stores.
 */

import type { OrgId } from "@nightshift/contracts";
import type { Fixtures } from "@nightshift/core";
import { makeProgramContract, makeProject, makeRootNode, makeRun } from "@nightshift/core";
import type { InMemoryStores } from "@nightshift/persistence/memory";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../../test-support.js";

const seedRun =
  (status: "succeeded" | "running", before?: (stores: InMemoryStores) => void) =>
  async (stores: InMemoryStores, f: Fixtures, orgId: OrgId) => {
    await stores.projects.put(makeProject(f, { orgId, name: "keyart" }));
    await stores.programContracts.put(makeProgramContract(f, {}));
    await stores.runs.put(
      makeRun(
        f,
        status === "running" ? { status } : { status, endedAt: "2026-09-15T12:30:00.000Z" },
      ),
    );
    await stores.executionNodes.put(makeRootNode(f, { status: "verified" }));
    before?.(stores);
  };

const worked = () => screen.findByRole("button", { name: "Worked" });
const didNot = () => screen.findByRole("button", { name: "Did not work" });

describe("the run verdict", () => {
  it("starts unrated, with both buttons unpressed", async () => {
    await mountStudio(seedRun("succeeded"), { at: runPathOf });
    expect((await worked()).getAttribute("aria-pressed")).toBe("false");
    expect((await didNot()).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Not rated")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Did it work?" })).toBeTruthy();
  });

  it("saves, changes and clears the verdict, keeping every revision", async () => {
    const { stores, f } = await mountStudio(seedRun("succeeded"), { at: runPathOf });
    await userEvent.click(await worked());
    await waitFor(async () => expect((await worked()).getAttribute("aria-pressed")).toBe("true"));
    let record = await stores.feedback.get(f.scope);
    expect(record?.verdict).toBe("worked");
    expect(record?.actor.userId).toBe("u1");
    expect(record?.version).toBe(1);

    await userEvent.click(await didNot());
    await waitFor(async () => expect((await didNot()).getAttribute("aria-pressed")).toBe("true"));
    expect((await worked()).getAttribute("aria-pressed")).toBe("false");
    record = await stores.feedback.get(f.scope);
    expect(record?.verdict).toBe("did_not_work");
    expect(record?.version).toBe(2);
    expect(record?.revisions).toHaveLength(2);

    await userEvent.click(await didNot());
    await waitFor(async () => expect((await didNot()).getAttribute("aria-pressed")).toBe("false"));
    record = await stores.feedback.get(f.scope);
    expect(record?.verdict).toBeNull();
    expect(record?.version).toBe(3);
    expect(record?.revisions).toHaveLength(3);
    expect(screen.getByText("Not rated")).toBeTruthy();
  });

  it("shows an alert and no pressed button when the save fails", async () => {
    const { stores, f } = await mountStudio(
      seedRun("succeeded", (s) => {
        s.feedback.put = async () => {
          throw new Error("store unavailable");
        };
      }),
      { at: runPathOf },
    );
    await userEvent.click(await worked());
    expect((await screen.findByRole("alert")).textContent).toContain("store unavailable");
    expect((await worked()).getAttribute("aria-pressed")).toBe("false");
    expect((await didNot()).getAttribute("aria-pressed")).toBe("false");
    expect(await stores.feedback.get(f.scope)).toBeUndefined();
  });

  it("is not rendered for a running run", async () => {
    await mountStudio(seedRun("running"), { at: runPathOf });
    await screen.findByRole("heading", { name: "Program status" });
    expect(screen.queryByRole("button", { name: "Worked" })).toBeNull();
    expect(screen.queryByText("Did it work?")).toBeNull();
  });

  it("saves from the keyboard", async () => {
    const { stores, f } = await mountStudio(seedRun("succeeded"), { at: runPathOf });
    const button = await worked();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(async () => expect((await stores.feedback.get(f.scope))?.verdict).toBe("worked"));
  });
});
