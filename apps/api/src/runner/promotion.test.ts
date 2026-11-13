/**
 * The promotion pull request (P26, S-01 J4): the publisher keeps one pull
 * request from the line to its promote target after each push, the reconciler
 * asks for a refresh when the target moved or a person may have closed it.
 * A fake GitHub stands in for the compare and pull-request calls, over memory
 * stores.
 */
import {
  type CommitSha,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type ExecutionNodeId,
  type LineRecord,
  type OrgId,
  type ProgramId,
  programsDirectoryOf,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  GitHubAccessMissing,
  type GitHubPromotionClient,
  lineProgramId,
  MAX_PROMOTION_BODY_CHARS,
  makeDecision,
  makeJobContract,
  makeLineRecord,
  makeLineVerification,
  makeMembership,
  makePlanDraft,
  makePlanDraftVersion,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
  type PullRequestFacts,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { ZERO_OID } from "../github/smart-http.js";
import type { ApiDeps } from "../http.js";
import { maintainPromotion } from "./promotion.js";
import { type GitRemote, publishLine, publishPromotion } from "./publisher.js";
import { type ReconcileDeps, reconcileLinePromotions } from "./reconcile.js";

const NOW = "2026-11-12T12:00:00.000Z";
const LINE = "nightshift/develop";
const REPOSITORY = "wildorder/fixture";
const sha = (n: number): CommitSha => n.toString(16).padStart(40, "0") as CommitSha;
const [H0, H1, H2] = [sha(1), sha(2), sha(3)] as const;
const T0 = sha(100);
const T1 = sha(101);

/** A table standing in for GitHub's compare and pull-request calls. */
const fakeGitHub = () => {
  const state = {
    calls: [] as string[],
    prs: [] as (Omit<PullRequestFacts, "state"> & {
      state: PullRequestFacts["state"];
      title: string;
      body: string;
    })[],
    aheadBy: 1,
    behindBy: 0,
    behindCommits: [] as { sha: string; subject: string; parents: string[] }[],
    denied: false,
    failure: undefined as Error | undefined,
    targetHead: T0 as string | undefined,
  };
  const guard = (call: string) => {
    state.calls.push(call);
    if (state.denied) throw new GitHubAccessMissing("pull_requests", "forbidden");
    if (state.failure !== undefined) throw state.failure;
  };
  const client: GitHubPromotionClient = {
    compare: async (_i, _r, base) => {
      guard("compare");
      return base === "main"
        ? {
            aheadBy: state.aheadBy,
            behindBy: state.behindBy,
            commits: Array.from({ length: state.aheadBy }, (_, index) => ({
              sha: sha(500 + index),
              subject: `commit ${index}`,
              parents: [],
            })),
            complete: true,
          }
        : {
            aheadBy: state.behindCommits.length,
            behindBy: 0,
            commits: state.behindCommits,
            complete: true,
          };
    },
    findOpenPullRequest: async () => {
      guard("find");
      return state.prs.find((pr) => pr.state === "open");
    },
    pullRequest: async (_i, _r, number) => {
      guard("read");
      return state.prs.find((pr) => pr.number === number);
    },
    openPullRequest: async (_i, _r, pull) => {
      guard("open");
      const pr = {
        number: state.prs.length + 1,
        url: `https://github.com/${REPOSITORY}/pull/${state.prs.length + 1}`,
        state: "open" as const,
        head: LINE,
        base: pull.base,
        title: pull.title,
        body: pull.body,
      };
      state.prs.push(pr);
      return pr;
    },
    updatePullRequest: async (_i, _r, number, pull) => {
      guard("update");
      const pr = state.prs.find((candidate) => candidate.number === number);
      if (pr === undefined) throw new Error("no such pull request");
      pr.title = pull.title;
      pr.body = pull.body;
      return pr;
    },
  };
  return { state, client };
};

const world = async (options: { promote?: boolean; head?: CommitSha } = {}) => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const orgId = f.ids.next("org") as OrgId;
  await stores.memberships.put(makeMembership(nextUserId(f), orgId));
  await stores.projects.put(makeProject(f, { orgId }));
  await stores.orgConfigs.put({
    schemaVersion: 1,
    orgId,
    routingPolicy: DEFAULT_ROUTING_POLICY,
    examinationPolicy: DEFAULT_EXAMINATION_POLICY,
    installations: [
      { installationId: 1, account: "wildorder", repositories: [REPOSITORY], recordedAt: NOW },
    ],
    version: 1,
    updatedAt: NOW,
  });
  const contract = (programId: ProgramId, createdAt: string, promote: boolean) =>
    makeProgramContract(f, {
      programId,
      createdAt,
      repository: {
        url: `https://github.com/${REPOSITORY}`,
        baseBranch: "main",
        programBranch: "program/fixture",
      },
      line: { branch: LINE, ...(promote ? { promote: { to: "main" } } : {}) },
    });
  await stores.programContracts.put(
    contract(f.scope.programId, "2026-11-01T00:00:00.000Z", options.promote !== false),
  );
  const projectId = f.scope.projectId;
  const github = fakeGitHub();
  const refs = new Map<string, string>([[`refs/heads/${LINE}`, options.head ?? H0]]);
  const remote: GitRemote = {
    advertise: async () => new Map(refs),
    push: async ({ ref, expectedOld, newOid }) => {
      if ((refs.get(ref) ?? ZERO_OID) !== expectedOld) {
        return { kind: "rejected", reason: "non-fast-forward" };
      }
      refs.set(ref, newOid);
      return { kind: "ok" };
    },
  };
  await stores.lines.update(projectId, LINE, () =>
    makeLineRecord(f, {
      projectId,
      repositoryUrl: `https://github.com/${REPOSITORY}`,
      head: options.head ?? H0,
    }),
  );
  const deps = {
    stores,
    clock: createFixedClock(Date.parse(NOW)),
    github: {
      writeToken: async () => ({ token: "t", expiresAt: NOW }),
      branchHead: async (_i: number, _r: string, branch: string) =>
        branch === "main" ? github.state.targetHead : undefined,
    },
    promotions: github.client,
    bundles: { get: async () => new Uint8Array() },
    remote,
    remoteUrlOf: () => "http://remote.invalid/line.git",
  };
  const line = { projectId, branch: LINE };
  const record = async (): Promise<LineRecord> => {
    const found = await stores.lines.get(projectId, LINE);
    if (found === undefined) throw new Error("no line");
    return found;
  };
  /** The owner asks for the line to move to `head`; the publisher pushes it. */
  const push = async (head: CommitSha) => {
    const current = await record();
    await stores.lines.update(projectId, LINE, (c) =>
      c === undefined
        ? undefined
        : {
            ...c,
            push: {
              head,
              expectedPredecessor: (current.head ?? H0) as CommitSha,
              bundleKey: `b/${head}`,
              generation: 1,
              status: "pending",
              requestedAt: NOW,
            },
          },
    );
    return publishLine(deps, line);
  };
  const callsOf = (name: string) => github.state.calls.filter((call) => call === name).length;
  return { stores, f, deps, line, github, refs, record, push, callsOf, contract };
};

