/** Retryable project preparation. It never resets the checkout or ends a run. */
import {
  type Dispatch,
  declaredSecrets,
  type ProgramContract,
  redactSecrets,
} from "@nightshift/contracts";
import { maskCredentials, type RunScope } from "@nightshift/core";
import { z } from "zod";
import { parseProjectEnv } from "../project-env.js";
import type { Machine } from "./machine.js";
import { type Prepared, prepareProject, type WorkspaceLayout } from "./workspace.js";

export const REMOTE_WORKSPACE_ENV = "NIGHTSHIFT_REMOTE_WORKSPACE";

export const ProjectSetupStatusSchema = z.object({
  state: z.enum(["not_started", "preparing", "ready", "failed", "interrupted"]),
  attempt: z.number().int().nonnegative(),
  updatedAt: z.number(),
  detail: z.string(),
  logPath: z.string().optional(),
  prepared: z
    .object({
      setupSeconds: z.number().nonnegative(),
      lockfileHashes: z.record(z.string(), z.string()),
      warm: z.boolean(),
    })
    .optional(),
});
export type ProjectSetupStatus = z.infer<typeof ProjectSetupStatusSchema>;
export type SetupExclusive = (task: () => Promise<void>) => Promise<void>;

export interface ProjectSetup {
  readonly scope: RunScope;
  readonly preparing: boolean;
  status(): Promise<ProjectSetupStatus>;
  /** Starts asynchronously; status() observes completion without an MCP timeout. */
  prepare(exclusive?: SetupExclusive): Promise<ProjectSetupStatus>;
}

interface SetupInput {
  readonly machine: Machine;
  readonly scope: RunScope;
  readonly layout: WorkspaceLayout;
  readonly projectEnv: Record<string, string>;
  readonly projectUser: string;
  readonly load: () => Promise<{ dispatch: Dispatch; program: ProgramContract }>;
  /** Test seam: production always uses the same checkout preparation implementation. */
  readonly perform?: typeof prepareProject;
  /** A-62: where the program's declared secrets are read from, by name. */
  readonly secretsFrom?: Readonly<Record<string, string | undefined>>;
}

/** Output may contain arbitrary project text: redact credential-shaped values before returning it. */
const redact = (value: string): string =>
  maskCredentials(value).text.replace(
    /(\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi,
    "$1[masked]",
  );
export const createProjectSetup = (input: SetupInput): ProjectSetup => {
  const { machine, layout } = input;
  // A-62: what this preparation was given, masked out of its log and its diagnostics.
  let secrets: Readonly<Record<string, string>> = {};
  const clean = (value: string): string => redactSecrets(redact(value), secrets);
  const diagnostic = (value: string): string => clean(value).slice(-4000);
  const file = `${layout.run}/project-setup.json`;
  let current: ProjectSetupStatus = {
    state: "not_started",
    attempt: 0,
    updatedAt: machine.now(),
    detail: "Project preparation has not been requested.",
  };
  let pending: Promise<void> | undefined;
  let loading: Promise<void> | undefined;
  const load = (): Promise<void> => {
    loading ??= (async () => {
      const text = await machine.readFile(file);
      if (text === undefined) return;
      try {
        current = ProjectSetupStatusSchema.parse(JSON.parse(text));
        if (current.state === "preparing") {
          current = {
            ...current,
            state: "interrupted",
            detail: "The preparation process stopped. Call environment.prepare to retry safely.",
          };
        }
      } catch {
        current.detail =
          "The previous preparation status was unreadable; preparation can be retried.";
      }
    })();
    return loading;
  };
  // Persist lifecycle only, not command output or arbitrary project secrets.
  const persist = async (): Promise<void> => {
    await machine.writeFile(
      file,
      `${JSON.stringify({
        ...current,
        detail:
          current.state === "failed"
            ? "Project preparation failed. Retry to collect fresh diagnostics."
            : current.state === "preparing"
              ? "Project preparation is in progress."
              : current.detail,
      })}\n`,
    );
  };
  const replaceEnvironment = (environment: Prepared["environment"]): void => {
    for (const key of Object.keys(input.projectEnv)) delete input.projectEnv[key];
    Object.assign(input.projectEnv, environment);
  };
  return {
    scope: input.scope,
    get preparing() {
      return pending !== undefined;
    },
    status: async () => {
      await load();
      return { ...current };
    },
    prepare: async (exclusive = (task) => task()) => {
      await load();
      if (pending !== undefined) return { ...current };
      const logPath = `${layout.run}/project-setup-${current.attempt + 1}.log`;
      current = {
        state: "preparing",
        attempt: current.attempt + 1,
        updatedAt: machine.now(),
        detail: "Preparing the project. Poll environment.status for progress.",
        logPath,
      };
      let log = "";
      let logWrite = Promise.resolve();
      const append = (line: string) => {
        log += `${clean(line)}\n`;
        const snapshot = log;
        logWrite = logWrite.then(() => machine.writeFile(logPath, snapshot));
        // Errors are observed at completion; do not create an unhandled rejection mid-setup.
        void logWrite.catch(() => {});
      };
      const recordFailure = (error: unknown) => {
        append(error instanceof Error ? error.message : String(error));
        current = {
          ...current,
          state: "failed",
          updatedAt: machine.now(),
          detail: diagnostic(error instanceof Error ? error.message : String(error)),
        };
      };
      const perform = () =>
        (async () => {
          await persist();
          const { dispatch, program } = await input.load();
          secrets = declaredSecrets(program.secrets, input.secretsFrom ?? {});
          const prepared = await (input.perform ?? prepareProject)(machine, {
            layout,
            dispatch,
            program,
            projectUser: input.projectUser,
            secrets,
            log: (line) => {
              append(line);
              current = { ...current, detail: diagnostic(line), updatedAt: machine.now() };
            },
          });
          replaceEnvironment(prepared.environment);
          current = {
            ...current,
            state: "ready",
            updatedAt: machine.now(),
            detail:
              "Project preparation completed. Required verification still runs before integration.",
            prepared: {
              setupSeconds: prepared.setupSeconds,
              lockfileHashes: prepared.lockfileHashes,
              warm: prepared.warm,
            },
          };
        })()
          .catch(async (error: unknown) => {
            recordFailure(error);
            // Runtime installation may have succeeded before a setup command failed.
            // Repair workers must get that environment, not this MCP process's image PATH.
            const environment = await machine
              .readFile(`${layout.run}/project.env`)
              .catch(() => undefined);
            if (environment !== undefined) replaceEnvironment(parseProjectEnv(environment));
          })
          .finally(async () => {
            try {
              await logWrite.catch(() => {});
              await persist();
            } catch {
              // Losing a diagnostic file must not turn a recoverable setup failure into a dead server.
            }
          });
      // The engine holds its scheduler/merge mutex for the entire preparation,
      // including environment refresh after a failed command, not merely this tool's return.
      pending = Promise.resolve()
        .then(() => exclusive(perform))
        .catch(async (error: unknown) => {
          // An active worker refused the lock: no project command or environment mutation occurred.
          recordFailure(error);
          await logWrite.catch(() => {});
          await persist().catch(() => {});
        })
        .finally(() => {
          pending = undefined;
        });
      return { ...current };
    },
  };
};
