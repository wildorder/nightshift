/**
 * Gate health on the run's Status tab (P15, D-P15-09, SC-P15-09), gathered
 * from the memory stores as `nightshift report` gathers it.
 */
import { AGGREGATE_EXAMPLES, type GateHealth, GateHealthSchema } from "@nightshift/contracts";
import {
  makeDecision,
  makeEvent,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
} from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../test-support.js";

const gateCard = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole("heading", { name: "Gate health" });
  const card = heading.closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error("no Gate health card");
  return card;
};

describe("the run page's gate health", () => {
  it("shows the audit, the red base, each repair with its decision and new definitions, and each flake", async () => {
    let decisionId = "";
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId }));
        await stores.programContracts.put(makeProgramContract(f));
        await stores.runs.put(makeRun(f, { status: "succeeded" }));
        await stores.gateHealth.put(
          GateHealthSchema.parse({
            ...(structuredClone(AGGREGATE_EXAMPLES.GateHealth) as Record<string, unknown>),
            projectId: f.scope.projectId,
            programId: f.scope.programId,
          }) as GateHealth,
        );
        const root = makeRootNode(f, { status: "succeeded" });
        await stores.executionNodes.put(root);
        const decision = makeDecision(f, root.executionNodeId, {
          context: "The build gate was red on the base commit.",
          choice: "Build from tsconfig.build.json",
          rationale: "the base config pulled the tests into the build",
        });
        decisionId = decision.decisionId;
        await stores.decisions.put(decision);

        const repair = makeJobContract(f, {
          objective: "Make the build gate green",
          repair: { cause: "red_base", gates: ["build"], decisionId: decision.decisionId },
        });
        await stores.jobContracts.put(repair);
        await stores.executionNodes.put(
          makeNode(f, root.executionNodeId, {
            kind: "job",
            status: "integrated",
            jobContractId: repair.jobContractId,
            commitSha: "b".repeat(40),
          }),
        );

        const work = makeJobContract(f, { objective: "Persist invoices" });
        await stores.jobContracts.put(work);
        const workNode = makeNode(f, root.executionNodeId, {
          kind: "job",
          status: "integrated",
          jobContractId: work.jobContractId,
          commitSha: "c".repeat(40),
        });
        await stores.executionNodes.put(workNode);
        await stores.verifications.put(
          makeVerification(f, workNode, {
            commands: [
              {
                stepId: "e2e",
                command: "npm run e2e",
                exitCode: 0,
                durationMs: 5,
                flaky: { firstExitCode: 3, firstDurationMs: 4 },
              },
            ],
          }),
        );

        await stores.events.append(
          makeEvent(f, {
            sequence: 0,
            type: "gate.red",
            source: "control-plane",
            payload: { baseCommit: "d".repeat(40), failing: ["build"] },
          }),
        );
        await stores.events.append(
          makeEvent(f, {
            sequence: 1,
            type: "gate.repaired",
            source: "control-plane",
            payload: {
              jobContractId: repair.jobContractId,
              decisionId: decision.decisionId,
              cause: "red_base",
              definitionsChanged: true,
              verification: [{ id: "build", command: "tsc -p tsconfig.build.json" }],
            },
          }),
        );
      },
      { at: runPathOf },
    );

    const card = await gateCard();
    await waitFor(() => expect(within(card).getByText("repairing")).toBeTruthy());
    expect(within(card).getByText(/The unit and e2e gates both write their builds/)).toBeTruthy();
    expect(within(card).getByText(/The base was red: build failed on/)).toBeTruthy();
    expect(within(card).getByText("dddddddd")).toBeTruthy();
    expect(within(card).getByText("Repair (red base) of build")).toBeTruthy();
    expect(within(card).getByText("integrated")).toBeTruthy();
    const link = within(card).getByRole("link", { name: "Build from tsconfig.build.json" });
    expect(link.getAttribute("href")).toMatch(
      new RegExp(`/runs/run_[^/]+/decisions/${decisionId}$`),
    );
    expect(within(card).getByText("the base config pulled the tests into the build")).toBeTruthy();
    // The changed definitions themselves, not a count of them.
    expect(within(card).getByText(/New gate definitions/)).toBeTruthy();
    expect(within(card).getByText("tsc -p tsconfig.build.json")).toBeTruthy();
    expect(within(card).getByText("e2e")).toBeTruthy();
    expect(within(card).getByText(/first run exited 3, the rerun passed/)).toBeTruthy();
    expect(within(card).queryByText(/No gate-health record, no red base/)).toBeNull();
  });

  it("says so in one line when there is nothing", async () => {
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId }));
        await stores.programContracts.put(makeProgramContract(f));
        await stores.runs.put(makeRun(f, { status: "succeeded" }));
        await stores.executionNodes.put(makeRootNode(f, { status: "succeeded" }));
      },
      { at: runPathOf },
    );
    const card = await gateCard();
    expect(
      within(card).getByText("No gate-health record, no red base, no repairs and no flakes."),
    ).toBeTruthy();
    expect(within(card).queryByText("Repairs")).toBeNull();
    expect(within(card).queryByText("Flakes")).toBeNull();
  });
});