describe("promotion after a push", () => {
  it("opens one pull request after a push and records it", async () => {
    const w = await world();
    expect(await w.push(H1)).toBe("published");
    expect(w.github.state.prs).toHaveLength(1);
    expect(w.github.state.prs[0]?.title).toBe(`Promote ${LINE} to main`);
    expect(w.github.state.prs[0]?.body).toContain(H1);
    const promotion = (await w.record()).promotion;
    expect(promotion).toMatchObject({
      to: "main",
      number: 1,
      state: "open",
      head: H1,
      targetHead: T0,
      aheadBy: 1,
      behindBy: 0,
    });
    expect(promotion?.blocked).toBeUndefined();
  });

  it("updates the same pull request after the next push: exactly one", async () => {
    const w = await world();
    await w.push(H1);
    await w.push(H2);
    expect(w.github.state.prs).toHaveLength(1);
    expect(w.github.state.prs[0]?.body).toContain(H2);
    expect((await w.record()).promotion).toMatchObject({ number: 1, head: H2, state: "open" });
    expect(w.callsOf("open")).toBe(1);
  });

  it("opens none when there is nothing to promote", async () => {
    const w = await world();
    w.github.state.aheadBy = 0;
    await w.push(H1);
    expect(w.github.state.prs).toHaveLength(0);
    expect(w.callsOf("open")).toBe(0);
    expect((await w.record()).promotion).toMatchObject({ to: "main", head: H1, aheadBy: 0 });
  });

  it("records a diverged target and says so first in the body, touching nothing else", async () => {
    const w = await world();
    w.github.state.behindBy = 1;
    w.github.state.behindCommits = [
      { sha: sha(900), subject: "hotfix on main", parents: [sha(1)] },
    ];
    await w.push(H1);
    const record = await w.record();
    expect(record.promotion?.diverged).toMatchObject({
      count: 1,
      commits: [{ sha: sha(900), subject: "hotfix on main" }],
    });
    expect(record.promotion?.behindBy).toBe(1);
    expect(w.github.state.prs[0]?.body.split("\n")[0]).toContain("Warning");
    expect(w.github.state.prs[0]?.body).toContain("hotfix on main");
    expect(record.queue).toEqual([]);
    expect(record.push?.status).toBe("published");
    expect(record.batch).toBeUndefined();
    expect(record.waiting).toBeUndefined();
    // Cleared when the target no longer diverges.
    w.github.state.behindBy = 0;
    w.github.state.behindCommits = [];
    await maintainPromotion(w.deps, w.line);
    expect((await w.record()).promotion?.diverged).toBeUndefined();
  });

  it("opens a fresh pull request for a push after the last one merged", async () => {
    const w = await world();
    await w.push(H1);
    const first = w.github.state.prs[0];
    if (first === undefined) throw new Error("no pull request");
    first.state = "merged";
    // Same head after the merge: nothing new to open.
    await maintainPromotion(w.deps, w.line);
    expect((await w.record()).promotion?.state).toBe("merged");
    expect(w.github.state.prs).toHaveLength(1);
    await w.push(H2);
    expect(w.github.state.prs).toHaveLength(2);
    expect((await w.record()).promotion).toMatchObject({ number: 2, state: "open", head: H2 });
  });
});

