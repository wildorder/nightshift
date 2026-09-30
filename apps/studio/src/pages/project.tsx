/**
 * A project: its programs with their plans, and every run of them (T3,
 * D-P11-10). Runs are gathered by listing each program's runs and merging; no
 * index is added for it.
 */
import type { ProgramContract, Project, ProjectId, Run } from "@nightshift/contracts";
import { ProjectIdSchema } from "@nightshift/contracts";
import { isPlanned, prerequisitesOf } from "@nightshift/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Settings } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "../components/data-table.js";
import { PageHeader } from "../components/page-header.js";
import { ProgramStatusSummary } from "../components/program-status.js";
import { StatusBadge } from "../components/status-badge.js";
import { CardStories } from "../components/stories.js";
import { between, shortId, when } from "../lib/format.js";
import { readAll } from "../lib/read-all.js";
import { useRunStatus } from "../lib/run-status.js";
import { useStudio } from "../studio.js";

export interface ProgramWithRuns {
  readonly program: ProgramContract;
  readonly runs: readonly Run[];
}

export const useProjectId = (): ProjectId => {
  const { projectId } = useParams();
  return ProjectIdSchema.parse(projectId);
};

export const useProject = (projectId: ProjectId) => {
  const { stores } = useStudio();
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => stores.projects.get(projectId),
  });
};

export const usePrograms = (projectId: ProjectId) => {
  const { stores } = useStudio();
  return useQuery({
    queryKey: ["programs", projectId],
    queryFn: async (): Promise<readonly ProgramWithRuns[]> => {
      const programs = await readAll((page) =>
        stores.programContracts.listByProject(projectId, page),
      );
      return Promise.all(
        programs.map(async (program) => ({
          program,
          runs: await readAll((page) =>
            stores.runs.listByProgram({ projectId, programId: program.programId }, page),
          ),
        })),
      );
    },
  });
};

