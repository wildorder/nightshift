import { createFixtures, makeDispatch, makeRun } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { bootstrapEngineToken, type RunnerIdentity, takeFirstToken } from "./bootstrap.js";
import type { CommandResult, Machine } from "./machine.js";
import { recoverLocalWorkspace } from "./recovery.js";
import { SIDECAR_MARKER } from "./sidecar.js";

const f = createFixtures();
const identity: RunnerIdentity = {
  scope: f.scope,
  generation: 2,
  stage: "dev",
  apiEndpoint: "https://api.dev.nightshift.invalid",
  instanceId: "i-current",
};
const now = Date.parse("2026-10-11T12:00:00Z");
const result = (stdout = "", exitCode = 0): CommandResult => ({ stdout, exitCode, stderr: "" });
const fakeMachine = () => {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const state = {
    firstToken: "first-token" as string | undefined,
    populated: false,
    sameRun: true,
    sidecar: true,
    failRestore: false,
    failListing: false,
  };
  const commands: Record<string, (args: readonly string[]) => CommandResult> = {
    aws: (args) => {
      if (args[1] === "get-parameter") {
        return state.firstToken === undefined ? result("", 1) : result(state.firstToken);
      }
      if (args[1] === "delete-parameter") state.firstToken = undefined;
      return result();
    },
    find: () => result(state.populated ? "/workspace/checkout" : "", state.failListing ? 1 : 0),
    test: (args) => result("", (args[0] === "-d" ? state.sameRun : state.sidecar) ? 0 : 1),
    mv: (args) => {
      files.set(args[2] as string, files.get(args[1] as string) as string);
      files.delete(args[1] as string);
      return result();
    },
    sudo: (args) => {
      if (args[0] !== "rsync") return result();
      state.populated = true;
      return result("", state.failRestore ? 1 : 0);
    },
  };
  const machine: Machine = {
    now: () => now,
    sleep: async () => undefined,
    http: async () => ({ status: 404, text: "" }),
    readFile: async (path) => files.get(path),
    writeFile: async (path, value) => {
      files.set(path, value);
    },
    exec: async (file, args) => {
      calls.push([file, ...args].join(" "));
      return commands[file]?.(args) ?? result();
    },
  };
  return { machine, files, calls, state };
};

