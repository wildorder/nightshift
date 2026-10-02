/**
 * The receive-pack client against the real protocol: a local bare repository
 * served by `git http-backend` stands in for GitHub (P10, T4, D-P10-22).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpServer, startGitHttpServer } from "./git-http-server.js";
import {
  advertiseReceivePack,
  installationAuthorization,
  pktLine,
  pushReceivePack,
  readPktLines,
  ZERO_OID,
} from "./smart-http.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commit = (work: string, file: string, text: string, message: string): string => {
  execFileSync(
    "node",
    ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", file, text],
    {
      cwd: work,
    },
  );
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
};

/** A pack of everything reachable from `head` and not from `exclude`: what the engine ships. */
const packOf = async (
  work: string,
  head: string,
  exclude: string | undefined,
): Promise<Uint8Array> => {
  const prefix = join(work, ".git", `pack-${head.slice(0, 8)}`);
  const revs = exclude === undefined ? `${head}\n` : `${head}\n^${exclude}\n`;
  const hash = execFileSync("git", ["pack-objects", "--revs", prefix], {
    cwd: work,
    input: revs,
    encoding: "utf8",
  }).trim();
  return new Uint8Array(await readFile(`${prefix}-${hash}.pack`));
};

let root: string;
let server: GitHttpServer;
let work: string;
let first: string;
const authorization = installationAuthorization("ghs_test");
const remote = () => `${server.url}/fixture.git`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ns-githttp-"));
  git(root, "init", "-q", "--bare", "fixture.git");
  git(join(root, "fixture.git"), "config", "http.receivepack", "true");
  work = await mkdtemp(join(tmpdir(), "ns-gitwork-"));
  git(work, "init", "-q", "-b", "main");
  first = commit(work, "a.txt", "one\n", "first");
  git(work, "push", "-q", join(root, "fixture.git"), "main:refs/heads/program/fixture");
  server = await startGitHttpServer(root);
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("pkt-line", () => {
  it("frames and reads back, flush included", () => {
    const lines = readPktLines(
      new Uint8Array([
        ...pktLine("hello\n"),
        ...pktLine(new Uint8Array([1, 2, 3])),
        0x30,
        0x30,
        0x30,
        0x30,
      ]),
    );
    expect(new TextDecoder().decode(lines[0])).toBe("hello\n");
    expect([...(lines[1] ?? [])]).toEqual([1, 2, 3]);
    expect(lines[2]?.length).toBe(0);
  });
});

describe("the receive-pack client against git http-backend", () => {
  it("reads the advertised refs and capabilities", async () => {
    const advertised = await advertiseReceivePack({ repositoryUrl: remote(), authorization });
    expect(advertised.refs.get("refs/heads/program/fixture")).toBe(first);
    expect(advertised.capabilities.has("report-status")).toBe(true);
  });

  it("pushes a non-thin pack with the lease held, and the branch moves", async () => {
    const second = commit(work, "b.txt", "two\n", "second");
    const outcome = await pushReceivePack({
      repositoryUrl: remote(),
      authorization,
      ref: "refs/heads/program/fixture",
      expectedOld: first,
      newOid: second,
      pack: await packOf(work, second, first),
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(git(join(root, "fixture.git"), "rev-parse", "refs/heads/program/fixture")).toBe(second);
  });

  it("is refused, not forced, when the lease is stale: the branch moved underneath", async () => {
    const head = git(join(root, "fixture.git"), "rev-parse", "refs/heads/program/fixture");
    const third = commit(work, "c.txt", "three\n", "third");
    // The lease names the first commit, but the branch is at the second.
    const outcome = await pushReceivePack({
      repositoryUrl: remote(),
      authorization,
      ref: "refs/heads/program/fixture",
      expectedOld: first,
      newOid: third,
      pack: await packOf(work, third, head),
    });
    expect(outcome.kind).toBe("rejected");
    expect(git(join(root, "fixture.git"), "rev-parse", "refs/heads/program/fixture")).toBe(head);
  });

  it("creates a branch from nothing with the zero id as the lease", async () => {
    const head = git(work, "rev-parse", "HEAD");
    const outcome = await pushReceivePack({
      repositoryUrl: remote(),
      authorization,
      ref: "refs/heads/another",
      expectedOld: ZERO_OID,
      newOid: head,
      pack: await packOf(work, head, undefined),
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(git(join(root, "fixture.git"), "rev-parse", "refs/heads/another")).toBe(head);
  });
});
