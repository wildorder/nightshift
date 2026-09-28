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
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  | "conform-broken"
  // --- P6: the tree fixture. Chosen by a tag on the job's objective, because one
  // --- run now holds jobs that must each do something different.
  /** `[add-module <name> wait=<n> delay=<ms>]`: a new module and its test, touching nothing shared. */
  | "add-module"
  /** `[rewrite-sum <variant>]`: rewrites the same line as every other variant, to conflict. */
  | "rewrite-sum"
  /** `[rename-sum]`: renames `sum` everywhere it is used. Green alone. */
  | "rename-sum"
  /** `[call-sum]`: a new module that calls `sum`. Green alone, broken after `rename-sum`. */
  | "call-sum"
  /** A sub-program's orchestrator: delegates `[add-module c1]` and `[add-module c2]`, waits, completes. */
  | "orchestrate"
  /** P7: the root of a planned run. Attaches, delegates every strand, waits, finishes truthfully. */
  | "follow-plan";

export const SCRIPT_NAMES: readonly ScriptName[] = [
  "implement",
  "implement-broken",
  "out-of-scope",
  "hang",
  "fail",
  "silent-exit",
  "conform",
  "conform-broken",
  "add-module",
  "rewrite-sum",
  "rename-sum",
  "call-sum",
  "orchestrate",
  "follow-plan",
];

/**
 * The script a job's objective asks for, and its arguments: `[name a b k=v] …`.
 *
 * A real model reads an objective; the scripted harness reads a tag at the
 * front of one. It is how a single run gives different jobs different work,
 * which P6's fixture needs and one script per server could not.
 */
export const taggedScript = (
  objective: string,
  /**
   * A strand's objective opens with its plan section, verbatim (P7), so its tag
   * is a line of that section rather than the objective's first characters.
   */
  anywhere = false,
): { readonly script: ScriptName; readonly args: readonly string[] } | undefined => {
  const tag = (anywhere ? /^\[([^\]]+)\]/m : /^\[([^\]]+)\]/).exec(objective)?.[1];
  if (tag === undefined) return undefined;
  const [name, ...args] = tag.trim().split(/\s+/);
  return (SCRIPT_NAMES as readonly string[]).includes(name ?? "")
    ? { script: name as ScriptName, args }
    : undefined;
};

