/**
 * The runner's bootstrap, sampler, heartbeat and volume, over a fake machine
 * and a fake plane (P10, T2).
 */
import { createHash } from "node:crypto";
import { type HeartbeatResponse, HeartbeatResponseSchema } from "@nightshift/contracts";
import { createFixtures, makeDispatch, makeProgramContract, planHash } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  BootstrapError,
  firstTokenParameter,
  IMDS,
  RUNNER_TAGS,
  readIdentity,
  takeFirstToken,
} from "./bootstrap.js";
import { createHeartbeat } from "./heartbeat.js";
import type { CommandResult, Machine } from "./machine.js";
import { runRunner } from "./main.js";
import type { PlaneFactory } from "./plane.js";
import { rootEnvironment, tokenFile } from "./root.js";
import { countOomKills, cpuBusyPct, parseCpuTimes, parseDiskPct, parseMeminfo } from "./sampler.js";
import {
  restoreFromSidecar,
  SIDECAR_MARKER,
  sidecarHoldsCopy,
  startSidecarSync,
  syncToSidecar,
} from "./sidecar.js";
import { findLocalDisk, mountWorkspace, resolveDevice, resolveLocalDisk } from "./volume.js";
import { layoutOf, prepareWorkspace } from "./workspace.js";

const f = createFixtures();
const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr = "no"): CommandResult => ({ exitCode: 1, stdout: "", stderr });

interface FakeMachine extends Machine {
  readonly commands: string[];
  readonly files: Map<string, string>;
}

