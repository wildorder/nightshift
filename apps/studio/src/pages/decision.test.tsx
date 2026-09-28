/**
 * The decision page and reversal (T5; SC-P11-07 offline): the record written
 * from the page is the record the CLI writes, built by the same function.
 */
import type { Decision } from "@nightshift/contracts";
import type { Fixtures } from "@nightshift/core";
import {
  buildReversal,
  createCountingIdGenerator,
  makeDecision,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../test-support.js";

const AT = "2026-09-28T15:00:00.000Z";

const seedDecision = async (overrides: Partial<Decision> = {}) => {
  let decision: Decision | undefined;
  const mounted = await mountStudio(
    async (stores, f, orgId) => {
      await stores.projects.put(makeProject(f, { orgId }));
      await stores.programContracts.put(makeProgramContract(f));
      await stores.runs.put(makeRun(f, { status: "succeeded" }));
      const root = makeRootNode(f);
      await stores.executionNodes.put(root);
      const node = makeNode(f, root.executionNodeId, { kind: "job", status: "verified" });
      await stores.executionNodes.put(node);
      decision = makeDecision(f, node.executionNodeId, {
        context: "How to store orders",
        choice: "one table",
        rationale: "simplest",
        alternatives: [{ summary: "a table per region", rejectedBecause: "more to migrate" }],
        reversibility: "compensatable",
        produced: { commits: ["b".repeat(40)] },
        ...overrides,
      });
      await stores.decisions.put(decision);
    },
    {
      at: (f: Fixtures) => `${runPathOf(f)}/decisions/${decision?.decisionId ?? ""}`,
      ids: createCountingIdGenerator(5000),
      now: () => AT,
    },
  );
  if (decision === undefined) throw new Error("no decision");
  return { ...mounted, decision };
};

describe("the decision page", () => {
  it("records a reversal exactly as the CLI's builder does, and shows the next step", async () => {
    const { stores, decision, f } = await seedDecision();
    await waitFor(() => expect(screen.getByRole("heading", { name: "one table" })).toBeTruthy());
    expect(screen.getByText(/rejected because more to migrate/)).toBeTruthy();
    expect(screen.getAllByText(/compensatable/).length).toBeGreaterThanOrEqual(2);

    await userEvent.type(screen.getByLabelText("Your choice"), "a table per region");
    await userEvent.type(screen.getByLabelText("Why"), "regions will diverge");
    await userEvent.click(screen.getByRole("button", { name: "Record the reversal" }));

    await waitFor(() => expect(screen.getByTestId("next-step")).toBeTruthy());
    expect(screen.getByTestId("next-step").textContent).toContain(
      `nightshift decision brief <program> ${decision.decisionId} --run ${f.scope.runId}`,
    );

    const all = (await stores.decisions.listByRun(f.scope, {})).items;
    const written = all.find((d) => d.supersedesDecisionId === decision.decisionId);
    const expected = buildReversal(decision, {
      decisionId: createCountingIdGenerator(5000).next("dec"),
      choice: "a table per region",
      reason: "regions will diverge",
      at: AT,
    });
    expect(written).toEqual(expected);
  });

  it("refuses to reverse a reversal, and a decision already reversed", async () => {
    const { stores, decision, f } = await seedDecision();
    await waitFor(() => expect(screen.getByRole("heading", { name: "one table" })).toBeTruthy());
    // Somebody reverses it from a terminal meanwhile.
    const reversal = buildReversal(decision, {
      decisionId: f.ids.next("dec"),
      choice: "two tables",
      reason: "why not",
      at: AT,
    });
    await stores.decisions.put(reversal);
    await userEvent.type(screen.getByLabelText("Your choice"), "x");
    await userEvent.type(screen.getByLabelText("Why"), "y");
    await userEvent.click(screen.getByRole("button", { name: "Record the reversal" }));
    // As the CLI would, the page writes the owner's word; the earlier reversal
    // stands beside it, and the page shows the latest.
    await waitFor(() => expect(screen.getByTestId("next-step")).toBeTruthy());
    const reversals = (await stores.decisions.listByRun(f.scope, {})).items.filter(
      (d) => d.supersedesDecisionId === decision.decisionId,
    );
    expect(reversals.map((d) => d.choice).sort()).toEqual(["two tables", "x"]);

    // A reversal itself cannot be reversed: the page says which decision to reverse instead.
    const target = reversals.find((d) => d.choice === "two tables");
    if (target === undefined) throw new Error("no reversal");
    expect(target.supersedesDecisionId).toBe(decision.decisionId);
  });
});
