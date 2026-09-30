/**
 * The header above every page (P13, D-P13-05): the sidebar toggle and where you
 * are, as breadcrumbs: project › program › run › decision.
 */
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { shortId } from "../lib/format.js";
import { useStudio } from "../studio.js";

interface Crumb {
  readonly label: string;
  readonly to?: string;
}

const useCrumbs = (): readonly Crumb[] => {
  const { stores } = useStudio();
  const params = useParams();
  const { pathname } = useLocation();
  const projectId = ProjectIdSchema.safeParse(params.projectId).data;
  const programId = ProgramIdSchema.safeParse(params.programId).data;
  const runId = RunIdSchema.safeParse(params.runId).data;
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => (projectId === undefined ? undefined : stores.projects.get(projectId)),
    enabled: projectId !== undefined,
  });
  const program = useQuery({
    queryKey: ["program", projectId, programId],
    queryFn: () =>
      projectId === undefined || programId === undefined
        ? undefined
        : stores.programContracts.get(projectId, programId),
    enabled: projectId !== undefined && programId !== undefined,
  });

  if (pathname === "/settings") return [{ label: "Settings" }];
  const crumbs: Crumb[] = [{ label: "Projects", to: "/" }];
  if (projectId === undefined) return [{ label: "Projects" }];
  crumbs.push({ label: project.data?.name ?? shortId(projectId), to: `/projects/${projectId}` });
  if (pathname.endsWith("/settings")) crumbs.push({ label: "Settings" });
  if (programId !== undefined) {
    const objective = program.data?.objective ?? shortId(programId);
    crumbs.push({ label: objective.length > 48 ? `${objective.slice(0, 47)}…` : objective });
  }
  if (runId !== undefined) {
    crumbs.push({
      label: `Run ${shortId(runId)}`,
      to: `/projects/${projectId}/programs/${programId}/runs/${runId}`,
    });
  }
  if (params.decisionId !== undefined)
    crumbs.push({ label: `Decision ${shortId(params.decisionId)}` });
  return crumbs;
};

export const AppHeader = () => {
  const crumbs = useCrumbs();
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <Fragment key={crumb.to ?? crumb.label}>
                {index > 0 ? <BreadcrumbSeparator /> : null}
                <BreadcrumbItem>
                  {last || crumb.to === undefined ? (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={crumb.to}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
};
