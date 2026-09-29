/**
 * `nightshift local` and `nightshift use` (P12, D-P12-01, D-P12-05).
 *
 * `local` starts the local instance of the control plane in the foreground,
 * writes the `local` profile once it is listening (which selects it, so every
 * command and MCP server after this talks to it), and opens the Studio. The
 * profile stays when it stops; `nightshift use <stage>` switches back.
 */
import { existsSync } from "node:fs";
import {
  isTokenProfile,
  knownStages,
  readProfile,
  selectStage,
  writeProfile,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { LOCAL_STAGE } from "./login.js";

/** The line `nightshift-local` prints once it listens: api, studio URL, token file. */
export const READY_LINE = "NIGHTSHIFT_LOCAL_READY";

export interface LocalOptions {
  readonly port?: string;
  readonly state?: string;
  /** Open the Studio in a browser once the plane is up. */
  readonly open: boolean;
}

export const runLocal = async (
  environment: CliEnvironment,
  options: LocalOptions,
): Promise<number> => {
  const bin = environment.assets?.localPath;
  if (environment.launch === undefined || bin === undefined || !existsSync(bin)) {
    throw new UsageError(
      "this build of the CLI does not carry the local instance",
      "Run `npm run build` in the Nightshift repository, then `nightshift local` again.",
    );
  }
  const studio = environment.assets?.studioDir;
  const args = [
    // `node:sqlite` is stable from Node 24; the flag keeps an older Node quiet.
    "--no-warnings=ExperimentalWarning",
    bin,
    ...(options.port === undefined ? [] : ["--port", options.port]),
    ...(options.state === undefined ? [] : ["--state", options.state]),
    ...(studio !== undefined && existsSync(studio) ? ["--studio", studio] : []),
  ];
  return environment.launch(process.execPath, args, async (line) => {
    if (!line.startsWith(`${READY_LINE}\t`)) {
      environment.out(line);
      return;
    }
    const [, apiEndpoint, studioUrl, tokenFile] = line.split("\t");
    if (apiEndpoint === undefined || studioUrl === undefined || tokenFile === undefined) {
      environment.err(`the local instance printed a ready line this CLI cannot read: ${line}`);
      return;
    }
    await writeProfile(
      { apiEndpoint, stage: LOCAL_STAGE, auth: "token", tokenFile },
      environment.paths,
    );
    environment.out(`control plane ${apiEndpoint} (stage local, now the current stage)`);
    environment.out(`Studio        ${studioUrl}`);
    environment.out("`nightshift use <stage>` switches back to a hosted stage.");
    if (options.open) await environment.openBrowser(studioUrl).catch(() => undefined);
  });
};

export const useStage = async (environment: CliEnvironment, stage: string): Promise<number> => {
  const stages = knownStages(environment.paths);
  if (!stages.includes(stage)) {
    throw new UsageError(
      `no profile for stage \`${stage}\``,
      stages.length === 0
        ? "Sign in with `nightshift login`, or start `nightshift local`."
        : `This machine has: ${stages.join(", ")}.`,
    );
  }
  selectStage(stage, environment.paths);
  const profile = await readProfile(environment.paths, stage);
  environment.out(
    `using ${stage}${profile === undefined ? "" : ` (${profile.apiEndpoint}${isTokenProfile(profile) ? ", a local instance" : ""})`}`,
  );
  return 0;
};