const jwt = (patch: Record<string, unknown> = {}, principal: Record<string, unknown> = {}) => {
  const dispatch = makeDispatch(f);
  const payload = {
    iss: identity.apiEndpoint,
    aud: "nightshift-api",
    sub: dispatch.engineAgentId,
    iat: Math.floor(now / 1000) - 20,
    exp: Math.floor(now / 1000) + 3600,
    nightshift: {
      kind: "execution",
      ...f.scope,
      nodeId: makeRun(f).rootNodeId,
      agentId: dispatch.engineAgentId,
      role: "engine",
      generation: identity.generation,
      ...principal,
    },
    ...patch,
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
};

describe("engine process restart bootstrap", () => {
  it("reuses the latest valid RAM token without trying to consume SSM again", async () => {
    const { machine, calls, state } = fakeMachine();
    state.firstToken = undefined;
    const token = jwt();
    expect(
      await bootstrapEngineToken(machine, identity, { readCachedToken: async () => token }),
    ).toBe(token);
    expect(calls).toEqual([]);
  });

  it.each([
    ["expired", () => jwt({ exp: Math.floor(now / 1000) })],
    ["old generation", () => jwt({}, { generation: 1 })],
    ["worker", () => jwt({}, { role: "worker" })],
    ["other issuer", () => jwt({ iss: "https://elsewhere.invalid" })],
    ["other run", () => jwt({}, { runId: createFixtures().scope.runId })],
    ["truncated", () => "header.partial"],
  ])("does not reuse a %s cache", async (_name, token) => {
    const { machine, calls } = fakeMachine();
    expect(
      await bootstrapEngineToken(machine, identity, { readCachedToken: async () => token() }),
    ).toBe("first-token");
    expect(calls.some((call) => call.includes("get-parameter"))).toBe(true);
  });

  it("installs the first token before deleting the bootstrap parameter", async () => {
    const { machine, state } = fakeMachine();
    let installed = false;
    await bootstrapEngineToken(machine, identity, {
      installToken: async (token) => {
        expect(state.firstToken).toBe(token);
        installed = true;
      },
    });
    expect(installed).toBe(true);
    expect(state.firstToken).toBeUndefined();
  });

  it("leaves SSM intact if the RAM token cannot be installed", async () => {
    const { machine, state } = fakeMachine();
    await expect(
      takeFirstToken(machine, identity, async () => {
        throw new Error("RAM write failed");
      }),
    ).rejects.toThrow("RAM write failed");
    expect(state.firstToken).toBe("first-token");
  });

  it("explains that missing/expired restart authority needs reconciler replacement", async () => {
    const { machine, state } = fakeMachine();
    state.firstToken = undefined;
    const secret = "SECRET-corrupt-token";
    const error = await bootstrapEngineToken(machine, identity, {
      readCachedToken: async () => secret,
    }).catch((cause: unknown) => cause);
    expect(String(error)).toContain("reconciler must replace");
    expect(String(error)).not.toContain(secret);
  });
});

describe("local workspace restart recovery", () => {
  const options = { workspace: "/workspace", sidecar: "/sidecar", identity };
  const marker = `/workspace/${SIDECAR_MARKER}`;

  it("restores a fresh replacement disk, then preserves newer local data on restart", async () => {
    const { machine, calls } = fakeMachine();
    expect(await recoverLocalWorkspace(machine, options)).toBe("restored");
    expect(await recoverLocalWorkspace(machine, options)).toBe("preserved");
    expect(calls.filter((call) => call.startsWith("sudo rsync"))).toHaveLength(1);
  });

  it("retries an interrupted restore instead of preserving a partial copy", async () => {
    const { machine, state, files, calls } = fakeMachine();
    state.failRestore = true;
    await expect(recoverLocalWorkspace(machine, options)).rejects.toThrow("rsync");
    expect(JSON.parse(files.get(marker) as string).state).toBe("restoring");
    state.failRestore = false;
    expect(await recoverLocalWorkspace(machine, options)).toBe("restored");
    expect(calls.filter((call) => call.startsWith("sudo rsync"))).toHaveLength(2);
  });

  it("preserves a same-run workspace created before markers existed", async () => {
    const { machine, state, calls } = fakeMachine();
    state.populated = true;
    expect(await recoverLocalWorkspace(machine, options)).toBe("preserved");
    expect(calls.some((call) => call.startsWith("sudo rsync"))).toBe(false);
  });

  it("starts cold when both local disk and sidecar are empty", async () => {
    const { machine, state } = fakeMachine();
    state.sidecar = false;
    expect(await recoverLocalWorkspace(machine, options)).toBe("empty");
  });

  it("never overwrites another run's nonempty unmarked workspace", async () => {
    const { machine, state, calls } = fakeMachine();
    state.populated = true;
    state.sameRun = false;
    await expect(recoverLocalWorkspace(machine, options)).rejects.toThrow("preserving it");
    expect(calls.some((call) => call.startsWith("sudo rsync"))).toBe(false);
  });

  it("refuses a different machine identity without modifying its disk", async () => {
    const { machine, calls } = fakeMachine();
    await recoverLocalWorkspace(machine, options);
    calls.length = 0;
    await expect(
      recoverLocalWorkspace(machine, {
        ...options,
        identity: { ...identity, instanceId: "i-other" },
      }),
    ).rejects.toThrow("different run/machine identity");
    expect(calls).toEqual([]);
  });

  it("does not mistake a failed directory listing for an empty disk", async () => {
    const { machine, state, calls } = fakeMachine();
    state.failListing = true;
    await expect(recoverLocalWorkspace(machine, options)).rejects.toThrow("could not inspect");
    expect(calls.some((call) => call.startsWith("sudo rsync"))).toBe(false);
  });
});
