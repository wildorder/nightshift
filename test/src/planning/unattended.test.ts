/**
 * A ratified plan to a report with nobody watching (P7, T4; SC-P7-06 … SC-P7-11).
 *
 * The real launcher binary, the real MCP server it starts, the real engine and
 * merge queue, real git, and the production API handler over a socket. Only the
 * model is scripted: the root follows the plan, and each strand's orchestrator
 * does what a tag in its own plan section says.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgramContract, Strand } from "@nightshift/contracts";
import { isSequenced, type RunScope, systemClock } from "@nightshift/core";
import {
  DEPARTURE_PREFIX,
  gatherReport,
  git,
  nodeGitRunner,
  renderReport,
  startRun,
} from "@nightshift/execution";
import { STRAND_DEPARTURE_PREFIX } from "@nightshift/harness";
import { createActivityFeed, renderActivity } from "@nightshift/mcp";
import { createHttpPlanning } from "@nightshift/persistence/http";
import { sanitizeEnvironment } from "@nightshift/verification";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalContext, type SliceContext, scriptedHarnessModule } from "../slice/context.js";
import { PROGRAM_BRANCH } from "../slice/fixture-repo.js";

const ORCHESTRATE = fileURLToPath(
  new URL("../../../apps/mcp/dist/bin/nightshift-orchestrate.js", import.meta.url),
);

/** Far longer than a scripted run takes, and well inside the test's own timeout. */
const WATCHDOG_MS = Number(process.env.NIGHTSHIFT_PLANNING_WATCHDOG_MS ?? "120000");

let context: SliceContext | undefined;

afterEach(async () => {
  await context?.close().catch(() => {});
  context = undefined;
});

const strand = (id: string, prefix: string, dependsOn: string[], criteria: string[]): Strand => ({
  id,
  name: `The ${prefix} modules`,
  scope: {
    summary: `modules whose names start with ${prefix}`,
    includes: [`src/${prefix}*.js`, `test/${prefix}*.test.js`],
    excludes: [],
  },
  acceptance: [`the ${prefix} modules exist and node --test passes`],
  successCriteria: criteria,
  dependsOn,
  prerequisites: [],
});

const section = (id: string, prefix: string, tag: string): string =>
  [
    `### ${id} The ${prefix} modules`,
    "",
    `Two small modules, \`${prefix}1\` and \`${prefix}2\`, each with its own test.`,
    "",
    // What a real model would read as prose, the scripted one reads as its script.
    `[orchestrate prefix=${prefix}${tag}]`,
    "",
    "#### Considered and rejected",
    "",
    "One module holding both: they verify separately and conflict less apart.",
  ].join("\n");

const plan = (tags: Readonly<Record<string, string>>): string =>
  [
    "# Three strands",
    "",
    "## Strands",
    "",
    section("S-01", "a", tags["S-01"] ?? ""),
    "",
    section("S-02", "b", tags["S-02"] ?? ""),
    "",
    section("S-03", "c", tags["S-03"] ?? ""),
    "",
  ].join("\n");

