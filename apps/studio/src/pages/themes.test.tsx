/** Every page renders in both themes (P13, SC-P13-03). */
import {
  type Fixtures,
  makeDecision,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_KEY } from "../components/theme-provider.js";
import { mountStudio, runPathOf } from "../test-support.js";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

const PAGES: readonly [string, (f: Fixtures, decisionId: string) => string, RegExp][] = [
  ["projects", () => "/", /Projects/],
  ["project", (f) => `/projects/${f.scope.projectId}`, /Programs/],
  ["project settings", (f) => `/projects/${f.scope.projectId}/settings`, /Contract policies/],
  ["organisation settings", () => "/settings", /Organisation settings/],
  ["run", (f) => runPathOf(f), /Program status/],
  [
    "decision",
    (f, id) => `${runPathOf(f)}/decisions/${id}`,
    /What it had to do|Record the reversal|Around it/,
  ],
];

describe("both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [name, at, expected] of PAGES) {
      it(`renders the ${name} page in ${theme}`, async () => {
        window.localStorage.setItem(THEME_KEY, theme);
        let decisionId = "";
        await mountStudio(
          async (stores, f, orgId) => {
            await stores.projects.put(makeProject(f, { orgId }));
            await stores.programContracts.put(makeProgramContract(f));
            await stores.runs.put(makeRun(f, { status: "succeeded" }));
            const root = makeRootNode(f);
            await stores.executionNodes.put(root);
            const decision = makeDecision(f, root.executionNodeId);
            await stores.decisions.put(decision);
            decisionId = decision.decisionId;
          },
          { at: (f) => at(f, decisionId) },
        );
        await waitFor(() =>
          expect(document.documentElement.classList.contains("dark")).toBe(theme === "dark"),
        );
        await waitFor(() => expect(screen.getAllByText(expected).length).toBeGreaterThan(0));
      });
    }
  }
});
