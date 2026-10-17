/** A prerequisite is met where the work runs: on a machine, by a check made there, once (A-58). */
import type { CheckDispatch, Prerequisite, ProgramContract } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import type { LandingEnvironment } from "./environment.js";
import { unmetWhereThisRuns } from "./prerequisites-here.js";

const dispatch = { runId: "run_1", generation: 2 } as CheckDispatch;
const docker = (status: Prerequisite["status"]): Prerequisite =>
  ({
    id: "HP-01",
    description: "Docker is reachable.",
    remediation: "Start Docker.",
    verifyCommand: 'node -e "process.exit(0)"',
    status,
  }) as Prerequisite;

const session = (prerequisite: Prerequisite) => ({
  scope: { projectId: "proj_1", programId: "prog_1", runId: "run_1" } as never,
  program: {
    projectId: "proj_1",
    programId: "prog_1",
    prerequisites: [prerequisite],
  } as unknown as ProgramContract,
  repoPath: process.cwd(),
});

const STEPS = [{ id: "db-test", command: "true", requires: ["HP-01"] }];

describe("a prerequisite, where the work runs", () => {
  it("on a machine with no check of its own, is checked there once and recorded under its generation", async () => {
    // The laptop's status says pending: on a machine it counts for nothing.
    let stored = docker("pending");
    const recorded: { id: string; exitCode: number; dispatch: CheckDispatch }[] = [];
    const environment = {
      site: { where: "machine", dispatch },
      prerequisites: {
        prerequisites: async () => [stored],
        recordDiscovered: async () => stored,
        recordMachineCheck: async (
          _scope: unknown,
          id: string,
          exitCode: number,
          at: CheckDispatch,
        ) => {
          recorded.push({ id, exitCode, dispatch: at });
          stored = {
            ...stored,
            machineChecks: [
              { where: "machine", ...at, exitCode, checkedAt: new Date().toISOString() },
            ],
          } as Prerequisite;
          return stored;
        },
      },
      clock: { now: () => Date.now() },
    } as unknown as LandingEnvironment;

    expect([...(await unmetWhereThisRuns(environment, session(stored), STEPS))]).toEqual([]);
    expect(recorded).toEqual([{ id: "HP-01", exitCode: 0, dispatch }]);
    // Asked again, the check it made stands: not run twice.
    expect([...(await unmetWhereThisRuns(environment, session(stored), STEPS))]).toEqual([]);
    expect(recorded).toHaveLength(1);
  }, 30_000);

  it("on the laptop, is the laptop's last check", async () => {
    const environment = {
      prerequisites: {
        prerequisites: async () => [docker("pending")],
        recordDiscovered: async () => docker("pending"),
      },
    } as unknown as LandingEnvironment;
    expect([...(await unmetWhereThisRuns(environment, session(docker("pending")), STEPS))]).toEqual(
      ["HP-01"],
    );
  });
});