/** Ratifies the three-strand plan, starts a run of it, and runs the launcher to its end. */
const runUnattended = async (
  tags: Readonly<Record<string, string>> = {},
  /** Adds a verification step that needs a human prerequisite nobody has met (D-P7-10). */
  gated = false,
) => {
  const ctx = await createLocalContext({
    delegationLimits: { maxDepth: 2, maxConcurrency: 3 },
    realTime: true,
  });
  context = ctx;
  const criteria = ctx.program.successCriteria.map((criterion) => criterion.id);
  const contract: ProgramContract = {
    ...ctx.program,
    status: "planning",
    strands: [
      strand("S-01", "a", [], criteria),
      strand("S-02", "b", ["S-01"], []),
      strand("S-03", "c", [], []),
    ],
    ...(gated
      ? {
          verification: [
            ...ctx.program.verification,
            { id: "release-check", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
          ],
          prerequisites: [
            {
              id: "HP-01",
              description: "The release token is in place.",
              remediation: "Ask the owner.",
              verifyCommand: 'node -e "process.exit(1)"',
              status: "pending" as const,
            },
          ],
        }
      : {}),
    decisions: [
      {
        id: "D-01",
        question: "One file per module?",
        options: ["yes", "no"],
        answer: "yes",
        rationale: "They verify separately.",
        touches: ["S-02"],
      },
    ],
  };
  const planText = plan(tags);
  await createHttpPlanning({ transport: ctx.transport }).ratify(contract, planText);
  // The program's directory, committed, as a planned repository has it: the
  // orchestrator finds the program there and writes the report beside it.
  const directory = join(ctx.fixture.repo, "docs", "programs", "three-strands");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(join(directory, "plan.md"), planText);
  await git(nodeGitRunner, ["add", "-A"], { cwd: ctx.fixture.repo });
  await git(
    nodeGitRunner,
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "plan"],
    { cwd: ctx.fixture.repo },
  );

  const started = await startRun(
    { stores: ctx.stores, clock: systemClock, ids: ctx.ids, git: nodeGitRunner },
    { program: contract, planText, repoPath: ctx.fixture.repo },
  );
  const scope: RunScope = {
    projectId: contract.projectId,
    programId: contract.programId,
    runId: started.run.runId,
  };

  const child = spawn(
    process.execPath,
    [
      ORCHESTRATE,
      "--project",
      scope.projectId,
      "--program",
      scope.programId,
      "--run",
      scope.runId,
      "--repo",
      ctx.fixture.repo,
    ],
    {
      cwd: ctx.fixture.repo,
      env: {
        ...sanitizeEnvironment({
          platform: process.platform,
          parentEnv: process.env,
          extra: undefined,
        }),
        ...ctx.serverEnv,
        NIGHTSHIFT_HARNESS_MODULE: scriptedHarnessModule(),
        NIGHTSHIFT_JOB_WAIT_CAP_SECONDS: "20",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (process.env.NIGHTSHIFT_DEBUG_PLANNING !== undefined) process.stderr.write(chunk);
  });
  // A run that hangs is diagnosed from its records, so they are printed before
  // the launcher is stopped rather than lost with the control plane.
  const watchdog = setTimeout(() => {
    void (async () => {
      await ctx.settle();
      const nodes = (await ctx.stores.executionNodes.listByRun(scope, { limit: 100 })).items;
      const recent = (await ctx.stores.events.listByRun(scope, { limit: 1000 })).items.slice(-25);
      process.stderr.write(
        `[unattended] still running after ${WATCHDOG_MS} ms\n${nodes
          .map((node) => `  ${node.kind} ${node.status} ${node.outcomeReason ?? ""}`)
          .join("\n")}\n${recent
          .map((event) => `  ${event.type} ${JSON.stringify(event.payload).slice(0, 300)}`)
          .join("\n")}\n${stderr.slice(-3000)}\n`,
      );
      child.kill("SIGTERM");
    })();
  }, WATCHDOG_MS);
  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(watchdog);
  expect(exitCode, stderr.slice(-3000)).toBe(0);
  const answer = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  await ctx.settle();
  const events = (await ctx.stores.events.listByRun(scope, { limit: 1000 })).items
    .filter(isSequenced)
    .sort((a, b) => a.sequence - b.sequence);
  const report = await gatherReport(ctx.stores, scope);
  const log = await git(
    nodeGitRunner,
    ["log", "--format=%s", `${started.baseCommit}..${PROGRAM_BRANCH}`],
    { cwd: ctx.fixture.repo },
  );
  return { ctx, scope, answer, events, report, log, planText };
};

describe("nightshift run {id}, unattended (SC-P7-06)", () => {
  it("finds departures by the prefix a strand's brief tells its orchestrator to use", () => {
    // Two packages, one convention: `execution` may not import `harness`'s brief.
    expect(DEPARTURE_PREFIX).toBe(STRAND_DEPARTURE_PREFIX);
  });

  it("takes a three-strand plan to a report: gated, briefed verbatim, decisions recorded", async () => {
    const { ctx, scope, answer, events, report, log, planText } = await runUnattended({
      "S-02": " depart=1",
    });

    // On a failure, why each strand ended as it did is the first thing to read.
    const why = JSON.stringify([
      report.strands.map((s) => [s.id, s.outcome, s.reason, s.jobs]),
      events.filter((event) => event.type === "agent.failed").map((event) => event.payload),
    ]);
    expect(answer, why).toMatchObject({ runStatus: "succeeded", exit: "completed" });
    expect(report.strands.map((s) => [s.id, s.outcome])).toEqual([
      ["S-01", "succeeded"],
      ["S-02", "succeeded"],
      ["S-03", "succeeded"],
    ]);
    // Six modules landed, two per strand, each through the merge queue.
    for (const name of ["a1", "a2", "b1", "b2", "c1", "c2"]) expect(log).toContain(name);

    // SC-P7-07, from the record: S-02 started only after S-01 had succeeded.
    const jobs = (await ctx.stores.jobContracts.listByRun(scope, { limit: 100 })).items;
    const nodes = (await ctx.stores.executionNodes.listByRun(scope, { limit: 100 })).items;
    const nodeOfStrand = (strandId: string): string => {
      const job = jobs.find((candidate) => candidate.strandId === strandId);
      return nodes.find((node) => node.jobContractId === job?.jobContractId)?.executionNodeId ?? "";
    };
    const at = (type: string, nodeId: string): number =>
      events.findIndex((event) => event.type === type && event.executionNodeId === nodeId);
    expect(at("node.started", nodeOfStrand("S-02"))).toBeGreaterThan(
      at("node.succeeded", nodeOfStrand("S-01")),
    );

    // SC-P7-10: the strand's orchestrator was handed its section verbatim, from
    // the ratified document, and the decision that touches it (SC-P7-09).
    const s02 = jobs.find((job) => job.strandId === "S-02");
    const verbatim = planText
      .slice(planText.indexOf("### S-02"), planText.indexOf("### S-03"))
      .trimEnd();
    expect(s02?.objective.startsWith(`${verbatim}\n\n`)).toBe(true);
    expect(s02?.objective).toContain("D-01: One file per module?\n    Answer: yes");
    expect(jobs.find((job) => job.strandId === "S-01")?.objective).not.toContain("D-01");

    // SC-P7-09: recorded with authority human, before any work started.
    // P9: the decision graph places it as the plan's (D-P9-08).
    const human = report.graph
      .filter((entry) => entry.place === "plan")
      .map((entry) => entry.decision);
    expect(human.map((d) => [d.choice, d.authority])).toEqual([["yes", "human"]]);
    const firstStart = events.findIndex((event) => event.type === "node.started");
    expect(Date.parse(human[0]?.createdAt ?? "")).toBeLessThanOrEqual(
      Date.parse(events[firstStart]?.occurredAt ?? ""),
    );

    // The plan names no jobs; each strand's orchestrator decided its own two.
    expect(report.strands.map((s) => s.jobs.length)).toEqual([2, 2, 2]);

    // SC-P7-11: the report leads S-02 with its departure, and every criterion is met.
    const text = renderReport(report);
    expect(report.criteria.every((criterion) => criterion.met)).toBe(true);
    const s02At = text.indexOf("### S-02");
    expect(text.indexOf("**Departed from the plan's approach:**")).toBeGreaterThan(s02At);
    expect(text.indexOf("**Departed from the plan's approach:**")).toBeLessThan(
      text.indexOf("Acceptance, as planned:", s02At),
    );
    expect(text).toContain("Nothing was parked.");

    // P9 (D-P9-01, SC-P9-01): what each decision produced. A strand's own
    // decision, its strand's commits; the plan's decision, what the strands it
    // touches landed; nothing from anywhere else.
    const decisions = (await ctx.stores.decisions.listByRun(scope, { limit: 100 })).items;
    const landedUnder = (strandIds: readonly string[]): string[] =>
      nodes
        .filter(
          (node) =>
            strandIds.map(nodeOfStrand).includes(node.parentNodeId ?? "") &&
            node.status === "integrated",
        )
        .map((node) => node.commitSha ?? "")
        .sort();
    const departure = decisions.find((decision) =>
      decision.context.startsWith(STRAND_DEPARTURE_PREFIX),
    );
    expect(departure?.executionNodeId).toBe(nodeOfStrand("S-02"));
    expect([...(departure?.produced?.commits ?? [])].sort()).toEqual(landedUnder(["S-02"]));
    const planned = report.program.decisions?.find((decision) => decision.id === "D-01");
    const touched =
      planned?.touches === "all" ? ["S-01", "S-02", "S-03"] : (planned?.touches ?? []);
    const d01 = decisions.find((decision) => decision.context.startsWith("D-01: "));
    expect(d01?.produced?.commits.length).toBeGreaterThan(0);
    expect([...(d01?.produced?.commits ?? [])].sort()).toEqual(landedUnder(touched));
    expect(text).toContain("## Decision graph");
    expect(text).toContain("**Plan:** D-01: One file per module?");
    // The orchestrator's run.finish wrote it: nothing else in this test writes one.
    const written = await readFile(
      join(ctx.fixture.repo, "docs", "programs", "three-strands", "report.md"),
      "utf8",
    );
    expect(written).toContain("3 of 3 strands succeeded");

    // What a session orchestrating this run would have been told as it went:
    // every strand's work, in the plan's terms, from the record alone.
    const feed = createActivityFeed(ctx.stores, scope);
    const lines = renderActivity(await feed.since());
    const said = lines.join("\n");
    for (const strandId of ["S-01", "S-02", "S-03"]) {
      expect(said).toContain(`${strandId} — started`);
      expect(said).toContain(`${strandId} — succeeded`);
    }
    // A job inside a strand is named under it, and its landing is on the record.
    expect(said).toMatch(/S-02 › Add the b1 module and its test\. — landed [0-9a-f]{8}/);
    expect(said).toContain("S-02 — decided: Two modules — DEPARTURE:");
    expect(said).toMatch(/S-0\d › .* — working: \d+ tool calls? \(/);
    // Each call answers "since the last one".
    expect(await feed.since()).toEqual([]);
    expect((await feed.all(5)).length).toBe(5);
  }, 180_000);

  it("carries on past a check that cannot run, on the provisional line, and ends deferred (SC-P7-08a)", async () => {
    const { ctx, scope, answer, report, log } = await runUnattended({}, true);
    const nodes = (await ctx.stores.executionNodes.listByRun(scope, { limit: 100 })).items;
    const seen: unknown[] = [
      (await ctx.stores.programContracts.get(scope.projectId, scope.programId))?.verification,
    ];
    for (const node of nodes.filter((candidate) => candidate.kind === "job")) {
      const verifications = await ctx.stores.verifications.listByNode(scope, node.executionNodeId);
      seen.push([
        node.status,
        verifications.map((v) => [v.outcome, v.commands.map((c) => c.stepId)]),
      ]);
    }
    expect(answer.runStatus, JSON.stringify(seen)).toBe("interrupted");
    expect(report.strands.map((s) => [s.id, s.outcome, s.waitingOn])).toEqual([
      ["S-01", "provisional", ["HP-01"]],
      ["S-02", "provisional", ["HP-01"]],
      ["S-03", "provisional", ["HP-01"]],
    ]);
    // The program branch received none of it.
    expect(log).toBe("");
  }, 180_000);

  it("parks a strand that fails with exactly its cone, finishes the rest, and says so (SC-P7-08)", async () => {
    const { answer, events, report, log } = await runUnattended({ "S-01": " fail=1" });

    expect(answer.runStatus).toBe("failed");
    expect(String(answer.outcomeReason)).toContain("S-01");
    expect(report.strands.map((s) => [s.id, s.outcome, s.blockedBy])).toEqual([
      ["S-01", "failed", []],
      ["S-02", "cancelled", ["S-01"]],
      ["S-03", "succeeded", []],
    ]);
    // Everything outside the cone still finished, and nothing inside it ran.
    expect(log).toContain("c1");
    expect(log).not.toContain("b1");

    const strandEvents = events
      .filter((event) => event.type.startsWith("strand."))
      .map((event) => [event.type, (event.payload as { strandId: string }).strandId]);
    expect(strandEvents).toEqual([
      ["strand.parked", "S-01"],
      ["strand.blocked", "S-02"],
    ]);

    const text = renderReport(report);
    expect(text).toContain("### S-02 The b modules: PARKED (cancelled), blocked by S-01");
    expect(text).toContain("- **S-02 The b modules**: blocked by S-01, so it was never started");
    expect(text).toContain("this strand's objective cannot be met as planned");
    expect(report.criteria.every((criterion) => !criterion.met)).toBe(true);
  }, 180_000);
});