/** A machine whose tags name `f`'s run, with a first token waiting in SSM. */
const fakeMachine = (
  overrides: {
    readonly exec?: (file: string, args: readonly string[]) => CommandResult | undefined;
    readonly tags?: Partial<Record<keyof typeof RUNNER_TAGS, string>>;
  } = {},
): FakeMachine => {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const tags: Record<string, string> = {
    [RUNNER_TAGS.project]: f.scope.projectId,
    [RUNNER_TAGS.program]: f.scope.programId,
    [RUNNER_TAGS.run]: f.scope.runId,
    [RUNNER_TAGS.generation]: "2",
    [RUNNER_TAGS.stage]: "dev",
    [RUNNER_TAGS.api]: "https://api.dev.nightshift.invalid",
  };
  for (const [key, value] of Object.entries(overrides.tags ?? {})) {
    tags[RUNNER_TAGS[key as keyof typeof RUNNER_TAGS]] = value as string;
  }
  let parameterPresent = true;
  let now = Date.parse("2026-10-01T12:00:00.000Z");
  return {
    commands,
    files,
    exec: async (file, args) => {
      commands.push([file, ...args].join(" "));
      const custom = overrides.exec?.(file, args);
      if (custom !== undefined) return custom;
      if (file === "aws" && args[1] === "get-parameter") {
        return parameterPresent ? ok("eyJ.first.token\n") : fail("ParameterNotFound");
      }
      if (file === "aws" && args[1] === "delete-parameter") {
        parameterPresent = false;
        return ok();
      }
      if (file === "findmnt") return fail();
      if (file === "test") return ok();
      if (file === "sudo" && args[0] === "blkid") return ok("");
      if (file === "df") return ok("Use%\n 12%\n");
      if (file === "dmesg") return ok("");
      return ok();
    },
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    http: async (method, url, headers) => {
      if (method === "PUT" && url === `${IMDS}/latest/api/token`) {
        return { status: 200, text: "imds-token" };
      }
      if (headers["X-aws-ec2-metadata-token"] !== "imds-token") return { status: 401, text: "" };
      const path = url.slice(`${IMDS}/latest/meta-data/`.length);
      if (path === "instance-id") return { status: 200, text: "i-0123456789abcdef0" };
      const tag = tags[path.replace("tags/instance/", "")];
      return tag === undefined ? { status: 404, text: "" } : { status: 200, text: tag };
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
};

describe("bootstrap (D-P10-18, D-P10-20)", () => {
  it("reads who it is from the instance's tags, over IMDSv2", async () => {
    const identity = await readIdentity(fakeMachine());
    expect(identity).toEqual({
      scope: f.scope,
      generation: 2,
      stage: "dev",
      apiEndpoint: "https://api.dev.nightshift.invalid",
      instanceId: "i-0123456789abcdef0",
    });
    expect(firstTokenParameter(identity)).toBe(`/nightshift/dev/dispatch/${f.scope.runId}/2`);
  });

  it("refuses a machine whose tags do not name a run", async () => {
    await expect(
      readIdentity(fakeMachine({ tags: { generation: "zero" } })),
    ).rejects.toBeInstanceOf(BootstrapError);
  });

  it("takes the first token once and deletes it, and does not start without one", async () => {
    const machine = fakeMachine();
    const identity = await readIdentity(machine);
    expect(await takeFirstToken(machine, identity)).toBe("eyJ.first.token");
    expect(machine.commands.some((command) => command.startsWith("aws ssm delete-parameter"))).toBe(
      true,
    );
    await expect(takeFirstToken(machine, identity)).rejects.toThrow(/does not start/);
  });

  it("stops if the token cannot be deleted: a readable token is one a second process could take", async () => {
    const machine = fakeMachine({
      exec: (file, args) =>
        file === "aws" && args[1] === "delete-parameter" ? fail("AccessDenied") : undefined,
    });
    await expect(takeFirstToken(machine, await readIdentity(machine))).rejects.toThrow(
      /could not delete/,
    );
  });
});

describe("the sampler's readers (D-P10-14b)", () => {
  it("reads CPU busy from two /proc/stat readings", () => {
    const before = parseCpuTimes("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4");
    const after = parseCpuTimes("cpu  300 0 200 900 0 0 0 0 0 0");
    expect(before).toEqual({ idle: 800, total: 1000 });
    expect(after).toEqual({ idle: 900, total: 1400 });
    expect(cpuBusyPct(before as never, after as never)).toBe(75);
    expect(parseCpuTimes("nothing")).toBeUndefined();
  });

  it("reads memory and swap from /proc/meminfo", () => {
    const reading = parseMeminfo(
      "MemTotal:       16000 kB\nMemFree:         2000 kB\nMemAvailable:   12000 kB\nSwapTotal:      1000 kB\nSwapFree:        900 kB\n",
    );
    expect(reading).toEqual({ memoryPct: 25, swapUsed: true });
    expect(parseMeminfo("MemTotal: 0 kB")).toBeUndefined();
  });

  it("reads disk use from df and OOM kills from the kernel log", () => {
    expect(parseDiskPct("Use%\n 42%\n")).toBe(42);
    expect(
      countOomKills("x\nOut of memory: Killed process 12 (node)\noom-kill:constraint=\n"),
    ).toBe(2);
  });
});

describe("the heartbeat (D-P10-18)", () => {
  const response = (overrides: Partial<HeartbeatResponse> = {}): HeartbeatResponse => ({
    generation: 2,
    status: "ready",
    leaseExpiresAt: "2026-10-01T12:01:00.000Z",
    stop: false,
    ...overrides,
  });

  const plane = (answers: readonly (HeartbeatResponse | Error)[]) => {
    const bodies: unknown[] = [];
    let index = 0;
    const post = async (body: unknown) => {
      bodies.push(body);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { post, bodies };
  };

  it("sends the pending milestone once, installs each renewed token, and stops when told", async () => {
    const { post, bodies } = plane([
      response({ token: "eyJ.second" }),
      response({ status: "running", token: "eyJ.third" }),
      response({ status: "stopping", stop: true }),
    ]);
    const installed: string[] = [];
    let now = 0;
    const heartbeat = createHeartbeat({
      generation: 2,
      post,
      installToken: (token) => installed.push(token),
      sample: async () => ({ memoryPct: 10, cpuPct: 5, diskPct: 1, swapUsed: false, oomKills: 0 }),
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      log: () => undefined,
      intervalMs: 1000,
    });
    heartbeat.report("ready");
    expect(await heartbeat.run()).toBe("stop");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ generation: 2, report: "ready", meteredSeconds: 0 });
    expect((bodies[1] as { report?: string }).report).toBeUndefined();
    expect((bodies[2] as { meteredSeconds: number }).meteredSeconds).toBe(2);
    expect(installed).toEqual(["eyJ.second", "eyJ.third"]);
    expect(heartbeat.last?.status).toBe("stopping");
  });

  it("gives up after three failures in a row, so a lost plane means a lost lease here too", async () => {
    const { post } = plane([new Error("ECONNREFUSED")]);
    const heartbeat = createHeartbeat({
      generation: 2,
      post,
      installToken: () => undefined,
      sample: async () => undefined,
      sleep: async () => undefined,
      now: () => 0,
      log: () => undefined,
      intervalMs: 1,
    });
    expect(await heartbeat.run()).toBe("lost");
  });
});

describe("the workspace volume (D-P10-15)", () => {
  it("formats a fresh device, mounts it and hands it to engine; leaves a mounted one alone", async () => {
    const machine = fakeMachine();
    await mountWorkspace(machine, {
      device: "/dev/xvdf",
      mountPoint: "/workspace",
      owner: "engine",
    });
    expect(machine.commands).toEqual(
      expect.arrayContaining([
        "sudo mkfs.ext4 -q -L nightshift /dev/xvdf",
        "sudo mount -o noatime /dev/xvdf /workspace",
        "sudo chown engine:engine /workspace",
      ]),
    );
    const mounted = fakeMachine({
      exec: (file) => (file === "findmnt" ? ok("/dev/nvme1n1\n") : undefined),
    });
    await mountWorkspace(mounted, {
      device: "/dev/xvdf",
      mountPoint: "/workspace",
      owner: "engine",
    });
    expect(mounted.commands.some((command) => command.startsWith("sudo mkfs"))).toBe(false);
  });

  it("does not format a device that already carries a filesystem", async () => {
    const machine = fakeMachine({
      exec: (file, args) => (file === "sudo" && args[0] === "blkid" ? ok("ext4\n") : undefined),
    });
    await mountWorkspace(machine, {
      device: "/dev/xvdf",
      mountPoint: "/workspace",
      owner: "engine",
    });
    expect(machine.commands.some((command) => command.startsWith("sudo mkfs"))).toBe(false);
  });

  it("finds the volume under its NVMe name when the attachment name is absent", async () => {
    const machine = fakeMachine({
      exec: (file) => {
        if (file === "test") return fail();
        if (file === "lsblk") return ok("/dev/nvme0n1 disk /\n/dev/nvme1n1 disk\n");
        return undefined;
      },
    });
    expect(await resolveDevice(machine, "/dev/xvdf")).toBe("/dev/nvme1n1");
  });

  it("puts the workspace on the instance's own NVMe when the record says local", async () => {
    const lsblk = [
      "/dev/nvme0n1 disk / Amazon Elastic Block Store",
      "/dev/nvme1n1 disk  Amazon Elastic Block Store",
      "/dev/nvme2n1 disk  Amazon EC2 NVMe Instance Storage",
    ].join("\n");
    const machine = fakeMachine({
      exec: (file) => (file === "lsblk" ? ok(`${lsblk}\n`) : undefined),
    });
    expect(await resolveLocalDisk(machine)).toBe("/dev/nvme2n1");
    await mountWorkspace(machine, {
      device: "/dev/xvdf",
      mountPoint: "/workspace",
      owner: "engine",
      disk: "local",
    });
    expect(machine.commands).toEqual(
      expect.arrayContaining([
        "sudo mkfs.ext4 -q -L nightshift /dev/nvme2n1",
        "sudo mount -o noatime /dev/nvme2n1 /workspace",
      ]),
    );
    const without = fakeMachine({
      exec: (file) =>
        file === "lsblk" ? ok("/dev/nvme0n1 disk / Amazon Elastic Block Store\n") : undefined,
    });
    await expect(resolveLocalDisk(without)).rejects.toThrow(/no local NVMe/);
    expect(await findLocalDisk(without)).toBeUndefined();
  });
});

describe("the durability sidecar (D-P10-27)", () => {
  it("copies the workspace to the sidecar with owners kept, and marks it", async () => {
    const machine = fakeMachine();
    await syncToSidecar(machine, "/workspace", "/workspace-sidecar");
    expect(machine.commands).toEqual([
      `sudo rsync -aHAX --delete --numeric-ids --exclude=/${SIDECAR_MARKER} /workspace/ /workspace-sidecar/`,
      `touch /workspace-sidecar/${SIDECAR_MARKER}`,
    ]);
  });

  it("restores only a sidecar that carries the marker", async () => {
    const empty = fakeMachine({ exec: (file) => (file === "test" ? fail() : undefined) });
    expect(await sidecarHoldsCopy(empty, "/workspace-sidecar")).toBe(false);
    const full = fakeMachine();
    expect(await sidecarHoldsCopy(full, "/workspace-sidecar")).toBe(true);
    await restoreFromSidecar(full, "/workspace-sidecar", "/workspace");
    expect(full.commands.at(-1)).toContain(
      "rsync -aHAX --delete --numeric-ids --exclude=/.nightshift-sidecar /workspace-sidecar/ /workspace/",
    );
  });

  it("tolerates files that vanish mid-copy, and refuses other failures", async () => {
    const vanished = fakeMachine({
      exec: (file, args) =>
        file === "sudo" && args[0] === "rsync"
          ? { exitCode: 24, stdout: "", stderr: "vanished" }
          : undefined,
    });
    await expect(
      syncToSidecar(vanished, "/workspace", "/workspace-sidecar"),
    ).resolves.toBeUndefined();
    const broken = fakeMachine({
      exec: (file, args) =>
        file === "sudo" && args[0] === "rsync" ? fail("disk full") : undefined,
    });
    await expect(syncToSidecar(broken, "/workspace", "/workspace-sidecar")).rejects.toThrow(
      /disk full/,
    );
  });

  it("copies on the interval and once more when stopped", async () => {
    const machine = fakeMachine();
    const lines: string[] = [];
    const sync = startSidecarSync(machine, {
      workspace: "/workspace",
      sidecar: "/workspace-sidecar",
      intervalMs: 1_000,
      log: (line) => lines.push(line),
    });
    // Three ticks of the fake clock, then the stop and its final copy.
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
    await sync.stop();
    const copies = machine.commands.filter((command) => command.startsWith("sudo rsync"));
    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(machine.commands.at(-2)).toContain("sudo rsync");
    expect(machine.commands.at(-1)).toBe(`touch /workspace-sidecar/${SIDECAR_MARKER}`);
    expect(lines).toEqual([]);
  });
});

describe("the workspace (T3, D-P10-15)", () => {
  const program = makeProgramContract(f, {
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: "program/fixture",
    },
    setup: [{ id: "install", command: "npm ci --prefer-offline" }],
  });
  const planText = "# Plan\n";
  const dispatch = makeDispatch(f, {
    input: {
      repositoryUrl: "https://github.com/wildorder/fixture",
      branch: "program/fixture",
      baseSha: "a".repeat(40),
      planHash: planHash(program, planText, (text) =>
        createHash("sha256").update(text).digest("hex"),
      ).hash,
    },
  });
  const layout = layoutOf("/workspace", f.scope.runId);

  /** A machine with git on it: `warm` says whether the mirror and checkout already exist. */
  const gitMachine = (warm: boolean) =>
    fakeMachine({
      exec: (file, args) => {
        const joined = [file, ...args].join(" ");
        if (joined.includes("rev-parse --is-bare-repository")) return warm ? ok("true\n") : fail();
        if (joined.includes("rev-parse --git-dir")) return warm ? ok(".git\n") : fail();
        if (joined.includes("status --porcelain")) return ok("");
        if (file === "env" && args.includes("bash")) return ok("installed\n");
        return undefined;
      },
    });

  it("clones the mirror and the checkout on a cold volume, runs setup against the stores, and hashes the lockfiles", async () => {
    const machine = gitMachine(false);
    machine.files.set(`${layout.checkout}/package-lock.json`, '{"lockfileVersion":3}');
    const prepared = await prepareWorkspace(machine, {
      layout,
      dispatch,
      program,
      planText,
      githubToken: "ghs_read",
      log: () => undefined,
    });
    expect(prepared.warm).toBe(false);
    expect(Object.keys(prepared.lockfileHashes)).toEqual(["package-lock.json"]);
    const commands = machine.commands.join("\n");
    expect(commands).toContain(
      "clone --mirror https://github.com/wildorder/fixture.git /workspace/mirror.git",
    );
    expect(commands).toContain(`checkout -q -B program/fixture ${"a".repeat(40)}`);
    expect(commands).toContain("npm_config_cache=/workspace/stores/npm");
    expect(commands).toContain("npm ci --prefer-offline");
    // Shared with the workers' group (D-P10-25).
    expect(commands).toContain("config core.sharedRepository group");
    expect(commands).toContain("chgrp -R nightshift /workspace");
    // The token travels in one command's environment, never in a URL or a file.
    expect(commands).toContain("NIGHTSHIFT_GIT_TOKEN=ghs_read");
    expect(commands).not.toContain("ghs_read@");
    expect([...machine.files.values()].join("\n")).not.toContain("ghs_read");
  });

  it("fetches a warm mirror instead of cloning, and refuses a changed plan before touching git", async () => {
    const machine = gitMachine(true);
    const prepared = await prepareWorkspace(machine, {
      layout,
      dispatch,
      program,
      planText,
      githubToken: "ghs_read",
      log: () => undefined,
    });
    expect(prepared.warm).toBe(true);
    expect(machine.commands.join("\n")).toContain("fetch --prune origin");
    expect(machine.commands.join("\n")).not.toContain("clone --mirror");

    const changed = gitMachine(true);
    await expect(
      prepareWorkspace(changed, {
        layout,
        dispatch,
        program,
        planText: "# Another plan\n",
        githubToken: "ghs_read",
        log: () => undefined,
      }),
    ).rejects.toThrow(/the plan changed/);
    expect(changed.commands.some((command) => command.includes("git"))).toBe(false);
  });

  it("fails setup loudly with the step's id", async () => {
    const machine = fakeMachine({
      exec: (file, args) => {
        const joined = [file, ...args].join(" ");
        if (joined.includes("rev-parse --is-bare-repository")) return ok("true\n");
        if (joined.includes("rev-parse --git-dir")) return ok(".git\n");
        if (joined.includes("status --porcelain")) return ok("");
        if (file === "env" && args.includes("bash")) return fail("npm ERR! missing lockfile");
        return undefined;
      },
    });
    await expect(
      prepareWorkspace(machine, {
        layout,
        dispatch,
        program,
        planText,
        githubToken: "ghs_read",
        log: () => undefined,
      }),
    ).rejects.toThrow(/setup install exited 1/);
  });
});

