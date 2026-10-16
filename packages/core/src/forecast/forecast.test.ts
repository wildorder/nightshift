/** The verification plan's arithmetic, the resolver, and the catalogue (P17). */
import { describe, expect, it } from "vitest";
import { QUIET_START_THRESHOLD_MS, recommend } from "./catalogue.js";
import { forecast, humanDuration, type MeasuredStep } from "./model.js";
import { resolveCommand } from "./resolve.js";

const measured = (durationMs: number, quietMs = 0, extra: Partial<MeasuredStep> = {}) => ({
  durationMs,
  quietMs,
  exitCode: 0,
  ...extra,
});

const plan = () =>
  forecast({
    setup: [{ id: "install", command: "npm ci" }],
    verification: [
      { id: "unit", command: "npm test" },
      { id: "db-test", command: "bash scripts/db.sh test" },
      { id: "e2e", command: "npm run test:e2e" },
      { id: "nightly", command: "npm run nightly", at: "end" },
    ],
    measured: new Map([
      ["setup:install", measured(3_000, 0, { seeded: true })],
      ["unit", measured(55_000)],
      ["db-test", measured(9 * 60_000 + 10_000, 3 * 60_000 + 5_000)],
      ["e2e", measured(11 * 60_000 + 40_000)],
      ["nightly", measured(20 * 60_000)],
    ]),
    landings: { count: 12, source: "given" },
  });

describe("the verification plan", () => {
  it("sums only what was measured, by when it runs, and states its multiplier", () => {
    const p = plan();
    expect(p.setupMs).toBe(0); // seeded: the audit skipped it, so a landing pays nothing for it
    expect(p.landingMs).toBe(55_000 + 550_000 + 700_000);
    expect(p.examinedJobMs).toBe(2 * p.landingMs);
    expect(p.endGatesMs).toBe(20 * 60_000);
    expect(p.projectedMs).toBe(12 * p.landingMs + 2 * p.endGatesMs);
    expect(p.landings).toEqual({ count: 12, source: "given" });
    expect(p.unmeasured).toEqual([]);
  });

  it("names a step the audit did not measure rather than guessing it", () => {
    const p = forecast({
      setup: [],
      verification: [{ id: "deploy", command: "npm run deploy-check", requires: ["HP-01"] }],
      measured: new Map(),
      landings: { count: 10, source: "default" },
    });
    expect(p.unmeasured).toEqual(["deploy"]);
    expect(p.landingMs).toBe(0);
  });

  it("reads durations at a glance", () => {
    expect(humanDuration(3_100)).toBe("3.1s");
    expect(humanDuration(9 * 60_000 + 10_000)).toBe("9m 10s");
    expect(humanDuration(2 * 3_600_000 + 10 * 60_000)).toBe("2h 10m");
  });
});

describe("the resolver", () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      scripts: {
        "test:e2e": "playwright test",
        pretest: "npm run build",
        test: "vitest run",
        build: "tsc -b",
      },
    }),
    "scripts/db.sh": [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "# start the database",
      "docker compose up -d --wait postgres",
      "npm test",
    ].join("\n"),
  };
  const read = async (path: string) => files[path];

  it("follows package scripts with their hooks and quotes each line's source", async () => {
    const resolved = await resolveCommand("unit", "npm test", read);
    expect(resolved.lines).toEqual([
      { source: "contract", text: "npm test" },
      { source: "package.json → scripts.pretest", text: "npm run build" },
      { source: "package.json → scripts.build", text: "tsc -b" },
      { source: "package.json → scripts.test", text: "vitest run" },
    ]);
    expect(resolved.unresolved).toEqual([]);
  });

  it("follows a shell script line by line, then what the script runs", async () => {
    const resolved = await resolveCommand("db-test", "bash scripts/db.sh test", read);
    expect(resolved.lines.map((line) => line.source)).toEqual([
      "contract",
      "scripts/db.sh:2",
      "scripts/db.sh:4",
      "scripts/db.sh:5",
      "package.json → scripts.pretest",
      "package.json → scripts.build",
      "package.json → scripts.test",
    ]);
  });

  it("reports what it could not follow instead of guessing", async () => {
    const resolved = await resolveCommand("x", "npm run nothing && bash scripts/gone.sh", read);
    expect(resolved.unresolved).toEqual(["nothing", "scripts/gone.sh"]);
    expect(resolved.lines).toEqual([
      { source: "contract", text: "npm run nothing && bash scripts/gone.sh" },
    ]);
  });
});

