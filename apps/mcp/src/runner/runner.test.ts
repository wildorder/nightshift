/**
 * The runner's bootstrap, sampler, heartbeat and volume, over a fake machine
 * and a fake plane (P10, T2).
 */
import type { HeartbeatResponse } from "@nightshift/contracts";
import { createFixtures } from "@nightshift/core";
import type { Transport } from "@nightshift/persistence/http";
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
import { countOomKills, cpuBusyPct, parseCpuTimes, parseDiskPct, parseMeminfo } from "./sampler.js";
import { mountWorkspace, resolveDevice } from "./volume.js";

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
    const transport: Transport = async (request) => {
      bodies.push(request.body);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return { status: 200, body: answer };
    };
    return { transport, bodies };
  };

  it("sends the pending milestone once, installs each renewed token, and stops when told", async () => {
    const { transport, bodies } = plane([
      response({ token: "eyJ.second" }),
      response({ status: "running", token: "eyJ.third" }),
      response({ status: "stopping", stop: true }),
    ]);
    const installed: string[] = [];
    let now = 0;
    const heartbeat = createHeartbeat({
      scope: f.scope,
      generation: 2,
      transport,
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
    const { transport } = plane([new Error("ECONNREFUSED")]);
    const heartbeat = createHeartbeat({
      scope: f.scope,
      generation: 2,
      transport,
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
});

describe("the runner end to end over fakes (T2)", () => {
  it("with no work yet, stays and heartbeats ready until the plane says stop", async () => {
    const machine = fakeMachine();
    const bodies: unknown[] = [];
    let beats = 0;
    const code = await runRunner({
      machine,
      log: () => undefined,
      workspace: "/workspace",
      device: "/dev/xvdf",
      engineUser: "engine",
      transportFor: () => async (request) => {
        bodies.push(request.body);
        beats += 1;
        return {
          status: 200,
          body: {
            generation: 2,
            status: beats < 3 ? "ready" : "stopping",
            leaseExpiresAt: "2026-10-01T12:01:00.000Z",
            stop: beats >= 3,
          },
        };
      },
    });
    expect(code).toBe(0);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ report: "ready" });
    expect((bodies[1] as { report?: string }).report).toBeUndefined();
  });

  it("boots, takes its token, mounts, heartbeats ready, works, reports stopped", async () => {
    const machine = fakeMachine();
    const bodies: unknown[] = [];
    const tokens: string[] = [];
    let beats = 0;
    const transportFor = (
      endpoint: string,
      provider: { idToken(): Promise<string> },
    ): Transport => {
      expect(endpoint).toBe("https://api.dev.nightshift.invalid");
      return async (request) => {
        tokens.push(await provider.idToken());
        bodies.push(request.body);
        beats += 1;
        return {
          status: 200,
          body: {
            generation: 2,
            status: beats === 1 ? "ready" : "stopping",
            leaseExpiresAt: "2026-10-01T12:01:00.000Z",
            stop: false,
            token: `eyJ.renewed.${beats}`,
          },
        };
      };
    };
    const lines: string[] = [];
    const code = await runRunner({
      machine,
      log: (line) => lines.push(line),
      workspace: "/workspace",
      device: "/dev/xvdf",
      engineUser: "engine",
      transportFor,
      work: async (context) => {
        expect(context.scope).toEqual(f.scope);
        await machine.sleep(25_000);
      },
    });
    expect(code).toBe(0);
    expect((bodies[0] as { report?: string }).report).toBe("ready");
    expect(bodies.at(-1)).toMatchObject({ report: "stopped" });
    expect(tokens[0]).toBe("eyJ.first.token");
    expect(tokens.at(-1)).toMatch(/^eyJ\.renewed\./);
    expect(lines.join("\n")).toContain("workspace mounted");
  });
});
