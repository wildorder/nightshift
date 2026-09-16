/**
 * `nightshift project create --name <name>` — mint a `proj_` id and store it.
 *
 * ## The CLI never sends an organisation (D-P2-13)
 *
 * The acting org is resolved from the validated token and never from a payload,
 * which is why the API's body schema is `ProjectBodySchema` — `Project` with
 * `orgId` omitted — and why this builds that shape rather than a `Project`.
 *
 * That is also why this goes through `routes` and `send` rather than
 * `stores.projects.put`. The store port takes a `Project`, so calling it would
 * mean inventing an `orgId` locally for the adapter to strip on the way out: a
 * value the CLI has no basis to pick, that means nothing, and that a reader
 * would reasonably mistake for the project's real org. The response carries the
 * org the control plane actually assigned, which is worth printing and which the
 * port's `put` discards.
 */
import type { ProjectBody } from "@nightshift/contracts";
import { ProjectBodySchema, ProjectSchema } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { openSession } from "../session.js";

export interface ProjectCreateOptions {
  readonly name: string;
  readonly description?: string;
}

export const createProject = async (
  environment: CliEnvironment,
  options: ProjectCreateOptions,
): Promise<{ readonly projectId: string; readonly orgId: string }> => {
  const session = await openSession(environment);
  const projectId = environment.ids.next("proj");

  const body: ProjectBody = ProjectBodySchema.parse({
    schemaVersion: 1,
    projectId,
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    createdAt: nowIso(environment.clock),
  } satisfies Record<string, unknown>);

  // Parsed on the way back so a response that drifted from the contract fails
  // here rather than in whatever reads the printed id.
  const stored = ProjectSchema.parse(
    await send(session.transport, {
      method: "PUT",
      path: routes.project(projectId),
      body,
    }),
  );

  environment.out(stored.projectId);
  environment.out(`created "${stored.name}" in org ${stored.orgId}`);
  environment.out(
    `Put ${stored.projectId} in your Program Contract's projectId, then run \`nightshift run\`.`,
  );
  return { projectId: stored.projectId, orgId: stored.orgId };
};
