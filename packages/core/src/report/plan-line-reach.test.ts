/**
 * A plan run's report says where this run's work reached the project's line,
 * attributing entries by the run's published program-branch heads.
 */
import type { IsoTimestamp } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import type { ProjectStores } from "../ports/stores.js";
import {
  createFixtures,
  type Fixtures,
  makeDispatch,
  makeLineRecord,
  makeLineVerification,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "../testing/factories.js";
import { gatherReport, renderReport } from "./report.js";

const page = <T>(items: readonly T[]) => Promise.resolve({ items });
const sha = (c: string) => c.repeat(40);
const AT = "2026-10-01T00:00:00.000Z" as IsoTimestamp;
const BRANCH = "nightshift/develop";

const intent = (digit: string) => ({
  head: sha(digit),
  expectedPredecessor: sha("0"),
  bundleKey: `bundle/${digit}`,
  status: "published",
  requestedAt: AT,
});

const render = async (
  heads: readonly string[],
  line: unknown,
  options: { hasLine?: boolean; program?: string } = {},
) => {
  const f: Fixtures = createFixtures();
  const run = makeRun(f, { status: "succeeded", startedAt: AT, endedAt: AT });
  const dispatch = makeDispatch(f, {
    publication: { intents: heads.map(intent) } as never,
  });
  const stores = {
    programContracts: {
      get: () =>
        Promise.resolve(
          makeProgramContract(f, options.hasLine === false ? {} : { line: { branch: BRANCH } }),
        ),
      listByProject: () => page([]),
    },
    runs: { get: () => Promise.resolve(run), listByProgram: () => page([run]) },
    executionNodes: { listByRun: () => page([makeRootNode(f)]) },
    jobContracts: { listByRun: () => page([]) },
    decisions: { listByRun: () => page([]), get: () => Promise.resolve(undefined) },
    events: { listByRun: () => page([]) },
    measurements: { listByRun: () => page([]) },
    dispatches: { get: () => Promise.resolve(dispatch) },
    computeUtilizations: { get: () => Promise.resolve(undefined) },
    agents: { listByNode: () => Promise.resolve([]) },
    routingDecisions: { listByNode: () => Promise.resolve([]) },
    examinations: { listByNode: () => Promise.resolve([]) },
    verifications: { listByNode: () => Promise.resolve([]) },
    gateHealth: { get: () => Promise.resolve(undefined) },
    lines: { get: () => Promise.resolve(line === undefined ? undefined : line) },
  } as unknown as ProjectStores;
  const record = typeof line === "function" ? line(f) : line;
  (stores.lines as unknown as { get: () => Promise<unknown> }).get = () => Promise.resolve(record);
  const report = await gatherReport(stores, f.scope);
  return { f, report, text: renderReport(report) };
};

const entry = (f: Fixtures, digit: string) => ({
  program: f.scope.programId,
  upTo: sha(digit),
  enqueuedAt: AT,
});
const composition = (f: Fixtures, id: string, digit: string, pushed: boolean) => ({
  compositionId: id,
  commit: sha("f"),
  parent: sha("e"),
  ranges: [{ program: f.scope.programId, upTo: sha(digit) }],
  verification: makeLineVerification(f),
  composedAt: AT,
  ...(pushed ? { pushed: { at: AT } } : {}),
});
const recordWith = (build: (f: Fixtures) => Record<string, unknown>) => (f: Fixtures) =>
  makeLineRecord(f, build(f) as never);

describe("a plan run's report of the project's line", () => {
  it("says a queued head is waiting for the owner", async () => {
    const { text } = await render(
      ["a"],
      recordWith((f) => ({ queue: [entry(f, "a")] })),
    );
    expect(text).toContain(`## Line \`${BRANCH}\``);
    expect(text).toContain("queued, waiting for the line's owner");
    expect(text).toContain("Promotion beyond the line is the project's own");
  });

  it("says a head is in the batch being composed", async () => {
    const { text } = await render(
      ["a"],
      recordWith((f) => ({
        batch: { batchId: "b1", entries: [entry(f, "a")], takenAt: AT, generation: 1 },
      })),
    );
    expect(text).toContain("being composed");
  });

  it("says a head is held for repair", async () => {
    const { text } = await render(
      ["a"],
      recordWith((f) => ({ held: [{ ...entry(f, "a"), repairs: 2 }] })),
    );
    expect(text).toContain("held for repair (2 repair(s) spent)");
  });

  it("says a composition, pushed or not", async () => {
    const pushed = await render(
      ["a"],
      recordWith((f) => ({ compositions: [composition(f, "c1", "a", true)] })),
    );
    expect(pushed.text).toContain(`composed onto the line at \`${sha("f").slice(0, 12)}\`, pushed`);
    const local = await render(
      ["a"],
      recordWith((f) => ({ compositions: [composition(f, "c1", "a", false)] })),
    );
    expect(local.text).toContain("not yet pushed");
  });

  it("says a parked head with its reason", async () => {
    const { text } = await render(
      ["a"],
      recordWith((f) => ({
        parked: [
          {
            compositionId: "p1",
            ranges: [{ program: f.scope.programId, upTo: sha("a") }],
            reason: "the line is protected",
            parkedAt: AT,
          },
        ],
      })),
    );
    expect(text).toContain("parked: the line is protected");
  });

  it("lists each state of a run with two heads in different places", async () => {
    const { report, text } = await render(
      ["a", "b"],
      recordWith((f) => ({
        queue: [entry(f, "b")],
        compositions: [composition(f, "c1", "a", true)],
      })),
    );
    expect(report.lineReach?.heads.map((h) => h.states.map((s) => s.kind))).toEqual([
      ["composed"],
      ["queued"],
    ]);
    expect(text).toContain(sha("a").slice(0, 12));
    expect(text).toContain("queued, waiting");
    expect(text).toContain("pushed");
  });

  it("does not show an earlier run's composition as this run's", async () => {
    const { report, text } = await render(
      ["b"],
      recordWith((f) => ({
        compositions: [composition(f, "earlier_run", "a", true)],
        queue: [{ ...entry(f, "b"), program: "prog_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      })),
    );
    expect(report.lineReach?.heads[0]?.states).toEqual([]);
    expect(text).not.toContain("composed onto the line");
    expect(text).not.toContain("queued, waiting");
    expect(text).toContain("not shown");
  });

  it("says a published head absent from the retained record is not shown, not unqueued", async () => {
    const { text } = await render(
      ["a"],
      recordWith(() => ({})),
    );
    expect(text).toContain("not shown");
    expect(text).toContain("no longer shows it, or it has not been queued yet");
  });

  it("says so when the run published nothing", async () => {
    const { text } = await render(
      [],
      recordWith(() => ({})),
    );
    expect(text).toContain("its work has not reached the line");
  });

  it("has no section for a project without a line", async () => {
    const { report, text } = await render(["a"], undefined, { hasLine: false });
    expect(report.lineReach).toBeUndefined();
    expect(text).not.toContain("Promotion beyond the line");
    expect(text).not.toContain("## Line `");
  });

  it("never says pull request", async () => {
    const { text } = await render(
      ["a", "b"],
      recordWith((f) => ({ queue: [entry(f, "a")] })),
    );
    expect(text.toLowerCase()).not.toContain("pull request");
  });
});
