/**
 * A line run's report: the compositions, parked entries and repairs inside the
 * run's window lead, and the plan sections are absent.
 */
import type { IsoTimestamp, LineRepairRef, Run } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { entryDigest, entryText, sha256Hex } from "../line/settlement.js";
import type { ProjectStores } from "../ports/stores.js";
import {
  createFixtures,
  type Fixtures,
  makeJobContract,
  makeLineRecord,
  makeLineVerification,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "../testing/factories.js";
import { gatherReport, renderReport } from "./report.js";

const at = (ms: number): IsoTimestamp =>
  new Date(Date.UTC(2026, 9, 1) + ms).toISOString() as IsoTimestamp;
const page = <T>(items: readonly T[]) => Promise.resolve({ items });
const sha = (c: string) => c.repeat(40);

const setup = (
  f: Fixtures,
  ended: Run,
  jobs: readonly unknown[] = [],
  events: readonly unknown[] = [],
) => {
  const composition = (id: string, composedAt: IsoTimestamp, repair?: LineRepairRef) => ({
    compositionId: id,
    commit: sha("a"),
    parent: sha("b"),
    ranges: [{ program: f.scope.programId, upTo: sha("c") }],
    verification: makeLineVerification(f),
    composedAt,
    ...(repair === undefined ? {} : { repair }),
  });
  const parkedEntry = (parkedAt: IsoTimestamp) => ({
    compositionId: "comp_parked",
    ranges: [{ program: f.scope.programId, upTo: sha("d") }],
    reason: "repair budget exhausted",
    parkedAt,
  });
  const stores = (line: unknown) =>
    ({
      programContracts: {
        get: () =>
          Promise.resolve(
            makeProgramContract(f, {
              kind: "line",
              line: { branch: "nightshift/develop" },
            }),
          ),
        listByProject: () => page([]),
      },
      runs: {
        get: () => Promise.resolve(ended),
        listByProgram: () => page([ended]),
      },
      executionNodes: { listByRun: () => page([makeRootNode(f)]) },
      jobContracts: { listByRun: () => page(jobs) },
      decisions: {
        listByRun: () => page([]),
        get: () => Promise.resolve(undefined),
      },
      events: { listByRun: () => page(events) },
      measurements: { listByRun: () => page([]) },
      dispatches: { get: () => Promise.resolve(undefined) },
      computeUtilizations: { get: () => Promise.resolve(undefined) },
      agents: { listByNode: () => Promise.resolve([]) },
      routingDecisions: { listByNode: () => Promise.resolve([]) },
      examinations: { listByNode: () => Promise.resolve([]) },
      verifications: { listByNode: () => Promise.resolve([]) },
      gateHealth: { get: () => Promise.resolve(undefined) },
      lines: { get: () => Promise.resolve(line) },
    }) as unknown as ProjectStores;
  return { composition, parkedEntry, stores };
};

describe("a line run's report", () => {
  it("leads with Composed, Parked and Repairs, only in-window, and omits plan sections", async () => {
    const f = createFixtures();
    const ended = makeRun(f, {
      status: "succeeded",
      startedAt: at(1000),
      endedAt: at(9000),
    });
    const repairJob = makeJobContract(f, {
      objective: "Resolve the conflict.",
      repair: {
        cause: "line_conflict",
        gates: ["test"],
        decisionId: f.ids.next("dec") as never,
      },
    });
    const { composition, parkedEntry, stores } = setup(f, ended, [repairJob]);
    const line = makeLineRecord(f, {
      head: sha("e") as never,
      compositions: [
        composition("comp_early", at(10)),
        composition("comp_in", at(2000)),
        composition("comp_repaired", at(3000), {
          runId: ended.runId,
          jobContractId: repairJob.jobContractId,
        }),
      ],
      parked: [parkedEntry(at(4000))],
    });
    const gathered = await gatherReport(stores(line), f.scope);
    expect(gathered.line?.branch).toBe("nightshift/develop");
    expect(gathered.line?.compositions.map((c) => c.compositionId)).toEqual([
      "comp_in",
      "comp_repaired",
    ]);
    expect(gathered.line?.repairs.map((r) => r.cause)).toEqual(["line_conflict"]);
    const text = renderReport(gathered);
    expect(text).toContain("a line run of `nightshift/develop`");
    const composed = text.indexOf("## Composed");
    expect(composed).toBeGreaterThan(0);
    expect(text.indexOf("## Parked")).toBeGreaterThan(composed);
    expect(text.indexOf("## Repairs")).toBeGreaterThan(text.indexOf("## Parked"));
    expect(text).toContain("Reason: repair budget exhausted");
    expect(text).toContain(`repair \`${repairJob.jobContractId}\``);
    expect(text).toContain("Resolve the conflict.");
    expect(text).not.toContain("comp_early");
    for (const heading of [
      "## Strands",
      "## Success criteria",
      "## Deferred",
      "## Human prerequisites still pending",
      "## Stories",
    ]) {
      expect(text).not.toContain(heading);
    }
    expect(text).toContain("## Usage");
  });

  it("shows entries newer than every run-scoped record of a live run, and asOf covers them", async () => {
    const f = createFixtures();
    const live = makeRun(f, { status: "running", startedAt: at(1000) });
    const { composition, parkedEntry, stores } = setup(f, live);
    const line = makeLineRecord(f, {
      compositions: [composition("comp_new", at(900_000))],
      parked: [parkedEntry(at(950_000))],
    });
    const gathered = await gatherReport(stores(line), f.scope);
    expect(gathered.line?.compositions).toHaveLength(1);
    expect(gathered.line?.parked).toHaveLength(1);
    expect(Date.parse(gathered.asOf)).toBeGreaterThanOrEqual(Date.parse(at(950_000)));
  });

  it("yields empty entries when the line record is missing, and no line for a plan", async () => {
    const f = createFixtures();
    const ended = makeRun(f, {
      status: "succeeded",
      startedAt: at(0),
      endedAt: at(10),
    });
    const { stores } = setup(f, ended);
    const gathered = await gatherReport(stores(undefined), f.scope);
    expect(gathered.line).toMatchObject({ compositions: [], parked: [] });
    expect(renderReport(gathered)).toContain("## Composed");
    const planStores = {
      ...(stores(undefined) as unknown as Record<string, unknown>),
      programContracts: {
        get: () => Promise.resolve(makeProgramContract(f, { strands: [] })),
        listByProject: () => page([]),
      },
    } as unknown as ProjectStores;
    expect((await gatherReport(planStores, f.scope)).line).toBeUndefined();
  });

  const eventOf = (
    f: Fixtures,
    type: string,
    payload: unknown,
    seq: number,
    occurredAt: string,
  ) => ({
    schemaVersion: 1,
    ...f.scope,
    eventId: f.ids.next("evt"),
    idempotencyKey: `${type}:${seq}`,
    sequence: seq,
    type,
    source: "control-plane",
    executionNodeId: null,
    agentId: null,
    payload,
    occurredAt,
    recordedAt: occurredAt,
  });

  type Entry = Parameters<typeof entryDigest>[0];
  const entryEvent = (f: Fixtures, type: string, entry: Entry, seq: number) =>
    eventOf(
      f,
      type,
      { ...entry, id: entry.compositionId, digest: entryDigest(entry) },
      seq,
      at(seq),
    );
  const markerEvent = (
    f: Fixtures,
    entries: readonly { type: string; entry: Entry }[],
    seq: number,
  ) =>
    eventOf(
      f,
      "line.settled",
      {
        batchId: "comp_batch",
        generation: 1,
        digest: sha256Hex("settlement"),
        part: 0,
        parts: 1,
        entries: entries.map((e) => ({
          type: e.type,
          id: e.entry.compositionId,
          digest: entryDigest(e.entry),
        })),
      },
      seq,
      at(seq),
    );

  it("reports entries the line record has evicted, from the run's events, with reasons", async () => {
    const f = createFixtures();
    const ended = makeRun(f, {
      status: "succeeded",
      startedAt: at(1000),
      endedAt: at(9000),
    });
    const base = setup(f, ended);
    const gone = base.composition("comp_gone", at(2000));
    const parked = base.parkedEntry(at(3000));
    const both = base.composition("comp_both", at(4000));
    const events = [
      entryEvent(f, "line.composed", gone, 0),
      entryEvent(f, "line.parked", parked, 1),
      entryEvent(f, "line.composed", both, 2),
      markerEvent(
        f,
        [
          { type: "line.composed", entry: gone },
          { type: "line.parked", entry: parked },
        ],
        3,
      ),
    ];
    const { stores } = setup(f, ended, [], events);
    const line = makeLineRecord(f, {
      compositions: [
        base.composition("comp_both", at(4000)),
        base.composition("comp_old", at(5000)),
      ],
    });
    const gathered = await gatherReport(stores(line), f.scope);
    expect(gathered.line?.compositions.map((c) => c.compositionId)).toEqual([
      "comp_gone",
      "comp_both",
      "comp_old",
    ]);
    expect(gathered.line?.parked.map((p) => p.reason)).toEqual(["repair budget exhausted"]);
    expect(renderReport(gathered)).toContain("Reason: repair budget exhausted");
    expect(Date.parse(gathered.asOf)).toBeGreaterThanOrEqual(Date.parse(at(5000)));
  });

  it("reports every composition of a run past the record's 50", async () => {
    const f = createFixtures();
    const ended = makeRun(f, {
      status: "succeeded",
      startedAt: at(1000),
      endedAt: at(900_000),
    });
    const base = setup(f, ended);
    const entries = Array.from({ length: 75 }, (_, i) =>
      base.composition(`comp_${i}`, at(2000 + i)),
    );
    const events = [
      ...entries.map((entry, i) => entryEvent(f, "line.composed", entry, i)),
      ...[0, 20, 40, 60].map((from) =>
        markerEvent(
          f,
          entries.slice(from, from + 20).map((entry) => ({ type: "line.composed", entry })),
          100 + from,
        ),
      ),
    ];
    const { stores } = setup(f, ended, [], events);
    const gathered = await gatherReport(stores(makeLineRecord(f, {})), f.scope);
    expect(gathered.line?.compositions).toHaveLength(75);
  });

  it("never reports an entry event that no marker names and the record does not hold", async () => {
    const f = createFixtures();
    const ended = makeRun(f, { status: "succeeded", startedAt: at(1000), endedAt: at(9000) });
    const base = setup(f, ended);
    const phantom = base.composition("comp_phantom", at(2000));
    const other = base.composition("comp_other", at(3000));
    const swapped = { ...base.composition("comp_other", at(3000)), commit: sha("f") };
    const events = [
      entryEvent(f, "line.composed", phantom, 0),
      entryEvent(f, "line.composed", swapped, 1),
      markerEvent(f, [{ type: "line.composed", entry: other }], 2),
    ];
    const { stores } = setup(f, ended, [], events);
    const gathered = await gatherReport(stores(makeLineRecord(f, {})), f.scope);
    expect(gathered.line?.compositions).toEqual([]);
  });

  it("reassembles a complete chunk set that hashes to its digest, and only that", async () => {
    const f = createFixtures();
    const ended = makeRun(f, { status: "succeeded", startedAt: at(1000), endedAt: at(9000) });
    const base = setup(f, ended);
    const entry = { ...base.parkedEntry(at(3000)), reason: "p ".repeat(9000) };
    const text = entryText(entry);
    const head = { kind: "parked", id: entry.compositionId, digest: entryDigest(entry) };
    const slices = [text.slice(0, 7000), text.slice(7000, 14000), text.slice(14000)];
    const chunk = (part: number) =>
      eventOf(
        f,
        "line.entry_chunk",
        { ...head, part, parts: 3, text: slices[part] },
        part,
        at(3000 + part),
      );
    const marker = markerEvent(f, [{ type: "line.parked", entry }], 9);
    const complete = setup(f, ended, [], [chunk(0), chunk(1), chunk(2), marker]).stores;
    const gathered = await gatherReport(complete(makeLineRecord(f, {})), f.scope);
    expect(gathered.line?.parked.map((p) => p.reason)).toEqual([entry.reason]);
    const missing = setup(f, ended, [], [chunk(0), chunk(2), marker]).stores;
    expect((await gatherReport(missing(makeLineRecord(f, {})), f.scope)).line?.parked).toEqual([]);
  });
});