describe("a pull request a person closed", () => {
  const openAtH1 = async () => {
    const w = await world();
    await w.push(H1);
    return w;
  };

  it("a target-only refresh opens none and records closed; a line push then opens a fresh one", async () => {
    const w = await openAtH1();
    const pr = w.github.state.prs[0];
    if (pr === undefined) throw new Error("no pull request");
    pr.state = "closed";
    w.github.state.targetHead = T1;
    expect(await publishPromotion(w.deps, w.line)).toBe("closed");
    expect(w.github.state.prs).toHaveLength(1);
    expect((await w.record()).promotion).toMatchObject({
      state: "closed",
      closedAtHead: H1,
      targetHead: T1,
    });
    // Another refresh still opens none.
    await publishPromotion(w.deps, w.line);
    expect(w.github.state.prs).toHaveLength(1);
    await w.push(H2);
    expect(w.github.state.prs).toHaveLength(2);
    expect((await w.record()).promotion).toMatchObject({ number: 2, state: "open", head: H2 });
    expect((await w.record()).promotion?.closedAtHead).toBeUndefined();
  });

  it("a push that lands before the close is seen still opens a fresh one", async () => {
    const w = await openAtH1();
    const pr = w.github.state.prs[0];
    if (pr === undefined) throw new Error("no pull request");
    pr.state = "closed";
    // The record still says open at H1; the push to H2 maintains first.
    await w.push(H2);
    expect(w.github.state.prs).toHaveLength(2);
    expect((await w.record()).promotion).toMatchObject({ number: 2, state: "open", head: H2 });
  });
});

