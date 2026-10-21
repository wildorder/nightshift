/**
 * `nightshift completion` (P20, D-05): the histories it puts, what it prints and
 * the exit codes, with the control plane's answers held fixed.
 */
import type { CompletionHistory } from "@nightshift/contracts";
import {
  createFixtures,
  makeCompletionHistory,
  makeProgramContract,
  makeRunFeedback,
} from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import {
  createWorld,
  DEFAULT_ORG,
  errorBody,
  FAKE_MEASURED,
  finishedRun,
  PROGRAM_DIRECTORY,
  type World,
} from "../testing/feedback-plane.js";
import { TEST_SUBJECT } from "../testing/harness.js";

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

/** A world with one finished anchor run, rated `worked`, and a history on it. */
const seeded = async (): Promise<
  World & { readonly historyId: string; readonly anchor: string }
> => {
  const world = await createWorld();
  worlds.push(world);
  world.runs.push(finishedRun(world.f));
  const key = `${world.f.scope.programId}/${world.f.scope.runId}`;
  world.feedback.set(key, makeRunFeedback(world.f));
  const history = makeCompletionHistory(world.f);
  world.histories.push(history);
  return Object.assign(world, { historyId: history.completionHistoryId, anchor: key });
};

const completion = (world: World, ...args: string[]): Promise<number> =>
  runCli(world.created.environment, [
    "completion",
    ...args.slice(0, 1),
    PROGRAM_DIRECTORY,
    ...args.slice(1),
  ]);

/** A second run, of a second program in the same project, finished. */
const otherRun = (world: World): { programId: string; runId: string } => {
  const programId = world.f.ids.next("prog");
  const runId = world.f.ids.next("run");
  world.runs.push(
    finishedRun(world.f, { programId, startedAt: "2026-09-15T08:00:00.000Z" }, runId),
  );
  return { programId, runId };
};

