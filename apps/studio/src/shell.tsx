/**
 * The dashboard's frame (Q4): the project selector, the signed-in user and
 * sign-out, and the page inside.
 */
import type { Project } from "@nightshift/contracts";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { useStudio } from "./studio.js";

export const useProjects = () => {
  const { stores, orgId } = useStudio();
  return useQuery({
    queryKey: ["projects", orgId],
    queryFn: async (): Promise<readonly Project[]> =>
      orgId === undefined ? [] : (await stores.projects.listByOrg(orgId, { limit: 100 })).items,
  });
};

const ProjectSelector = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const projects = useProjects();
  return (
    <select
      aria-label="Project"
      className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
      value={projectId ?? ""}
      onChange={(event) => {
        const next = event.target.value;
        void navigate(next === "" ? "/" : `/projects/${next}`);
      }}
    >
      <option value="">All projects</option>
      {(projects.data ?? []).map((project) => (
        <option key={project.projectId} value={project.projectId}>
          {project.name}
        </option>
      ))}
    </select>
  );
};

export const Shell = () => {
  const { identity, orgId, signOut } = useStudio();
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-2">
        <NavLink to="/" className="font-semibold">
          Nightshift Studio
        </NavLink>
        <ProjectSelector />
        <nav className="ml-auto flex items-center gap-3 text-sm">
          <NavLink to="/settings" className="hover:underline">
            Settings
          </NavLink>
          <span title={identity.subject ?? ""}>{identity.email ?? "(no email claim)"}</span>
          <span className="text-slate-500" title="Acting organisation">
            {orgId ?? identity.activeOrgClaim ?? "(no org yet)"}
          </span>
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        <Outlet />
      </main>
    </div>
  );
};
