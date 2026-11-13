/**
 * A stand-in for GitHub's compare and pull-request calls, backed by a bare
 * repository on disk: what a branch holds that another lacks is computed by
 * git itself, and the pull requests are kept in memory.
 */
import { execFileSync } from "node:child_process";
import type { GitHubPromotionClient, PullRequestFacts } from "@nightshift/core";

export interface FakePullRequest {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  state: PullRequestFacts["state"];
  title: string;
  body: string;
}

export interface PromotionFake {
  readonly client: GitHubPromotionClient;
  readonly pulls: FakePullRequest[];
  /** The calls made, by name. */
  readonly calls: string[];
}

const gitIn = (bare: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd: bare,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const resolve = (bare: string, name: string): string => {
  for (const candidate of [`refs/heads/${name}`, name]) {
    try {
      return gitIn(bare, "rev-parse", "--verify", "-q", `${candidate}^{commit}`);
    } catch {
      // try the next form
    }
  }
  throw new Error(`no such ref ${name}`);
};

export const promotionFake = (bare: string, repository: string): PromotionFake => {
  const pulls: FakePullRequest[] = [];
  const calls: string[] = [];
  const facts = (pull: FakePullRequest): PullRequestFacts => ({
    number: pull.number,
    url: pull.url,
    state: pull.state,
    head: resolve(bare, pull.head),
    base: pull.base,
  });
  const client: GitHubPromotionClient = {
    compare: async (_installation, _repository, base, head) => {
      calls.push("compare");
      const from = resolve(bare, base);
      const to = resolve(bare, head);
      const count = (range: string): number => Number(gitIn(bare, "rev-list", "--count", range));
      const log = gitIn(bare, "log", "--reverse", "--format=%H%x1f%s%x1f%P", `${from}..${to}`);
      const commits =
        log === ""
          ? []
          : log.split("\n").map((line) => {
              const [sha = "", subject = "", parents = ""] = line.split("\x1f");
              return { sha, subject, parents: parents === "" ? [] : parents.split(" ") };
            });
      return {
        aheadBy: count(`${from}..${to}`),
        behindBy: count(`${to}..${from}`),
        commits,
        complete: true,
      };
    },
    findOpenPullRequest: async (_installation, _repository, branches) => {
      calls.push("find");
      const found = pulls.find(
        (pull) =>
          pull.state === "open" && pull.head === branches.head && pull.base === branches.base,
      );
      return found === undefined ? undefined : facts(found);
    },
    pullRequest: async (_installation, _repository, number) => {
      calls.push("read");
      const found = pulls.find((pull) => pull.number === number);
      return found === undefined ? undefined : facts(found);
    },
    openPullRequest: async (_installation, _repository, pull) => {
      calls.push("open");
      const number = pulls.length + 1;
      const made: FakePullRequest = {
        number,
        url: `https://github.com/${repository}/pull/${number}`,
        head: pull.head,
        base: pull.base,
        state: "open",
        title: pull.title,
        body: pull.body,
      };
      pulls.push(made);
      return facts(made);
    },
    updatePullRequest: async (_installation, _repository, number, pull) => {
      calls.push("update");
      const found = pulls.find((candidate) => candidate.number === number);
      if (found === undefined) throw new Error("no such pull request");
      found.title = pull.title;
      found.body = pull.body;
      return facts(found);
    },
  };
  return { client, pulls, calls };
};
