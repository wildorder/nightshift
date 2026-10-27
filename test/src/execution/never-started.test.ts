/**
 * A never-started run is settled by the next start (D-07, PIP-9): a start of a
 * program whose only run is stale-pending proceeds and ends the old run as
 * interrupted; a start refused by a live run writes nothing at all.
 */
import {
  type IdGenerator,
  NEVER_STARTED_GRACE,
  ProgramRunLiveError,
  type RunScope,
} from "@nightshift/core";
import { startRun } from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorlds, createBaseWorld } from "./world.js";

afterEach(cleanupWorlds);

const START = Date.parse("2026-01-01T00:00:00.000Z");

const setup = async () => {
  let at = START;
  const world = await createBaseWorld({ clock: { now: () => at } });
  let lastRunId: string | undefined;
  const ids: IdGenerator = {
    ...world.ids,
    next: (kind: Parameters<IdGenerator["next"]>[0]) => {
      const id = world.ids.next(kind);
      if (kind === "run") lastRunId = id;
      return id;
    },
  } as IdGenerator;
  const start = () =>
    startRun(
      { stores: world.backing, clock: world.clock, ids, git: world.git },
      { program: world.program, repoPath: world.repo },
    );
  return { world, start, advance: (ms: number) => (at += ms), lastRunId: () => lastRunId };
};

describe("starting beside a run that never started", () => {
  it("proceeds past a stale pending run and ends it as interrupted, never started", async () => {
    const { world, start, advance } = await setup();
    const first = await start();
    advance(NEVER_STARTED_GRACE + 1_000);
    const second = await start();

    const ended = await world.backing.runs.get(first.run, first.run.runId);
    expect(ended).toMatchObject({
      status: "interrupted",
      endedAt: second.run.startedAt,
      outcomeReason: "never started",
    });
    expect(second.run.status).toBe("pending");
    expect(await world.backing.runs.get(second.run, second.run.runId)).toEqual(second.run);
  });

  it("is refused by a live run, and writes no run, node, checkpoint, decision or event", async () => {
    const { world, start, advance, lastRunId } = await setup();
    const first = await start();
    advance(1_000);
    const refusal = await start().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ProgramRunLiveError);
    expect(refusal).toMatchObject({ liveRunId: first.run.runId });
    const refusedId = lastRunId();
    expect(refusedId).toBeDefined();
    expect(refusedId).not.toBe(first.run.runId);
    const refused = { ...first.run, runId: refusedId } as unknown as RunScope;
    const { backing } = world;
    expect(await backing.runs.get(refused, refused.runId)).toBeUndefined();
    expect((await backing.runs.listByProgram(first.run)).items).toEqual([first.run]);
    expect((await backing.executionNodes.listByRun(refused)).items).toHaveLength(0);
    expect((await backing.checkpoints.listByRun(refused)).items).toHaveLength(0);
    expect((await backing.decisions.listByRun(refused)).items).toHaveLength(0);
    expect((await backing.events.listByRun(refused)).items).toHaveLength(0);
  });
});
