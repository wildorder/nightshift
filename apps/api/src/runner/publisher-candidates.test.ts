/**
 * The GitHub writer's work for a line's candidates (P25, D-P25-11, D-P25-12):
 * a qualified candidate's pull request opened from a pinned branch, a
 * superseded one's closed with a link, a merge noticed or made, and a
 * refusal recorded. Over the memory stores, with a fake GitHub.
 */
import {
  type CandidateId,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type LineCandidate,
  type OrgId,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type GitHubPullRequest,
  type GitHubPullRequests,
  makeLineRecord,
  makeMembership,
  makeProgramContract,
  makeProject,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { candidatePullRequestBody, publishCandidates } from "./publisher.js";

const NOW = "2026-11-04T12:00:00.000Z";
const LINE = "nightshift/develop";
const HEAD = "c".repeat(40);
const MAIN = "a".repeat(40);
const UPTO = "b".repeat(40);

interface FakeGitHub extends GitHubPullRequests {
  readonly calls: string[];
  pulls: Map<number, GitHubPullRequest>;
  refuseOpen?: string;
  refuseMerge?: string;
}

const fakeGitHub = (): FakeGitHub => {
  const github: FakeGitHub = {
    calls: [],
    pulls: new Map(),
    createBranch: async (_i, _r, branch, sha) => {
      github.calls.push(`branch ${branch} ${sha.slice(0, 4)}`);
    },
    open: async (_i, _r, request) => {
      if (github.refuseOpen !== undefined) throw new Error(github.refuseOpen);
      github.calls.push(
        `open ${request.head} -> ${request.base}${request.draft === true ? " (draft)" : ""}: ${request.title}`,
      );
      const number = github.pulls.size + 7;
      const pr: GitHubPullRequest = {
        number,
        url: `https://github.com/wildorder/fixture/pull/${number}`,
        state: "open",
        merged: false,
        headSha: HEAD,
      };
      github.pulls.set(number, pr);
      lastBody = request.body;
      return pr;
    },
    get: async (_i, _r, number) => github.pulls.get(number),
    close: async (_i, _r, number, comment) => {
      github.calls.push(`close #${number}: ${comment}`);
      const pr = github.pulls.get(number);
      if (pr !== undefined) github.pulls.set(number, { ...pr, state: "closed" });
    },
    merge: async (_i, _r, number, sha) => {
      github.calls.push(`merge #${number} at ${sha.slice(0, 4)}`);
      if (github.refuseMerge !== undefined) return { merged: false, detail: github.refuseMerge };
      const pr = github.pulls.get(number);
      if (pr !== undefined) github.pulls.set(number, { ...pr, state: "closed", merged: true });
      return { merged: true };
    },
  };
  return github;
};
let lastBody = "";

const world = async (
  candidates: LineCandidate[] | ((f: ReturnType<typeof createFixtures>) => LineCandidate[]),
) => {
  const stores: InMemoryStores = createInMemoryStores();
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
      {
        installationId: 9,
        account: "wildorder",
        repositories: ["wildorder/fixture"],
        recordedAt: NOW,
      },
    ],
    version: 1,
    updatedAt: NOW,
  });
  await stores.programContracts.put(
    makeProgramContract(f, {
      objective: "Show the tablet's check page.\nMore words.",
      repository: {
        url: "https://github.com/wildorder/fixture",
        baseBranch: "main",
        programBranch: "program/tablet-check",
      },
      line: { branch: LINE },
    }),
  );
  await stores.lines.update(f.scope.projectId, LINE, () =>
    makeLineRecord(f, {
      branch: LINE,
      repositoryUrl: "https://github.com/wildorder/fixture",
      head: HEAD as never,
      undeployed: [
        { program: f.scope.programId, upTo: UPTO as never, since: HEAD as never, at: NOW },
      ],
      candidates: typeof candidates === "function" ? candidates(f) : candidates,
    }),
  );
  const github = fakeGitHub();
  const deps = {
    stores,
    clock: createFixedClock(Date.parse(NOW)),
    github: {
      writeToken: async () => ({ token: "t", expiresAt: NOW }),
      pullRequests: github,
    },
    bundles: { get: async () => new Uint8Array() },
  };
  const record = async () => {
    const found = await stores.lines.get(f.scope.projectId, LINE);
    if (found === undefined) throw new Error("no line");
    return found;
  };
  const publish = () => publishCandidates(deps, { projectId: f.scope.projectId, branch: LINE });
  const update = (next: Awaited<ReturnType<typeof record>>) =>
    stores.lines.update(f.scope.projectId, LINE, () => next);
  return { f, github, record, publish, update };
};

