/**
 * What a verification records of what it ran against: the environment it ran
 * in, the gate fingerprint at its commit, and (for the end gates) the base the
 * head stands on.
 */
import type { CommitSha, Verification } from "@nightshift/contracts";
import type { GateHealthStore } from "@nightshift/core";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import { fingerprintAtCommit, gitBlobReader } from "./gate-fingerprint.js";
import type { GateDefinitions } from "./gate-repair.js";
import { tryGit } from "./git/index.js";

/** Where this engine runs, as a verification records it. */
export const verificationEnvironmentOf = (
  site: ExecutionEnvironment["site"],
): NonNullable<Verification["environment"]> =>
  site === undefined || site.where === "laptop"
    ? { where: "laptop" }
    : {
        where: "machine",
        generation: site.dispatch.generation,
        imageVersion: site.imageVersion ?? "unknown",
      };

/**
 * The P15 fingerprint of the gates at `commit`, from the project's gate-health
 * record. Absent with no store or no record (no machinery), and when it cannot
 * be computed: a verification never fails for it.
 */
export const gateFingerprintOf = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  session: Pick<RunSession, "scope" | "repoPath">,
  commit: CommitSha,
  gates: GateDefinitions,
): Promise<string | undefined> => {
  try {
    const store = environment.stores.gateHealth as GateHealthStore | undefined;
    if (store === undefined) return undefined;
    const record = await store.get(session.scope.projectId);
    if (record === undefined) return undefined;
    return await fingerprintAtCommit(
      gitBlobReader(session.repoPath),
      commit,
      { setup: [...gates.setup], verification: [...gates.verification] },
      record.machinery,
    );
  } catch {
    return undefined;
  }
};

/**
 * What the end gates' head stands on: its merge-base with the base branch
 * (local, then `origin/`), or the head itself when neither resolves.
 */
export const endGatesBaseOf = async (
  environment: Pick<ExecutionEnvironment, "git">,
  session: Pick<RunSession, "program" | "repoPath">,
  head: CommitSha,
): Promise<CommitSha> => {
  const branch = session.program.repository.baseBranch;
  for (const ref of [branch, `origin/${branch}`]) {
    const result = await tryGit(environment.git, ["merge-base", head, ref], {
      cwd: session.repoPath,
    });
    if (result.exitCode === 0 && result.stdout.trim() !== "") {
      return result.stdout.trim() as CommitSha;
    }
  }
  return head;
};
