import { generateKeyPairSync } from "node:crypto";
import { GitHubAccessMissing } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { createGitHubAppClient, GitHubError } from "./app.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** GitHub's token endpoint, answering 422 for a permission the installation has not granted. */
const tokenEndpoint = (granted: readonly string[]) => {
  const asked: Record<string, string>[] = [];
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      permissions: Record<string, string>;
    };
    asked.push(body.permissions);
    const missing = Object.keys(body.permissions).filter((name) => !granted.includes(name));
    return missing.length > 0
      ? new Response(
          JSON.stringify({
            message: "The permissions requested are not granted to this installation.",
          }),
          { status: 422 },
        )
      : new Response(
          JSON.stringify({
            token: "ghs_x",
            expires_at: "2026-10-14T06:00:00Z",
          }),
          {
            status: 201,
          },
        );
  }) as typeof fetch;
  const client = createGitHubAppClient({
    secret: async () => ({ appId: "1", privateKey }),
    fetch: fetchStub,
  });
  return { client, asked };
};

describe("the publisher's write token (2026-10-14)", () => {
  it("asks for workflows with contents, so a push that changes a workflow file is allowed", async () => {
    const { client, asked } = tokenEndpoint(["contents", "workflows", "metadata"]);
    await expect(client.writeToken(7, "wildorder/foodfly")).resolves.toMatchObject({
      token: "ghs_x",
    });
    expect(asked).toEqual([{ contents: "write", workflows: "write", metadata: "read" }]);
  });

  it("falls back to contents alone while the installation has not accepted workflows", async () => {
    const { client, asked } = tokenEndpoint(["contents", "metadata"]);
    await expect(client.writeToken(7, "wildorder/foodfly")).resolves.toMatchObject({
      token: "ghs_x",
    });
    expect(asked).toEqual([
      { contents: "write", workflows: "write", metadata: "read" },
      { contents: "write", metadata: "read" },
    ]);
  });

  it("never asks a reading token for workflows", async () => {
    const { client, asked } = tokenEndpoint(["contents", "metadata"]);
    await client.readToken(7, ["wildorder/foodfly"]);
    expect(asked).toEqual([{ contents: "read", metadata: "read" }]);
  });
});

