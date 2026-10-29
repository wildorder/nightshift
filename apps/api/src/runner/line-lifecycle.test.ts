/**
 * The line run follows its dispatch (Pipkin): it starts when the owner runs and
 * ends with the dispatch, freeing the line program for the next run.
 */
import {
  createFixedClock,
  createFixtures,
  lineProgramId,
  makeDispatch,
  makeProgramContract,
  makeRun,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { followLineRun } from "./line-lifecycle.js";

const NOW = "2026-10-01T12:00:00.000Z";
const clock = createFixedClock(Date.parse(NOW));

const world = async (isLine = true) => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const programId = isLine ? lineProgramId(f.scope.projectId, "l") : f.scope.programId;
  await stores.programContracts.put(
    makeProgramContract(f, { programId, ...(isLine ? { kind: "line" as const } : {}) }),
  );
  const runId = f.ids.next("run");
  await stores.runs.put(makeRun(f, { programId, runId, status: "pending", location: "remote" }));
  const scope = { projectId: f.scope.projectId, programId };
  const dispatch = (overrides: Record<string, unknown>) =>
    makeDispatch(f, { programId, runId, ...overrides });
  const status = async () => (await stores.runs.get(scope, runId))?.status;
  return { stores, dispatch, status };
};

describe("followLineRun", () => {
  it("starts the pending run when its owner runs, and leaves it while it does", async () => {
    const w = await world();
    await followLineRun(w.stores, clock, w.dispatch({ status: "provisioning" }));
    expect(await w.status()).toBe("pending");
    await followLineRun(w.stores, clock, w.dispatch({ status: "running" }));
    expect(await w.status()).toBe("running");
    await followLineRun(w.stores, clock, w.dispatch({ status: "running" }));
    expect(await w.status()).toBe("running");
  });

  it("ends the run with its dispatch: succeeded when it stopped, failed with its cause", async () => {
    const stopped = await world();
    await followLineRun(stopped.stores, clock, stopped.dispatch({ status: "running" }));
    await followLineRun(stopped.stores, clock, stopped.dispatch({ status: "stopped" }));
    expect(await stopped.status()).toBe("succeeded");

    const failed = await world();
    await followLineRun(failed.stores, clock, failed.dispatch({ status: "running" }));
    await followLineRun(
      failed.stores,
      clock,
      failed.dispatch({ status: "failed", failure: { code: "setup_failed", message: "no" } }),
    );
    expect(await failed.status()).toBe("failed");

    const never = await world();
    await followLineRun(
      never.stores,
      clock,
      never.dispatch({ status: "failed", failure: { code: "setup_failed", message: "no" } }),
    );
    expect(await never.status()).toBe("interrupted");
  });

  it("touches no run of a program that is not a line's", async () => {
    const w = await world(false);
    await followLineRun(w.stores, clock, w.dispatch({ status: "running" }));
    expect(await w.status()).toBe("pending");
  });
});
