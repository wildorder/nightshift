/**
 * Settings › project and policies (T3, read-only): the project's cross-account
 * role, each program contract's policies, and each run's effective policy.
 */
import { Link } from "react-router";
import { Json } from "../components/json.js";
import { shortId } from "../lib/format.js";
import { usePrograms, useProject, useProjectId } from "./project.js";

export const ProjectSettingsPage = () => {
  const projectId = useProjectId();
  const project = useProject(projectId);
  const programs = usePrograms(projectId);
  if (project.isPending || programs.isPending) return <p>Loading…</p>;
  if (project.isError || programs.isError || project.data === undefined) {
    return <p role="alert">Could not read the project.</p>;
  }
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">
        <Link to={`/projects/${projectId}`} className="underline">
          {project.data.name}
        </Link>{" "}
        · settings
      </h1>
      <div>
        <h2 className="font-semibold">Cross-account access</h2>
        {project.data.crossAccount === undefined ? (
          <p className="text-sm text-slate-600">
            None: this project reaches no AWS account of its own.
          </p>
        ) : (
          <Json label="cross-account" value={project.data.crossAccount} />
        )}
      </div>
      {programs.data.map(({ program, runs }) => (
        <div key={program.programId} className="rounded border border-slate-200 bg-white p-3">
          <h2 className="font-semibold">{program.objective}</h2>
          <p className="mb-2 font-mono text-xs text-slate-500">{program.programId}</p>
          <h3 className="mt-2 text-sm font-semibold">Contract policies</h3>
          <Json
            label={`policies of ${program.programId}`}
            value={{
              verification: program.verification,
              modelPolicy: program.modelPolicy,
              delegationLimits: program.delegationLimits,
              costPolicy: program.costPolicy,
              examinationPolicy: program.examinationPolicy,
              defaultRisk: program.defaultRisk,
              routing: program.routing,
            }}
          />
          {runs.map((run) => (
            <details key={run.runId} className="mt-2">
              <summary className="cursor-pointer text-sm">
                Effective policy of run <code>{shortId(run.runId)}</code>
                {run.policy === undefined
                  ? " (none recorded)"
                  : ` (org config v${run.policy.orgConfigVersion})`}
              </summary>
              {run.policy === undefined ? null : <Json value={run.policy} />}
            </details>
          ))}
        </div>
      ))}
    </section>
  );
};
