/**
 * The composition root's one piece of pure logic.
 *
 * Everything else `compose.ts` does is wiring, and the slice suite proves that
 * by running the real binary. This is the exception: a rule about specifiers
 * whose Windows half cannot be observed on a POSIX machine, and which CI found
 * the hard way — the scripted harness is handed an absolute path through
 * `NIGHTSHIFT_HARNESS_MODULE`, and on Windows `await import()` refuses it.
 */
import { pathToFileURL } from "node:url";
import type { AgentId, ExecutionNodeId, JobContractId } from "@nightshift/contracts";
import type { WorkerLaunchIdentity } from "@nightshift/execution";
import { describe, expect, it } from "vitest";
import {
  API_ENDPOINT_ENV,
  API_TOKEN_ENV,
  createWorkerLaunchForTest,
  harnessModuleSpecifier,
} from "./compose.js";
import { EXECUTION_TOKEN_ENV, EXECUTION_TOKEN_FILE_ENV, WORKER_IDENTITY_ENV } from "./role.js";

describe("harnessModuleSpecifier", () => {
  it("turns a Windows absolute path into a file:// URL", () => {
    // Stated as a literal rather than built from `process.platform`, so this
    // assertion holds on the machine of whoever is reading it.
    const specifier = harnessModuleSpecifier("C:\\work\\nightshift\\test\\dist\\scripted.js");
    expect(specifier.startsWith("file:///")).toBe(true);
    expect(specifier).toContain("scripted.js");
    // Never the bare path: `C:` would be read as a URL scheme.
    expect(specifier.startsWith("C:")).toBe(false);
  });

  it("turns a POSIX absolute path into a file:// URL too", () => {
    expect(harnessModuleSpecifier("/work/nightshift/test/dist/scripted.js")).toBe(
      pathToFileURL("/work/nightshift/test/dist/scripted.js").href,
    );
  });

  it("converts a relative path, which import() resolves against this module otherwise", () => {
    expect(harnessModuleSpecifier("./scripted.js").startsWith("file://")).toBe(true);
    expect(harnessModuleSpecifier("../scripted.js").startsWith("file://")).toBe(true);
  });

  it("leaves a bare package name exactly as written", () => {
    // The other legitimate form: a harness published as a package.
    expect(harnessModuleSpecifier("@nightshift/harness-codex")).toBe("@nightshift/harness-codex");
    expect(harnessModuleSpecifier("some-harness")).toBe("some-harness");
  });
});

/**
 * A worker's credential, and what it is no longer given (P4, T4; D-P4-06,
 * SC-P4-06).
 *
 * Before P4, `createWorkerLaunch` passed `NIGHTSHIFT_CONFIG_DIR` through and the
 * worker found the operator's refresh token in it, because it runs as the same
 * operating-system user. These assertions are the structural half of closing
 * that: the environment is built here, so what is *absent* from it is checkable
 * without running anything.
 */
describe("the worker's launch environment", () => {
  const identity: WorkerLaunchIdentity = {
    projectId: "proj_00000000000000000000000001",
    programId: "prog_00000000000000000000000001",
    runId: "run_00000000000000000000000001",
    nodeId: "node_00000000000000000000000001" as ExecutionNodeId,
    agentId: "agent_00000000000000000000000001" as AgentId,
    jobContractId: "job_00000000000000000000000001" as JobContractId,
    worktree: "/tmp/worktree",
    role: "worker",
    executionToken: "a.execution.token",
  };

  const launchWith = (env: Record<string, string>) =>
    createWorkerLaunchForTest(env, "https://api.dev.nightshift.wildorder.dev")(identity);

  it("carries the execution token and the endpoint", () => {
    const launch = launchWith({});
    expect(launch.env[EXECUTION_TOKEN_ENV]).toBe(identity.executionToken);
    expect(launch.env[API_ENDPOINT_ENV]).toBe("https://api.dev.nightshift.wildorder.dev");
  });

  it("carries the token's file instead of the token when the engine keeps one (P10, T4)", () => {
    const launch = createWorkerLaunchForTest(
      {},
      "https://api.dev.nightshift.wildorder.dev",
    )({
      ...identity,
      executionTokenFile: "/dev/shm/nightshift/run_x/agents/agent_y/token",
    });
    expect(launch.env[EXECUTION_TOKEN_FILE_ENV]).toBe(
      "/dev/shm/nightshift/run_x/agents/agent_y/token",
    );
    expect(launch.env[EXECUTION_TOKEN_ENV]).toBeUndefined();
    expect(Object.values(launch.env)).not.toContain(identity.executionToken);
  });

  it("never carries the config directory, whatever the orchestrator holds", () => {
    const launch = launchWith({
      NIGHTSHIFT_CONFIG_DIR: "/home/operator/.config/nightshift",
      NIGHTSHIFT_STATE_DIR: "/home/operator/.local/state/nightshift",
    });
    expect(launch.env.NIGHTSHIFT_CONFIG_DIR).toBeUndefined();
    // The state directory is worktrees, spool and transcripts. No credential.
    expect(launch.env.NIGHTSHIFT_STATE_DIR).toBe("/home/operator/.local/state/nightshift");
  });

  it("never passes the orchestrator's own API token down to a worker", () => {
    const launch = launchWith({ [API_TOKEN_ENV]: "the-operators-machine-token" });
    expect(launch.env[API_TOKEN_ENV]).toBeUndefined();
    expect(Object.values(launch.env)).not.toContain("the-operators-machine-token");
  });

  it("carries the seven identity variables and the token, and nothing else", () => {
    const launch = launchWith({
      NIGHTSHIFT_CONFIG_DIR: "/home/operator/.config/nightshift",
      [API_TOKEN_ENV]: "the-operators-machine-token",
      AWS_PROFILE: "nightshift",
      AWS_ACCESS_KEY_ID: "AKIA-not-a-real-key",
    });
    expect(Object.keys(launch.env).sort()).toEqual(
      [
        API_ENDPOINT_ENV,
        EXECUTION_TOKEN_ENV,
        "NIGHTSHIFT_ROLE",
        ...Object.values(WORKER_IDENTITY_ENV),
      ].sort(),
    );
  });
});
