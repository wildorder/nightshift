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
 */
import { createSign } from "node:crypto";
import type { GitHubAppClient, GitHubPullRequests } from "@nightshift/core";

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

export const createGitHubAppClient = (options: GitHubAppOptions): GitHubAppClient => {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.apiBase ?? "https://api.github.com";

  const call = async <T>(
    authorization: string,
    method: "GET" | "POST" | "PATCH" | "PUT",
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
  /**
   * The GitHub writer's pull-request token (P25): pull requests and contents
   * write on one repository. A refusal names the missing permission.
   */
  const pullRequestToken = async (installationId: number, repository: string): Promise<string> => {
    const name = repository.split("/")[1];
    const { status, body } = await call<{ token?: string; message?: string }>(
      await asApp(),
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      {
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        ...(name === undefined ? {} : { repositories: [name] }),
      },
    );
    if (status !== 201 || body.token === undefined) {
      throw new GitHubError(
        status,
        "access_tokens",
        status === 422
          ? "the Nightshift App has not been granted Pull requests (read and write) on this installation"
          : (body.message ?? "no token"),
      );
    }
    return `token ${body.token}`;
  };

  type RawPull = {
    number?: number;
    html_url?: string;
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    head?: { sha?: string };
    message?: string;
  };
  const pullOf = (raw: RawPull) => {
    if (raw.number === undefined || raw.html_url === undefined || raw.head?.sha === undefined) {
      throw new GitHubError(500, "pulls", raw.message ?? "no pull request in the answer");
    }
    return {
      number: raw.number,
      url: raw.html_url,
      state: raw.state === "open" ? ("open" as const) : ("closed" as const),
      merged: raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null),
      headSha: raw.head.sha,
    };
  };

  const pullRequests: GitHubPullRequests = {
    createBranch: async (installationId, repository, branch, sha) => {
      const auth = await pullRequestToken(installationId, repository);
      const made = await call<{ message?: string }>(auth, "POST", `/repos/${repository}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
      if (made.status === 201) return;
      if (made.status === 422) {
        const found = await call<{ object?: { sha?: string } }>(
          auth,
          "GET",
          `/repos/${repository}/git/ref/heads/${branch}`,
        );
        if (found.status === 200 && found.body.object?.sha === sha) return;
      }
      throw new GitHubError(made.status, "git/refs", made.body.message ?? "no branch");
    },
    open: async (installationId, repository, request) => {
      const auth = await pullRequestToken(installationId, repository);
      const opened = await call<RawPull>(auth, "POST", `/repos/${repository}/pulls`, request);
      if (opened.status === 201) return pullOf(opened.body);
      if (opened.status === 422) {
        const owner = repository.split("/")[0] ?? "";
        const listed = await call<RawPull[]>(
          auth,
          "GET",
          `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${request.head}`)}`,
        );
        const first = Array.isArray(listed.body) ? listed.body[0] : undefined;
        if (listed.status === 200 && first !== undefined) return pullOf(first);
      }
      throw new GitHubError(opened.status, "pulls", opened.body.message ?? "no pull request");
    },
    get: async (installationId, repository, number) => {
      const auth = await pullRequestToken(installationId, repository);
      const found = await call<RawPull>(auth, "GET", `/repos/${repository}/pulls/${number}`);
      if (found.status === 404) return undefined;
      if (found.status !== 200) {
        throw new GitHubError(found.status, "pulls", found.body.message ?? "no pull request");
      }
      return pullOf(found.body);
    },
    close: async (installationId, repository, number, comment) => {
      const auth = await pullRequestToken(installationId, repository);
      await call(auth, "POST", `/repos/${repository}/issues/${number}/comments`, { body: comment });
      const closed = await call<{ message?: string }>(
        auth,
        "PATCH",
        `/repos/${repository}/pulls/${number}`,
        { state: "closed" },
      );
      if (closed.status !== 200) {
        throw new GitHubError(closed.status, "pulls", closed.body.message ?? "not closed");
      }
    },
    merge: async (installationId, repository, number, sha) => {
      const auth = await pullRequestToken(installationId, repository);
      const merged = await call<{ merged?: boolean; message?: string }>(
        auth,
        "PUT",
        `/repos/${repository}/pulls/${number}/merge`,
        { sha, merge_method: "merge" },
      );
      if (merged.status === 200 && merged.body.merged === true) return { merged: true };
      return {
        merged: false,
        detail: merged.body.message ?? `GitHub answered ${merged.status}`,
      };
    },
  };

  const readToken = (installationId: number, repositories: readonly string[]) =>
    installationToken(installationId, repositories, "read");
  const writeToken = (installationId: number, repository: string) =>
    installationToken(installationId, [repository], "write");

  return {
    app: async () => {
      const { status, body } = await call<{ slug?: string; html_url?: string; message?: string }>(
        await asApp(),
        "GET",
        "/app",
      );
      if (status !== 200 || body.slug === undefined) {
        throw new GitHubError(status, "/app", body.message ?? "no slug");
      }
      return {
        slug: body.slug,
        installUrl: `https://github.com/apps/${body.slug}/installations/new`,
      };
    },
    installation: async (installationId) => {
      const found = await call<{ account?: { login?: string }; message?: string }>(
        await asApp(),
        "GET",
        `/app/installations/${installationId}`,
      );
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
        const listed = await call<{ repositories?: { full_name: string }[]; message?: string }>(
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
    contains: async (installationId, repository, ancestor, descendant) => {
      const { token } = await readToken(installationId, [repository]);
      const { status, body } = await call<{ status?: string; message?: string }>(
        `token ${token}`,
        "GET",
        `/repos/${repository}/compare/${ancestor}...${descendant}`,
      );
      if (status === 404) return undefined;
      if (status !== 200 || body.status === undefined) {
        throw new GitHubError(status, "compare", body.message ?? "no status");
      }
      return body.status === "identical" || body.status === "ahead";
    },
    readToken,
    writeToken,
    pullRequests,
  };
};
