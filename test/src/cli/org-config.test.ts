/**
 * `nightshift org config` and `nightshift routes export` (P8, D-P8-02,
 * SC-P8-15), through the real CLI against the real handler.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@nightshift/cli";
import {
  DEFAULT_ROUTING_POLICY,
  OrgConfigSchema,
  RoutingDatasetLineSchema,
} from "@nightshift/contracts";
import {
  createFixtures,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "./operator.js";

let op: Operator;
let dir: string;

beforeEach(async () => {
  op = await signIn();
  dir = await mkdtemp(join(tmpdir(), "nightshift-org-"));
});

afterEach(async () => {
  await op.cleanup();
  await rm(dir, { recursive: true, force: true });
});

const storesOf = () =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("unused"),
    }),
  });

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, argv);
};

describe("nightshift org config (D-P8-02)", () => {
  it("gets the seeded default, sets an edited copy on top of it, and refuses a stale one", async () => {
    expect(await cli("org", "config", "get", "--org", op.orgId)).toBe(0);
    const seeded = OrgConfigSchema.parse(JSON.parse(op.out.join("\n")));
    expect(seeded.version).toBe(0);
    expect(op.err.join("\n")).toContain("seeded default");

    const file = join(dir, "org.json");
    const edited = {
      ...seeded,
      routingPolicy: {
        ...seeded.routingPolicy,
        rules: [{ id: "R-all", when: {}, start: { ladder: "codex", tier: "standard" } }],
      },
    };
    await writeFile(file, JSON.stringify(edited));
    expect(await cli("org", "config", "set", file, "--org", op.orgId), op.err.join("\n")).toBe(0);
    expect(op.out.join("\n")).toContain("version 1");

    expect(await cli("org", "config", "get", "--org", op.orgId)).toBe(0);
    const now = OrgConfigSchema.parse(JSON.parse(op.out.join("\n")));
    expect(now.routingPolicy.rules.map((rule) => rule.id)).toEqual(["R-all"]);
    expect(now.routingPolicy.ladders).toEqual(DEFAULT_ROUTING_POLICY.ladders);

    // The same file again was read at version 0, which is gone.
    expect(await cli("org", "config", "set", file, "--org", op.orgId)).toBe(1);
    expect(op.err.join("\n")).toMatch(/version/);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(0);
  });
});

describe("nightshift routes export (SC-P8-15)", () => {
  it("prints one self-contained line per routing decision of the program's runs", async () => {
    const stores = storesOf();
    const f = createFixtures();
    await stores.projects.put({
      schemaVersion: 1,
      projectId: f.scope.projectId,
      orgId: op.orgId,
      name: "export",
      createdAt: "2026-09-25T10:00:00.000Z",
    });
    const program = makeProgramContract(f);
    await stores.programContracts.put(program);
    const root = makeRootNode(f);
    await stores.runs.put(makeRun(f, { rootNodeId: root.executionNodeId }));
    await stores.executionNodes.put(root);
    const job = makeJobContract(f, { testability: "strong", kind: "implement" });
    await stores.jobContracts.put(job);
    const node = makeNode(f, root.executionNodeId, { jobContractId: job.jobContractId });
    await stores.executionNodes.put(node);
    await stores.routingDecisions.put({
      schemaVersion: 1,
      ...f.scope,
      routingDecisionId: f.ids.next("route"),
      executionNodeId: node.executionNodeId,
      attempt: 1,
      eligibleOptions: [
        {
          target: { harness: "claude", provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          eligible: true,
        },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      ruleId: "R-bounded",
      wasOverride: false,
      usage: {},
      outcome: "pending",
      previousRouteId: null,
      ladder: "claude",
      rung: { tier: "cheap", index: 0 },
      classification: { risk: "low", ambiguity: "low", testability: "strong", kind: "implement" },
      policyVersion: 0,
      createdAt: "2026-09-25T10:00:00.000Z",
    });
    await mkdir(join(dir, "docs", "programs", "demo"), { recursive: true });
    await writeFile(
      join(dir, "docs", "programs", "demo", "contract.json"),
      JSON.stringify(program),
    );
    await writeFile(join(dir, "docs", "programs", "demo", "plan.md"), "# Demo\n");

    expect(await cli("routes", "export", "demo", "--repo", dir), op.err.join("\n")).toBe(0);
    const lines = op.out.map((line) => RoutingDatasetLineSchema.parse(JSON.parse(line)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      purpose: "work",
      ruleId: "R-bounded",
      ladder: "claude",
      classification: { testability: "strong", kind: "implement" },
      jobContractId: job.jobContractId,
    });
  });
});
