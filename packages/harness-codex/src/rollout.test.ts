import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  MAX_OBSERVATION_BYTES,
  type MeasurementObservation,
  MeasurementObservationSchema,
  observationBytes,
} from "@nightshift/contracts";
import { createCountingIdGenerator, reconcileSegment } from "@nightshift/core";
import type { HarnessObservation } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import {
  CODEX_ROLLOUT_READER_VERSION,
  locateRollout,
  type RolloutFs,
  type RolloutRecord,
  readRolloutMetadata,
  rolloutObservations,
} from "./rollout.js";

const FIXTURE = readFileSync(
  new URL("./__fixtures__/codex-rollout-measured.jsonl", import.meta.url),
  "utf8",
);
const THREAD = "01a15bbb-94ca-7bb3-9199-122e66126ad3";
/** First ordinal of the resumed launch (its first thread_settings_applied). */
const RESUME = 16;
const RESUME_STARTED_AT = "2026-10-20T23:54:28.010Z";

const ids = createCountingIdGenerator();
const stamp = (observation: HarnessObservation): MeasurementObservation =>
  MeasurementObservationSchema.parse({
    ...observation,
    schemaVersion: 1,
    projectId: ids.next("proj"),
    programId: ids.next("prog"),
    runId: ids.next("run"),
    executionNodeId: ids.next("node"),
    agentId: ids.next("agent"),
    launch: { agentId: ids.next("agent"), launchId: "l1", segment: 0 },
    receivedAt: "2026-10-21T00:00:00.000Z",
  });

const all = readRolloutMetadata(FIXTURE).records;
const requests = (obs: readonly HarnessObservation[]) => obs.filter((o) => o.kind === "request");
const snapshots = (obs: readonly HarnessObservation[]) =>
  obs.filter((o) => o.kind === "cumulative_snapshot");

describe("readRolloutMetadata", () => {
  it("reads the fixture's records with ordinals and timestamps", () => {
    expect(CODEX_ROLLOUT_READER_VERSION).toBe(1);
    const read = readRolloutMetadata(FIXTURE);
    expect(read.tornTail).toBe(false);
    expect(read.nextOrdinal).toBe(27);
    expect(read.nextByteOffset).toBe(Buffer.byteLength(FIXTURE));
    const meta = read.records.find((r) => r.type === "session_meta");
    expect(meta).toMatchObject({
      id: THREAD,
      cliVersion: "0.155.1",
      modelProvider: "fake",
    });
    expect(read.records.every((r) => r.timestamp !== "" && Number.isInteger(r.ordinal))).toBe(true);
  });

  it("exposes last-request and cumulative usage apart", () => {
    const counts = all.filter((r) => r.type === "token_count");
    const last = counts.at(-1);
    expect(last?.type === "token_count" && last.totalTokenUsage?.inputTokens).toBe(4021);
    expect(last?.type === "token_count" && last.lastTokenUsage?.inputTokens).toBe(1007);
  });

  it("re-reads only the growth and gives the same records as one read", () => {
    const cut = Math.floor(FIXTURE.length / 2);
    const first = readRolloutMetadata(FIXTURE.slice(0, cut));
    expect(first.tornTail).toBe(true);
    const second = readRolloutMetadata(FIXTURE, {
      fromByteOffset: first.nextByteOffset,
      fromOrdinal: first.nextOrdinal,
    });
    expect(second.tornTail).toBe(false);
    expect([...first.records, ...second.records]).toEqual(all);
    const again = readRolloutMetadata(FIXTURE, {
      fromByteOffset: second.nextByteOffset,
      fromOrdinal: second.nextOrdinal,
    });
    expect(again.records).toEqual([]);
    expect(again.nextOrdinal).toBe(second.nextOrdinal);
  });

  it("drops duplicate ordinals, skips bad lines, and never throws", () => {
    const line = FIXTURE.split("\n")[8] as string;
    const read = readRolloutMetadata(`${line}\n${line}\nnot json\n[1]\n{"ordinal":"x"}\n`);
    expect(read.records).toHaveLength(1);
    expect(read.tornTail).toBe(false);
    expect(readRolloutMetadata("{").tornTail).toBe(true);
    expect(readRolloutMetadata("", { fromByteOffset: 99 }).records).toEqual([]);
  });
});