describe("what blocks the promotion", () => {
  it("records a missing grant and makes no further calls in that refresh", async () => {
    const w = await world();
    w.github.state.denied = true;
    expect(await w.push(H1)).toBe("published");
    expect(w.github.state.calls).toEqual(["compare"]);
    const blocked = (await w.record()).promotion?.blocked;
    expect(blocked).toMatchObject({ reason: "pull_requests_permission", head: H1 });
    expect(blocked?.detail).toContain("Pull requests: Read and write");
    expect((await w.record()).push?.status).toBe("published");
  });

  it("records any other failure as an error block and never throws", async () => {
    const w = await world();
    w.github.state.failure = new Error("boom");
    expect(await w.push(H1)).toBe("published");
    expect((await w.record()).promotion?.blocked).toMatchObject({
      reason: "error",
      detail: "boom",
    });
    w.github.state.failure = undefined;
    await publishPromotion(w.deps, w.line);
    expect((await w.record()).promotion?.blocked).toBeUndefined();
    expect(w.github.state.prs).toHaveLength(1);
  });

  it("makes no call and removes a stale promotion when the line has no promote", async () => {
    const w = await world({ promote: false });
    await w.stores.lines.update(w.line.projectId, LINE, (c) =>
      c === undefined ? undefined : { ...c, promotion: { to: "main", updatedAt: NOW } },
    );
    expect(await publishPromotion(w.deps, w.line)).toBe("not_configured");
    expect(w.github.state.calls).toEqual([]);
    expect((await w.record()).promotion).toBeUndefined();
    await w.push(H1);
    expect(w.github.state.calls).toEqual([]);
    expect((await w.record()).promotion).toBeUndefined();
  });

  it("makes no call without a promotions client", async () => {
    const w = await world();
    const { promotions: _none, ...without } = w.deps;
    expect(await maintainPromotion(without, w.line)).toBe("no_client");
    expect(w.github.state.calls).toEqual([]);
  });

  it("follows the newest contract: one without promote wins over an older one with it", async () => {
    const w = await world();
    await w.stores.programContracts.put(
      w.contract(w.f.ids.next("prog") as ProgramId, "2026-11-10T00:00:00.000Z", false),
    );
    await w.push(H1);
    expect(w.github.state.calls).toEqual([]);
    expect((await w.record()).promotion).toBeUndefined();
  });

  it("describes whole and part programs from the runs store", async () => {
    const w = await world();
    await w.stores.runs.put(makeRun(w.f, { status: "succeeded", location: "remote" }));
    await w.push(H1);
    expect(w.github.state.prs[0]?.body).toContain("## Programs");
  });

  /** A composition of the commit the fake compare lists, for the world's program. */
  const withComposition = async (
    w: Awaited<ReturnType<typeof world>>,
    over: Partial<LineRecord["compositions"][number]> = {},
  ) => {
    await w.stores.lines.update(w.line.projectId, LINE, (c) =>
      c === undefined
        ? undefined
        : {
            ...c,
            compositions: [
              {
                compositionId: "c1",
                commit: sha(500),
                parent: H0,
                ranges: [{ program: w.f.scope.programId, upTo: sha(900) }],
                verification: makeLineVerification(w.f, { commitSha: sha(500) }),
                composedAt: NOW,
                ...over,
              },
            ],
          },
    );
  };

  it("links the report at the path a run publishes it to, by the plan draft's name", async () => {
    const w = await world();
    await w.stores.planDrafts.appendVersion(makePlanDraftVersion(w.f), () =>
      makePlanDraft(w.f, { name: "p1-billing" }),
    );
    await withComposition(w);
    await w.push(H1);
    const body = w.github.state.prs[0]?.body ?? "";
    const contract = await w.stores.programContracts.get(w.line.projectId, w.f.scope.programId);
    // publish-run.ts: `${programsDirectoryOf(program)}/${name}` plus report.md.
    const published = `${programsDirectoryOf(contract)}/p1-billing/report.md`;
    expect(published).toBe("docs/programs/p1-billing/report.md");
    expect(body).toContain(`](https://github.com/${REPOSITORY}/blob/${LINE}/${published})`);
    expect(body).not.toContain(`${w.f.scope.programId}/report.md`);
  });

  it("states each repair's decision from the line run's job contract", async () => {
    const w = await world();
    const scope = {
      projectId: w.line.projectId,
      programId: lineProgramId(w.line.projectId, LINE),
      runId: w.f.scope.runId,
    };
    const decision = makeDecision(w.f, w.f.ids.next("node") as ExecutionNodeId, {
      ...scope,
      choice: "Delegate repair attempt 1 of 3 as a line_red job.",
      rationale: "Only this range waits.",
    });
    const job = makeJobContract(w.f, {
      ...scope,
      repair: { cause: "line_red", gates: ["npm test"], decisionId: decision.decisionId },
    });
    const missing = makeJobContract(w.f, { ...scope });
    await w.stores.decisions.put(decision);
    await w.stores.jobContracts.put(job);
    await w.stores.jobContracts.put(missing);
    await withComposition(w, {
      repair: { runId: scope.runId, jobContractId: job.jobContractId },
    });
    await w.push(H1);
    const body = w.github.state.prs[0]?.body ?? "";
    expect(body).toContain("Delegate repair attempt 1 of 3 as a line_red job.");
    expect(body).toContain("because Only this range waits.");
    expect(body).toContain("cause line_red; gates npm test");
    expect(body.length).toBeLessThanOrEqual(MAX_PROMOTION_BODY_CHARS);
  });

  it("says the decision is not recorded when the repair job is unknown", async () => {
    const w = await world();
    const ghost = w.f.ids.next("job");
    await withComposition(w, { repair: { runId: w.f.scope.runId, jobContractId: ghost } });
    await w.push(H1);
    expect(w.github.state.prs[0]?.body).toContain(`job ${ghost}; decision not recorded`);
  });
});

