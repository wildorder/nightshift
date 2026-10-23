/**
 * The plan page over the memory stores (P21): a draft's latest version, its
 * answers and their authors, the plane's check, the versions, and read-only.
 */
import type { PlanDraftCheck } from "@nightshift/contracts";
import { PrincipalSchema } from "@nightshift/contracts";
import {
  applyPlanDraftAct,
  createFixtures,
  type Fixtures,
  makePlanDraftVersion,
  makeProgramContract,
  reconcilePlanDraftWrite,
} from "@nightshift/core";
import type { InMemoryStores } from "@nightshift/persistence/memory";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mountStudio } from "../test-support.js";

const alice = PrincipalSchema.parse({
  kind: "user",
  userId: "alice",
  orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
});
const bob = PrincipalSchema.parse({ ...alice, userId: "bob" });

const sha = (c: string) => c.repeat(64);
const ref = (c: string) => ({ uri: `s3://plans/${c}`, sha256: sha(c), sizeBytes: 10 });

const strand = (id: string, dependsOn: string[] = []) => ({
  id,
  name: `Strand ${id}`,
  scope: { summary: `summary of ${id}`, includes: ["src/**"], excludes: [] },
  acceptance: ["it works"],
  successCriteria: [],
  dependsOn,
  prerequisites: id === "S-02" ? ["HP-01"] : [],
});
const prerequisite = {
  id: "HP-01",
  description: "Create the bucket",
  remediation: "aws s3 mb",
  verifyCommand: "true",
  status: "pending",
};
const decision = (extra: Record<string, unknown> = {}) => ({
  id: "D-01",
  question: "Which store?",
  options: ["dynamo", "s3"],
  leaning: "dynamo",
  touches: "all",
  ...extra,
});

const contract1 = (f: Fixtures) =>
  JSON.stringify(makeProgramContract(f, { strands: [strand("S-01")], decisions: [decision()] }));
const contract2 = (f: Fixtures) =>
  JSON.stringify(
    makeProgramContract(f, {
      strands: [strand("S-01"), strand("S-02", ["S-01"])],
      prerequisites: [prerequisite],
      decisions: [decision({ answer: "s3", rationale: "cheaper" })],
    }),
  );

const documents = (f: Fixtures) => ({
  [sha("1")]: contract1(f),
  [sha("2")]: "# The plan\n\nBody of plan one.",
  [sha("3")]: contract2(f),
  [sha("4")]: "# The plan\n\nBody of plan two.",
});

const seedDraft = async (stores: InMemoryStores, f: Fixtures) => {
  const at = "2026-09-01T10:00:00.000Z";
  const first = reconcilePlanDraftWrite({ scope: f.scope, basedOn: null, at });
  await stores.planDrafts.appendVersion(
    makePlanDraftVersion(f, {
      version: 1,
      contract: ref("1"),
      plan: ref("2"),
      author: alice,
      createdAt: at,
    }),
    () => first.draft,
  );
  const at2 = "2026-09-02T10:00:00.000Z";
  await stores.planDrafts.appendVersion(
    makePlanDraftVersion(f, {
      version: 2,
      contract: ref("3"),
      plan: ref("4"),
      planHash: sha("a"),
      author: bob,
      act: { kind: "answer", decisionId: "D-01", answer: "s3", rationale: "cheaper" },
      createdAt: at2,
    }),
    (current) =>
      reconcilePlanDraftWrite({
        ...(current === undefined ? {} : { stored: current }),
        scope: f.scope,
        basedOn: 1,
        at: at2,
      }).draft,
  );
  await stores.planDrafts.update(f.scope.projectId, f.scope.programId, (draft) =>
    applyPlanDraftAct(draft, {
      kind: "awaiting_owner",
      version: 2,
      by: alice,
      note: "ready for you",
      at: "2026-09-03T10:00:00.000Z",
    }),
  );
};

const planPath = (f: Fixtures) =>
  `/projects/${f.scope.projectId}/programs/${f.scope.programId}/plan`;

const f0 = createFixtures();
const READY: PlanDraftCheck = { ready: true };
const NOT_READY: PlanDraftCheck = {
  ready: false,
  reasons: [
    { kind: "unanswered_decision", message: "decision D-09 has no answer" },
    { kind: "missing_acceptance", message: "strand S-02 states no acceptance" },
  ],
};

const mountPlan = (checks?: Record<number, PlanDraftCheck>) =>
  mountStudio(seedDraft, {
    at: planPath,
    documents: documents(f0),
    ...(checks === undefined ? {} : { checks }),
  });

