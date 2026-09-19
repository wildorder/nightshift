/**
 * What a scripted worker does, written once for both transports (P5, T1).
 *
 * A script is given a {@link WorkerSurface}: the four worker operations, plus
 * `get` where the transport has one. Over stdio the surface is a real MCP client
 * talking to a real worker-role server (`worker.ts`); in the function transport
 * it is `HarnessStartInput.tools` called directly (`scripted.ts`). The scripts
 * cannot tell which, and that is the property under test: A-37 says there is one
 * implementation of the worker operations and two ways to reach it.
 *
 * A script's return value is the process's exit code.
 */
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What a scripted worker does. Chosen per test, or by `NIGHTSHIFT_SCRIPT`. */
export type ScriptName =
  /** Read a file, edit it, add a test, report progress twice, complete, exit 0. */
  | "implement"
  /** As `implement`, but the added test fails. */
  | "implement-broken"
  /** Edit a file outside the job's includes, then complete. */
  | "out-of-scope"
  /** Report progress once, then wait until killed. */
  | "hang"
  /** Call `job.fail` with a reason, exit 0. */
  | "fail"
  /** Edit, then exit 1 without reporting anything at all. */
  | "silent-exit"
  /** The conformance job: explore, edit source and test, run the tests, decide, complete. */
  | "conform"
  /** The deterministic-failure job: do what was asked, which the fixture's tests contradict. */
  | "conform-broken";

export const SCRIPT_NAMES: readonly ScriptName[] = [
  "implement",
  "implement-broken",
  "out-of-scope",
  "hang",
  "fail",
  "silent-exit",
  "conform",
  "conform-broken",
];

export interface SurfaceDecision {
  readonly context: string;
  readonly alternatives: readonly { readonly summary: string; readonly rejectedBecause?: string }[];
  readonly choice: string;
  readonly rationale: string;
  readonly reversibility: "reversible" | "compensatable" | "irreversible";
}

/** The worker operations as a script sees them, whichever transport carries them. */
export interface WorkerSurface {
  /** `job.get`. Only the MCP transport has it: a function caller already holds the job. */
  get(): Promise<void>;
  progress(message: string, percent?: number): Promise<void>;
  decide(decision: SurfaceDecision): Promise<void>;
  complete(summary: string): Promise<"implemented" | "scope_violation">;
  fail(reason: string): Promise<void>;
}

export interface ScriptContext {
  readonly surface: WorkerSurface;
  readonly worktree: string;
  /** Settles when the harness has been asked to stop. Never, for a child that is simply killed. */
  readonly cancelled: Promise<void>;
  note(text: string): void;
}

/** The helper every `implement` script adds. Correct, and its test passes. */
const MEDIAN_SOURCE = `
export const median = (values) => {
  if (values.length === 0) throw new RangeError("median of an empty list is undefined");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
`;

const PASSING_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "../src/math.js";

test("median of an odd-length list is the middle value", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median of an even-length list is the mean of the middle two", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
`;

/** The same helper, with a test that asserts something untrue. */
const FAILING_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "../src/math.js";

test("median of an odd-length list is the middle value", () => {
  // Wrong on purpose: SC-P3-07 needs a verification that genuinely fails.
  assert.equal(median([3, 1, 2]), 99);
});
`;

const addMedian = async (worktree: string, testSource: string): Promise<void> => {
  const mathPath = join(worktree, "src", "math.js");
  const existing = await readFile(mathPath, "utf8");
  await writeFile(mathPath, `${existing}${MEDIAN_SOURCE}`, "utf8");
  await writeFile(join(worktree, "test", "median.test.js"), testSource, "utf8");
};

/** `node --test` in the worktree, as a worker with `shell.exec` would run it. */
const runTests = (worktree: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--test"], { cwd: worktree }, (error) => {
      resolve(error === null);
    });
  });

