/**
 * `nightshift rate` (P20, D-04): the bodies it puts, the sentences it prints and
 * the exit codes, with the control plane's answers held fixed.
 */
import { makeRunFeedback } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import {
  createWorld,
  DEFAULT_ORG,
  errorBody,
  finishedRun,
  PROGRAM_DIRECTORY,
  type World,
} from "../testing/feedback-plane.js";
import { TEST_SUBJECT } from "../testing/harness.js";

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

const rated = async (running = false): Promise<World> => {
  const world = await createWorld();
  worlds.push(world);
  world.runs.push(
    running
      ? finishedRun(world.f, { status: "running", endedAt: undefined })
      : finishedRun(world.f),
  );
  return world;
};

const rate = (world: World, ...args: string[]): Promise<number> =>
  runCli(world.created.environment, ["rate", PROGRAM_DIRECTORY, ...args]);

describe("nightshift rate", () => {
  it("up puts a first `worked` verdict at version 1, attributed to the session's subject", async () => {
    const world = await rated();
    expect(await rate(world, "up")).toBe(0);

    expect(world.puts).toHaveLength(1);
    expect(world.puts[0]?.path).toMatch(/\/feedback$/);
    expect(world.puts[0]?.body).toMatchObject({
      runId: world.f.scope.runId,
      verdict: "worked",
      version: 1,
      actor: { kind: "user", userId: TEST_SUBJECT, orgId: DEFAULT_ORG },
      recordedAt: "2026-09-15T12:00:00.000Z",
    });
    expect(world.created.out).toEqual([`rated run ${world.f.scope.runId} as worked (revision 1)`]);
  });

  it("down replaces a stored verdict, naming the version it read plus one", async () => {
    const world = await rated();
    world.feedback.set(
      `${world.f.scope.programId}/${world.f.scope.runId}`,
      makeRunFeedback(world.f),
    );
    expect(await rate(world, "down")).toBe(0);

    expect(world.puts[0]?.body).toMatchObject({ verdict: "did_not_work", version: 2 });
    expect(world.created.out).toEqual([
      `rated run ${world.f.scope.runId} as did not work (revision 2)`,
    ]);
  });

  it("clear puts a null verdict over a stored one", async () => {
    const world = await rated();
    world.feedback.set(
      `${world.f.scope.programId}/${world.f.scope.runId}`,
      makeRunFeedback(world.f),
    );
    expect(await rate(world, "clear")).toBe(0);

    expect(world.puts[0]?.body).toMatchObject({ verdict: null, version: 2 });
    expect(world.created.out).toEqual([`cleared the verdict on run ${world.f.scope.runId}`]);
  });

  it("clear on a run with no verdict is a 404 and still exits 0", async () => {
    const world = await rated();
    world.answerPut = () => errorBody(404, "not_found", "nothing to clear");
    expect(await rate(world, "clear")).toBe(0);

    expect(world.created.out).toEqual([`run ${world.f.scope.runId} is not rated`]);
    expect(world.created.err).toEqual([]);
  });

  it("reports a stale write and does not retry it", async () => {
    const world = await rated();
    world.answerPut = () => errorBody(409, "stale_write", "run feedback is at version 3, not 0");
    expect(await rate(world, "up")).toBe(1);

    expect(world.puts).toHaveLength(1);
    expect(world.created.err).toEqual(["the rating changed underneath you; run the command again"]);
    expect(world.created.out).toEqual([]);
  });

  it("refuses a run that has not finished before writing anything", async () => {
    const world = await rated(true);
    expect(await rate(world, "up")).toBe(1);

    expect(world.puts).toEqual([]);
    expect(world.created.err.join("\n")).toContain(`run ${world.f.scope.runId} is not finished`);
  });

  it("prints the server's refusal when it says the run is not finished", async () => {
    const world = await rated();
    world.answerPut = () => errorBody(409, "run_not_finished", "run is still running");
    expect(await rate(world, "down")).toBe(1);

    expect(world.created.err).toEqual(["run is still running"]);
  });

  it("rates the named run rather than the latest", async () => {
    const world = await rated();
    const earlier = world.f.ids.next("run");
    world.runs.push(finishedRun(world.f, { startedAt: "2026-09-14T10:00:00.000Z" }, earlier));
    expect(await rate(world, "up", "--run", earlier)).toBe(0);

    expect(world.puts[0]?.body).toMatchObject({ runId: earlier });
  });

  it("exits 2 for an unknown action, a missing action and an unknown flag", async () => {
    const world = await rated();
    expect(await rate(world, "sideways")).toBe(2);
    expect(await rate(world)).toBe(2);
    expect(await rate(world, "up", "--loud")).toBe(2);
    expect(await runCli(world.created.environment, ["rate"])).toBe(2);
    expect(world.puts).toEqual([]);
  });
});
