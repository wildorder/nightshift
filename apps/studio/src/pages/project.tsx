/**
 * A project: its programs, one slim row each, what is being built first, each
 * with its runs (T3, D-P11-10; slimmed 2026-10-24, the owner: "programs should
 * be listed the way runs are listed today"). A run is one attempt at a
 * program, so runs are listed under theirs. Runs are gathered by listing each
 * program's runs; no index is added for it.
 */
import type { PlanDraft, ProgramContract, Project, ProjectId, Run } from "@nightshift/contracts";
import { ProjectIdSchema } from "@nightshift/contracts";
import { prerequisitesOf } from "@nightshift/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Settings } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "../components/page-header.js";
import { StatusBadge } from "../components/status-badge.js";
import { between, readable, shortId } from "../lib/format.js";
import { planPathOf } from "../lib/paths.js";
import { readAll } from "../lib/read-all.js";
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

const usePlanDrafts = (projectId: ProjectId) => {
  const { stores } = useStudio();
  return useQuery({
    queryKey: ["plan-drafts", projectId],
    queryFn: (): Promise<readonly PlanDraft[]> =>
      readAll((page) => stores.planDrafts.listByProject(projectId, page)),
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

/** One program as the project page lists it: its contract when ratified, its draft, and its runs. */
interface ProgramRow {
  readonly programId: string;
  /** The program's name on the plane (its directory name); its id when it has none. */
  readonly name: string;
  readonly objective?: string;
  readonly program?: ProgramContract;
  readonly draft?: PlanDraft;
  readonly runs: readonly Run[];
  /** The latest run, when it has run. */
  readonly latest?: Run;
}

const LIVE_RUN_STATUSES: ReadonlySet<Run["status"]> = new Set(["pending", "running"]);

const latestOf = (runs: readonly Run[]): Run | undefined =>
  [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

/** When the program last did anything: its latest run's start, else its draft's last change. */
const lastActivity = (row: ProgramRow): string =>
  row.latest?.startedAt ?? row.draft?.updatedAt ?? row.program?.createdAt ?? "";

/**
 * Every program of the project, contract or draft alike, once each: what is
 * being built first (a live run), then the most recently active.
 */
export const programRows = (
  programs: readonly ProgramWithRuns[],
  drafts: readonly PlanDraft[],
): readonly ProgramRow[] => {
  const draftOf = new Map(drafts.map((draft) => [draft.programId as string, draft]));
  const rows: ProgramRow[] = programs.map(({ program, runs }) => {
    const draft = draftOf.get(program.programId);
    const latest = latestOf(runs);
    return {
      programId: program.programId,
      name: draft?.name ?? program.programId,
      objective: program.objective,
      program,
      ...(draft === undefined ? {} : { draft }),
      runs,
      ...(latest === undefined ? {} : { latest }),
    };
  });
  const listed = new Set(rows.map((row) => row.programId));
  for (const draft of drafts) {
    if (listed.has(draft.programId)) continue;
    rows.push({ programId: draft.programId, name: draft.name ?? draft.programId, draft, runs: [] });
  }
  const live = (row: ProgramRow): boolean =>
    row.latest !== undefined && LIVE_RUN_STATUSES.has(row.latest.status);
  return rows.sort(
    (a, b) => Number(live(b)) - Number(live(a)) || lastActivity(b).localeCompare(lastActivity(a)),
  );
};

/** A program's status in one badge: its latest run's, or where its plan stands when it has not run. */
const ProgramBadge = ({ row }: { readonly row: ProgramRow }) => {
  if (row.latest !== undefined) return <StatusBadge status={row.latest.status} />;
  const state = row.draft?.state ?? row.program?.status ?? "planning";
  return (
    <StatusBadge
      status={state === "ratified" ? "succeeded" : "pending"}
      label={state === "ratified" ? "ratified, not run" : state.replace("_", " ")}
    />
  );
};

const runPath = (projectId: ProjectId, run: Run): string =>
  `/projects/${projectId}/programs/${run.programId}/runs/${run.runId}`;

/** A program's runs, newest first, shown when its row is opened. */
const ProgramRuns = ({
  projectId,
  runs,
}: {
  readonly projectId: ProjectId;
  readonly runs: readonly Run[];
}) => (
  <ul className="mt-2 grid gap-1 border-l pl-3 text-sm" aria-label="Runs">
    {[...runs]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => (
        <li key={run.runId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to={runPath(projectId, run)}
            className="font-mono underline-offset-4 hover:underline"
          >
            {shortId(run.runId)}
          </Link>
          <StatusBadge status={run.status} />
          <span className="text-muted-foreground">
            {readable(run.startedAt)}
            {run.endedAt === undefined ? "" : ` · took ${between(run.startedAt, run.endedAt)}`}
          </span>
          {run.outcomeReason === undefined ? null : (
            <span
              className="min-w-0 basis-full truncate text-muted-foreground"
              title={run.outcomeReason}
            >
              {run.outcomeReason}
            </span>
          )}
        </li>
      ))}
  </ul>
);

/** One program, slim: name, status, runs, when it last ran; its objective in full beneath. */
const ProgramItem = ({
  projectId,
  row,
  now,
}: {
  readonly projectId: ProjectId;
  readonly row: ProgramRow;
  readonly now: number;
}) => {
  const [open, setOpen] = useState(false);
  const pending =
    row.program === undefined
      ? 0
      : prerequisitesOf(row.program).filter((p) => p.status !== "satisfied").length;
  return (
    <li className="border-b py-3 last:border-b-0" data-testid="program-row">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          to={planPathOf({ projectId, programId: row.programId } as never)}
          className="font-mono font-medium underline-offset-4 hover:underline"
          title="The plan"
        >
          {row.name}
        </Link>
        <ProgramBadge row={row} />
        {row.latest === undefined ? null : (
          <Link
            to={runPath(projectId, row.latest)}
            className="text-sm underline-offset-4 hover:underline"
          >
            last run {readable(row.latest.startedAt, now)}
          </Link>
        )}
        {pending === 0 ? null : (
          <span className="text-sm text-status-warning-foreground">
            {pending} prerequisite{pending === 1 ? "" : "s"} pending
          </span>
        )}
        {row.runs.length === 0 ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            {row.runs.length} run{row.runs.length === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      {row.objective === undefined ? null : (
        <p className="mt-1 text-sm text-muted-foreground">{row.objective}</p>
      )}
      {open ? <ProgramRuns projectId={projectId} runs={row.runs} /> : null}
    </li>
  );
};

export const ProjectPage = () => {
  const projectId = useProjectId();
  const project = useProject(projectId);
  const programs = usePrograms(projectId);
  const drafts = usePlanDrafts(projectId);
  const [editing, setEditing] = useState(false);
  if (project.isPending || programs.isPending)
    return <p className="text-muted-foreground">Loading project…</p>;
  if (project.isError)
    return <p role="alert">Could not read the project: {String(project.error)}</p>;
  if (programs.isError)
    return <p role="alert">Could not list programs: {String(programs.error)}</p>;
  if (project.data === undefined) return <p role="alert">No such project.</p>;

  const rows = programRows(programs.data, drafts.data ?? []);
  const now = Date.now();

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
      {drafts.isError ? (
        <p role="alert" className="mb-3 text-sm text-muted-foreground">
          Could not list plan drafts: {String(drafts.error)}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="mb-6 text-muted-foreground">No programs yet.</p>
      ) : (
        <ul className="mb-8" aria-label="Programs">
          {rows.map((row) => (
            <ProgramItem key={row.programId} projectId={projectId} row={row} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
};
