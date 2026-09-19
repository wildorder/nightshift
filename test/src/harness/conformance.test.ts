/**
 * The scripted harness against T1's shared conformance suite.
 *
 * `describeHarnessConformance` is the seed of P5's suite, and this is its first
 * subject. What it proves is narrow and load-bearing: a handle carries the
 * identity it was given, `exit` settles exactly once, `cancel` settles it as
 * `cancelled`, `status` agrees with `exit` forever, and every event that reached
 * the sink is hook-sourced with a start and exactly one ending.
 *
 * Running a real adapter against it is T8's business, gated on
 * `NIGHTSHIFT_SLICE_HARNESS=claude`. Running the *scripted* one against it is
 * what proves the suite itself is satisfiable — a conformance suite nothing has
 * ever passed is a suite nobody knows the shape of.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ExecutionNode, JobContract, ProgramContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
  makeJobContract,
  makeNode,
  makeProgramContract,
} from "@nightshift/core";
import { millis, refusingWorkerTools } from "@nightshift/harness";
import { describeHarnessConformance } from "../conformance/harness.js";
import { createScriptedHarness, WORKER_SCRIPT_ENV, workerEntry } from "./scripted.js";

/**
 * A worktree with nothing in it, and an MCP launch that starts nothing.
 *
 * The conformance suite asserts only about the *handle and its lifecycle*, so
 * the child needs a directory to sit in and a launch it will never successfully
 * use. `fail` and `hang` both end without touching the worktree — `fail` calls
 * `job.fail` through an MCP server that is not there, so its connect fails and
 * the child exits non-zero, which is a perfectly good "ended on its own".
 */
const created: string[] = [];

const startInput = async (script: "fail" | "hang") => {
  const f = createFixtures();
  const worktree = await mkdtemp(join(tmpdir(), "nightshift-conformance-"));
  created.push(worktree);

  const node: ExecutionNode = makeNode(f, f.rootNodeId, { status: "running" });
  const agent: Agent = makeAgent(f, node.executionNodeId, { status: "started" });
  const job: JobContract = makeJobContract(f);
  const program: ProgramContract = makeProgramContract(f);

  return {
    agent,
    node,
    job,
    program,
    worktree,
    model: { harness: "scripted", provider: "test", model: "scripted" },
    mcp: {
      name: "nightshift",
      // A command that exits immediately, so the child's attempt to speak MCP to
      // it fails and it ends on its own rather than hanging.
      command: process.execPath,
      args: ["--version"],
      // Which part this worker plays. The harness passes the launch through
      // unchanged and reads its own variable back out of it.
      env: { [WORKER_SCRIPT_ENV]: script },
    },
    // The handle and its lifecycle are what this suite asserts; the v1 suite
    // (`conformance/worker.ts`) is where a real job runs.
    tools: refusingWorkerTools("this start input describes no real job"),
  };
};

describeHarnessConformance(
  "the scripted harness",
  createScriptedHarness({ script: "fail", entry: workerEntry() }),
  {
    completing: () => startInput("fail"),
    longRunning: () => startInput("hang"),
    cancelGrace: millis(2_000),
    completionTimeout: millis(30_000),
    cleanup: async () => {
      for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  },
);
