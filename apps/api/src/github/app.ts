/**
 * The Nightshift GitHub App, as the control plane speaks to it (P10, D-P10-02,
 * D-P10-22).
 *
 * The App's id and private key come from one secret (H-P10-04). A JWT signed
 * with the key is the App; an installation token minted from it is the App
 * acting in one customer's installation, scoped to named repositories and to
 * the permissions asked for. Here only `contents: read` is ever asked: the
 * machines clone with it. The publisher asks for `write` in T4, in its own
 * function, which is the only one that holds that, and with it `workflows:
 * write`: GitHub refuses an App's push that touches `.github/workflows/`
 * without it (2026-10-14, a run's deploy-workflow change blocked everything
 * landed after it). An installation that has not yet accepted that permission
 * gets a token without it, and such a push is then refused as `forbidden`.
 *
 * The promotion pull request (P26) is kept through the same App: every compare
 * and pull-request call uses a token minted for the one repository with
 * `pull_requests: write`, `contents: read`, `metadata: read`. An installation
 * that has not granted `pull_requests` answers 422 at minting, or 403 "Resource
 * not accessible by integration" at the route; both are `GitHubAccessMissing`,
 * not retried.
 */
import { createSign } from "node:crypto";
import {
  GitHubAccessMissing,
  type GitHubAppClient,
  type GitHubPromotionClient,
  type PullRequestFacts,
} from "@nightshift/core";

export interface GitHubAppSecret {
  readonly appId: string;
  readonly privateKey: string;
}

export interface GitHubAppOptions {
  readonly secret: () => Promise<GitHubAppSecret>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly apiBase?: string;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** A ten-minute App JWT, the most GitHub allows. */
export const appJwt = (secret: GitHubAppSecret, nowMs: number): string => {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: secret.appId }));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(secret.privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
};

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`GitHub answered ${status} for ${path}: ${detail}`);
  }
}

/** Most commits a compare lists; beyond it the answer is `complete: false`. */
const COMPARE_CAP = 2500;

interface RawPull {
  readonly number?: number;
  readonly html_url?: string;
  readonly state?: string;
  readonly merged_at?: string | null;
  readonly head?: { readonly sha?: string };
  readonly base?: { readonly ref?: string };
  readonly message?: string;
}

