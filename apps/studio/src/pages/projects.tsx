import { FolderGit2 } from "lucide-react";
import { Link } from "react-router";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "../components/page-header.js";
import { useProjects } from "../projects.js";

export const ProjectsPage = () => {
  const projects = useProjects();
  if (projects.isPending) return <p className="text-muted-foreground">Loading projects…</p>;
  if (projects.isError)
    return <p role="alert">Could not list projects: {String(projects.error)}</p>;
  const items = projects.data;
  return (
    <section>
      <PageHeader
        title="Projects"
        description="Every repository Nightshift works in, for this organisation."
      />
      {items.length === 0 ? (
        <p className="text-muted-foreground">
          No projects yet. Create one with <code className="font-mono">nightshift init</code> in a
          repository.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((project) => (
            <li key={project.projectId}>
              <Card className="h-full transition-colors hover:bg-accent/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FolderGit2 className="size-4 text-muted-foreground" />
                    <Link
                      to={`/projects/${project.projectId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {project.name}
                    </Link>
                  </CardTitle>
                  {project.description === undefined ? null : (
                    <CardDescription>{project.description}</CardDescription>
                  )}
                  <CardDescription className="font-mono text-xs">
                    {project.projectId}
                  </CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
