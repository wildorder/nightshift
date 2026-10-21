/**
 * A stateful stand-in for the feedback and completion routes (P20), and a
 * repository holding one program, for `rate` and `completion` tests.
 *
 * It answers reads from what the test seeded and lets a test decide what each
 * write is answered with, so the stale, refused and not-found paths can be
 * produced on demand. Everything else goes to the ordinary fake control plane.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompletionHistory,
  CompletionMeasurement,
  IsoTimestamp,
  ProgramContract,
  Run,
  RunFeedback,
} from "@nightshift/contracts";
import { createFixtures, type Fixtures, makeProgramContract, makeRun } from "@nightshift/core";
import type { FetchLike } from "@nightshift/persistence/http";
import {
  createFakeControlPlane,
  createTestEnvironment,
  DEFAULT_TEST_ORG,
  type FakeResponse,
  type RecordedRequest,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_SUBJECT,
  type TestEnvironment,
} from "./harness.js";

export const DEFAULT_ORG = DEFAULT_TEST_ORG;
export const PROGRAM_DIRECTORY = "p20-fixture";

export interface World {
  readonly f: Fixtures;
  readonly created: TestEnvironment;
  readonly contract: ProgramContract;
  readonly runs: Run[];
  readonly feedback: Map<string, RunFeedback>;
  readonly histories: CompletionHistory[];
  readonly contracts: ProgramContract[];
  /** The run's records a report reads; empty unless a test fills them. */
  readonly records: {
    readonly nodes: unknown[];
    readonly routes: unknown[];
    readonly measurements: unknown[];
    readonly agents: unknown[];
  };
  /** Every write the CLI made, in order, with its body parsed. */
  readonly puts: { readonly path: string; readonly body: Record<string, unknown> }[];
  /** What a write is answered with; default echoes it with 201. */
  answerPut: (request: RecordedRequest) => FakeResponse;
  cleanup: () => Promise<void>;
}

export const json = (status: number, body: unknown): FakeResponse => ({
  status,
  body: JSON.stringify(body),
});

export const errorBody = (status: number, code: string, message: string): FakeResponse =>
  json(status, { error: { code, message } });

/**
 * The measured block the fake gives every checkpoint it newly stores. The real
 * control plane computes it from the members' records; the fake fabricates this
 * fixed one so a test can see it survive later membership changes unchanged.
 */
export const FAKE_MEASURED: CompletionMeasurement = {
  measuredTo: "2026-09-15T12:00:00.000Z" as IsoTimestamp,
  readableMembers: 2,
  measuredMembers: 2,
  unmeasuredMembers: 0,
  earliestStart: "2026-09-15T08:00:00.000Z" as IsoTimestamp,
  leadTimeSeconds: 14_400,
  runCompletionSeconds: 10_800,
  activeSeconds: 7_200,
  tokens: { input: 1000, output: 500, inputConventionUnknown: 0 },
  usd: { estimated: 1.5, reported: 2.25 },
  reportedAttempts: 2,
  estimatedAttempts: 2,
  coverage: { complete: 2, partial: 0, unknown: 0, legacy: 0, missing: 0 },
  infrastructure: { usd: 0.5, members: 2, withoutMachine: 0 },
  combined: {
    usd: 2,
    model: 1.5,
    infrastructure: 0.5,
    coverage: {
      measuredMembers: 2,
      unmeasuredMembers: 0,
      estimateIncomplete: 0,
      membersWithoutMachine: 0,
    },
    lowerBound: false,
    priceBases: [{ model: "model-a", source: "table", version: "v7", incomplete: false }],
  },
  recordedAt: "2026-09-15T12:00:00.000Z" as IsoTimestamp,
};

/**
 * A stateful put: stores the proposal, keeping each stored checkpoint as it was
 * and giving a newly added one the fixed {@link FAKE_MEASURED} block.
 */
const storeHistory = (histories: CompletionHistory[], proposed: CompletionHistory): void => {
  const index = histories.findIndex((h) => h.completionHistoryId === proposed.completionHistoryId);
  const kept = new Map((histories[index]?.checkpoints ?? []).map((c) => [c.name, c]));
  const stored: CompletionHistory = {
    ...proposed,
    checkpoints: proposed.checkpoints.map(
      (c) => kept.get(c.name) ?? { ...c, measured: FAKE_MEASURED },
    ),
  };
  if (index < 0) histories.push(stored);
  else histories[index] = stored;
};

