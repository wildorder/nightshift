/**
 * The fixture preview's entry (P20, S-04): the real `App` over in-memory stores
 * seeded with a scenario, for designing and reviewing the run page against
 * realistic data in a browser. Dev only; `vite.preview.config.ts` serves it and
 * the production build never includes it.
 *
 *   /preview.html?scenario=complete&theme=dark&tab=overview&scope=...
 *
 * `scenario` and `theme` are the preview's own; every other parameter is passed
 * through to the run page.
 */
import { createCountingIdGenerator } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "../app.js";
import { THEME_KEY } from "../components/theme-provider.js";
import "../index.css";
import type { Studio } from "../studio.js";
import {
  PREVIEW_EMAIL,
  PREVIEW_USER,
  runPath,
  SCENARIO_NAMES,
  SCENARIOS,
  type ScenarioName,
} from "./scenarios.js";

/** The preview's clock: every scenario is laid out relative to it. */
export const PREVIEW_NOW = "2026-09-28T12:00:00.000Z";

const params = new URLSearchParams(window.location.search);
const scenarioParam = params.get("scenario") ?? "complete";
const theme = params.get("theme");
params.delete("scenario");
params.delete("theme");

// The theme provider reads its stored choice on mount, so set it first.
if (theme === "light" || theme === "dark") window.localStorage.setItem(THEME_KEY, theme);
else window.localStorage.removeItem(THEME_KEY);

const root = createRoot(document.getElementById("root") as HTMLElement);

const start = async (): Promise<void> => {
  if (!SCENARIO_NAMES.includes(scenarioParam as ScenarioName)) {
    throw new Error(
      `no scenario "${scenarioParam}"; the scenarios are ${SCENARIO_NAMES.join(", ")}`,
    );
  }
  const stores = createInMemoryStores();
  const seeded = await SCENARIOS[scenarioParam as ScenarioName](
    stores,
    createCountingIdGenerator(),
    () => PREVIEW_NOW,
  );
  const studio: Studio = {
    stores: seeded.stores ?? stores,
    identity: { subject: PREVIEW_USER, email: PREVIEW_EMAIL, activeOrgClaim: undefined },
    orgId: seeded.orgId,
    signOut: async () => {},
    ids: createCountingIdGenerator(9000),
    now: () => PREVIEW_NOW,
    // Nothing moves in a fixture world, so the live poll can be slow.
    pollMs: 60_000,
  };
  // A refused read is shown at once, not after the default retries.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const query = params.toString();
  const at = `${runPath(seeded.scope)}${query === "" ? "" : `?${query}`}`;
  root.render(
    <StrictMode>
      <MemoryRouter initialEntries={[at]}>
        <App studio={studio} client={client} />
      </MemoryRouter>
    </StrictMode>,
  );
};

start().catch((error: unknown) => {
  root.render(
    <main className="m-8 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
      <h1 className="font-semibold">The preview could not start</h1>
      <pre className="whitespace-pre-wrap text-sm">{String(error)}</pre>
    </main>,
  );
});
