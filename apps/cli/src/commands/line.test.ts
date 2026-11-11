/**
 * `nightshift line status`: the report over a line view, and the refusal for a
 * project with no line configured.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Dispatch,
  type LineView,
  NIGHTSHIFT_CONFIG_FILE,
  type Run,
} from "@nightshift/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import {
  createFakeControlPlane,
  createTestEnvironment,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_EMAIL,
  TEST_SUBJECT,
  type TestEnvironment,
} from "../testing/harness.js";
import { describeLine, lineStatus, NO_LINE_CONFIGURED } from "./line.js";

const live: TestEnvironment[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

const PROJECT = "proj_00000000000000000000000001";
const ALPHA = "prog_00000000000000000000000001";
const BETA = "prog_00000000000000000000000002";
const sha = (c: string): string => c.repeat(40);
const RUN_A = "run_01J0000000000000000000000A";
const RUN_B = "run_01J0000000000000000000000B";
const AT = "2026-10-27T10:00:00.000Z";

const range = (program: string, upTo: string, from?: string) => ({
  program,
  ...(from === undefined ? {} : { from }),
  upTo,
});

const verification = (outcome = "passed") => ({
  verificationId: "ver_00000000000000000000000001",
  phase: "line",
  commitSha: sha("c"),
  baseSha: sha("b"),
  commands: [],
  outcome,
  startedAt: AT,
  endedAt: AT,
});

const view = (record: object = {}, rest: object = {}): LineView =>
  ({
    record: {
      schemaVersion: 1,
      projectId: PROJECT,
      branch: "nightshift/develop",
      repositoryUrl: "https://example.test/r.git",
      version: 1,
      queue: [],
      held: [],
      compositions: [],
      parked: [],
      updatedAt: AT,
      ...record,
    },
    programs: [
      { program: ALPHA, branch: "nightshift/alpha" },
      { program: BETA, branch: "nightshift/beta" },
    ],
    ...rest,
  }) as unknown as LineView;

const text = (lines: string[]): string => lines.join("\n");

describe("describeLine", () => {
  it("describes an empty line", () => {
    const out = text(describeLine(view({ head: sha("a") })));
    expect(out).toContain("line nightshift/develop  head aaaaaaa");
    expect(out).toContain("last push: none");
    expect(out).toContain("runs: none yet (the line's program is made when");
    expect(out).toContain("queue: empty");
    expect(out).toContain("compositions: none");
    expect(out).not.toContain("parked");
  });

  it("lists the queue with branch names and short shas", () => {
    const out = text(
      describeLine(
        view({
          queue: [
            { program: ALPHA, upTo: sha("d"), enqueuedAt: AT },
            { program: BETA, upTo: sha("e"), enqueuedAt: AT },
          ],
        }),
      ),
    );
    expect(out).toContain("queue: 2");
    expect(out).toContain(`nightshift/alpha up to ddddddd, enqueued ${AT}`);
    expect(out).toContain("nightshift/beta up to eeeeeee");
  });

  it("shows a composition with its resolver decision, ranges and push", () => {
    const out = text(
      describeLine(
        view({
          compositions: [
            {
              compositionId: "comp-1",
              commit: sha("f"),
              parent: sha("a"),
              ranges: [range(ALPHA, sha("d")), range(BETA, sha("e"), sha("1"))],
              verification: verification(),
              resolver: { decision: "resolved", attempts: 2, detail: "kept both imports" },
              composedAt: AT,
              pushed: { at: AT },
            },
          ],
        }),
      ),
    );
    expect(out).toContain(
      "fffffff  nightshift/alpha base..ddddddd, nightshift/beta 1111111..eeeeeee",
    );
    expect(out).toContain("verification passed (ver_00000000000000000000000001)");
    expect(out).toContain("resolver resolved, 2 attempts: kept both imports");
    expect(out).toContain(`pushed ${AT}`);
  });

  it("prints a composition's repair run and job contract", () => {
    const out = text(
      describeLine(
        view({
          compositions: [
            {
              compositionId: "comp-3",
              commit: sha("f"),
              parent: sha("a"),
              ranges: [range(ALPHA, sha("d"))],
              verification: verification(),
              repair: { runId: RUN_A, jobContractId: "job_00000000000000000000000001" },
              composedAt: AT,
            },
          ],
        }),
      ),
    );
    expect(out).toContain(`repair ${RUN_A} job_00000000000000000000000001`);
  });

  it("lists the runs newest first, with machine and spend, or no machine", () => {
    const running = {
      run: { runId: RUN_A, status: "running", startedAt: "2026-10-27T11:00:00.000Z" },
      dispatch: { instanceType: "c7i.xlarge", instanceId: "i-abc", spend: { meteredUsd: 1.5 } },
    } as unknown as { run: Run; dispatch: Dispatch };
    const ended = {
      run: {
        runId: RUN_B,
        status: "succeeded",
        startedAt: AT,
        endedAt: "2026-10-27T10:30:00.000Z",
      },
    } as unknown as { run: Run };
    const out = text(describeLine(view(), [running, ended]));
    expect(out).toContain("runs: 2");
    expect(out).toContain(`${RUN_A}  running (live)`);
    expect(out).toContain("c7i.xlarge i-abc, metered $1.50");
    expect(out).toContain(`${RUN_B}  succeeded`);
    expect(out).toContain("ended 2026-10-27T10:30:00.000Z  no machine");
    expect(out.indexOf(RUN_A)).toBeLessThan(out.indexOf(RUN_B));
  });

  it("shows a parked composition with its ranges and reason", () => {
    const out = text(
      describeLine(
        view({
          parked: [
            {
              compositionId: "comp-2",
              ranges: [range(BETA, sha("e"), sha("1"))],
              reason: "verification failed after the resolver gave up",
              resolver: { decision: "gave_up", attempts: 3 },
              parkedAt: AT,
            },
          ],
        }),
      ),
    );
    expect(out).toContain("parked: 1");
    expect(out).toContain("nightshift/beta 1111111..eeeeeee");
    expect(out).toContain("reason: verification failed after the resolver gave up");
    expect(out).toContain("resolver gave_up, 3 attempts");
    expect(out).toContain("(1 waiting for `nightshift line requeue`)");
  });

  it("marks a parked entry that was sent back, and counts only the rest as waiting (P25)", () => {
    const parked = (compositionId: string) => ({
      compositionId,
      ranges: [range(BETA, sha("e"), sha("1"))],
      reason: "main does not compose onto the line",
      parkedAt: AT,
    });
    const out = text(
      describeLine(
        view({
          parked: [parked("comp-2"), parked("comp-3")],
          requeued: [{ parkedId: "comp-2", at: AT, by: "user-1" }],
        }),
      ),
    );
    expect(out).toContain("parked: 2 (1 waiting for `nightshift line requeue`)");
    expect(out).toContain(`(requeued ${AT} by user-1)`);
  });

  it("shows the cap reached and why the line is waiting", () => {
    const out = text(
      describeLine(
        view(
          { waiting: { reason: "monthly_cap", detail: "the $50.00 cap is reached", since: AT } },
          {
            usage: {
              month: "2026-10",
              meteredUsd: 50,
              capUsd: 50,
              reachedAt: AT,
            },
          },
        ),
      ),
    );
    expect(out).toContain("self-started spend 2026-10: $50.00 of $50.00 cap");
    expect(out).toContain(`(reached ${AT})`);
    expect(out).toContain("waiting (monthly_cap): the $50.00 cap is reached");
  });

  it("shows a push conflict with its detail", () => {
    const out = text(
      describeLine(
        view({
          head: sha("a"),
          push: {
            head: sha("f"),
            expectedPredecessor: sha("a"),
            bundleKey: "k",
            generation: 1,
            status: "conflict",
            requestedAt: AT,
            detail: "the line moved to 9999999",
          },
        }),
      ),
    );
    expect(out).toContain("last push: conflict fffffff (from aaaaaaa): the line moved to 9999999");
  });
});

describe("nightshift line status", () => {
  it("says the project has no line and exits 1", async () => {
    const created = await createTestEnvironment();
    live.push(created);
    await writeFile(
      join(created.environment.cwd, NIGHTSHIFT_CONFIG_FILE),
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT,
        contextDocs: [],
        verification: [{ id: "test", command: "npm test" }],
        modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
        delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
        costPolicy: {},
      }),
    );
    expect(await lineStatus(created.environment, {})).toBe(1);
    expect(created.out.join("\n")).toBe(NO_LINE_CONFIGURED);
    expect(NO_LINE_CONFIGURED).toContain("`line`");
  });
});

describe("nightshift line status names the line", () => {
  it("names the line program and the branch work ships from", () => {
    const out = text(describeLine(view({ branch: "main" }, { programId: ALPHA })));
    expect(out).toContain(`line program: ${ALPHA}`);
    expect(out).toContain("line branch: main, the branch work ships from");
  });
});

describe("nightshift line requeue", () => {
  const prepare = async (requeueResponse: object = { requeued: [], run: "none" }) => {
    const plane = createFakeControlPlane({
      apiEndpoint: TEST_API,
      authDomain: TEST_AUTH_DOMAIN,
      claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
      overrides: [
        {
          path: `/projects/${PROJECT}/line/requeue`,
          response: { status: 200, body: JSON.stringify(requeueResponse) },
        },
      ],
    });
    const created = await createTestEnvironment({ fetch: plane.fetch });
    live.push(created);
    await signIn(created.environment);
    await writeFile(
      join(created.environment.cwd, NIGHTSHIFT_CONFIG_FILE),
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT,
        contextDocs: [],
        verification: [{ id: "test", command: "npm test" }],
        modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
        delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
        costPolicy: {},
        line: { branch: "main" },
      }),
    );
    return { created, plane };
  };

  it("requeues one program's parked ranges", async () => {
    const { created, plane } = await prepare({
      requeued: [{ program: ALPHA, upTo: sha("a") }],
      run: "started",
    });
    expect(await runCli(created.environment, ["line", "requeue", ALPHA])).toBe(0);
    expect(plane.calls.at(-1)).toMatchObject({
      method: "POST",
      path: `/projects/${PROJECT}/line/requeue`,
      body: { program: ALPHA },
    });
    expect(created.out.join("\n")).toContain("queued 1 range again");
  });

  it("requeues every parked range with --all", async () => {
    const { created, plane } = await prepare();
    expect(await runCli(created.environment, ["line", "requeue", "--all"])).toBe(0);
    expect(plane.calls.at(-1)?.body).toEqual({});
    expect(created.out.join("\n")).toContain("nothing new was queued");
  });

  it("is a usage error with neither a program nor --all, or with both", async () => {
    const { created, plane } = await prepare();
    expect(await runCli(created.environment, ["line", "requeue"])).toBe(2);
    expect(await runCli(created.environment, ["line", "requeue", ALPHA, "--all"])).toBe(2);
    expect(plane.calls).toEqual([]);
  });
});

describe("nightshift land for the line program", () => {
  const LINE_RUN = RUN_A;
  const held = (status: string, detail?: string) =>
    view(
      {
        branch: "main",
        head: sha("a"),
        push: {
          head: sha("f"),
          expectedPredecessor: sha("a"),
          bundleKey: "bundles/line",
          generation: 1,
          status,
          requestedAt: AT,
          ...(detail === undefined ? {} : { detail }),
        },
        waiting: { reason: "line_refused", detail: "protected branch", since: AT },
      },
      { programId: ALPHA, runId: LINE_RUN },
    );

  /** A plane whose line record is `states[0]` until the retry, then walks `after`. */
  const prepare = async (after: readonly LineView[], clock?: { now: () => number }) => {
    const plane = createFakeControlPlane({
      apiEndpoint: TEST_API,
      authDomain: TEST_AUTH_DOMAIN,
      claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
    });
    let retried = false;
    let reads = 0;
    const retries: string[] = [];
    const fetch: typeof plane.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === "POST" && path.endsWith("/publication/retry")) {
        retried = true;
        retries.push(path);
        return {
          status: 200,
          text: async () => JSON.stringify({ rearmed: 0, lineReleased: true }),
        };
      }
      if (init.method === "GET" && path === `/projects/${PROJECT}/line`) {
        const current = retried ? after[Math.min(reads++, after.length - 1)] : held("protected");
        return { status: 200, text: async () => JSON.stringify(current) };
      }
      return plane.fetch(url, init);
    };
    const created = await createTestEnvironment({
      fetch,
      ...(clock === undefined ? {} : { clock: clock as never }),
      sleep: async () => undefined,
    });
    live.push(created);
    await signIn(created.environment);
    await writeFile(
      join(created.environment.cwd, NIGHTSHIFT_CONFIG_FILE),
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT,
        contextDocs: [],
        verification: [{ id: "test", command: "npm test" }],
        modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
        delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
        costPolicy: {},
        line: { branch: "main" },
      }),
    );
    return { created, plane, retries };
  };

  it("retries a refused line push once, with no plan, intents, parked entries or landing", async () => {
    const { created, retries } = await prepare([held("pending"), held("published")]);
    expect(await runCli(created.environment, ["land", "main"]), created.err.join("\n")).toBe(0);
    expect(retries).toEqual([
      `/projects/${PROJECT}/programs/${ALPHA}/runs/${LINE_RUN}/publication/retry`,
    ]);
    expect(created.out.join("\n")).toContain("GitHub has the line");
  });

  it("finds the line program by its program id too", async () => {
    const { created, retries } = await prepare([held("published")]);
    expect(await runCli(created.environment, ["land", ALPHA])).toBe(0);
    expect(retries).toHaveLength(1);
  });

  it("fails with the reason when the line is refused again", async () => {
    const { created, retries } = await prepare([held("protected", "GH006: protected branch")]);
    expect(await runCli(created.environment, ["land", "main"])).toBe(1);
    expect(retries).toHaveLength(1);
    expect(created.err.join("\n")).toContain("GH006: protected branch");
  });

  it("stops waiting at the deadline when the push stays pending", async () => {
    let now = 0;
    const { created, retries } = await prepare([held("pending")], { now: () => (now += 60_000) });
    expect(await runCli(created.environment, ["land", "main"])).toBe(1);
    expect(retries).toHaveLength(1);
    expect(created.err.join("\n")).toContain("has not finished");
  });
});