export const createGitHubAppClient = (
  options: GitHubAppOptions,
): GitHubAppClient & GitHubPromotionClient => {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.apiBase ?? "https://api.github.com";

  const call = async <T>(
    authorization: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: T }> => {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "nightshift-control-plane",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T };
  };

  const asApp = async (): Promise<string> => `Bearer ${appJwt(await options.secret(), now())}`;

  const installationToken = async (
    installationId: number,
    repositories: readonly string[],
    contents: "read" | "write",
  ) => {
    const names = repositories.map((repository) => repository.split("/")[1]).filter(Boolean);
    const mint = async (permissions: Record<string, string>) =>
      call<{ token?: string; expires_at?: string; message?: string }>(
        await asApp(),
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        { permissions, repositories: names },
      );
    let { status, body } = await mint(
      contents === "write"
        ? { contents, workflows: "write", metadata: "read" }
        : { contents, metadata: "read" },
    );
    // 422: the installation has not granted `workflows` (yet). Publish what can
    // be published; a workflow change is then refused, and says how to fix it.
    if (contents === "write" && status === 422) {
      ({ status, body } = await mint({ contents, metadata: "read" }));
    }
    if (status !== 201 || body.token === undefined || body.expires_at === undefined) {
      throw new GitHubError(status, "access_tokens", body.message ?? "no token");
    }
    return { token: body.token, expiresAt: body.expires_at };
  };
  const pullsToken = async (installationId: number, repository: string): Promise<string> => {
    const name = repository.split("/")[1];
    const { status, body } = await call<{
      token?: string;
      expires_at?: string;
      message?: string;
    }>(await asApp(), "POST", `/app/installations/${installationId}/access_tokens`, {
      permissions: {
        pull_requests: "write",
        contents: "read",
        metadata: "read",
      },
      repositories: name === undefined ? [] : [name],
    });
    if (status === 422) {
      throw new GitHubAccessMissing(
        "pull_requests",
        body.message ?? "installation has not granted it",
      );
    }
    if (status !== 201 || body.token === undefined) {
      throw new GitHubError(status, "access_tokens", body.message ?? "no token");
    }
    return `token ${body.token}`;
  };
  /** A call on the repository's pull-request or compare routes, with its own token. */
  const pulls = async <T>(
    installationId: number,
    repository: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) => {
    const result = await call<T & { message?: string }>(
      await pullsToken(installationId, repository),
      method,
      path,
      body,
    );
    if (
      result.status === 403 &&
      /not accessible by integration/i.test(result.body?.message ?? "")
    ) {
      throw new GitHubAccessMissing("pull_requests", result.body.message ?? "");
    }
    return result;
  };
  const factsOf = (raw: RawPull, path: string): PullRequestFacts => {
    if (
      raw.number === undefined ||
      raw.html_url === undefined ||
      raw.head?.sha === undefined ||
      raw.base?.ref === undefined
    ) {
      throw new GitHubError(200, path, raw.message ?? "not a pull request");
    }
    return {
      number: raw.number,
      url: raw.html_url,
      state: raw.merged_at ? "merged" : raw.state === "closed" ? "closed" : "open",
      head: raw.head.sha,
      base: raw.base.ref,
    };
  };
  const readToken = (installationId: number, repositories: readonly string[]) =>
    installationToken(installationId, repositories, "read");
  const writeToken = (installationId: number, repository: string) =>
    installationToken(installationId, [repository], "write");

  return {
    app: async () => {
      const { status, body } = await call<{
        slug?: string;
        html_url?: string;
        message?: string;
      }>(await asApp(), "GET", "/app");
      if (status !== 200 || body.slug === undefined) {
        throw new GitHubError(status, "/app", body.message ?? "no slug");
      }
      return {
        slug: body.slug,
        installUrl: `https://github.com/apps/${body.slug}/installations/new`,
      };
    },
    installation: async (installationId) => {
      const found = await call<{
        account?: { login?: string };
        message?: string;
      }>(await asApp(), "GET", `/app/installations/${installationId}`);
      if (found.status === 404) return undefined;
      if (found.status !== 200 || found.body.account?.login === undefined) {
        throw new GitHubError(found.status, "installation", found.body.message ?? "no account");
      }
      const minted = await call<{ token?: string; message?: string }>(
        await asApp(),
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        { permissions: { metadata: "read" } },
      );
      if (minted.status !== 201 || minted.body.token === undefined) {
        throw new GitHubError(minted.status, "access_tokens", minted.body.message ?? "no token");
      }
      const repositories: string[] = [];
      for (let page = 1; page < 20; page += 1) {
        const listed = await call<{
          repositories?: { full_name: string }[];
          message?: string;
        }>(
          `token ${minted.body.token}`,
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
        );
        if (listed.status !== 200) {
          throw new GitHubError(listed.status, "repositories", listed.body.message ?? "");
        }
        const names = (listed.body.repositories ?? []).map((repository) => repository.full_name);
        repositories.push(...names);
        if (names.length < 100) break;
      }
      return { account: found.body.account.login, repositories };
    },
    branchHead: async (installationId, repository, branch) => {
      const { token } = await readToken(installationId, [repository]);
      const { status, body } = await call<{ commit?: { sha?: string } }>(
        `token ${token}`,
        "GET",
        `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
      );
      if (status === 404) return undefined;
      if (status !== 200 || body.commit?.sha === undefined) {
        throw new GitHubError(status, "branch", "no commit");
      }
      return body.commit.sha;
    },
    defaultBranch: async (installationId, repository) => {
      const { token } = await readToken(installationId, [repository]);
      const { status, body } = await call<{ default_branch?: string }>(
        `token ${token}`,
        "GET",
        `/repos/${repository}`,
      );
      if (status === 404) return undefined;
      if (status !== 200 || body.default_branch === undefined) {
        throw new GitHubError(status, "repository", "no default branch");
      }
      return body.default_branch;
    },
    readToken,
    writeToken,
    compare: async (installationId, repository, baseBranch, head) => {
      const path = `/repos/${repository}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(head)}`;
      interface Page {
        ahead_by?: number;
        behind_by?: number;
        commits?: {
          sha: string;
          commit: { message: string };
          parents?: { sha: string }[];
        }[];
        message?: string;
      }
      const commits: { sha: string; subject: string; parents: string[] }[] = [];
      let aheadBy = 0;
      let behindBy = 0;
      for (let page = 1; ; page += 1) {
        const { status, body } = await pulls<Page>(
          installationId,
          repository,
          "GET",
          `${path}?per_page=100&page=${page}`,
        );
        if (status !== 200 || body.ahead_by === undefined) {
          throw new GitHubError(status, "compare", body?.message ?? "no comparison");
        }
        aheadBy = body.ahead_by;
        behindBy = body.behind_by ?? 0;
        const listed = body.commits ?? [];
        for (const commit of listed) {
          commits.push({
            sha: commit.sha,
            subject: commit.commit.message.split("\n")[0] ?? "",
            parents: (commit.parents ?? []).map((parent) => parent.sha),
          });
        }
        if (listed.length === 0 || commits.length >= Math.min(aheadBy, COMPARE_CAP)) break;
      }
      const kept = commits.slice(0, COMPARE_CAP);
      return {
        aheadBy,
        behindBy,
        commits: kept,
        complete: kept.length >= aheadBy,
      };
    },
    findOpenPullRequest: async (installationId, repository, branches) => {
      const owner = repository.split("/")[0] ?? "";
      const path = `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branches.head}`)}&base=${encodeURIComponent(branches.base)}`;
      const { status, body } = await pulls<RawPull[]>(installationId, repository, "GET", path);
      if (status !== 200 || !Array.isArray(body)) {
        throw new GitHubError(status, "pulls", "no list");
      }
      const first = body[0];
      return first === undefined ? undefined : factsOf(first, "pulls");
    },
    pullRequest: async (installationId, repository, number) => {
      const path = `/repos/${repository}/pulls/${number}`;
      const { status, body } = await pulls<RawPull>(installationId, repository, "GET", path);
      if (status === 404) return undefined;
      if (status !== 200) throw new GitHubError(status, "pull", body?.message ?? "");
      return factsOf(body, "pull");
    },
    openPullRequest: async (installationId, repository, pull) => {
      const { status, body } = await pulls<RawPull>(
        installationId,
        repository,
        "POST",
        `/repos/${repository}/pulls`,
        {
          head: pull.head,
          base: pull.base,
          title: pull.title,
          body: pull.body,
        },
      );
      if (status !== 201) throw new GitHubError(status, "pulls", body?.message ?? "");
      return factsOf(body, "pulls");
    },
    updatePullRequest: async (installationId, repository, number, pull) => {
      const { status, body } = await pulls<RawPull>(
        installationId,
        repository,
        "PATCH",
        `/repos/${repository}/pulls/${number}`,
        { title: pull.title, body: pull.body },
      );
      if (status !== 200) throw new GitHubError(status, "pull", body?.message ?? "");
      return factsOf(body, "pull");
    },
  };
};
