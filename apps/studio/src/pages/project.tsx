/**
 * A project: its programs with their plans, and every run of them (T3,
 * D-P11-10). Runs are gathered by listing each program's runs and merging; no
 * index is added for it.
 */
import type { ProgramContract, Project, ProjectId, Run } from "@nightshift/contracts";
import { ProjectIdSchema } from "@nightshift/contracts";
import { isPlanned, prerequisitesOf } from "@nightshift/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Status } from "../components/status.js";
import { between, shortId, when } from "../lib/format.js";
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

const ProjectDetails = ({ project }: { readonly project: Project }) => {
  const { stores } = useStudio();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
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
      setEditing(false);
      await client.invalidateQueries({ queryKey: ["project", project.projectId] });
      await client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  if (!editing) {
    return (
      <header className="mb-4">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        {project.description === undefined ? null : (
          <p className="text-slate-600">{project.description}</p>
        )}
        <p className="font-mono text-xs text-slate-500">{project.projectId}</p>
        <div className="mt-1 flex gap-3 text-sm">
          <button type="button" className="underline" onClick={() => setEditing(true)}>
            Edit
          </button>
          <Link to={`/projects/${project.projectId}/settings`} className="underline">
            Project settings
          </Link>
        </div>
      </header>
    );
  }
  return (
    <form
      className="mb-4 flex flex-col gap-2 rounded border border-slate-200 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label className="text-sm">
        Name
        <input
          className="ml-2 rounded border border-slate-300 px-2 py-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="text-sm">
        Description
        <input
          className="ml-2 w-96 rounded border border-slate-300 px-2 py-1"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {save.isError ? (
        <p role="alert" className="text-sm text-red-700">
          {String(save.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded bg-slate-900 px-3 py-1 text-white"
          disabled={save.isPending}
        >
          Save
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
};

const PlanState = ({ program }: { readonly program: ProgramContract }) => {
  if (!isPlanned(program))
    return <span className="text-sm text-slate-500">unplanned contract</span>;
  const latest = program.ratifications?.at(-1);
  const pending = prerequisitesOf(program).filter((p) => p.status !== "satisfied");
  return (
    <div className="text-sm">
      <Status value={program.status ?? "planning"} />{" "}
      {latest === undefined ? null : (
        <span className="text-slate-600">
          ratified {when(latest.ratifiedAt)} · plan <code>{latest.planHash.slice(0, 12)}</code>
        </span>
      )}
      {pending.length === 0 ? null : (
        <details className="mt-1">
          <summary className="cursor-pointer text-amber-800">
            {pending.length} pending prerequisite{pending.length === 1 ? "" : "s"}
          </summary>
          <ul className="ml-4 list-disc">
            {pending.map((p) => (
              <li key={p.id}>
                <b>{p.id}</b> {p.description}
                <pre className="whitespace-pre-wrap rounded bg-slate-50 p-1 text-xs">
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

export const ProjectPage = () => {
  const projectId = useProjectId();
  const project = useProject(projectId);
  const programs = usePrograms(projectId);
  if (project.isPending || programs.isPending) return <p>Loading project…</p>;
  if (project.isError)
    return <p role="alert">Could not read the project: {String(project.error)}</p>;
  if (programs.isError)
    return <p role="alert">Could not list programs: {String(programs.error)}</p>;
  if (project.data === undefined) return <p role="alert">No such project.</p>;

  const runs = programs.data
    .flatMap(({ program, runs }) => runs.map((run) => ({ program, run })))
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));

  return (
    <section>
      <ProjectDetails project={project.data} />

      <h2 className="mb-2 text-lg font-semibold">Programs</h2>
      {programs.data.length === 0 ? (
        <p className="mb-4 text-slate-600">No programs yet.</p>
      ) : (
        <ul className="mb-6 divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {programs.data.map(({ program, runs }) => (
            <li key={program.programId} className="p-3">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{program.objective}</span>
                <span className="font-mono text-xs text-slate-500">{program.programId}</span>
                <span className="ml-auto text-sm text-slate-600">
                  {runs.length} run{runs.length === 1 ? "" : "s"}
                </span>
              </div>
              <PlanState program={program} />
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-2 text-lg font-semibold">Runs</h2>
      {runs.length === 0 ? (
        <p className="text-slate-600">No runs yet.</p>
      ) : (
        <table className="w-full rounded border border-slate-200 bg-white text-sm">
          <thead className="text-left text-slate-600">
            <tr>
              <th className="p-2">Run</th>
              <th className="p-2">Program</th>
              <th className="p-2">Status</th>
              <th className="p-2">Where</th>
              <th className="p-2">Started</th>
              <th className="p-2">Ended</th>
              <th className="p-2">Took</th>
              <th className="p-2">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(({ program, run }) => (
              <tr key={run.runId} className="border-t border-slate-100">
                <td className="p-2 font-mono">
                  <Link
                    to={`/projects/${projectId}/programs/${program.programId}/runs/${run.runId}`}
                    className="underline"
                  >
                    {shortId(run.runId)}
                  </Link>
                </td>
                <td className="p-2">{program.objective}</td>
                <td className="p-2">
                  <Status value={run.status} />
                </td>
                <td className="p-2">{run.location}</td>
                <td className="p-2">{when(run.startedAt)}</td>
                <td className="p-2">{when(run.endedAt)}</td>
                <td className="p-2">{between(run.startedAt, run.endedAt)}</td>
                <td className="p-2 text-slate-600">{run.outcomeReason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};