export const createWorld = async (): Promise<World> => {
  const f = createFixtures();
  const repo = await mkdtemp(join(tmpdir(), "nightshift-p20-"));
  const directory = join(repo, "docs", "programs", PROGRAM_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const contract = makeProgramContract(f);
  await writeFile(join(directory, "contract.json"), JSON.stringify(contract));
  await writeFile(join(directory, "plan.md"), "# The plan\n");

  const plane = createFakeControlPlane({
    apiEndpoint: TEST_API,
    authDomain: TEST_AUTH_DOMAIN,
    claims: { sub: TEST_SUBJECT, "custom:active_org": DEFAULT_TEST_ORG },
  });
  const runs: Run[] = [];
  const feedback = new Map<string, RunFeedback>();
  const histories: CompletionHistory[] = [];
  const contracts: ProgramContract[] = [contract];
  const puts: World["puts"] = [];
  const world: World = {
    f,
    created: undefined as unknown as TestEnvironment,
    contract,
    runs,
    feedback,
    histories,
    contracts,
    records: { nodes: [], routes: [], measurements: [], agents: [] },
    puts,
    answerPut: (request) => json(201, JSON.parse(request.body ?? "null")),
    cleanup: async () => {
      await world.created.cleanup();
      await rm(repo, { recursive: true, force: true });
    },
  };

  const programRuns = /^\/projects\/[^/]+\/programs\/([^/]+)\/runs$/;
  const oneRun = /^\/projects\/[^/]+\/programs\/([^/]+)\/runs\/([^/]+)$/;
  const feedbackOf = /^\/projects\/[^/]+\/programs\/([^/]+)\/runs\/([^/]+)\/feedback$/;
  const oneProgram = /^\/projects\/[^/]+\/programs\/([^/]+)$/;
  const runList = /\/runs\/[^/]+\/(nodes|jobs|decisions|events|measurements)$/;
  const nodeList = /\/nodes\/([^/]+)\/(agents|routing-decisions|examinations|verifications)$/;
  const programList = /^\/projects\/[^/]+\/programs$/;
  const projectHistories = /^\/projects\/[^/]+\/completion-histories$/;
  const oneHistory = /\/completion-histories\/(comp_[^/]+)$/;

  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (url.startsWith(TEST_API)) {
      const request: RecordedRequest = {
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      };
      const page = (items: readonly unknown[]): FakeResponse => json(200, { items });
      const reply = (response: FakeResponse) => ({
        status: response.status,
        text: async () => response.body,
      });
      if (init.method === "GET") {
        let m = feedbackOf.exec(path);
        if (m) {
          const found = feedback.get(`${m[1]}/${m[2]}`);
          return reply(found ? json(200, found) : errorBody(404, "not_found", "no feedback"));
        }
        m = oneRun.exec(path);
        if (m) {
          const found = runs.find((r) => r.programId === m?.[1] && r.runId === m?.[2]);
          return reply(found ? json(200, found) : errorBody(404, "not_found", "no run"));
        }
        m = programRuns.exec(path);
        if (m) return reply(page(runs.filter((r) => r.programId === m?.[1])));
        if (programList.test(path)) return reply(page(contracts));
        m = oneProgram.exec(path);
        if (m) {
          const found = contracts.find((c) => c.programId === m?.[1]);
          return reply(found ? json(200, found) : errorBody(404, "not_found", "no program"));
        }
        m = runList.exec(path);
        if (m) {
          const records = world.records;
          const items =
            m[1] === "nodes" ? records.nodes : m[1] === "measurements" ? records.measurements : [];
          return reply(page(items));
        }
        m = nodeList.exec(path);
        if (m) {
          const records = world.records;
          const wanted =
            m[2] === "agents" ? records.agents : m[2] === "routing-decisions" ? records.routes : [];
          return reply(
            page(
              wanted.filter((r) => (r as { executionNodeId?: string }).executionNodeId === m?.[1]),
            ),
          );
        }
        if (projectHistories.test(path)) return reply(page(histories));
        m = oneHistory.exec(path);
        if (m) {
          const found = histories.find((h) => h.completionHistoryId === m?.[1]);
          return reply(found ? json(200, found) : errorBody(404, "not_found", "no history"));
        }
      }
      if (init.method === "PUT" && (path.endsWith("/feedback") || oneHistory.test(path))) {
        puts.push({ path, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
        const answer = world.answerPut(request);
        if (oneHistory.test(path) && answer.status >= 200 && answer.status < 300) {
          storeHistory(histories, JSON.parse(init.body ?? "{}") as CompletionHistory);
        }
        return reply(answer);
      }
    }
    return plane.fetch(url, init);
  };

  (world as { created: TestEnvironment }).created = await createTestEnvironment({
    fetch,
    cwd: repo,
  });
  await signIn(world.created.environment);
  return world;
};

/** A finished run of the fixture program, or of another program. */
export const finishedRun = (
  f: Fixtures,
  overrides: Record<string, unknown> = {},
  runId = f.scope.runId,
): Run =>
  makeRun(f, {
    runId,
    status: "succeeded",
    startedAt: "2026-09-15T10:00:00.000Z",
    endedAt: "2026-09-15T11:00:00.000Z",
    ...overrides,
  } as never);