const candidateOf = (
  f: ReturnType<typeof createFixtures>,
  overrides: Partial<LineCandidate> = {},
): LineCandidate => ({
  candidateId: f.ids.next("cand") as CandidateId,
  commit: HEAD as never,
  mainAt: MAIN as never,
  programs: [{ program: f.scope.programId, upTo: UPTO as never }],
  state: "qualified",
  runId: f.scope.runId,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("the GitHub writer and a line's candidates", () => {
  it("opens a qualified candidate's pull request from a branch pinned at its commit, to main", async () => {
    const f = createFixtures();
    const candidate = candidateOf(f);
    const w = await world([
      { ...candidate, programs: [{ program: f.scope.programId, upTo: UPTO as never }] },
    ]);
    // The world's fixtures own the program: re-point the candidate at it.
    const [stored] = (await w.record()).candidates ?? [];
    expect(stored).toBeDefined();
    await w.publish();
    const after = (await w.record()).candidates?.[0];
    expect(w.github.calls).toEqual([
      `branch nightshift/candidates/${candidate.candidateId} cccc`,
      `open nightshift/candidates/${candidate.candidateId} -> main: Nightshift: ship ${candidate.programs[0]?.program}`,
    ]);
    expect(after?.pr).toEqual({
      number: 7,
      url: "https://github.com/wildorder/fixture/pull/7",
      branch: `nightshift/candidates/${candidate.candidateId}`,
    });
    expect(lastBody).toContain("merge commit");
    expect(lastBody).toContain(candidate.candidateId);
  });

  it("closes a superseded candidate's pull request with a link to the one that replaced it", async () => {
    const f = createFixtures();
    const newer = candidateOf(f, {
      pr: {
        number: 8,
        url: "https://github.com/wildorder/fixture/pull/8",
        branch: "nightshift/candidates/n",
      },
    });
    const older = candidateOf(f, {
      state: "superseded",
      supersededBy: newer.candidateId,
      pr: {
        number: 7,
        url: "https://github.com/wildorder/fixture/pull/7",
        branch: "nightshift/candidates/o",
      },
    });
    const w = await world([older, newer]);
    for (const number of [7, 8]) {
      w.github.pulls.set(number, {
        number,
        url: `https://github.com/wildorder/fixture/pull/${number}`,
        state: "open",
        merged: false,
        headSha: HEAD,
      });
    }
    await w.publish();
    expect(w.github.calls).toContain(
      "close #7: Superseded by https://github.com/wildorder/fixture/pull/8: a newer qualified candidate of the line.",
    );
    const after = (await w.record()).candidates ?? [];
    expect(after[0]?.prClosedAt).toBe(NOW);
    expect(after[1]?.state).toBe("qualified");
  });

  it("merges a deploying candidate's pull request at its commit, then it is deployed and what it shipped is no longer undeployed", async () => {
    const w = await world((f) => [
      candidateOf(f, {
        state: "deploying",
        pr: { number: 7, url: "https://github.com/wildorder/fixture/pull/7", branch: "b" },
      }),
    ]);
    w.github.pulls.set(7, {
      number: 7,
      url: "https://github.com/wildorder/fixture/pull/7",
      state: "open",
      merged: false,
      headSha: HEAD,
    });
    expect((await w.record()).undeployed).toHaveLength(1);
    await w.publish();
    expect(w.github.calls).toEqual(["merge #7 at cccc"]);
    const after = await w.record();
    expect(after.candidates?.[0]).toMatchObject({ state: "deployed", deployedAt: NOW });
    expect(after.undeployed).toEqual([]);
  });

  it("notices a pull request merged in GitHub, and one closed unmerged", async () => {
    const f = createFixtures();
    const merged = candidateOf(f, {
      pr: { number: 7, url: "https://github.com/wildorder/fixture/pull/7", branch: "b" },
    });
    const w = await world([merged]);
    w.github.pulls.set(7, {
      number: 7,
      url: "https://github.com/wildorder/fixture/pull/7",
      state: "closed",
      merged: true,
      headSha: HEAD,
    });
    await w.publish();
    expect((await w.record()).candidates?.[0]?.state).toBe("deployed");

    const g = createFixtures();
    const closed = candidateOf(g, {
      pr: { number: 7, url: "https://github.com/wildorder/fixture/pull/7", branch: "b" },
    });
    const v = await world([closed]);
    v.github.pulls.set(7, {
      number: 7,
      url: "https://github.com/wildorder/fixture/pull/7",
      state: "closed",
      merged: false,
      headSha: HEAD,
    });
    await v.publish();
    expect((await v.record()).candidates?.[0]?.state).toBe("closed");
  });

  it("records why a pull request could not be opened, and a deploy GitHub refused", async () => {
    const f = createFixtures();
    const w = await world([candidateOf(f)]);
    w.github.refuseOpen =
      "the Nightshift App has not been granted Pull requests (read and write) on this installation";
    await w.publish();
    const after = (await w.record()).candidates?.[0];
    expect(after?.pr).toBeUndefined();
    expect(after?.prDetail).toContain("Pull requests");

    const g = createFixtures();
    const deploying = candidateOf(g, {
      state: "deploying",
      pr: { number: 7, url: "https://github.com/wildorder/fixture/pull/7", branch: "b" },
    });
    const v = await world([deploying]);
    v.github.pulls.set(7, {
      number: 7,
      url: "https://github.com/wildorder/fixture/pull/7",
      state: "open",
      merged: false,
      headSha: HEAD,
    });
    v.github.refuseMerge = "Head branch was modified";
    await v.publish();
    const refused = (await v.record()).candidates?.[0];
    expect(refused?.state).toBe("qualified");
    expect(refused?.prDetail).toContain("Head branch was modified");
  });
});

describe("a candidate pull request's words", () => {
  it("say what it ships, how the line got there, and what proved it", () => {
    const f = createFixtures();
    const body = candidatePullRequestBody({
      candidate: candidateOf(f),
      programs: [
        { program: f.scope.programId, name: "program/tablet-check", objective: "Show the page." },
      ],
      repairs: [{ commit: HEAD, runId: f.scope.runId, jobContractId: "job_x" }],
    });
    expect(body).toContain("## What this ships");
    expect(body).toContain("**program/tablet-check**");
    expect(body).toContain("job `job_x`");
    expect(body).toContain("merge commit");
  });
});

describe("a pull request per program, and drafts (P25, D-P25-16, D-P25-17)", () => {
  it("titles a candidate's pull request with its program, and says what else it ships", async () => {
    const other = createFixtures().ids.next("prog");
    const w = await world((f) => [
      candidateOf(f, {
        program: f.scope.programId,
        programs: [
          { program: f.scope.programId, upTo: UPTO as never },
          { program: other, upTo: UPTO as never },
        ],
      }),
    ]);
    await w.publish();
    expect(w.github.calls.at(-1)).toContain(
      "-> main: Nightshift: program/tablet-check: Show the tablet's check page.",
    );
    expect(lastBody).toContain("This also ships one other program not deployed yet");
  });

  it("closes the pull request of a candidate a later merge included", async () => {
    const w = await world((f) => {
      const merged = candidateOf(f, {
        state: "deployed",
        pr: { number: 8, url: "https://github.com/wildorder/fixture/pull/8", branch: "m" },
      });
      return [
        candidateOf(f, {
          state: "deployed",
          includedIn: merged.candidateId,
          pr: { number: 7, url: "https://github.com/wildorder/fixture/pull/7", branch: "i" },
        }),
        merged,
      ];
    });
    w.github.pulls.set(7, {
      number: 7,
      url: "https://github.com/wildorder/fixture/pull/7",
      state: "open",
      merged: false,
      headSha: HEAD,
    });
    await w.publish();
    expect(w.github.calls).toContain(
      "close #7: Deployed: included in https://github.com/wildorder/fixture/pull/8, which was merged.",
    );
    expect((await w.record()).candidates?.[0]?.prClosedAt).toBe(NOW);
  });

  it("opens a draft for work that did not ship, from its branch, and closes it once a candidate ships it", async () => {
    const w = await world([]);
    const { f } = w;
    const draft = {
      draftId: f.scope.runId,
      kind: "run" as const,
      program: f.scope.programId,
      runId: f.scope.runId,
      reason: "The run ended failed: S-03 could not log in.",
      createdAt: NOW,
    };
    const seeded = await w.record();
    await w.update({ ...seeded, drafts: [draft] });
    await w.publish();
    expect(w.github.calls).toEqual([
      "open program/tablet-check -> main (draft): Not shipped: program/tablet-check",
    ]);
    expect(lastBody).toContain("S-03 could not log in");
    expect((await w.record()).drafts?.[0]?.pr?.number).toBe(7);

    const later = await w.record();
    await w.update({
      ...later,
      candidates: [candidateOf(f, { createdAt: "2026-11-04T13:00:00.000Z" })],
    });
    await w.publish();
    expect(
      w.github.calls.some((call) => call.startsWith("close #7: This work reached the line")),
    ).toBe(true);
    expect((await w.record()).drafts?.[0]?.closedAt).toBe(NOW);
  });
});
