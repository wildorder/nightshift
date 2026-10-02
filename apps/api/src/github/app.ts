/**
 * The Nightshift GitHub App, as the control plane speaks to it (P10, D-P10-02,
 * D-P10-22).
 *
 * The App's id and private key come from one secret (H-P10-04). A JWT signed
 * with the key is the App; an installation token minted from it is the App
 * acting in one customer's installation, scoped to named repositories and to
 * the permissions asked for. Here only `contents: read` is ever asked: the
 * machines clone with it. The publisher asks for `write` in T4, in its own
 * function, which is the only one that holds that.
 */
import { createSign } from "node:crypto";
import type { GitHubAppClient } from "@nightshift/core";

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
    method: "GET" | "POST",
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
    const { status, body } = await call<{ token?: string; expires_at?: string; message?: string }>(
      await asApp(),
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      { permissions: { contents, metadata: "read" }, repositories: names },
    );
    if (status !== 201 || body.token === undefined || body.expires_at === undefined) {
      throw new GitHubError(status, "access_tokens", body.message ?? "no token");
    }
    return { token: body.token, expiresAt: body.expires_at };
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
    readToken,
    writeToken,
  };
};