describe("a crash between the push and the maintenance", () => {
  it("is recovered by the reconciler from the seeded record", async () => {
    const w = await world();
    await w.push(H1);
    // The push landed but the maintenance never ran: the line moved, the promotion did not.
    await w.stores.lines.update(w.line.projectId, LINE, (c) =>
      c === undefined ? undefined : { ...c, head: H2 },
    );
    const asked: unknown[] = [];
    const deps = reconcilerDeps(w, asked);
    await reconcileLinePromotions(deps, () => undefined);
    expect(asked).toEqual([{ kind: "promotion", projectId: w.line.projectId, branch: LINE }]);
    await publishPromotion(w.deps, w.line);
    expect((await w.record()).promotion?.head).toBe(H2);
    expect(w.github.state.prs[0]?.body).toContain(H2);
  });

  it("seeds the promotion before the push", async () => {
    const w = await world();
    const seen: (LineRecord["promotion"] | undefined)[] = [];
    const remote: GitRemote = {
      advertise: w.deps.remote.advertise,
      push: async (input) => {
        seen.push((await w.record()).promotion);
        return w.deps.remote.push(input);
      },
    };
    await w.stores.lines.update(w.line.projectId, LINE, (c) =>
      c === undefined
        ? undefined
        : {
            ...c,
            push: {
              head: H1,
              expectedPredecessor: H0,
              bundleKey: "b",
              generation: 1,
              status: "pending",
              requestedAt: NOW,
            },
          },
    );
    await publishLine({ ...w.deps, remote }, w.line);
    expect(seen[0]).toMatchObject({ to: "main" });
  });
});

const reconcilerDeps = (
  w: Awaited<ReturnType<typeof world>>,
  asked: unknown[],
  now = Date.parse(NOW),
): ReconcileDeps =>
  ({
    provision: { stores: w.stores, clock: { now: () => now } },
    plane: { github: { branchHead: async () => w.github.state.targetHead } } as unknown as ApiDeps,
    askPublisher: async (request: unknown) => {
      asked.push(request);
    },
  }) as unknown as ReconcileDeps;

describe("the reconciler's ask", () => {
  const settled = async () => {
    const w = await world();
    w.github.state.aheadBy = 0;
    await w.push(H1);
    return w;
  };

  it("asks when the target moved", async () => {
    const w = await settled();
    w.github.state.targetHead = T1;
    const asked: unknown[] = [];
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    expect(asked).toHaveLength(1);
  });

  it("does not ask when nothing moved and the pull request is closed", async () => {
    const w = await world();
    await w.push(H1);
    const pr = w.github.state.prs[0];
    if (pr === undefined) throw new Error("no pull request");
    pr.state = "closed";
    await publishPromotion(w.deps, w.line);
    const asked: unknown[] = [];
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    expect(asked).toEqual([]);
  });

  it("keeps asking while the pull request is open, so a close is seen within a tick", async () => {
    const w = await world();
    await w.push(H1);
    const asked: unknown[] = [];
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    expect(asked).toHaveLength(1);
  });

  it("asks every tick after an error block", async () => {
    const w = await settled();
    w.github.state.failure = new Error("boom");
    await publishPromotion(w.deps, w.line);
    const asked: unknown[] = [];
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    expect(asked).toHaveLength(2);
  });

  it("does not ask for a permission block every tick, but when something moved or an hour passed", async () => {
    const w = await settled();
    w.github.state.denied = true;
    await publishPromotion(w.deps, w.line);
    const asked: unknown[] = [];
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    expect(asked).toEqual([]);
    w.github.state.targetHead = T1;
    await reconcileLinePromotions(reconcilerDeps(w, asked), () => undefined);
    expect(asked).toHaveLength(1);
    w.github.state.targetHead = T0;
    await reconcileLinePromotions(
      reconcilerDeps(w, asked, Date.parse(NOW) + 61 * 60_000),
      () => undefined,
    );
    expect(asked).toHaveLength(2);
  });

  it("counts and survives a failure on one line", async () => {
    const w = await settled();
    const deps = reconcilerDeps(w, []);
    const failing = {
      ...deps,
      plane: {
        github: {
          branchHead: async () => {
            throw new Error("down");
          },
        },
      },
    } as unknown as ReconcileDeps;
    const counts: Record<string, number> = {};
    const quiet = console.error;
    console.error = () => undefined;
    try {
      await reconcileLinePromotions(failing, (key) => {
        counts[key] = (counts[key] ?? 0) + 1;
      });
    } finally {
      console.error = quiet;
    }
    expect(counts).toEqual({ error: 1 });
  });
});