describe("rolloutObservations", () => {
  const whole = rolloutObservations(all, {
    threadId: THREAD,
    launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
  });

  it("emits a request per token_usage_record with the raw counters", () => {
    const reqs = requests(whole.observations);
    expect(reqs).toHaveLength(3);
    expect(new Set(reqs.map((r) => r.observationId)).size).toBe(3);
    expect(reqs.map((r) => r.kind === "request" && r.requestId)).toEqual([
      "resp_1",
      "resp_2",
      "resp_1",
    ]);
    const expected = [
      [1007, 500, 41, 10],
      [2007, 1000, 42, 20],
      [1007, 500, 41, 10],
    ];
    reqs.forEach((r, i) => {
      const [input, cache, output, reasoning] = expected[i] as number[];
      expect(r).toMatchObject({
        observationId: expect.stringMatching(`^codex:rollout:${THREAD}:\\d+$`),
        counters: {
          inputTokens: input,
          cacheReadTokens: cache,
          cacheWriteTokens: 0,
          outputTokens: output,
          reasoningTokens: reasoning,
          inputIncludesCache: true,
        },
        sessionId: THREAD,
        model: "gpt-5.5",
        contextWindowTokens: 258400,
        source: "harness",
        inclusion: "self",
        provenance: { adapter: "codex", version: "0.155.1" },
      });
      expect(r.provenance.note).toContain("capacity");
    });
    expect(whole.facts).toMatchObject({
      boundary: "ordinal",
      aborted: false,
      excludedBeforeBoundary: 0,
      cliVersion: "0.155.1",
      latestContextWindow: 258400,
      spawnEvidence: { spawned: false, childThreadIds: [] },
    });
    expect(whole.facts.turnIds).toHaveLength(2);
  });

  it("emits one session snapshot from the latest total, not the sum of the second launch", () => {
    const snaps = snapshots(whole.observations);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      counterScope: "session",
      counters: {
        inputTokens: 4021,
        cacheReadTokens: 2000,
        outputTokens: 124,
        reasoningTokens: 40,
      },
    });
    const secondLaunchInput = rolloutObservations(all, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: RESUME },
    })
      .observations.filter((o) => o.kind === "request")
      .reduce((sum, o) => sum + (o.counters.inputTokens ?? 0), 0);
    // total_token_usage after resume is cumulative over the thread, while the
    // last request is only 1007: the total is not the second launch's requests.
    expect(secondLaunchInput).toBe(1007);
    expect(snaps[0]?.kind === "cumulative_snapshot" && snaps[0].counters.inputTokens).not.toBe(
      secondLaunchInput,
    );
  });

  it("never emits an observation from last_token_usage or turn_token_usage", () => {
    expect(whole.observations).toHaveLength(4);
  });

  it("selects the resumed launch by ordinal boundary", () => {
    const { observations, facts } = rolloutObservations(all, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: RESUME },
    });
    expect(requests(observations)).toHaveLength(1);
    expect(snapshots(observations)[0]).toMatchObject({
      counters: { inputTokens: 4021 },
    });
    expect(facts.excludedBeforeBoundary).toBe(2);
    expect(facts.turnIds).toHaveLength(1);
  });

  it("selects the same request by time boundary", () => {
    const byOrdinal = rolloutObservations(all, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: RESUME },
    });
    const byTime = rolloutObservations(all, {
      threadId: THREAD,
      launchBoundary: { kind: "time", notBefore: RESUME_STARTED_AT },
    });
    expect(byTime.facts.boundary).toBe("time");
    expect(requests(byTime.observations)).toEqual(requests(byOrdinal.observations));
    expect(byTime.facts.excludedBeforeBoundary).toBe(2);
  });

  it("reconciles both launches to per-segment 3014 and 1007", () => {
    const firstRecords = readRolloutMetadata(
      `${FIXTURE.split("\n").slice(0, RESUME).join("\n")}\n`,
    ).records;
    const first = rolloutObservations(firstRecords, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
    });
    const second = rolloutObservations(all, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: RESUME },
    });
    const one = reconcileSegment(first.observations.map(stamp), {
      resumedSession: false,
    });
    expect(one.counters.inputTokens).toBe(3014);
    const baseline = one.sessionCumulative?.counters;
    expect(baseline?.inputTokens).toBe(3014);
    const two = reconcileSegment(second.observations.map(stamp), {
      resumedSession: true,
      baseline,
    });
    expect(two.counters.inputTokens).toBe(1007);
  });

  it("does not emit records of another thread, and marks a child's requests", () => {
    const other = all.map((r) =>
      r.type === "token_usage_record" ? { ...r, threadId: "someone-else" } : r,
    );
    expect(
      requests(
        rolloutObservations(other, {
          threadId: THREAD,
          launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
        }).observations,
      ),
    ).toHaveLength(0);

    // SYNTHETIC child rollout, modelled on the binary's parent_thread_id field; not measured.
    const childText = [
      {
        ordinal: 0,
        type: "session_meta",
        payload: {
          id: "child-1",
          parent_thread_id: THREAD,
          cli_version: "0.155.1",
        },
      },
      {
        ordinal: 1,
        type: "token_usage_record",
        payload: {
          thread_id: "child-1",
          turn_id: "t",
          response_id: "r1",
          usage: { input_tokens: 5 },
        },
      },
    ]
      .map((l) => JSON.stringify({ timestamp: "2026-10-20T23:00:00.000Z", ...l }))
      .join("\n");
    const child = readRolloutMetadata(`${childText}\n`).records;
    expect(child[0]).toMatchObject({ parentThreadId: THREAD });
    const { observations } = rolloutObservations(child, {
      threadId: "child-1",
      launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
      childOf: THREAD,
    });
    expect(observations[0]).toMatchObject({
      childRef: { kind: "session", id: THREAD },
    });
  });

  it("keeps a request that precedes an abort and reports the abort", () => {
    const aborted: RolloutRecord[] = [
      ...all.filter((r) => r.ordinal < RESUME),
      {
        type: "turn_aborted",
        ordinal: 100,
        timestamp: "2026-10-20T23:53:03.000Z",
        turnId: "t",
        reason: "interrupted",
      },
    ];
    const { observations, facts } = rolloutObservations(aborted, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
    });
    expect(requests(observations)).toHaveLength(2);
    expect(facts.aborted).toBe(true);
  });

  it("reports spawn evidence", () => {
    const text = [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "c1",
          arguments: "SECRET-ARGS",
        },
      },
      {
        type: "event_msg",
        payload: { type: "collab_agent_spawn_begin", new_thread_id: "child-9" },
      },
    ]
      .map((l, i) =>
        JSON.stringify({
          timestamp: "2026-10-20T23:00:00.000Z",
          ordinal: i,
          ...l,
        }),
      )
      .join("\n");
    const { facts } = rolloutObservations(readRolloutMetadata(`${text}\n`).records, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
    });
    expect(facts.spawnEvidence).toEqual({
      spawned: true,
      childThreadIds: ["child-9"],
    });
    expect(whole.facts.spawnEvidence.spawned).toBe(false);
  });

  it("never carries text, and every observation validates and is small", () => {
    const SENTINEL = "SENTINEL-TEXT-9f3a";
    const lines = [
      {
        type: "session_meta",
        payload: {
          id: THREAD,
          cli_version: "0.155.1",
          base_instructions: { text: SENTINEL },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: SENTINEL }],
        },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: SENTINEL },
      },
      {
        type: "event_msg",
        payload: { type: "agent_message", message: SENTINEL },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agents",
          call_id: "c",
          arguments: SENTINEL,
        },
      },
      {
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "t", reason: "interrupted" },
      },
      {
        type: "turn_context",
        payload: {
          turn_id: "t",
          model: "gpt-5.5",
          developer_instructions: SENTINEL,
        },
      },
      {
        type: "token_usage_record",
        payload: {
          thread_id: THREAD,
          turn_id: "t",
          response_id: "r",
          usage: { input_tokens: 3, output_tokens: 1 },
          extra: SENTINEL,
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 3 },
            model_context_window: 10,
          },
        },
      },
    ]
      .map((l, i) =>
        JSON.stringify({
          timestamp: "2026-10-20T23:00:00.000Z",
          ordinal: i,
          ...l,
        }),
      )
      .join("\n");
    const read = readRolloutMetadata(`${lines}\n${FIXTURE}`);
    const result = rolloutObservations(read.records, {
      threadId: THREAD,
      launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
    });
    expect(JSON.stringify([read, result])).not.toContain(SENTINEL);
    expect(JSON.stringify(read)).not.toContain("<text omitted>");
    for (const observation of [...result.observations, ...whole.observations]) {
      const stamped = stamp(observation);
      expect(observationBytes(stamped)).toBeLessThanOrEqual(MAX_OBSERVATION_BYTES);
    }
  });
});

