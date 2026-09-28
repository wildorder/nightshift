import { Link } from "react-router";
import { useProjects } from "../shell.js";

export const ProjectsPage = () => {
  const projects = useProjects();
  if (projects.isPending) return <p>Loading projects…</p>;
  if (projects.isError)
    return <p role="alert">Could not list projects: {String(projects.error)}</p>;
  const items = projects.data;
  return (
    <section>
      <h1 className="mb-3 text-xl font-semibold">Projects</h1>
      {items.length === 0 ? (
        <p>No projects yet. Create one with `nightshift project create`.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {items.map((project) => (
            <li key={project.projectId} className="p-3">
              <Link to={`/projects/${project.projectId}`} className="font-medium hover:underline">
                {project.name}
              </Link>
              {project.description === undefined ? null : (
                <p className="text-sm text-slate-600">{project.description}</p>
              )}
              <p className="font-mono text-xs text-slate-500">{project.projectId}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