export const SCRIPTS: Readonly<Record<ScriptName, (context: ScriptContext) => Promise<number>>> = {
  implement: async ({ surface, worktree, note }) => {
    await surface.get();
    await surface.progress("reading src/math.js");
    await addMedian(worktree, PASSING_TEST);
    await surface.progress("added median and its tests", 80);
    const outcome = await surface.complete(
      "Added a median helper to src/math.js, with tests for odd and even lengths.",
    );
    if (outcome !== "implemented") {
      note(`job.complete answered ${outcome}`);
      return 1;
    }
    return 0;
  },

  "implement-broken": async ({ surface, worktree }) => {
    await surface.get();
    await addMedian(worktree, FAILING_TEST);
    await surface.progress("added median; confident, wrongly");
    // The worker reports success. Verification is what disagrees, which is the
    // whole of SC-P3-06 and SC-P3-07.
    await surface.complete("Added a median helper.");
    return 0;
  },

  "out-of-scope": async ({ surface, worktree }) => {
    await surface.get();
    await addMedian(worktree, PASSING_TEST);
    // Outside `src/**` and `test/**`. Everything else about this job is fine,
    // which is the point: the scope check is what stops it.
    await appendFile(join(worktree, "README.md"), "\nEdited by a worker that strayed.\n", "utf8");
    await surface.complete("Added median, and tidied the README.");
    return 0;
  },

  hang: async ({ surface, cancelled }) => {
    await surface.get();
    await surface.progress("waiting for an instruction that never comes");
    // Until stopped. A child is killed by its process group; an in-process
    // worker is released by the harness's cancel.
    await cancelled;
    return 0;
  },

  fail: async ({ surface }) => {
    await surface.get();
    await surface.fail("the job asks for a median of a stream, and the module is list-based");
    return 0;
  },

  "silent-exit": async ({ worktree }) => {
    // Calls nothing, reports nothing, prints nothing on the stream. The
    // lifecycle must still be observable (SC-P3-12), and the node must still
    // end durably (P3 §4.3).
    await writeFile(join(worktree, "src", "half-done.js"), "export const x = 1;\n", "utf8");
    return 1;
  },

  conform: async ({ surface, worktree, note }) => {
    await surface.get();
    // Exploration: where the helpers live, how they are exported, how tested.
    await surface.progress("reading src/math.js, src/index.js and test/math.test.js");
    const index = await readFile(join(worktree, "src", "index.js"), "utf8");
    await readFile(join(worktree, "test", "math.test.js"), "utf8");

    // A source edit and a test edit.
    await addMedian(worktree, PASSING_TEST);
    await writeFile(
      join(worktree, "src", "index.js"),
      index.replace("export { mean, sum }", "export { mean, median, sum }"),
      "utf8",
    );
    await surface.progress("added median, exported it, and wrote its tests", 60);

    await surface.decide({
      context: "median of an even-length list has no single middle value",
      alternatives: [
        { summary: "return the lower of the two middle values", rejectedBecause: "biased low" },
        { summary: "return the mean of the two middle values" },
      ],
      choice: "return the mean of the two middle values",
      rationale: "It is the conventional definition, and it matches how `mean` already behaves.",
      reversibility: "reversible",
    });

    // A shell command.
    const passed = await runTests(worktree);
    await surface.progress(passed ? "the test suite passes" : "the test suite fails", 90);

    const outcome = await surface.complete(
      "Added a median helper beside mean, exported from src/index.js, with tests.",
    );
    if (outcome !== "implemented") {
      note(`job.complete answered ${outcome}`);
      return 1;
    }
    return 0;
  },

  "conform-broken": async ({ surface, worktree }) => {
    await surface.get();
    await surface.progress("changing sum to answer null for an empty list");
    const mathPath = join(worktree, "src", "math.js");
    const math = await readFile(mathPath, "utf8");
    await writeFile(
      mathPath,
      math.replace(
        "export const sum = (values) => values.reduce((total, value) => total + value, 0);",
        "export const sum = (values) =>\n  values.length === 0 ? null : values.reduce((total, value) => total + value, 0);",
      ),
      "utf8",
    );
    // Exactly what was asked, reported honestly. The fixture's own test says
    // `sum([])` is 0, and verification is what finds that out (A-05).
    await surface.complete("sum now answers null for an empty list, as the job asked.");
    return 0;
  },
};