describe("nightshift completion", () => {
  it("create anchors a new history on the latest run, with an id from the environment", async () => {
    const world = await createWorld();
    worlds.push(world);
    world.runs.push(finishedRun(world.f));
    expect(await completion(world, "create", "--title", "Billing export")).toBe(0);

    const put = world.puts[0];
    expect(put?.path).toMatch(/\/completion-histories\/comp_/);
    expect(put?.body).toMatchObject({
      title: "Billing export",
      version: 1,
      runId: world.f.scope.runId,
      members: [{ programId: world.f.scope.programId, runId: world.f.scope.runId, role: "anchor" }],
      checkpoints: [],
    });
    expect(world.created.out[0]).toMatch(
      /^created completion history comp_\w+ "Billing export" anchored on run run_\w+ \(version 1\)$/,
    );
  });

  it("list prints one line per history that includes a run of the program", async () => {
    const world = await seeded();
    // Another program's history, in the same project, that includes none of this program's runs.
    world.histories.push(makeCompletionHistory(createFixtures()));
    expect(await completion(world, "list")).toBe(0);

    expect(world.created.out).toEqual([
      `${world.historyId} "Fixture outcome" 1 members, version 1`,
    ]);
  });

  it("show prints members, coverage and the three durations", async () => {
    const world = await seeded();
    expect(await completion(world, "show", "--history", world.historyId)).toBe(0);

    const text = world.created.out.join("\n");
    expect(text).toContain(`completion history ${world.historyId} "Fixture outcome" (version 1)`);
    expect(text).toContain(`member ${world.anchor} anchor succeeded worked`);
    expect(text).toContain("rated 1 of 1 finished runs, positive share 100%");
    expect(text).toMatch(/now: lead time .*run completion 1h 0m, active union 1h 0m/);
    expect(world.puts).toEqual([]);
  });

  it("show says dollars and tokens were not observed, with measured counts, never a zero", async () => {
    const world = await seeded();
    const { usd: _usd, tokens: _tokens, coverage: _coverage, ...bare } = FAKE_MEASURED;
    const history = world.histories[0] as CompletionHistory;
    world.histories[0] = {
      ...history,
      checkpoints: [
        {
          name: "bare",
          programId: world.f.scope.programId,
          runId: world.f.scope.runId,
          feedbackVersion: 1,
          verdictRecordedAt: FAKE_MEASURED.recordedAt,
          members: history.members,
          membershipVersion: history.version,
          recordedAt: FAKE_MEASURED.recordedAt,
          recordedBy: { kind: "user", userId: TEST_SUBJECT, orgId: DEFAULT_ORG },
          measured: { ...bare, readableMembers: 3, measuredMembers: 1, unmeasuredMembers: 2 },
        } as CompletionHistory["checkpoints"][number],
      ],
    };
    const code = await completion(world, "show", "--history", world.historyId);
    expect(world.created.err).toEqual([]);
    expect(code).toBe(0);
    const line = world.created.out.find((l) => l.startsWith("checkpoint `bare`")) as string;
    expect(line).toContain("measured 1 of 3 members");
    expect(line).toContain("dollars not observed");
    expect(line).toContain("tokens not observed");
    expect(line).not.toMatch(/\$0\.0+\b/);
    const now = world.created.out.find((l) => l.startsWith("now:")) as string;
    expect(now).not.toMatch(/\$0\.00/);
    expect(now).toContain("dollars not observed");
  });

  it("checkpoint prints a measurement_unavailable refusal with a retry hint and exits 1", async () => {
    const world = await seeded();
    world.answerPut = () =>
      errorBody(503, "measurement_unavailable", "the measurement store could not be read");
    expect(
      await completion(
        world,
        "checkpoint",
        "--history",
        world.historyId,
        "--name",
        "first",
        "--member",
        world.anchor,
      ),
    ).toBe(1);
    // The transport retries a 5xx of the same request; the CLI itself proposes once.
    expect(new Set(world.puts.map((put) => JSON.stringify(put)))).toHaveLength(1);
    expect(world.created.err.join("\n")).toContain("the measurement store could not be read");
    expect(world.created.err.join("\n")).toContain("retry when the measurement store answers");
  });

  it("show prints a stored checkpoint unchanged after a contributing member is removed", async () => {
    const world = await createWorld();
    worlds.push(world);
    world.runs.push(finishedRun(world.f));
    world.feedback.set(
      `${world.f.scope.programId}/${world.f.scope.runId}`,
      makeRunFeedback(world.f),
    );
    const extra = otherRun(world);
    const extraKey = `${extra.programId}/${extra.runId}`;
    const anchor = `${world.f.scope.programId}/${world.f.scope.runId}`;
    expect(await completion(world, "create", "--title", "Billing export")).toBe(0);
    const id = world.histories[0]?.completionHistoryId as string;
    expect(await completion(world, "add", "--history", id, "--member", extraKey)).toBe(0);
    expect(
      await completion(world, "checkpoint", "--history", id, "--name", "first", "--member", anchor),
    ).toBe(0);

    world.created.out.length = 0;
    expect(await completion(world, "show", "--history", id)).toBe(0);
    const before = [...world.created.out];
    const line = before.find((l) => l.startsWith("checkpoint `first`"));
    expect(line).toContain("active union 2h 0m");
    expect(line).toContain("run completion 3h 0m");
    expect(line).toContain("measured to 2026-09-15T12:00:00.000Z");
    expect(line).toContain("estimated $1.5000, reported $2.2500");
    expect(line).toContain("infrastructure $0.5000 over 2 members");
    expect(line).toContain("2 readable members");
    expect(before.some((l) => l.startsWith(`member ${extraKey} contributing`))).toBe(true);

    expect(await completion(world, "remove", "--history", id, "--member", extraKey)).toBe(0);
    world.created.out.length = 0;
    expect(await completion(world, "show", "--history", id)).toBe(0);
    const after = [...world.created.out];

    expect(after.find((l) => l.startsWith("checkpoint `first`"))).toBe(line);
    expect(after).toContain(`  snapshot member ${extraKey} contributing succeeded not_rated`);
    expect(after.some((l) => l.startsWith(`member ${extraKey} `))).toBe(false);
    expect(after.find((l) => l.startsWith("now:"))).not.toBe(
      before.find((l) => l.startsWith("now:")),
    );
  });

  it("lists a snapshot-only run as unreadable when the stores no longer have it", async () => {
    const world = await seeded();
    const extra = otherRun(world);
    const key = `${extra.programId}/${extra.runId}`;
    expect(await completion(world, "add", "--history", world.historyId, "--member", key)).toBe(0);
    expect(
      await completion(
        world,
        "checkpoint",
        "--history",
        world.historyId,
        "--name",
        "first",
        "--member",
        world.anchor,
      ),
    ).toBe(0);
    expect(await completion(world, "remove", "--history", world.historyId, "--member", key)).toBe(
      0,
    );
    world.runs.splice(
      world.runs.findIndex((r) => r.runId === extra.runId),
      1,
    );
    world.created.out.length = 0;
    expect(await completion(world, "show", "--history", world.historyId)).toBe(0);
    expect(world.created.out).toContain(
      `  snapshot member ${key} contributing unreadable unreadable`,
    );
  });

  it("suggest prints each suggestion with its reason and performs no PUT", async () => {
    const world = await seeded();
    const correction = otherRun(world);
    world.contracts.push(
      makeProgramContract(world.f, {
        programId: correction.programId,
        corrects: [
          {
            programId: world.f.scope.programId,
            runId: world.f.scope.runId,
            decisionId: world.f.ids.next("dec"),
            reversedBy: world.f.ids.next("dec"),
          },
        ],
      } as never),
    );
    expect(await completion(world, "suggest", "--history", world.historyId)).toBe(0);

    expect(world.created.out).toHaveLength(1);
    expect(world.created.out[0]).toContain(
      `suggest ${correction.programId}/${correction.runId} as correction: corrects_member`,
    );
    expect(world.puts).toEqual([]);
  });

  it("add puts the next version with the new member", async () => {
    const world = await seeded();
    const extra = otherRun(world);
    expect(
      await completion(
        world,
        "add",
        "--history",
        world.historyId,
        "--member",
        `${extra.programId}/${extra.runId}`,
        "--role",
        "correction",
      ),
    ).toBe(0);

    expect(world.puts[0]?.body).toMatchObject({
      version: 2,
      members: [
        { role: "anchor" },
        { programId: extra.programId, runId: extra.runId, role: "correction" },
      ],
    });
    expect(world.created.out).toEqual([
      `added ${extra.programId}/${extra.runId} to completion history ${world.historyId} as correction (version 2)`,
    ]);
  });

  it("remove drops a member but never the anchor", async () => {
    const world = await seeded();
    const extra = otherRun(world);
    const key = `${extra.programId}/${extra.runId}`;
    const stored = makeCompletionHistory(world.f, {
      completionHistoryId: world.historyId,
      members: [
        { programId: world.f.scope.programId, runId: world.f.scope.runId, role: "anchor" },
        { ...extra, role: "contributing" },
      ],
      revisions: [
        {
          version: 1,
          actor: { kind: "user", userId: "fixture-operator", orgId: DEFAULT_ORG },
          recordedAt: "2026-09-15T12:00:00.000Z",
          added: [
            { programId: world.f.scope.programId, runId: world.f.scope.runId, role: "anchor" },
            { ...extra, role: "contributing" },
          ],
          removed: [],
        },
      ],
    } as never);
    world.histories.splice(0, 1, stored);

    expect(
      await completion(world, "remove", "--history", world.historyId, "--member", world.anchor),
    ).toBe(2);
    expect(world.created.err.join("\n")).toContain("is the anchor");
    expect(world.puts).toEqual([]);

    expect(await completion(world, "remove", "--history", world.historyId, "--member", key)).toBe(
      0,
    );
    expect(world.puts[0]?.body).toMatchObject({
      version: 2,
      members: [{ role: "anchor" }],
    });
  });

  it("checkpoint puts the next version naming the checkpoint and its attribution", async () => {
    const world = await seeded();
    expect(
      await completion(
        world,
        "checkpoint",
        "--history",
        world.historyId,
        "--name",
        "first release",
        "--member",
        world.anchor,
      ),
    ).toBe(0);

    expect(world.puts[0]?.body).toMatchObject({
      version: 2,
      checkpoints: [
        {
          name: "first release",
          runId: world.f.scope.runId,
          recordedBy: { userId: TEST_SUBJECT, orgId: DEFAULT_ORG },
        },
      ],
    });
  });

  it("prints a 422 refusal's reason and exits 1", async () => {
    const world = await seeded();
    const extra = otherRun(world);
    world.answerPut = () =>
      errorBody(422, "completion_membership", "completion membership refused: unknown_run");
    expect(
      await completion(
        world,
        "add",
        "--history",
        world.historyId,
        "--member",
        `${extra.programId}/${extra.runId}`,
      ),
    ).toBe(1);

    expect(world.created.err).toEqual(["completion membership refused: unknown_run"]);
    expect(world.created.out).toEqual([]);
  });

  it("reports a stale write and does not retry it", async () => {
    const world = await seeded();
    const extra = otherRun(world);
    world.answerPut = () => errorBody(409, "stale_write", "completion history is at version 4");
    expect(
      await completion(
        world,
        "add",
        "--history",
        world.historyId,
        "--member",
        `${extra.programId}/${extra.runId}`,
      ),
    ).toBe(1);

    // The transport retries a 5xx of the same request; the CLI itself proposes once.
    expect(new Set(world.puts.map((put) => JSON.stringify(put)))).toHaveLength(1);
    expect(world.created.err).toEqual([
      "the completion history changed underneath you; run the command again",
    ]);
  });

  it("exits 2 for bad usage and writes nothing", async () => {
    const world = await seeded();
    expect(await runCli(world.created.environment, ["completion"])).toBe(2);
    expect(await completion(world, "dance")).toBe(2);
    expect(await completion(world, "create")).toBe(2);
    expect(await completion(world, "show")).toBe(2);
    expect(await completion(world, "show", "--history", world.historyId, "--title", "x")).toBe(2);
    expect(await completion(world, "add", "--history", world.historyId, "--member", "nope")).toBe(
      2,
    );
    expect(
      await completion(
        world,
        "add",
        "--history",
        world.historyId,
        "--member",
        world.anchor,
        "--role",
        "anchor",
      ),
    ).toBe(2);
    expect(await completion(world, "show", "--history", "comp_missing")).toBe(2);
    expect(world.puts).toEqual([]);
  });
});
