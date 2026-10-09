/**
 * The attached display (P16 S-03): WAIT, the stage and its times, the gates
 * side by side, and every ending with its exit code; on a terminal and off one.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatch, DispatchProgress, Event } from "@nightshift/contracts";
import { createFixtures, makeDispatch, makeEvent, makeProgramContract } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { Session } from "../session.js";
import {
  createFakeFetch,
  createTestEnvironment,
  fakeIdToken,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_EMAIL,
  TEST_SUBJECT,
  type TestEnvironment,
} from "../testing/harness.js";
import {
  EXIT_DETACHED,
  MAX_POLL_FAILURES,
  OK_GO_BANNER,
  POLL_MS,
  WAIT_BANNER,
  watchDispatch,
} from "./watch.js";

/** `makeDispatch`'s `requestedAt`. */
const REQUESTED_MS = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (seconds: number): string => new Date(REQUESTED_MS + seconds * 1000).toISOString();
const ESC = "\u001b";

const live: TestEnvironment[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const f = createFixtures();

const at = (
  seconds: number,
  stage: DispatchProgress["stage"],
  extra: Partial<DispatchProgress> = {},
  stageStartedSeconds = seconds,
): DispatchProgress => ({
  stage,
  generation: 1,
  stageStartedAt: iso(stageStartedSeconds),
  updatedAt: iso(seconds),
  ...extra,
});

const running = (progress?: DispatchProgress, overrides: Partial<Dispatch> = {}): Dispatch =>
  makeDispatch(f, {
    status: progress === undefined ? "provisioning" : "running",
    ...(progress === undefined ? {} : { progress }),
    ...overrides,
  });

const unit = {
  id: "unit",
  kind: "check" as const,
  machine: "passed" as const,
  reference: "passed" as const,
};
const lint = {
  id: "lint",
  kind: "check" as const,
  machine: "failed" as const,
  reference: "passed" as const,
};

/** One answer per poll; the last repeats. An `Error` is a poll that throws. */
type Answer = Dispatch | Error | undefined;

interface Harness {
  readonly created: TestEnvironment;
  readonly session: Pick<Session, "stores">;
  readonly sleeps: number[];
  polls(): number;
}

const harness = async (
  answers: readonly Answer[],
  options: {
    readonly tty?: boolean;
    /** Seconds after `requestedAt` at each poll; the last repeats. */
    readonly times?: readonly number[];
    readonly events?: () => Promise<readonly Event[]>;
    /** Called at each poll, with its index, before it answers. */
    readonly onPoll?: (index: number, created: TestEnvironment) => void;
  } = {},
): Promise<Harness> => {
  let index = -1;
  const sleeps: number[] = [];
  const times = options.times ?? [0];
  const clock = {
    now: () => REQUESTED_MS + (times[Math.min(Math.max(index, 0), times.length - 1)] ?? 0) * 1000,
  };
  const created = await createTestEnvironment({
    stdoutIsTTY: options.tty === true,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  live.push(created);
  const session = {
    stores: {
      dispatches: {
        get: async () => {
          index += 1;
          options.onPoll?.(index, created);
          const answer = answers[Math.min(index, answers.length - 1)];
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      events: {
        listByRun: async () => ({ items: [...((await options.events?.()) ?? [])] }),
      },
    },
  } as unknown as Pick<Session, "stores">;
  return { created, session, sleeps, polls: () => index + 1 };
};

const watch = (h: Harness) =>
  watchDispatch(h.created.environment, h.session, { program: "p1-fixture", scope: f.scope });

const AUDITING: readonly Answer[] = [
  running(),
  running(at(20, "up")),
  running(at(45, "toolchain", { detail: "node 22.22.0" })),
  running(at(95, "audit", { gates: [unit] }, 80)),
  running(at(100, "audit", { gates: [unit, lint] }, 80)),
  running(at(105, "audit", { gates: [unit, lint], verdict: "agrees" }, 80)),
];

describe("watchDispatch without a terminal", () => {
  it("prints plain lines, one per stage change, gate and verdict, each with both times, and no escapes", async () => {
    const h = await harness(AUDITING, { times: [5, 30, 50, 100, 103, 110] });
    expect(await watch(h)).toBe(0);
    const out = h.created.out;
    expect(out.join("\n")).not.toContain(ESC);
    expect(out.slice(0, WAIT_BANNER.length)).toEqual([...WAIT_BANNER]);
    const body = out.slice(WAIT_BANNER.length, out.indexOf(OK_GO_BANNER[0] ?? ""));
    expect(body).toEqual([
      "[total 0:05] dispatch provisioning: the machine is being provisioned",
      "[stage 0:10, total 0:30] the machine is up",
      "[stage 0:05, total 0:50] the project's runtimes: node 22.22.0",
      "[stage 0:20, total 1:40] the machine's gate audit, against your laptop's",
      "  gate unit: machine passed, reference passed",
      "  gate lint: machine failed, reference passed  << disagrees: passed on your laptop, failed on the machine",
      "[stage 0:30, total 1:50] verdict: the machine agrees with your laptop",
    ]);
    expect(h.sleeps.every((ms) => ms === POLL_MS)).toBe(true);
  });
});

describe("watchDispatch on a terminal", () => {
  it("redraws the WAIT frame in place: up over the last frame, then clear to the end", async () => {
    const h = await harness(AUDITING, { tty: true, times: [5, 30, 50, 100, 103, 110] });
    expect(await watch(h)).toBe(0);
    const out = h.created.out;
    // The first frame starts clean; every later one moves up over the last.
    expect(out[0]).toBe(WAIT_BANNER[0]);
    const redraws = out.filter((line) => line.includes(`${ESC}[`));
    expect(redraws).toHaveLength(5);
    for (const line of redraws) expect(line).toMatch(new RegExp(`^${ESC}\\[\\d+A${ESC}\\[0J#`));
    const text = out.join("\n");
    expect(text).toContain("  the project's runtimes: node 22.22.0");
    expect(text).toContain("  stage 0:23, total 1:43");
    expect(text).toContain("    unit: machine passed, reference passed");
    expect(text).toContain(
      "    lint: machine failed, reference passed  << disagrees: passed on your laptop, failed on the machine",
    );
    // The frame's line count is what the next redraw moves up over.
    const first = out.findIndex((line) => line.includes(`${ESC}[`));
    expect(out[first]).toContain(`${ESC}[${first}A`);
  });
});

describe("watchDispatch's endings", () => {
  it("OK GO on agrees, exit 0, with the follow command", async () => {
    const h = await harness([running(at(1, "audit", { verdict: "agrees" }))]);
    expect(await watch(h)).toBe(0);
    const text = h.created.out.join("\n");
    expect(text).toContain(OK_GO_BANNER.join("\n"));
    expect(text).toContain(
      "the machine agrees with your laptop: you can close it now. `nightshift remote status p1-fixture` follows the run.",
    );
    expect(h.created.interruptHandlers()).toBe(0);
  });

  it("OK GO on red, saying the run starts by repairing the base", async () => {
    const h = await harness([running(at(1, "audit", { verdict: "red" }))]);
    expect(await watch(h)).toBe(0);
    const text = h.created.out.join("\n");
    expect(text).toContain(OK_GO_BANNER.join("\n"));
    expect(text).toContain("the base is red on both, so the run starts by repairing it.");
  });

  it("OK GO on skipped, saying a replacement machine carries on", async () => {
    const h = await harness([
      running(at(1, "audit", { verdict: "skipped", generation: 2 }), { generation: 2 }),
    ]);
    expect(await watch(h)).toBe(0);
    expect(h.created.out.join("\n")).toContain(
      "a replacement machine carries on the audited run; it does not audit again.",
    );
  });

  it("generation 2 provisioning with generation-1 agrees progress keeps waiting and shows replacement line", async () => {
    const h = await harness(
      [
        running(undefined, { generation: 2 }),
        running(at(1, "audit", { verdict: "agrees", generation: 1 }), { generation: 2 }),
        running(at(2, "audit", { verdict: "skipped", generation: 2 }), { generation: 2 }),
      ],
      { times: [0, 5, 10] },
    );
    expect(await watch(h)).toBe(0);
    const out = h.created.out;
    const text = out.join("\n");
    // The output should show the replacement provisioning line when stale generation-1 progress arrives
    expect(text).toContain("a replacement machine is being provisioned (generation 2)");
    // Should eventually show OK GO when generation-2 progress arrives
    expect(text).toContain(OK_GO_BANNER.join("\n"));
    // Should show the machine agrees message for the replacement
    expect(text).toContain(
      "a replacement machine carries on the audited run; it does not audit again.",
    );
  });

  it("then generation-2 progress with verdict skipped reaches OK GO with exit 0", async () => {
    const h = await harness(
      [
        running(undefined, { generation: 2 }),
        running(at(1, "audit", { verdict: "agrees", generation: 1 }), { generation: 2 }),
        running(at(2, "audit", { verdict: "skipped", generation: 2 }), { generation: 2 }),
      ],
      { times: [0, 5, 10] },
    );
    expect(await watch(h)).toBe(0);
    const text = h.created.out.join("\n");
    expect(text).toContain(OK_GO_BANNER.join("\n"));
    expect(text).toContain(
      "a replacement machine carries on the audited run; it does not audit again.",
    );
  });

  it("generation 2 with generation-2 agrees reaches OK GO", async () => {
    const h = await harness([
      running(undefined, { generation: 2 }),
      running(at(1, "audit", { verdict: "agrees", generation: 2 }), { generation: 2 }),
    ]);
    expect(await watch(h)).toBe(0);
    expect(h.created.out.join("\n")).toContain(OK_GO_BANNER.join("\n"));
  });

  const fault = {
    baseCommit: "c".repeat(40),
    referenceNode: "24.4.1",
    machineNode: "18.20.4",
    gates: [
      {
        id: "lint",
        command: "npm run lint",
        kind: "check" as const,
        reference: "passed" as const,
        machine: "failed" as const,
        referenceTail: "all clean",
        machineTail: "SyntaxError: Unexpected token",
      },
    ],
  };
  const faulted = running(at(1, "audit", { gates: [unit, lint], verdict: "fault" }), {
    status: "failed",
    failure: {
      code: "environment_fault",
      message: "lint passed in the reference audit and failed here",
    },
  });

  it("an environment fault waits for the dispatch to end, then shows the cause side by side, exit 1", async () => {
    const pending = running(at(1, "audit", { gates: [unit, lint], verdict: "fault" }));
    const h = await harness([pending, faulted], {
      events: async () => [
        makeEvent(f, { type: "environment.fault", source: "control-plane", payload: fault }),
      ],
    });
    expect(await watch(h)).toBe(1);
    const text = h.created.out.join("\n");
    expect(text).toContain("environment fault: ending the dispatch");
    expect(text).toContain("environment fault: lint passed in the reference audit and failed here");
    expect(text).toContain("  cause: the machine, not the project.");
    expect(text).toContain("| `lint` | `npm run lint` | passed | failed |");
    expect(text).toContain("SyntaxError: Unexpected token");
    expect(text).not.toContain(OK_GO_BANNER[0]);
  });

  it("an environment fault whose events cannot be read is tried again, then said by its cause alone", async () => {
    let reads = 0;
    const h = await harness([faulted], {
      events: async () => {
        reads += 1;
        throw new Error("not yet");
      },
    });
    expect(await watch(h)).toBe(1);
    expect(reads).toBe(3);
    const text = h.created.out.join("\n");
    expect(text).toContain("  cause: the machine, not the project.");
    expect(text).not.toContain("| Gate |");
  });

  it("any other failure says its code and message, exit 1", async () => {
    const h = await harness([
      running(at(1, "setup", { detail: "setup install" }), {
        status: "failed",
        failure: { code: "setup_failed", message: "npm ci exited 1" },
      }),
    ]);
    expect(await watch(h)).toBe(1);
    expect(h.created.out).toContain("the dispatch failed: setup_failed: npm ci exited 1");
  });

  it("a dispatch stopped from elsewhere before OK GO says so, exit 1", async () => {
    const h = await harness([
      running(at(1, "setup")),
      running(at(2, "setup"), { status: "stopping" }),
    ]);
    expect(await watch(h)).toBe(1);
    expect(h.created.out.join("\n")).toContain(
      "the dispatch is stopping before the machine agreed with your laptop",
    );
  });

  it("Ctrl-C detaches, cancels nothing, says how to reattach and cancel, exit 130", async () => {
    const h = await harness([running(at(1, "setup")), running(at(2, "audit"))], {
      onPoll: (index, created) => {
        if (index === 1) created.interrupt();
      },
    });
    expect(await watch(h)).toBe(EXIT_DETACHED);
    expect(h.created.out.at(-1)).toBe(
      "detached: the machine carries on and nothing was cancelled. " +
        "`nightshift remote status p1-fixture --watch` reattaches; `nightshift remote cancel p1-fixture` stops it.",
    );
    expect(h.created.interruptHandlers()).toBe(0);
  });

  it("keeps polling through failures, and gives up after ten in a row, exit 1", async () => {
    const down = new Error("ECONNRESET");
    const h = await harness([down, down, running(at(1, "up")), down]);
    expect(await watch(h)).toBe(1);
    expect(h.polls()).toBe(3 + MAX_POLL_FAILURES);
    const out = h.created.out;
    expect(out).toContain("the control plane did not answer; trying again");
    expect(out.at(-1)).toBe(
      "the control plane did not answer 10 times in a row; nothing was cancelled. " +
        "`nightshift remote status p1-fixture --watch` reattaches.",
    );
    expect(h.created.interruptHandlers()).toBe(0);
  });
});

describe("nightshift remote status", () => {
  const RUN_PATH = `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;

  /** Writes to the control plane; the token endpoint is not one. */
  const postsToThePlane = (requests: readonly { url: string; method: string }[]) =>
    requests.filter((request) => request.method !== "GET" && request.url.startsWith(TEST_API));

  /** A checkout holding the program, and a plane answering the dispatch in turn. */
  const statusOf = async (answers: readonly Dispatch[]) => {
    const repo = await mkdtemp(join(tmpdir(), "nightshift-watch-"));
    scratch.push(repo);
    const directory = join(repo, "docs", "programs", "p1-fixture");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "contract.json"), JSON.stringify(makeProgramContract(f)));
    await writeFile(join(directory, "plan.md"), "# The plan\n");
    let polled = 0;
    const plane = createFakeFetch((request) => {
      if (request.url.startsWith(`https://${TEST_AUTH_DOMAIN}/`)) {
        const body = {
          id_token: fakeIdToken({ sub: TEST_SUBJECT, email: TEST_EMAIL }),
          expires_in: 3600,
        };
        return { status: 200, body: JSON.stringify(body) };
      }
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === `${RUN_PATH}/dispatch`) {
        const answer = answers[Math.min(polled, answers.length - 1)];
        polled += 1;
        return { status: 200, body: JSON.stringify(answer) };
      }
      return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: path } }) };
    });
    const created = await createTestEnvironment({ fetch: plane.fetch, cwd: repo });
    live.push(created);
    await signIn(created.environment);
    return { created, plane, repo };
  };

  it("--watch reattaches to a dispatch mid-audit and runs to OK GO, without cancelling", async () => {
    const { created, plane, repo } = await statusOf([
      running(at(1, "audit", { gates: [unit] })),
      running(at(2, "audit", { gates: [unit, { ...lint, machine: "passed" }] })),
      running(at(3, "audit", { gates: [unit, { ...lint, machine: "passed" }], verdict: "agrees" })),
    ]);
    const argv = [
      "remote",
      "status",
      "p1-fixture",
      "--watch",
      "--run",
      f.scope.runId,
      "--repo",
      repo,
    ];
    expect(await runCli(created.environment, argv), created.err.join("\n")).toBe(0);
    const text = created.out.join("\n");
    expect(text).toContain(WAIT_BANNER.join("\n"));
    expect(text).toContain("the machine's gate audit, against your laptop's");
    expect(text).toContain("  gate unit: machine passed, reference passed");
    expect(text).toContain("  gate lint: machine passed, reference passed");
    expect(text).toContain(OK_GO_BANNER.join("\n"));
    expect(postsToThePlane(plane.requests)).toEqual([]);
  });

  it("--watch detaches on Ctrl-C with no POST to the control plane, cancel or otherwise", async () => {
    const { created, plane, repo } = await statusOf([
      running(at(1, "setup")),
      running(at(2, "prerequisites")),
    ]);
    let polls = 0;
    const environment = {
      ...created.environment,
      sleep: async () => {
        polls += 1;
        if (polls === 2) created.interrupt();
      },
    };
    const argv = [
      "remote",
      "status",
      "p1-fixture",
      "--watch",
      "--run",
      f.scope.runId,
      "--repo",
      repo,
    ];
    expect(await runCli(environment, argv)).toBe(EXIT_DETACHED);
    expect(created.out.at(-1)).toContain(
      "detached: the machine carries on and nothing was cancelled.",
    );
    expect(postsToThePlane(plane.requests)).toEqual([]);
    expect(plane.requests.some((request) => request.url.includes("/cancel"))).toBe(false);
    expect(created.interruptHandlers()).toBe(0);
  });

  it("--watch on a dispatch already past OK GO shows the ending at once", async () => {
    const { created, repo } = await statusOf([running(at(1, "audit", { verdict: "agrees" }))]);
    const argv = [
      "remote",
      "status",
      "p1-fixture",
      "--watch",
      "--run",
      f.scope.runId,
      "--repo",
      repo,
    ];
    expect(await runCli(created.environment, argv)).toBe(0);
    expect(created.out.join("\n")).not.toContain(WAIT_BANNER[0]);
    expect(created.out.join("\n")).toContain(OK_GO_BANNER.join("\n"));
  });

  it("--watch on a stopped dispatch without a verdict says it stopped, exit 1", async () => {
    const { created, repo } = await statusOf([running(undefined, { status: "stopped" })]);
    const argv = [
      "remote",
      "status",
      "p1-fixture",
      "--watch",
      "--run",
      f.scope.runId,
      "--repo",
      repo,
    ];
    expect(await runCli(created.environment, argv)).toBe(1);
    expect(created.out.join("\n")).toContain("the dispatch is stopped before the machine agreed");
  });

  it("without --watch prints the dispatch and one progress line", async () => {
    const { created, repo } = await statusOf([
      running(at(1, "audit", { detail: "3 of 6 gates", verdict: "agrees", gates: [unit] })),
    ]);
    const argv = ["remote", "status", "p1-fixture", "--run", f.scope.runId, "--repo", repo];
    expect(await runCli(created.environment, argv)).toBe(0);
    const progress = created.out.filter((line) => line.startsWith("  progress:"));
    expect(progress).toEqual([
      "  progress: audit (the machine's gate audit, against your laptop's): 3 of 6 gates; verdict agrees",
    ]);
    expect(created.out.join("\n")).not.toContain(WAIT_BANNER[0]);
  });

  it("refuses --watch on cancel", async () => {
    const created = await createTestEnvironment();
    live.push(created);
    expect(await runCli(created.environment, ["remote", "cancel", "p1-fixture", "--watch"])).toBe(
      2,
    );
  });
});