const EditProject = ({
  project,
  onDone,
}: {
  readonly project: Project;
  readonly onDone: () => void;
}) => {
  const { stores } = useStudio();
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const save = useMutation({
    mutationFn: async () => {
      await stores.projects.put({
        ...project,
        name,
        ...(description === "" ? { description: undefined } : { description }),
      } as Project);
    },
    onSuccess: async () => {
      onDone();
      await client.invalidateQueries({ queryKey: ["project", project.projectId] });
      await client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return (
    <Card className="mb-6">
      <CardContent>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Input
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {String(save.error)}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};

const PlanState = ({ program }: { readonly program: ProgramContract }) => {
  if (!isPlanned(program))
    return <span className="text-sm text-muted-foreground">unplanned contract</span>;
  const latest = program.ratifications?.at(-1);
  const pending = prerequisitesOf(program).filter((p) => p.status !== "satisfied");
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          status={program.status === "ratified" ? "succeeded" : "pending"}
          label={program.status ?? "planning"}
        />
        {latest === undefined ? null : (
          <span className="text-muted-foreground">
            ratified {when(latest.ratifiedAt)} · plan{" "}
            <code className="font-mono">{latest.planHash.slice(0, 12)}</code>
          </span>
        )}
      </div>
      {pending.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer text-status-warning-foreground">
            {pending.length} pending prerequisite{pending.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 ml-4 list-disc">
            {pending.map((p) => (
              <li key={p.id}>
                <span className="font-medium">{p.id}</span> {p.description}
                <pre className="mt-1 rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                  {p.remediation}
                </pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

/** A program's latest run's status (D-P13-09), on its card. */
const LatestRunStatus = ({ program, runs }: ProgramWithRuns) => {
  const latest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const status = useRunStatus(latest);
  if (latest === undefined) return <p className="text-sm text-muted-foreground">Not run yet.</p>;
  if (status.isPending) return <Skeleton className="h-6 w-2/3" />;
  if (status.data === undefined) return null;
  return (
    <div className="grid gap-2">
      <ProgramStatusSummary status={status.data.status} compact />
      <Link
        to={`/projects/${program.projectId}/programs/${program.programId}/runs/${latest.runId}`}
        className="text-sm font-medium underline-offset-4 hover:underline"
      >
        Open run {shortId(latest.runId)} · {when(latest.startedAt)}
      </Link>
    </div>
  );
};

interface RunRow {
  readonly program: ProgramContract;
  readonly run: Run;
}

const runColumns = (projectId: ProjectId): ColumnDef<RunRow, unknown>[] => [
  {
    id: "run",
    header: "Run",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        to={`/projects/${projectId}/programs/${row.original.program.programId}/runs/${row.original.run.runId}`}
        className="font-mono underline-offset-4 hover:underline"
      >
        {shortId(row.original.run.runId)}
      </Link>
    ),
  },
  { id: "program", header: "Program", accessorFn: (row) => row.program.objective },
  {
    id: "status",
    header: "Status",
    accessorFn: (row) => row.run.status,
    cell: ({ row }) => <StatusBadge status={row.original.run.status} />,
  },
  { id: "where", header: "Where", accessorFn: (row) => row.run.location, enableSorting: false },
  {
    id: "started",
    header: "Started",
    accessorFn: (row) => row.run.startedAt,
    cell: ({ row }) => when(row.original.run.startedAt),
  },
  {
    id: "ended",
    header: "Ended",
    accessorFn: (row) => row.run.endedAt ?? "",
    cell: ({ row }) => when(row.original.run.endedAt),
  },
  {
    id: "took",
    header: "Took",
    enableSorting: false,
    cell: ({ row }) => between(row.original.run.startedAt, row.original.run.endedAt),
  },
  {
    id: "outcome",
    header: "Outcome",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.run.outcomeReason ?? ""}</span>
    ),
  },
];

export const ProjectPage = () => {
  const projectId = useProjectId();
  const project = useProject(projectId);
  const programs = usePrograms(projectId);
  const [editing, setEditing] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  if (project.isPending || programs.isPending)
    return <p className="text-muted-foreground">Loading project…</p>;
  if (project.isError)
    return <p role="alert">Could not read the project: {String(project.error)}</p>;
  if (programs.isError)
    return <p role="alert">Could not list programs: {String(programs.error)}</p>;
  if (project.data === undefined) return <p role="alert">No such project.</p>;

  const runs: RunRow[] = programs.data.flatMap(({ program, runs }) =>
    runs.map((run) => ({ program, run })),
  );
  const statuses = [...new Set(runs.map((r) => r.run.status))].sort();
  const shown = statusFilter === "all" ? runs : runs.filter((r) => r.run.status === statusFilter);

  return (
    <section>
      <PageHeader
        title={project.data.name}
        description={
          <>
            {project.data.description === undefined ? null : <p>{project.data.description}</p>}
            <p className="font-mono text-xs">{project.data.projectId}</p>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/projects/${project.data.projectId}/settings`}>
                <Settings /> Project settings
              </Link>
            </Button>
          </>
        }
      />
      {editing ? <EditProject project={project.data} onDone={() => setEditing(false)} /> : null}

      <h2 className="mb-3 text-lg font-semibold">Programs</h2>
      {programs.data.length === 0 ? (
        <p className="mb-6 text-muted-foreground">No programs yet.</p>
      ) : (
        <ul className="mb-8 grid gap-4 lg:grid-cols-2">
          {programs.data.map(({ program, runs }) => (
            <li key={program.programId}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle>{program.objective}</CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{program.programId}</span>
                    <span>
                      · {runs.length} run{runs.length === 1 ? "" : "s"}
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <CardStories program={program} />
                  <LatestRunStatus program={program} runs={runs} />
                  <PlanState program={program} />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Runs</h2>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-40" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DataTable
        label="Runs"
        columns={runColumns(projectId)}
        rows={shown}
        initialSort={[{ id: "started", desc: true }]}
        empty="No runs yet."
      />
    </section>
  );
};