describe("the promotion pull request client (P26)", () => {
  interface Seen {
    readonly method: string;
    readonly url: string;
    readonly body: unknown;
  }
  const rig = (
    route: (seen: Seen) => Response | undefined,
    mint: () => Response = () =>
      new Response(JSON.stringify({ token: "ghs_p", expires_at: "2026-11-13T00:00:00Z" }), {
        status: 201,
      }),
  ) => {
    const seen: Seen[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      const entry = {
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      seen.push(entry);
      if (entry.url.endsWith("/access_tokens")) return mint();
      return route(entry) ?? new Response("{}", { status: 500 });
    }) as typeof fetch;
    const client = createGitHubAppClient({
      secret: async () => ({ appId: "1", privateKey }),
      fetch: fetchStub,
    });
    return { client, seen };
  };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const commitList = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      sha: `sha${from + index}`,
      commit: { message: `subject ${from + index}\n\nbody` },
      parents: [{ sha: `sha${from + index - 1}` }],
    }));
  const pull = (extra: Record<string, unknown> = {}) => ({
    number: 5,
    html_url: "https://github.com/o/r/pull/5",
    state: "open",
    merged_at: null,
    head: { sha: "h1" },
    base: { ref: "main" },
    ...extra,
  });

  it("mints one repository's token with pull_requests write", async () => {
    const { client, seen } = rig(() => json(pull()));
    await client.pullRequest(7, "o/r", 5);
    expect(seen[0]?.body).toEqual({
      permissions: {
        pull_requests: "write",
        contents: "read",
        metadata: "read",
      },
      repositories: ["r"],
    });
  });

  it("compares over several pages", async () => {
    const { client, seen } = rig(({ url }) => {
      const page = Number(/&page=(\d+)/.exec(url)?.[1]);
      return json({
        ahead_by: 250,
        behind_by: 3,
        commits: commitList((page - 1) * 100, page === 3 ? 50 : 100),
      });
    });
    const result = await client.compare(7, "o/r", "main", "line");
    expect(result.aheadBy).toBe(250);
    expect(result.behindBy).toBe(3);
    expect(result.commits).toHaveLength(250);
    expect(result.complete).toBe(true);
    expect(result.commits[0]).toEqual({
      sha: "sha0",
      subject: "subject 0",
      parents: ["sha-1"],
    });
    expect(seen.filter((s) => s.url.includes("/compare/"))).toHaveLength(3);
    expect(seen[1]?.url).toContain("/repos/o/r/compare/main...line?per_page=100&page=1");
  });

  it("stops at the cap and says the list is not complete", async () => {
    const { client } = rig(({ url }) => {
      const page = Number(/&page=(\d+)/.exec(url)?.[1]);
      return json({
        ahead_by: 3000,
        behind_by: 0,
        commits: commitList((page - 1) * 100, 100),
      });
    });
    const result = await client.compare(7, "o/r", "main", "line");
    expect(result.commits).toHaveLength(2500);
    expect(result.complete).toBe(false);
  });

  it("finds the open pull request for a head and base", async () => {
    const { client, seen } = rig(() => json([pull()]));
    await expect(
      client.findOpenPullRequest(7, "o/r", { head: "line", base: "main" }),
    ).resolves.toEqual({
      number: 5,
      url: "https://github.com/o/r/pull/5",
      state: "open",
      head: "h1",
      base: "main",
    });
    expect(seen[1]?.url).toContain("/repos/o/r/pulls?state=open&head=o%3Aline&base=main");
  });

  it("finds none", async () => {
    const { client } = rig(() => json([]));
    await expect(
      client.findOpenPullRequest(7, "o/r", { head: "line", base: "main" }),
    ).resolves.toBeUndefined();
  });

  it("reads a pull request, 404 as undefined, merged when merged_at is set", async () => {
    const merged = rig(() => json(pull({ state: "closed", merged_at: "2026-11-12T00:00:00Z" })));
    await expect(merged.client.pullRequest(7, "o/r", 5)).resolves.toMatchObject({
      state: "merged",
    });
    const closed = rig(() => json(pull({ state: "closed" })));
    await expect(closed.client.pullRequest(7, "o/r", 5)).resolves.toMatchObject({
      state: "closed",
    });
    const none = rig(() => json({ message: "Not Found" }, 404));
    await expect(none.client.pullRequest(7, "o/r", 5)).resolves.toBeUndefined();
  });

  it("opens a pull request", async () => {
    const { client, seen } = rig(() => json(pull(), 201));
    await client.openPullRequest(7, "o/r", {
      head: "line",
      base: "main",
      title: "T",
      body: "B",
    });
    expect(seen[1]).toMatchObject({
      method: "POST",
      body: { head: "line", base: "main", title: "T", body: "B" },
    });
    expect(seen[1]?.url).toMatch(/\/repos\/o\/r\/pulls$/);
  });

  it("updates a pull request", async () => {
    const { client, seen } = rig(() => json(pull()));
    await client.updatePullRequest(7, "o/r", 5, { title: "T2", body: "B2" });
    expect(seen[1]).toMatchObject({
      method: "PATCH",
      body: { title: "T2", body: "B2" },
    });
    expect(seen[1]?.url).toMatch(/\/repos\/o\/r\/pulls\/5$/);
  });

  it("throws GitHubError for another failure", async () => {
    const { client } = rig(() => json({ message: "boom" }, 500));
    await expect(
      client.openPullRequest(7, "o/r", {
        head: "a",
        base: "b",
        title: "",
        body: "",
      }),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("reports the missing permission at the mint, without retrying", async () => {
    const { client, seen } = rig(
      () => undefined,
      () => json({ message: "not granted" }, 422),
    );
    await expect(client.pullRequest(7, "o/r", 5)).rejects.toBeInstanceOf(GitHubAccessMissing);
    expect(seen).toHaveLength(1);
  });

  it("reports the missing permission at the route", async () => {
    const { client, seen } = rig(() =>
      json({ message: "Resource not accessible by integration" }, 403),
    );
    await expect(
      client.openPullRequest(7, "o/r", {
        head: "a",
        base: "b",
        title: "",
        body: "",
      }),
    ).rejects.toMatchObject({
      name: "GitHubAccessMissing",
      permission: "pull_requests",
    });
    expect(seen).toHaveLength(2);
  });
});
