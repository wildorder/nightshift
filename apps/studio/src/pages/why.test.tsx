/**
 * Why a program exists, in the Studio (P14, SC-P14-08): the stories on the
 * program card and the Status tab, the Why tab with the plan and the kept
 * conversation, "Serves" on a node's detail and a decision's page, and the
 * graph read by story.
 */

import {
  emptyConversation,
  type Fixtures,
  keepMessages,
  makeDecision,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
  renderConversation,
} from "@nightshift/core";
import type { InMemoryStores } from "@nightshift/persistence/memory";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../test-support.js";

const PLAN_SHA = "b".repeat(64);
const CONVERSATION_SHA = "d".repeat(64);
const PLAN =
  "# Tenant billing\n\n## Strands\n\n### S-01 Isolation\n\nEvery read filters by tenant.\n\n<script>alert(1)</script>\n";
const CONVERSATION = renderConversation(
  keepMessages(
    emptyConversation("p1"),
    {
      harness: "claude",
      sessionId: "s-1",
      messages: [
        {
          index: 1,
          role: "human",
          text: "an admin must never see another company's invoices, not even by accident",
          at: "2026-09-30T14:00:00.000Z",
        },
        { index: 2, role: "assistant", text: "Then every read filters by tenant." },
      ],
    },
    [1, 2],
    "The owner wants tenants isolated with no support bypass.",
  ),
);

const strand = (id: string, criteria: string[]) => ({
  id,
  name: `The ${id}`,
  scope: { summary: "s", includes: [`src/${id}/**`], excludes: [] },
  acceptance: [`${id} is done`],
  successCriteria: criteria,
  dependsOn: [],
  prerequisites: [],
});

interface Seeded {
  s1Job: string;
  s1Strand: string;
  s2Job: string;
  s2Strand: string;
  root: string;
  decisionId: string;
}

