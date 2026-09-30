/** The run graph on the run page (P13, T4b; SC-P13-11, SC-P13-12). */
import {
  type Fixtures,
  makeDecision,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
} from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../../test-support.js";

const strand = (id: string, dependsOn: string[] = []) => ({
  id,
  name: `The ${id}`,
  scope: { summary: "s", includes: ["src/**"], excludes: [] },
  acceptance: [`${id} is done`],
  successCriteria: ["SC-01"],
  dependsOn,
  prerequisites: [],
});

describe("the run graph", () => {
  it("draws the run, marks a decision's two sets, and opens a node's detail beneath", async () => {
    let ids:
      | { s1Job: string; s2Strand: string; s3Strand: string; decisionChoice: string }
      | undefined;
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId }));
        await stores.programContracts.put(
          makeProgramContract(f, {
            objective: "Add billing",
            status: "ratified",
            planHash: "c".repeat(64),
            planDocument: { uri: "s3://b/x", sha256: "b".repeat(64), sizeBytes: 1 },
            strands: [strand("S-01"), strand("S-02", ["S-01"]), strand("S-03")],
          }),
        );
        await stores.runs.put(makeRun(f, { status: "succeeded" }));
        const root = makeRootNode(f, { status: "succeeded" });
        await stores.executionNodes.put(root);
        const make = async (strandId: string, sha: string) => {
          const sj = makeJobContract(f, {
            jobContractId: f.ids.next("job"),
            objective: `orchestrate ${strandId}`,
            strandId,
          });
          const sn = makeNode(f, root.executionNodeId, {
            kind: "sub-program",
            status: "succeeded",
            jobContractId: sj.jobContractId,
          });
          const jj = makeJobContract(f, {
            jobContractId: f.ids.next("job"),
            objective: `Build ${strandId}`,
            acceptance: [`${strandId} passes its tests`],
          });
          const jn = makeNode(f, sn.executionNodeId, {
            kind: "job",
            status: "integrated",
            jobContractId: jj.jobContractId,
            commitSha: sha as never,
          });
          await stores.jobContracts.put(sj);
          await stores.jobContracts.put(jj);
          await stores.executionNodes.put(sn);
          await stores.executionNodes.put(jn);
          await stores.verifications.put(makeVerification(f, jn));
          return { sn, jn };
        };
        const s1 = await make("S-01", "1".repeat(40));
        const s2 = await make("S-02", "2".repeat(40));
        const s3 = await make("S-03", "3".repeat(40));
        const decision = makeDecision(f, s1.sn.executionNodeId, {
          choice: "One table per tenant",
          produced: { commits: ["1".repeat(40)] },
        });
        await stores.decisions.put(decision);
        ids = {
          s1Job: s1.jn.executionNodeId,
          s2Strand: s2.sn.executionNodeId,
          s3Strand: s3.sn.executionNodeId,
          decisionChoice: decision.choice,
        };
      },
      { at: (f: Fixtures) => `${runPathOf(f)}?tab=graph` },
    );
    if (ids === undefined) throw new Error("not seeded");
    const graph = await screen.findByTestId("run-graph");
    await waitFor(() => expect(graph.querySelectorAll("[data-graph-node]")).toHaveLength(7));
    const nodeEl = (id: string) => graph.querySelector(`[data-graph-node="${id}"]`);

    // Nothing is marked until a decision is chosen.
    expect(
      graph.querySelectorAll('[data-highlight="produced"], [data-highlight="after"]'),
    ).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: ids.decisionChoice }));
    await waitFor(() =>
      expect(nodeEl(ids?.s1Job ?? "")?.getAttribute("data-highlight")).toBe("produced"),
    );
    expect(nodeEl(ids.s2Strand)?.getAttribute("data-highlight")).toBe("after");
    expect(nodeEl(ids.s3Strand)?.getAttribute("data-highlight")).toBe("none");
    expect(screen.getByTestId("reach-legend").textContent).toContain("built after");

    // A node's detail opens beneath the graph: what it had to do, what was checked.
    const job = nodeEl(ids.s1Job);
    if (!(job instanceof HTMLElement)) throw new Error("no node");
    await userEvent.click(job);
    const detail = await screen.findByTestId("graph-detail");
    await waitFor(() => expect(within(detail).getByText("Build S-01")).toBeTruthy());
    expect(within(detail).getByText("S-01 passes its tests")).toBeTruthy();
    expect(within(detail).getByText("What was checked")).toBeTruthy();
    await waitFor(() => expect(within(detail).getByText("exit 0")).toBeTruthy());

    // A strand's detail says which success criteria it claims, and whether they are met.
    const strandNode = nodeEl(ids.s2Strand);
    if (!(strandNode instanceof HTMLElement)) throw new Error("no strand node");
    await userEvent.click(strandNode);
    await waitFor(() => expect(within(detail).getByText("S-02 is done")).toBeTruthy());
    const criteria = within(detail).getByRole("list", { name: "Success criteria" });
    expect(criteria.textContent).toContain("SC-01");
  });
});