describe("the catalogue", () => {
  const resolved = new Map([
    [
      "e2e",
      {
        stepId: "e2e",
        command: "npm run test:e2e",
        lines: [
          { source: "contract", text: "npm run test:e2e" },
          { source: "package.json → scripts.test:e2e", text: "playwright test" },
        ],
        unresolved: [],
      },
    ],
    [
      "db-test",
      {
        stepId: "db-test",
        command: "bash scripts/db.sh test",
        lines: [
          { source: "contract", text: "bash scripts/db.sh test" },
          { source: "scripts/db.sh:4", text: "docker compose up -d --wait postgres" },
        ],
        unresolved: [],
      },
    ],
  ]);

  it("recommends the end for a whole-system gate on tool signature, priced by landings", () => {
    const [first] = recommend(plan(), resolved);
    expect(first).toMatchObject({
      rule: 9,
      stepId: "e2e",
      savingMs: 700_000 * 12 - 700_000 * 2,
      edit: { stepId: "e2e", set: { at: "end" } },
    });
    expect(first?.evidence[0]).toContain("playwright test");
  });

  it("matches a tool only where it runs, not where a line merely names it", () => {
    const usage = new Map([
      [
        "db-test",
        {
          stepId: "db-test",
          command: "bash scripts/test-docker.sh test",
          lines: [
            { source: "contract", text: "bash scripts/test-docker.sh test" },
            {
              source: "scripts/test-docker.sh:43",
              text: "echo 'usage: scripts/test-docker.sh test | e2e [<playwright args>]' >&2",
            },
            { source: "scripts/test-docker.sh:171", text: "docker run --detach --rm \\" },
            { source: "scripts/test-docker.sh:232", text: "pnpm exec vitest run --maxWorkers=1" },
          ],
          unresolved: [],
        },
      ],
      [
        "e2e",
        {
          stepId: "e2e",
          command: "npm run test:e2e",
          lines: [
            { source: "contract", text: "npm run test:e2e" },
            { source: "package.json → scripts.test:e2e", text: "CI=1 npx playwright test" },
          ],
          unresolved: [],
        },
      ],
    ]);
    const all = recommend(plan(), usage);
    expect(all.filter((r) => r.rule === 9).map((r) => r.stepId)).toEqual(["e2e"]);
    expect(all.find((r) => r.rule === 7)?.stepId).toBe("db-test");
  });

  it("never recommends the end on time alone", () => {
    // unit is the slowest landing step here and resolves to nothing whole-system.
    const slow = forecast({
      setup: [],
      verification: [{ id: "unit", command: "npm test" }],
      measured: new Map([["unit", measured(3 * 3_600_000)]]),
      landings: { count: 12, source: "given" },
    });
    expect(recommend(slow, new Map()).filter((r) => r.rule === 9)).toEqual([]);
  });

  it("prices a quiet start on a service-starting gate under rule 7, with the threshold shown", () => {
    const quiet = recommend(plan(), resolved).find((r) => r.rule === 7);
    expect(quiet).toMatchObject({ stepId: "db-test", savingMs: (3 * 60_000 + 5_000) * 12 });
    expect(quiet?.evidence[1]).toContain(`over the ${QUIET_START_THRESHOLD_MS / 1000}`.slice(0, 8));
    expect(quiet?.fix).toContain("NIGHTSHIFT_VERIFICATION_ID");
  });

  it("does not treat an end gate as a landing gate, and lists facts last", () => {
    const all = recommend(plan(), resolved);
    expect(all.find((r) => r.stepId === "nightly")).toBeUndefined();
    expect(all.at(-1)?.title).toBe("an examined job verifies twice");
  });
});
