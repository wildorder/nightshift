/**
 * The Studio's routes, over a `Studio` somebody else composed.
 *
 * `main.tsx` composes the real one (a browser session, the HTTP stores); a test
 * composes one over the memory stores. Either way this is the same tree.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Routes } from "react-router";
import { ThemeProvider } from "./components/theme-provider.js";
import { DecisionPage } from "./pages/decision.js";
import { ProjectPage } from "./pages/project.js";
import { ProjectSettingsPage } from "./pages/project-settings.js";
import { ProjectsPage } from "./pages/projects.js";
import { RunPage } from "./pages/run.js";
import { OrgSettingsPage } from "./pages/settings.js";
import { Shell } from "./shell.js";
import { type Studio, StudioProvider } from "./studio.js";

export const App = ({
  studio,
  client,
}: {
  readonly studio: Studio;
  readonly client?: QueryClient;
}) => (
  <ThemeProvider>
    <QueryClientProvider client={client ?? new QueryClient()}>
      <StudioProvider value={studio}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectPage />} />
            <Route path="projects/:projectId/settings" element={<ProjectSettingsPage />} />
            <Route
              path="projects/:projectId/programs/:programId/runs/:runId"
              element={<RunPage />}
            />
            <Route
              path="projects/:projectId/programs/:programId/runs/:runId/decisions/:decisionId"
              element={<DecisionPage />}
            />
            <Route path="settings" element={<OrgSettingsPage />} />
          </Route>
        </Routes>
      </StudioProvider>
    </QueryClientProvider>
  </ThemeProvider>
);
