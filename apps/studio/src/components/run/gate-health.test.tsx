/**
 * An environment fault in the run's gate health (P16 S-02, D-07): each gate
 * with the reference's verdict and output beside the machine's, under both
 * Nodes, gathered from the run's `environment.fault` events.
 */
import {
  makeEvent,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../../test-support.js";

const gateCard = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole("heading", { name: "Gate health" });
  const card = heading.closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error("no Gate health card");
  return card;
};

const fault = {
  baseCommit: "e".repeat(40),
  referenceNode: "24.4.1",
  machineNode: "18.20.4",
};
const unit = {
  id: "unit",
  command: "npm test",
  kind: "check",
  reference: "passed",
  machine: "failed",
  referenceTail: "Tests  12 passed (12)",
  machineTail: "TypeError: fetch is not a function",
};
const lint = {
  id: "lint",
  command: "npm run lint",
  kind: "check",
  reference: "passed",
  machine: "failed",
  machineTail: "eslint: Unsupported engine",
};

describe("the gate health's environment fault", () => {
  it("shows each gate side by side: both verdicts, both tails and both Nodes, from every part", async () => {
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId }));
        await stores.programContracts.put(makeProgramContract(f));
        await stores.runs.put(makeRun(f, { status: "cancelled" }));
        await stores.executionNodes.put(makeRootNode(f, { status: "cancelled" }));
        // A fault of many gates is written in parts; the panel shows them as one.
        await stores.events.append(
          makeEvent(f, {
            sequence: 0,
            type: "environment.fault",
            source: "control-plane",
            payload: { ...fault, gates: [unit], part: 1, parts: 2 },
          }),
        );
        await stores.events.append(
          makeEvent(f, {
            sequence: 1,
            type: "environment.fault",
            source: "control-plane",
            payload: { ...fault, gates: [lint], part: 2, parts: 2 },
          }),
        );
      },
      { at: runPathOf },
    );

    const card = await gateCard();
    const panel = card.querySelector("[data-environment-fault]");
    if (!(panel instanceof HTMLElement)) throw new Error("no environment fault");
    expect(within(panel).getByText("Environment fault")).toBeTruthy();
    expect(within(panel).getByText(/2 gates passed in the reference audit of/)).toBeTruthy();
    expect(within(panel).getByText("eeeeeeee")).toBeTruthy();
    expect(within(panel).getByText("Reference (Node 24.4.1)")).toBeTruthy();
    expect(within(panel).getByText("Machine (Node 18.20.4)")).toBeTruthy();

    const row = panel.querySelector('[data-gate="unit"]');
    if (!(row instanceof HTMLElement)) throw new Error("no unit row");
    expect(within(row).getByText("npm test")).toBeTruthy();
    const reference = row.querySelector('[data-side="reference"]') as HTMLElement;
    const machine = row.querySelector('[data-side="machine"]') as HTMLElement;
    expect(within(reference).getByText("passed")).toBeTruthy();
    // The tail as it was printed, spacing and all.
    expect(reference.querySelector("pre")?.textContent).toBe("Tests  12 passed (12)");
    expect(within(machine).getByText("failed")).toBeTruthy();
    expect(within(machine).getByText("TypeError: fetch is not a function")).toBeTruthy();

    const lintRow = panel.querySelector('[data-gate="lint"]') as HTMLElement;
    expect(
      within(lintRow.querySelector('[data-side="reference"]') as HTMLElement).getByText(
        "No output was kept.",
      ),
    ).toBeTruthy();
    expect(within(lintRow).getByText("eslint: Unsupported engine")).toBeTruthy();
    expect(within(card).queryByText(/No gate-health record, no red base/)).toBeNull();
  });
});