/** What a sub-orchestrator script drives: the sub-orchestrator role's tools. */
export interface OrchestratorSurface {
  delegate(objective: string, includes: readonly string[]): Promise<string>;
  /** Waits until every one of `jobIds` has settled; answers each one's final status. */
  waitAll(jobIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
  progress(message: string): Promise<void>;
  complete(summary: string): Promise<void>;
  fail(reason: string): Promise<void>;
  decide(decision: SurfaceDecision): Promise<void>;
}

/** What the root of a planned run drives (P7): the orchestrator role's tools, strands only. */
export interface RootSurface {
  attach(runId: string): Promise<void>;
  /** `strand.delegate`. Answers the job id, or the refusal's code when it was refused. */
  delegateStrand(strandId: string): Promise<{ jobId?: string; refused?: string }>;
  waitAll(jobIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
  finish(outcome: "succeeded" | "failed" | "deferred", reason?: string): Promise<boolean>;
}

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
  /** The arguments of the objective's tag, positional then `key=value`. */
  readonly args?: readonly string[];
  /** Somewhere every worker of this run can see, for barriers between processes. */
  readonly sharedDir?: string;
  /** Present when the node is a sub-program's. */
  readonly orchestrator?: OrchestratorSurface;
  /** Present when the node is the program's own, run headless from a plan (P7). */
  readonly root?: RootSurface;
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

const option = (args: readonly string[] | undefined, key: string): string | undefined =>
  args?.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);

/**
 * A barrier between worker **processes**: says "I am here", then waits until
 * `count` workers have. Overlap becomes a fact the test can rely on rather than
 * a race it hopes to win. Files, because the workers share nothing else.
 */
const meetAt = async (
  dir: string | undefined,
  group: string,
  name: string,
  count: number,
): Promise<void> => {
  if (dir === undefined || count <= 1) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${group}.${name}.here`), "", "utf8");
  for (;;) {
    const here = (await readdir(dir)).filter(
      (file) => file.startsWith(`${group}.`) && file.endsWith(".here"),
    ).length;
    if (here >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const replaceIn = async (worktree: string, path: string, change: (text: string) => string) => {
  const file = join(worktree, path);
  await writeFile(file, change(await readFile(file, "utf8").catch(() => "")), "utf8");
};

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

  "add-module": async ({ surface, worktree, args, sharedDir }) => {
    const name = args?.[0] ?? "extra";
    await surface.get();
    await surface.progress(`adding src/${name}.js`);
    // `group` keeps one pair's barrier from being satisfied by another's.
    await meetAt(
      sharedDir,
      option(args, "group") ?? "all",
      name,
      Number(option(args, "wait") ?? "1"),
    );
    const delay = Number(option(args, "delay") ?? "0");
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    // `value=` (P9): what the module returns, so a correction can rewrite a
    // module an earlier run added, rather than add the same one again.
    const value = option(args, "value") ?? name;
    await writeFile(
      join(worktree, "src", `${name}.js`),
      `export const ${name} = () => "${value}";\n`,
      "utf8",
    );
    await writeFile(
      join(worktree, "test", `${name}.test.js`),
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\n` +
        `import { ${name} } from "../src/${name}.js";\n\n` +
        `test("${name}", () => {\n  assert.equal(${name}(), "${value}");\n});\n`,
      "utf8",
    );
    return (await surface.complete(`Added the ${name} module and its test.`)) === "implemented"
      ? 0
      : 1;
  },

  "rewrite-sum": async ({ surface, worktree, args }) => {
    const bodies: Readonly<Record<string, string>> = {
      loop: "values.reduce((t, v) => t + v, 0)",
      strict: "values.reduce((total, value) => total + Number(value), 0)",
    };
    await surface.get();
    await replaceIn(worktree, "src/math.js", (text) =>
      text.replace(
        /export const sum = .*;/,
        `export const sum = (values) => ${bodies[args?.[0] ?? "loop"] ?? bodies.loop};`,
      ),
    );
    await surface.complete(`Rewrote sum (${args?.[0] ?? "loop"}).`);
    return 0;
  },

  "rename-sum": async ({ surface, worktree }) => {
    await surface.get();
    await replaceIn(worktree, "src/math.js", (text) => text.replaceAll("sum", "total"));
    await replaceIn(worktree, "src/index.js", () => 'export { mean, total } from "./math.js";\n');
    await replaceIn(worktree, "test/math.test.js", (text) => text.replaceAll("sum", "total"));
    // The program's own `shape` step insists `sum` is still exported, so keep an alias there.
    await replaceIn(
      worktree,
      "src/index.js",
      (text) => `${text}export { total as sum } from "./math.js";\n`,
    );
    await surface.complete(
      "Renamed sum to total in src/math.js, keeping the entry point's export.",
    );
    return 0;
  },

  "call-sum": async ({ surface, worktree }) => {
    await surface.get();
    await writeFile(
      join(worktree, "src", "range.js"),
      'import { sum } from "./math.js";\n\nexport const range = (values) => sum(values) - 2 * Math.min(...values);\n',
      "utf8",
    );
    await writeFile(
      join(worktree, "test", "range.test.js"),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\n' +
        'import { range } from "../src/range.js";\n\ntest("range", () => {\n  assert.equal(range([1, 5]), 4);\n});\n',
      "utf8",
    );
    await surface.complete("Added range, which uses sum from src/math.js.");
    return 0;
  },

  orchestrate: async ({ orchestrator, worktree, note, args }) => {
    if (orchestrator === undefined) {
      note("the orchestrate script needs a sub-orchestrator surface");
      return 1;
    }
    await orchestrator.progress("dividing the sub-program into two independent jobs");
    // Something an orchestrator must not do, and a real model might: edit its own
    // checkout. Nothing collects it, which the tree test asserts.
    await writeFile(join(worktree, "src", "orchestrator-was-here.js"), "export {};\n", "utf8");
    // Its children's tag is its own, passed down: `[orchestrate delay=500]` makes a
    // benchmark's tree, and no tag makes the barrier pair the tree test forces.
    // A strand's tag (P7): `prefix=` names its modules so strands running at once
    // touch different files, `fail=1` is a strand that cannot be done, `depart=1`
    // one that leaves the plan's approach and says so.
    const prefix = option(args, "prefix");
    if (option(args, "depart") === "1") {
      await orchestrator.decide({
        context: "DEPARTURE: the plan said one module; the code wants two",
        alternatives: [
          { summary: "One module, as planned", rejectedBecause: "it would not divide" },
        ],
        choice: "Two modules",
        rationale: "They are independent and verify separately.",
        // `class=` (P9): how reversible the departure says it is.
        reversibility: (option(args, "class") ?? "reversible") as
          | "reversible"
          | "compensatable"
          | "irreversible",
      });
    }
    if (option(args, "fail") === "1") {
      await orchestrator.fail("this strand's objective cannot be met as planned");
      return 0;
    }
    const passed = (args ?? []).filter((arg) => !/^(prefix|fail|depart|class)=/.test(arg));
    const how =
      prefix === undefined
        ? passed.length
          ? passed.join(" ")
          : "wait=2 group=c"
        : passed.join(" ");
    const [first, second] = prefix === undefined ? ["c1", "c2"] : [`${prefix}1`, `${prefix}2`];
    // A strand's jobs ask for the strand's own paths: anything wider is refused (A-11).
    const includes =
      prefix === undefined
        ? ["src/**", "test/**"]
        : [`src/${prefix}*.js`, `test/${prefix}*.test.js`];
    const jobs = [
      await orchestrator.delegate(
        `[add-module ${first} ${how}] Add the ${first} module and its test.`,
        includes,
      ),
      await orchestrator.delegate(
        `[add-module ${second} ${how}] Add the ${second} module and its test.`,
        includes,
      ),
    ];
    const statuses = await orchestrator.waitAll(jobs);
    // `deferred` (P7, D-P7-10) is done for now: on the provisional line, waiting on a human.
    if (
      Object.values(statuses).every((status) => status === "integrated" || status === "deferred")
    ) {
      await orchestrator.complete("Both modules are integrated.");
      return 0;
    }
    await orchestrator.fail(`not every job integrated: ${JSON.stringify(statuses)}`);
    return 0;
  },

  "follow-plan": async ({ root, args, note }) => {
    if (root === undefined) {
      note("the follow-plan script needs the root orchestrator's surface");
      return 1;
    }
    const [runId, ...strandIds] = args ?? [];
    if (runId === undefined) return 1;
    await root.attach(runId);
    // Every strand, at once: the engine holds what must wait (D-P7-04).
    const jobs = new Map<string, string>();
    for (const strandId of strandIds) {
      const delegated = await root.delegateStrand(strandId);
      if (delegated.jobId !== undefined) jobs.set(strandId, delegated.jobId);
    }
    const statuses = await root.waitAll([...jobs.values()]);
    const unfinished = strandIds.filter((strandId) => {
      const jobId = jobs.get(strandId);
      return jobId === undefined || statuses[jobId] !== "succeeded";
    });
    if (unfinished.length > 0) {
      return (await root.finish("failed", `parked: ${unfinished.join(", ")}`)) ? 0 : 1;
    }
    // Every strand's orchestrator finished. If the run still may not be called
    // succeeded, some of their work is deferred, and that is how it ends.
    if (await root.finish("succeeded")) return 0;
    return (await root.finish("deferred", "checks are deferred for a human prerequisite")) ? 0 : 1;
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
