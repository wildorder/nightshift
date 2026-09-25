/**
 * `nightshift org config get | set <file>` (P8, D-P8-02).
 *
 * An organisation's routing and examination policy: its ladders, its rules, its
 * prices, and the examination every project in it gets unless a repository or a
 * program asks for more. `get` prints what a run would get (the seeded default
 * at version 0 when nobody has written one); `set` writes a file of the same
 * shape on top of the version it was read at, and the control plane refuses a
 * write that lost a race, or a policy that is not one, with every reason.
 */
import { readFile } from "node:fs/promises";
import { OrgConfigSchema, OrgIdSchema, ProjectSchema } from "@nightshift/contracts";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";

/**
 * The org to act on: the one named, else the org that owns the projects this
 * caller can see (the acting org, D-P2-13). An org with no project yet is named.
 */
const orgOf = async (session: Session, named: string | undefined): Promise<string> => {
  if (named !== undefined) {
    const parsed = OrgIdSchema.safeParse(named);
    if (!parsed.success) throw new UsageError(`\`${named}\` is not an org id`);
    return parsed.data;
  }
  const page = (await send(session.transport, { method: "GET", path: routes.projects() })) as {
    items?: unknown[];
  };
  const first = page.items?.[0];
  if (first === undefined) {
    throw new UsageError("this org has no project yet, so name it: --org <org_…>");
  }
  return ProjectSchema.parse(first).orgId;
};

export const getOrgConfig = async (environment: CliEnvironment, org?: string): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  const config = OrgConfigSchema.parse(
    await send(session.transport, { method: "GET", path: routes.orgConfig(orgId as never) }),
  );
  environment.out(JSON.stringify(config, null, 2));
  if (config.version === 0) {
    environment.err(
      "This is the seeded default: nobody in this org has written a configuration yet.",
    );
  }
  return 0;
};

export const setOrgConfig = async (
  environment: CliEnvironment,
  file: string,
  org?: string,
): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolveFrom(environment.cwd, file), "utf8"));
  } catch (cause) {
    throw new UsageError(
      `could not read ${file} as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const edited = raw as { routingPolicy?: unknown; examinationPolicy?: unknown; version?: unknown };
  if (typeof edited.version !== "number") {
    throw new UsageError(
      "the file needs the `version` it was read at: start from `nightshift org config get > file`, edit, then set",
    );
  }
  const written = OrgConfigSchema.parse(
    await send(session.transport, {
      method: "PUT",
      path: routes.orgConfig(orgId as never),
      body: {
        routingPolicy: edited.routingPolicy,
        examinationPolicy: edited.examinationPolicy,
        replacesVersion: edited.version,
      },
    }),
  );
  environment.out(`The org's configuration is now at version ${written.version}.`);
  return 0;
};