describe("locateRollout", () => {
  const NAME = `rollout-2026-10-20T23-53-02-${THREAD}.jsonl`;
  const listing = (tree: Record<string, string[]>): RolloutFs => ({
    readdir: async (path) => {
      const entries = tree[path];
      if (entries === undefined) throw new Error("ENOENT");
      return entries;
    },
  });
  // Linux paths, as on a runner machine, joined as Linux joins them on any host.
  const input = {
    threadId: THREAD,
    env: { CODEX_HOME: "/h" },
    home: "/u",
    around: "2026-10-20T23:55:00.000Z",
    join: posix.join,
  };

  it("finds the file under the day directory", async () => {
    const fs = listing({
      "/h/sessions/2026/10/20": ["rollout-x-other.jsonl", NAME],
    });
    expect(await locateRollout({ ...input, fs })).toBe(`/h/sessions/2026/10/20/${NAME}`);
  });

  it("falls back to a full scan, and to the archive after a move", async () => {
    const scan = listing({ "/h/sessions": [`2026/10/19/${NAME}`] });
    expect(await locateRollout({ ...input, fs: scan })).toBe(`/h/sessions/2026/10/19/${NAME}`);
    const archived = listing({
      "/h/sessions": [],
      "/h/archived_sessions": [NAME],
    });
    expect(await locateRollout({ ...input, fs: archived })).toBe(`/h/archived_sessions/${NAME}`);
  });

  it("uses ~/.codex by default, returns undefined when gone, refuses a bad id", async () => {
    const fs = listing({ "/u/.codex/sessions": [NAME] });
    expect(
      await locateRollout({ threadId: THREAD, env: {}, home: "/u", fs, join: posix.join }),
    ).toBe(`/u/.codex/sessions/${NAME}`);
    expect(await locateRollout({ ...input, fs: listing({}) })).toBeUndefined();
    expect(await locateRollout({ ...input, threadId: "../x", fs })).toBeUndefined();
  });
});
