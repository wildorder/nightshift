import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProgramContract, Project } from "@nightshift/contracts";
import { createFixtures, makeProgramContract, makeProject } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../failures.js";
import type { TestEnvironment } from "../testing/harness.js";
import {
  createFakeControlPlane,
  createFakeGit,
  createTestEnvironment,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_EMAIL,
  TEST_SUBJECT,
} from "../testing/harness.js";
import { REMOTE_REFUSAL, run } from "./run.js";

const BASE_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const live: TestEnvironment[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Prepared {
  readonly created: TestEnvironment;
  readonly plane: ReturnType<typeof createFakeControlPlane>;
  readonly program: ProgramContract;
  readonly project: Project;
  readonly contractPath: string;
  readonly repoPath: string;
}

const prepare = async (
  options: { readonly projectExists?: boolean; readonly contract?: unknown } = {},
): Promise<Prepared> => {
  const fixtures = createFixtures();
  const project = makeProject(fixtures);
  const program = makeProgramContract(fixtures);
  const plane = createFakeControlPlane({
    apiEndpoint: TEST_API,
    authDomain: TEST_AUTH_DOMAIN,
    claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
    orgId: project.orgId,
    stored: options.projectExists === false ? [] : [project],
  });
  const repoPath = await mkdtemp(join(tmpdir(), "nightshift-repo-"));
  scratch.push(repoPath);
  const contractPath = join(repoPath, "nightshift.program.json");
  await writeFile(contractPath, JSON.stringify(options.contract ?? program, null, 2));

  const created = await createTestEnvironment({
    fetch: plane.fetch,
    cwd: repoPath,
    // `rev-parse` on the program branch is the only git call `startRun` makes
    // before `update-ref`, and neither needs a real repository here.
    git: createFakeGit({ "rev-parse": BASE_COMMIT }),
  });
  live.push(created);
  await signIn(created.environment);
  return { created, plane, program, project, contractPath, repoPath };
};

describe("nightshift run", () => {
  it("calls the shared startRun and prints the run id", async () => {
    const { created, plane, program, contractPath } = await prepare();

    const result = await run(created.environment, { contract: contractPath, remote: false });

    expect(result.runId).toMatch(/^run_/);
    expect(result.programId).toBe(program.programId);
    expect(created.out[0]).toBe(result.runId);

    // The writes `startRun` makes, in the order the API's referential integrity
    // requires. Asserted here because "the CLI must not reimplement it" is only
    // true if the CLI is visibly going through it.
    const paths = plane.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain(`GET /projects/${program.projectId}`);
    expect(paths).toContain(`PUT /projects/${program.projectId}/programs/${program.programId}`);
    expect(paths.some((path) => path.startsWith("PUT ") && path.endsWith(result.runId))).toBe(true);
    expect(paths.some((path) => path.includes("/nodes/"))).toBe(true);
    expect(paths.some((path) => path.includes("/checkpoints/"))).toBe(true);
    expect(paths.filter((path) => path.endsWith("/events"))).toHaveLength(2);
  });

  it("tells the operator to open their orchestrator in the repository", async () => {
    const { created, contractPath, repoPath } = await prepare();

    await run(created.environment, { contract: contractPath, remote: false });

    const printed = created.out.join("\n");
    expect(printed).toContain("Open your orchestrator in");
    expect(printed).toContain(repoPath);
    expect(printed).toContain("pending");
  });

  it("resolves --repo against the working directory", async () => {
    const { created, contractPath, repoPath } = await prepare();

    await run(created.environment, { contract: contractPath, repo: ".", remote: false });

    expect(created.out.join("\n")).toContain(repoPath);
  });

  it("refuses --remote for a contract file: remote execution is for a ratified plan (D-P10-09)", async () => {
    const { created, plane, contractPath } = await prepare();

    const failure = await run(created.environment, {
      contract: contractPath,
      remote: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toBe(REMOTE_REFUSAL);
    // P10 (D-P10-09): a contract file is not a ratified planned program.
    expect(REMOTE_REFUSAL).toMatch(/ratified planned program/);
    // Refused before anything was written.
    expect(plane.calls).toHaveLength(0);
  });

  it("renders a missing project as advice, not a stack trace", async () => {
    const { created, contractPath, program } = await prepare({ projectExists: false });

    const failure = await run(created.environment, {
      contract: contractPath,
      remote: false,
    }).catch((error: unknown) => error);

    expect((failure as Error).name).toBe("ProjectMissingError");
    expect((failure as Error).message).toContain(program.projectId);
    expect((failure as Error).message).toContain("nightshift project create");
  });

  it("refuses a contract that does not validate, before writing anything", async () => {
    const { created, plane, contractPath } = await prepare({
      contract: { schemaVersion: 1, objective: "" },
    });

    await expect(
      run(created.environment, { contract: contractPath, remote: false }),
    ).rejects.toThrow();
    expect(plane.calls).toHaveLength(0);
  });

  it("explains a contract path that does not exist", async () => {
    const { created, repoPath } = await prepare();

    const failure = await run(created.environment, {
      contract: "no-such-file.json",
      remote: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toContain(join(repoPath, "no-such-file.json"));
  });

  it("explains a contract that is not JSON", async () => {
    const { created, repoPath } = await prepare();
    const path = join(repoPath, "broken.json");
    await writeFile(path, "{ not json");

    const failure = await run(created.environment, { contract: path, remote: false }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toContain("not valid JSON");
  });

  it("refuses without a session", async () => {
    const created = await createTestEnvironment();
    live.push(created);
    const dir = await mkdtemp(join(tmpdir(), "nightshift-repo-"));
    scratch.push(dir);
    const path = join(dir, "contract.json");
    await writeFile(path, "{}");

    await expect(run(created.environment, { contract: path, remote: false })).rejects.toThrow(
      /not signed in/,
    );
  });
});