describe("the plan page", () => {
  it("shows the latest version's plan, answers with who gave them, state and a ready check", async () => {
    await mountPlan({ 2: READY });
    expect(await screen.findByText(/Strand S-02/)).toBeTruthy();
    expect(screen.getByText(/Strand S-01/)).toBeTruthy();
    const strandCard = document.querySelector('[data-strand="S-02"]') as HTMLElement;
    expect(strandCard.textContent).toContain("Depends on: S-01");
    expect(strandCard.textContent).toContain("Prerequisites: HP-01");
    expect(
      document.querySelector('[data-story="US-01"]') ?? screen.getByText(/US-01/),
    ).toBeTruthy();
    const decision = document.querySelector('[data-decision="D-01"]') as HTMLElement;
    expect(decision.textContent).toContain("Which store?");
    expect(decision.textContent).toContain("Answer: s3");
    expect(decision.textContent).toContain("Rationale: cheaper");
    expect(decision.textContent).toContain("answered by bob (version 2)");
    expect(document.querySelector('[data-prerequisite="HP-01"]')?.textContent).toContain(
      "Create the bucket",
    );
    expect(screen.getAllByText("awaiting_owner").length).toBeGreaterThan(0);
    expect(screen.getByText(/latest version 2/)).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(await screen.findByText("Body of plan two.")).toBeTruthy();
    expect(screen.getByText(/ready for you/)).toBeTruthy();
    expect(screen.getByText(/nightshift plan/)).toBeTruthy();
  });

  it("shows each reason of a check that is not ready", async () => {
    await mountPlan({ 2: NOT_READY });
    expect(await screen.findByText("Not ready")).toBeTruthy();
    expect(screen.getByText("unanswered_decision")).toBeTruthy();
    expect(screen.getByText(/decision D-09 has no answer/)).toBeTruthy();
    expect(screen.getByText("missing_acceptance")).toBeTruthy();
  });

  it("says the check is unavailable when the port is absent", async () => {
    await mountPlan();
    expect(await screen.findByText(/check of this version is unavailable/)).toBeTruthy();
    expect(await screen.findByText(/Strand S-02/)).toBeTruthy();
  });

  it("says the check is unavailable when the read has no such version", async () => {
    await mountPlan({ 1: READY });
    expect(await screen.findByText(/check of this version is unavailable/)).toBeTruthy();
  });

  it("lists versions newest first with author, act and what changed", async () => {
    await mountPlan({ 2: READY });
    const two = await waitFor(() => {
      const el = document.querySelector('[data-version="2"]') as HTMLElement | null;
      if (el === null || !el.textContent?.includes("strands added")) throw new Error("not yet");
      return el;
    });
    expect(two.textContent).toContain("by bob");
    expect(two.textContent).toContain("answer of decision D-01");
    expect(two.textContent).toContain("plan document changed");
    expect(two.textContent).toContain("strands added: S-02");
    expect(two.textContent).toContain("decisions changed: D-01");
    expect(two.textContent).toContain("prerequisites added: HP-01");
    const one = document.querySelector('[data-version="1"]') as HTMLElement;
    expect(one.textContent).toContain("by alice");
    expect(one.textContent).toContain("write");
    const order = [...document.querySelectorAll("[data-version]")].map((el) =>
      el.getAttribute("data-version"),
    );
    expect(order).toEqual(["2", "1"]);
  });

  const seedTwo =
    (second: { author: typeof alice; act?: Record<string, unknown> }) =>
    async (stores: InMemoryStores, f: Fixtures) => {
      const at = "2026-09-01T10:00:00.000Z";
      await stores.planDrafts.appendVersion(
        makePlanDraftVersion(f, {
          version: 1,
          contract: ref("5"),
          plan: ref("2"),
          author: alice,
          act: { kind: "answer", decisionId: "D-01", answer: "s3" },
          createdAt: at,
        }),
        () => reconcilePlanDraftWrite({ scope: f.scope, basedOn: null, at }).draft,
      );
      const at2 = "2026-09-02T10:00:00.000Z";
      await stores.planDrafts.appendVersion(
        makePlanDraftVersion(f, {
          version: 2,
          contract: ref("6"),
          plan: ref("2"),
          createdAt: at2,
          ...second,
        }),
        (current) =>
          reconcilePlanDraftWrite({
            ...(current === undefined ? {} : { stored: current }),
            scope: f.scope,
            basedOn: 1,
            at: at2,
          }).draft,
      );
    };
  const twoDocs = (f: Fixtures, answer: string, objective: string) => ({
    [sha("2")]: "# The plan\n\nBody.",
    [sha("5")]: JSON.stringify(makeProgramContract(f, { decisions: [decision({ answer: "s3" })] })),
    [sha("6")]: JSON.stringify(
      makeProgramContract(f, { objective, decisions: [decision({ answer })] }),
    ),
  });

  it("shows a contract field edit that touches nothing else", async () => {
    const base = makeProgramContract(f0, {}).objective;
    await mountStudio(seedTwo({ author: bob }), {
      at: planPath,
      documents: twoDocs(f0, "s3", `${base} revised`),
      checks: { 2: READY },
    });
    const two = await waitFor(() => {
      const el = document.querySelector('[data-version="2"]') as HTMLElement | null;
      if (el === null || !el.textContent?.includes("contract fields")) throw new Error("not yet");
      return el;
    });
    expect(two.textContent).toContain("contract fields changed: objective");
    expect(two.textContent).not.toContain("no changes to the documents");
  });

  it("names the writer, not the earlier answerer, of an overwritten answer", async () => {
    const base = makeProgramContract(f0, {}).objective;
    await mountStudio(seedTwo({ author: bob }), {
      at: planPath,
      documents: twoDocs(f0, "gcs", base),
      checks: { 2: READY },
    });
    const decisionEl = await waitFor(() => {
      const el = document.querySelector('[data-decision="D-01"]') as HTMLElement | null;
      if (el === null || !el.textContent?.includes("Answer: gcs")) throw new Error("not yet");
      return el;
    });
    expect(decisionEl.textContent).not.toContain("alice");
    expect(decisionEl.textContent).toContain("bob");
  });

  it("still shows the check reasons when the contract does not parse", async () => {
    await mountStudio(seedDraft, {
      at: planPath,
      documents: { ...documents(f0), [sha("3")]: "{not json" },
      checks: { 2: NOT_READY },
    });
    expect(await screen.findByText(/The contract could not be parsed/)).toBeTruthy();
    expect(screen.getByText(/decision D-09 has no answer/)).toBeTruthy();
  });

  it("says the documents are not retrievable when the control plane holds none", async () => {
    await mountStudio(seedDraft, { at: planPath, documents: {}, checks: { 2: READY } });
    expect(await screen.findByText(/documents are not retrievable/)).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("renders no control that changes a draft, and writes nothing", async () => {
    const writes = vi.fn();
    await mountStudio(seedDraft, {
      at: planPath,
      documents: documents(f0),
      checks: { 2: READY },
      serve: (seeded) => ({
        ...seeded,
        planDrafts: {
          ...seeded.planDrafts,
          get: (...args) => seeded.planDrafts.get(...args),
          listVersions: (...args) => seeded.planDrafts.listVersions(...args),
          appendVersion: async (...args) => {
            writes("appendVersion");
            return seeded.planDrafts.appendVersion(...args);
          },
          update: async (...args) => {
            writes("update");
            return seeded.planDrafts.update(...args);
          },
        },
      }),
    });
    await screen.findByText(/Strand S-02/);
    await screen.findByText("Body of plan two.");
    const page = screen.getByTestId("plan-page");
    expect(within(page).queryAllByRole("button")).toHaveLength(0);
    expect(page.querySelector("form, input, textarea, select, button")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });

  it("says a program with no draft has none, without an error", async () => {
    await mountStudio(async () => {}, { at: planPath, documents: {} });
    expect(await screen.findByText(/no plan draft in the plane/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("links back to the project", async () => {
    const mounted = await mountPlan({ 2: READY });
    const link = await screen.findByRole("link", { name: "Project" });
    expect(link.getAttribute("href")).toBe(`/projects/${mounted.f.scope.projectId}`);
    expect(within(document.body).getAllByText(/Plan of/).length).toBeGreaterThan(0);
  });
});

describe("the drafts port in main.tsx", () => {
  it("issues only GET", async () => {
    const { default: source } = await import("../main.tsx?raw");
    const start = source.indexOf("const draftsOver");
    const block = source.slice(start, source.indexOf("\n});\n", start));
    expect(block).toContain('method: "GET"');
    expect(block).not.toMatch(/method: "(POST|PUT|PATCH|DELETE)"/);
  });
});