describe("the runner end to end over fakes (T2, T3)", () => {
  /** A plane that knows one run: its dispatch, program and plan, and heartbeats with the clone's token. */
  const fakePlane = (
    program: ReturnType<typeof makeProgramContract>,
    dispatch: ReturnType<typeof makeDispatch>,
    planText: string,
    status: (beat: number) => { status: string; stop: boolean },
  ) => {
    const heartbeats: unknown[] = [];
    const tokensSeen: string[] = [];
    let beats = 0;
    const planeFor: PlaneFactory = (endpoint, tokens) => {
      expect(endpoint).toBe("https://api.dev.nightshift.invalid");
      const seen = async () => void tokensSeen.push(await tokens.idToken());
      return {
        dispatch: async () => {
          await seen();
          return dispatch;
        },
        program: async () => {
          await seen();
          return program;
        },
        planDocument: async () => {
          await seen();
          return { text: planText };
        },
        heartbeat: async (_scope, body) => {
          await seen();
          heartbeats.push(body);
          beats += 1;
          return HeartbeatResponseSchema.parse({
            generation: 2,
            ...status(beats),
            leaseExpiresAt: "2026-10-01T12:01:00.000Z",
            token: `eyJ.renewed.${beats}`,
            credentials: { github: "ghs_read" },
          });
        },
      };
    };
    return { planeFor, heartbeats, tokensSeen, beats: () => beats };
  };

  const planText = "# Plan\n";
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const program = makeProgramContract(f, {
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: "program/fixture",
    },
    planDocument: { uri: "s3://plans/x", sha256: sha256(planText), sizeBytes: planText.length },
    setup: [{ id: "install", command: "npm ci" }],
  });
  const dispatch = makeDispatch(f, {
    status: "provisioning",
    generation: 2,
    input: {
      repositoryUrl: "https://github.com/wildorder/fixture",
      branch: "program/fixture",
      baseSha: "a".repeat(40),
      planHash: planHash(program, planText, sha256).hash,
    },
  });
  const gitMachine = () =>
    fakeMachine({
      exec: (file, args) => {
        const joined = [file, ...args].join(" ");
        if (joined.includes("rev-parse --is-bare-repository")) return fail();
        if (joined.includes("rev-parse --git-dir")) return fail();
        if (joined.includes("status --porcelain")) return ok("");
        if (file === "env" && args.includes("bash")) return ok("");
        return undefined;
      },
    });

  it("with no work yet, prepares the workspace, reports ready with setup's facts, and stays until told to stop", async () => {
    const machine = gitMachine();
    const plane = fakePlane(program, dispatch, planText, (beat) =>
      beat < 4 ? { status: "ready", stop: false } : { status: "stopping", stop: true },
    );
    const lines: string[] = [];
    const tokensInstalled: string[] = [];
    const code = await runRunner({
      machine,
      log: (line) => lines.push(line),
      workspace: "/workspace",
      device: "/dev/xvdf",
      engineUser: "engine",
      plane: plane.planeFor,
      onToken: async (token, scope) => {
        expect(scope).toEqual(f.scope);
        tokensInstalled.push(token);
      },
    });
    expect(code).toBe(0);
    // The first token and every renewal reach the composition (D-P10-20).
    expect(tokensInstalled[0]).toBe("eyJ.first.token");
    expect(tokensInstalled.at(-1)).toMatch(/^eyJ\.renewed\./);
    const ready = plane.heartbeats.find((body) => (body as { report?: string }).report === "ready");
    expect(ready).toMatchObject({ report: "ready", setupSeconds: expect.any(Number) });
    expect(plane.heartbeats.at(-1)).toMatchObject({ report: "stopped" });
    expect(plane.tokensSeen[0]).toBe("eyJ.first.token");
    expect(plane.tokensSeen.at(-1)).toMatch(/^eyJ\.renewed\./);
    expect(lines.join("\n")).toContain("workspace cold");
  });

  it("on a machine with a local disk, works there, restores the sidecar's copy first and copies back before stopping", async () => {
    const lsblk = [
      "/dev/nvme0n1 disk / Amazon Elastic Block Store",
      "/dev/nvme1n1 disk  Amazon Elastic Block Store",
      "/dev/nvme2n1 disk  Amazon EC2 NVMe Instance Storage",
    ].join("\n");
    const machine = fakeMachine({
      exec: (file, args) => {
        if (file === "lsblk")
          return ok(`${lsblk}
`);
        const joined = [file, ...args].join(" ");
        if (joined.includes("rev-parse --is-bare-repository")) return fail();
        if (joined.includes("rev-parse --git-dir")) return fail();
        if (joined.includes("status --porcelain")) return ok("");
        if (file === "env" && args.includes("bash")) return ok("");
        return undefined;
      },
    });
    const plane = fakePlane(program, dispatch, planText, () => ({
      status: "running",
      stop: false,
    }));
    const lines: string[] = [];
    const code = await runRunner({
      machine,
      log: (line) => lines.push(line),
      workspace: "/workspace",
      device: "/dev/xvdf",
      engineUser: "engine",
      plane: plane.planeFor,
      sidecarIntervalMs: 5_000,
      work: async () => {
        await machine.sleep(12_000);
      },
    });
    expect(code).toBe(0);
    const commands = machine.commands;
    // The volume at the sidecar, the local disk at the workspace, the copy restored, copies back.
    expect(commands).toContain("sudo mount -o noatime /dev/xvdf /workspace-sidecar");
    expect(commands).toContain("sudo mount -o noatime /dev/nvme2n1 /workspace");
    const restore = commands.findIndex((c) => c.includes("/workspace-sidecar/ /workspace/"));
    const firstClone = commands.findIndex((c) => c.includes("clone"));
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(firstClone);
    const copiesBack = commands.filter((c) => c.includes("/workspace/ /workspace-sidecar/"));
    expect(copiesBack.length).toBeGreaterThanOrEqual(1);
    const lastCopy = commands.lastIndexOf(copiesBack[copiesBack.length - 1] as string);
    expect(lastCopy).toBeGreaterThan(commands.findIndex((c) => c.includes("clone")));
    expect(lines.join("\n")).toContain("local NVMe; sidecar at /workspace-sidecar");
    expect(lines.join("\n")).toContain("sidecar: final copy");
    expect(plane.heartbeats.at(-1)).toMatchObject({ report: "stopped" });
  });

  it("works between ready and stopped, and reports stopped when the work ends", async () => {
    const machine = gitMachine();
    const plane = fakePlane(program, dispatch, planText, () => ({
      status: "running",
      stop: false,
    }));
    const code = await runRunner({
      machine,
      log: () => undefined,
      workspace: "/workspace",
      device: "/dev/xvdf",
      engineUser: "engine",
      plane: plane.planeFor,
      work: async (context) => {
        expect(context.scope).toEqual(f.scope);
        expect(context.layout.checkout).toBe("/workspace/checkout");
        await machine.sleep(25_000);
      },
    });
    expect(code).toBe(0);
    expect(plane.heartbeats.at(-1)).toMatchObject({ report: "stopped" });
  });

  it("stops and says so when the workspace cannot be made", async () => {
    const machine = gitMachine();
    const plane = fakePlane(program, dispatch, "# Another plan\n", () => ({
      status: "provisioning",
      stop: false,
    }));
    const lines: string[] = [];
    const code = await runRunner({
      machine,
      log: (line) => lines.push(line),
      workspace: "/workspace",
      device: "/dev/xvdf",
      engineUser: "engine",
      plane: plane.planeFor,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("the plan changed");
    expect(plane.heartbeats.at(-1)).toMatchObject({ report: "stopped" });
  });
});

describe("the root's environment (T4, D-P10-20, D-P10-22)", () => {
  it("names the plane, the token file, the state directory, the publication base and the pinned run", () => {
    const dispatch = makeDispatch(f, {
      input: { ...makeDispatch(f).input, baseSha: "b".repeat(40) },
    });
    const env = rootEnvironment({
      context: {
        scope: f.scope,
        dispatch,
        layout: layoutOf("/workspace", f.scope.runId),
      } as never,
      apiEndpoint: "https://api.dev.nightshift.invalid",
      providerKeys: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
      workerUsers: 16,
      parentEnv: { PATH: "/usr/bin", HOME: "/home/engine", SECRET: "never" },
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/engine",
      NIGHTSHIFT_API_ENDPOINT: "https://api.dev.nightshift.invalid",
      NIGHTSHIFT_API_TOKEN_FILE: tokenFile(f.scope.runId),
      NIGHTSHIFT_STATE_DIR: `/workspace/runs/${f.scope.runId}`,
      NIGHTSHIFT_PUBLISH_BASE: "b".repeat(40),
      NIGHTSHIFT_PINNED_RUN: `${f.scope.projectId}/${f.scope.programId}/${f.scope.runId}`,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
      NIGHTSHIFT_WORKER_USERS: "16",
      NIGHTSHIFT_WORKER_CREDENTIAL_DIR: `/dev/shm/nightshift/${f.scope.runId}/workers`,
    });
    expect(env.SECRET).toBeUndefined();
    // Every id in the pin is one the server will parse.
    for (const part of env.NIGHTSHIFT_PINNED_RUN?.split("/") ?? []) {
      expect(part).toMatch(/^(proj|prog|run)_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });
});