const seed =
  (out: { ids?: Seeded }) =>
  async (stores: InMemoryStores, f: Fixtures, orgId: string): Promise<void> => {
    await stores.projects.put(makeProject(f, { orgId: orgId as never }));
    await stores.programContracts.put(
      makeProgramContract(f, {
        objective: "Add tenant-aware billing",
        status: "ratified",
        planHash: "c".repeat(64),
        planDocument: { uri: "s3://b/plan", sha256: PLAN_SHA, sizeBytes: PLAN.length },
        conversation: {
          uri: "s3://b/conv",
          sha256: CONVERSATION_SHA,
          sizeBytes: CONVERSATION.length,
        },
        stories: [
          {
            id: "US-01",
            who: "A customer's billing admin",
            problem: "A support query can return another company's invoices.",
            outcome: "They only ever see their own company's invoices.",
            words: ["an admin must never see another company's invoices"],
          },
          {
            id: "US-02",
            who: "An existing customer",
            problem: "A schema change could break their past invoices.",
            outcome: "Their past invoices still open and total as before.",
          },
          {
            id: "US-03",
            who: "Support staff",
            problem: "They cannot tell which tenant a ticket is about.",
            outcome: "Every ticket names its tenant.",
          },
        ],
        successCriteria: [
          { id: "SC-01", outcome: "Tenant billing data is isolated.", serves: ["US-01"] },
          { id: "SC-02", outcome: "Existing customers remain compatible.", serves: ["US-02"] },
          { id: "SC-03", outcome: "Tickets carry a tenant.", serves: ["US-03"] },
        ],
        strands: [strand("S-01", ["SC-01", "SC-03"]), strand("S-02", ["SC-02"])],
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
    const decision = makeDecision(f, s1.jn.executionNodeId, {
      context: "Where is the tenant enforced?",
      choice: "In the query layer",
      produced: { commits: ["1".repeat(40)] },
    });
    await stores.decisions.put(decision);
    out.ids = {
      s1Job: s1.jn.executionNodeId,
      s1Strand: s1.sn.executionNodeId,
      s2Job: s2.jn.executionNodeId,
      s2Strand: s2.sn.executionNodeId,
      root: root.executionNodeId,
      decisionId: decision.decisionId,
    };
  };

const documents = { [PLAN_SHA]: PLAN, [CONVERSATION_SHA]: CONVERSATION };

describe("the why, in the Studio (SC-P14-08)", () => {
  it("puts each program's story outcomes on its card, the first two and how many more", async () => {
    const out: { ids?: Seeded } = {};
    await mountStudio(seed(out), {
      at: (f: Fixtures) => `/projects/${f.scope.projectId}`,
    });
    const stories = await screen.findByRole("list", { name: "Stories" });
    expect(
      within(stories).getByText("They only ever see their own company's invoices"),
    ).toBeTruthy();
    expect(
      within(stories).getByText("Their past invoices still open and total as before"),
    ).toBeTruthy();
    expect(within(stories).queryByText("Every ticket names its tenant")).toBeNull();
    expect(screen.getByText("+1 more")).toBeTruthy();
  });

  it("opens the Status tab with a line per story, done or not", async () => {
    const out: { ids?: Seeded } = {};
    await mountStudio(seed(out), { at: runPathOf, documents });
    const stories = await screen.findByRole("list", { name: "Stories" });
    await waitFor(() =>
      expect(stories.querySelector('[data-story="US-01"]')?.textContent).toMatch(/^met/),
    );
    expect(stories.querySelector('[data-story="US-01"]')?.textContent).not.toContain("not met");
    expect(stories.querySelectorAll("[data-story]")).toHaveLength(3);
  });

  it("shows each story in full on the Why tab, then the plan and the conversation, with no raw HTML", async () => {
    const out: { ids?: Seeded } = {};
    await mountStudio(seed(out), { at: (f: Fixtures) => `${runPathOf(f)}?tab=why`, documents });
    const story = await screen.findByTestId("story-US-01");
    expect(within(story).getByText("A customer's billing admin")).toBeTruthy();
    expect(
      within(story).getByText("A support query can return another company's invoices."),
    ).toBeTruthy();
    expect(
      within(story).getByText("an admin must never see another company's invoices"),
    ).toBeTruthy();
    expect(within(story).getByText("Tenant billing data is isolated.")).toBeTruthy();
    expect(within(story).getByText(/The S-01/)).toBeTruthy();
    expect(within(story).getByRole("link", { name: "In the query layer" })).toBeTruthy();
    // US-02 is built by S-02 alone, so the decision on S-01 is not behind it.
    expect(within(screen.getByTestId("story-US-02")).getByText("None recorded.")).toBeTruthy();

    const plan = await screen.findByRole("region", { name: "The plan" });
    await waitFor(() =>
      expect(within(plan).getByText("Every read filters by tenant.")).toBeTruthy(),
    );
    expect(plan.textContent).not.toContain("alert(1)");
    expect(plan.querySelector("script")).toBeNull();

    const conversation = await screen.findByRole("region", { name: "The planning conversation" });
    await waitFor(() =>
      expect(
        within(conversation).getByText("The owner wants tenants isolated with no support bypass."),
      ).toBeTruthy(),
    );
    expect(conversation.textContent).toContain("not even by accident");
    expect(conversation.textContent).not.toContain("nightshift:message");
  });

  it("opens a node's detail and a decision's page with the stories they serve", async () => {
    const out: { ids?: Seeded } = {};
    await mountStudio(seed(out), { at: (f: Fixtures) => `${runPathOf(f)}?tab=graph`, documents });
    const graph = await screen.findByTestId("run-graph");
    await waitFor(() => expect(graph.querySelectorAll("[data-graph-node]")).toHaveLength(5));
    const job = graph.querySelector(`[data-graph-node="${out.ids?.s2Job}"]`);
    if (!(job instanceof HTMLElement)) throw new Error("no node");
    await userEvent.click(job);
    const detail = await screen.findByTestId("graph-detail");
    const serves = await within(detail).findByRole("region", { name: "Serves" });
    expect(
      within(serves).getByText("Their past invoices still open and total as before"),
    ).toBeTruthy();
    expect(within(serves).queryByText(/own company's invoices/)).toBeNull();
  });

  it("reads the graph by story: exactly the strands and jobs built for it light", async () => {
    const out: { ids?: Seeded } = {};
    await mountStudio(seed(out), { at: (f: Fixtures) => `${runPathOf(f)}?tab=graph`, documents });
    const graph = await screen.findByTestId("run-graph");
    await waitFor(() => expect(graph.querySelectorAll("[data-graph-node]")).toHaveLength(5));
    await userEvent.click(screen.getByRole("button", { name: /^US-02 / }));
    const lit = () =>
      [...graph.querySelectorAll('[data-highlight="serves"]')].map((el) =>
        el.getAttribute("data-graph-node"),
      );
    await waitFor(() => expect(lit().sort()).toEqual([out.ids?.s2Job, out.ids?.s2Strand].sort()));
    expect(screen.getByTestId("story-legend").textContent).toContain("built for it (2)");

    // Choosing a decision reads the graph the other way, and clears the story.
    await userEvent.click(screen.getByRole("button", { name: "In the query layer" }));
    await waitFor(() => expect(lit()).toEqual([]));
    expect(screen.getByRole("button", { name: /^US-02 / }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("says a program planned before stories has none, and shows its plan", async () => {
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId }));
        const { stories: _stories, ...contract } = makeProgramContract(f, {
          planDocument: { uri: "s3://b/plan", sha256: PLAN_SHA, sizeBytes: PLAN.length },
          successCriteria: [{ id: "SC-01", outcome: "It works." }],
        });
        await stores.programContracts.put(contract);
        await stores.runs.put(makeRun(f, { status: "succeeded" }));
        await stores.executionNodes.put(makeRootNode(f, { status: "succeeded" }));
      },
      { at: (f: Fixtures) => `${runPathOf(f)}?tab=why`, documents },
    );
    expect(
      await screen.findByText(
        "This program was planned before Nightshift kept stories. Its plan is below.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Every read filters by tenant.")).toBeTruthy();
    expect(screen.getByText("No planning conversation was kept for this plan.")).toBeTruthy();
  });
});

describe("a decision's page (SC-P14-08)", () => {
  it("opens with the stories the decision serves", async () => {
    const out: { ids?: Seeded } = {};
    await mountStudio(seed(out), {
      at: (f: Fixtures) => `${runPathOf(f)}/decisions/${out.ids?.decisionId}`,
      documents,
    });
    const serves = await screen.findByRole("region", { name: "Serves" });
    expect(
      within(serves).getByText("They only ever see their own company's invoices"),
    ).toBeTruthy();
    expect(within(serves).getByText("Every ticket names its tenant")).toBeTruthy();
    expect(within(serves).queryByText(/past invoices/)).toBeNull();
  });
});
