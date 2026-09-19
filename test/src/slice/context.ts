/**
 * Where a slice runs, and what it drives (T9 deliverables 3 and 4).
 *
 * One suite, two axes, chosen by environment and defaulting to the offline pair:
 *
 * | | `local` (default, `npm test`) | `deployed` (`npm run slice`) |
 * |---|---|---|
 * | control plane | the production handler over loopback, in-memory stores | the real endpoint, a machine token, a throwaway project |
 * | harness | the scripted harness: a real child, a real worker MCP server | a real adapter: `claude -p`, or `codex exec` (P5) |
 *
 * Whichever pair is chosen, **the thing under test is the same**: the real
 * `nightshift-mcp` binary, spawned as a child, driven over stdio by the SDK's
 * own client, exactly as Claude Code drives it. A suite that called the server's
 * functions directly would prove the functions worked, not the server.
 *
 * Every assertion in the suite reads the **control plane**. A test that read
 * process memory would prove nothing about SC-P3-11, whose whole subject is what
 * survives a process.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type LocalControlPlane, startLocalControlPlane } from "@nightshift/api/testing";
import type { ProgramContract } from "@nightshift/contracts";
import {
  createSteppingClock,
  createUlidIdGenerator,
  type IdGenerator,
  makeMembership,
  nowIso,
  type ProjectStores,
  type RunScope,
  systemClock,
} from "@nightshift/core";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpStores,
  staticTokenProvider,
  type Transport,
} from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { sanitizeEnvironment } from "@nightshift/verification";
import type { ScriptName } from "../harness/scripted.js";
import {
  type MaterialisedRepo,
  type MaterialiseOptions,
  materialiseFixtureRepo,
} from "./fixture-repo.js";

export const TARGET_ENV = "NIGHTSHIFT_SLICE_TARGET";
export const HARNESS_ENV = "NIGHTSHIFT_SLICE_HARNESS";

export type SliceTarget = "local" | "deployed";
export type SliceHarness = "scripted" | "claude" | "codex";

export const sliceTarget = (): SliceTarget =>
  process.env[TARGET_ENV] === "deployed" ? "deployed" : "local";

export const sliceHarness = (): SliceHarness => {
  const value = process.env[HARNESS_ENV];
  return value === "claude" || value === "codex" ? value : "scripted";
};

/**
 * The repository root.
 *
 * This module is at `test/src/slice/` in source and `test/dist/slice/` when
 * built, and vitest runs it from source while the server child loads *built*
 * modules. Three levels up is the root either way, which is what makes the two
 * paths below correct in both.
 */
const REPO_ROOT = new URL("../../../", import.meta.url);

/** The built server binary. The suite drives this, not a re-implementation. */
export const serverBinary = (): string =>
  fileURLToPath(new URL("apps/mcp/dist/bin/nightshift-mcp.js", REPO_ROOT));

/**
 * The built scripted harness, loaded by the server's composition root.
 *
 * Deliberately the `dist` path rather than one relative to this module: it is
 * imported by a **different process**, which has no TypeScript loader.
 */
export const scriptedHarnessModule = (): string =>
  fileURLToPath(new URL("test/dist/harness/scripted.js", REPO_ROOT));

/**
 * A clear failure rather than a mysterious one.
 *
 * The suite drives compiled output, so a tree that has not been built fails at
 * the first spawn with an error nobody can read. This says what to do.
 */
export const assertBuilt = async (): Promise<void> => {
  for (const path of [serverBinary(), scriptedHarnessModule()]) {
    try {
      await access(path);
    } catch {
      throw new Error(
        `${path} does not exist. The slice suite drives compiled output — run \`npm run build\` first.`,
      );
    }
  }
};

export interface SliceContext {
  readonly target: SliceTarget;
  readonly fixture: MaterialisedRepo;
  readonly stores: ProjectStores;
  readonly bodies: ReturnType<typeof createHttpArtifactBodyStore>;
  readonly transport: Transport;
  readonly ids: IdGenerator;
  readonly program: ProgramContract;
  /** How the server is told to reach this control plane. */
  readonly serverEnv: Readonly<Record<string, string>>;
  /** Reads an artifact's bytes back, however this target stores them. */
  readArtifact(scope: RunScope, artifactId: string): Promise<string | undefined>;
  /** Numbers every event appended so far. A no-op against the deployed stack. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** Every URL this context handed the server, for SC-P3-15's own assertion. */
export const configuredUrls = (context: SliceContext): readonly string[] =>
  Object.entries(context.serverEnv)
    .filter(([name]) => name.endsWith("_ENDPOINT") || name.endsWith("_URL"))
    .map(([, value]) => value);

/**
 * The offline pair: the production handler over loopback, in-memory stores with
 * deferred numbering, and a fixture repository in a temporary directory.
 */
export interface LocalContextOptions extends Pick<MaterialiseOptions, "modelPolicy"> {
  /**
   * Real time rather than the stepping clock. The stepping clock advances a
   * second per reading, which makes a scripted run's records deterministic and
   * makes a **real** worker's execution token expire in fake time: a job that
   * takes minutes reads the clock thousands of times. Found by the first real
   * Codex worker, whose `job.complete` was refused as expired.
   */
  readonly realTime?: boolean;
}

export const createLocalContext = async (
  options: LocalContextOptions = {},
): Promise<SliceContext> => {
  await assertBuilt();
  const backing: InMemoryStores = createInMemoryStores({ deferSequencing: true });
  const ids = createUlidIdGenerator();
  const subject = "11111111-2222-3333-4444-555555555555";
  const orgId = ids.next("org");
  await backing.memberships.put(makeMembership(subject as never, orgId));

  const clock =
    options.realTime === true
      ? systemClock
      : createSteppingClock(Date.parse("2026-09-15T12:00:00.000Z"), 1_000);
  const plane: LocalControlPlane = await startLocalControlPlane({
    stores: backing,
    principal: { kind: "user", userId: subject as never, activeOrg: orgId },
    clock,
  });

  const transport = createFetchTransport({
    endpoint: plane.url,
    tokens: staticTokenProvider("ignored-by-the-local-plane"),
  });
  const stores = createHttpStores({ transport, actingOrg: orgId });
  const bodies = createHttpArtifactBodyStore({
    transport,
    read: async (scope, artifactId) =>
      plane.bodies.get(`${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`)?.body,
  });

  // The authored identifiers, so a local run's records read the same every time.
  const fixture = await materialiseFixtureRepo(
    options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy },
  );
  await stores.projects.put({
    schemaVersion: 1,
    projectId: fixture.program.projectId,
    orgId,
    name: "nightshift-slice-fixture",
    createdAt: nowIso(clock),
  });

  return {
    target: "local",
    fixture,
    stores,
    bodies,
    transport,
    ids,
    program: fixture.program,
    serverEnv: {
      NIGHTSHIFT_API_ENDPOINT: plane.url,
      NIGHTSHIFT_API_TOKEN: "ignored-by-the-local-plane",
      NIGHTSHIFT_STATE_DIR: fixture.stateDir,
    },
    readArtifact: async (scope, artifactId) =>
      plane.bodies.text(`${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`),
    settle: async () => {
      backing.materializeSequences();
    },
    close: async () => {
      await plane.close();
      await fixture.remove();
    },
  };
};

export interface OrchestratorOptions {
  readonly context: SliceContext;
  /** Which scripted behaviour the worker will follow. Ignored by the real adapter. */
  readonly script?: ScriptName;
  readonly harness?: SliceHarness;
  /** Overrides merged into the server's environment. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface Orchestrator {
  readonly client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<Structured>;
  toolNames(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export interface Structured extends Record<string, unknown> {
  readonly ok: boolean;
}

/**
 * The real server binary, as a child process over stdio, driven by a real
 * client — exactly the shape Claude Code launches it in.
 */
export const startOrchestrator = async (options: OrchestratorOptions): Promise<Orchestrator> => {
  const { context } = options;
  const harness = options.harness ?? sliceHarness();
  // The platform allowlist, not `PATH` and `HOME` by hand: on Windows a child
  // spawned without `SystemRoot`, `PATHEXT` and `TEMP` fails to start at all,
  // and the failure surfaces as the MCP client's "Connection closed" rather
  // than as anything about the environment. `sanitizeEnvironment` is the same
  // function the verification runner uses, and it matches names
  // case-insensitively on Windows so a parent's `Path` still reaches the child.
  const env: Record<string, string> = {
    ...sanitizeEnvironment({
      platform: process.platform,
      parentEnv: process.env,
      extra: undefined,
    }),
    ...context.serverEnv,
    // Under a second in a test, rather than the production default: a slice test
    // that waited fifty-five seconds per poll would dominate `npm test`.
    NIGHTSHIFT_JOB_WAIT_CAP_SECONDS: "20",
    ...(harness === "scripted"
      ? {
          NIGHTSHIFT_HARNESS_MODULE: scriptedHarnessModule(),
          NIGHTSHIFT_WORKER_SCRIPT: options.script ?? "implement",
        }
      : {}),
    ...options.env,
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBinary()],
    env,
    cwd: context.fixture.repo,
    stderr: "pipe",
  });
  const client = new Client({ name: "claude-code", version: "2.1.273" });
  await client.connect(transport);

  // Kept rather than printed: a failing test wants the server's diagnostics.
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return {
    client,
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const structured = result.structuredContent as Structured | undefined;
      if (structured !== undefined) return structured;

      // A refusal the **protocol** made, before the tool body ran: the SDK
      // validates arguments against the tool's declared input schema and answers
      // `-32602 Invalid params` itself. That is a real refusal of a real
      // malformed request — one layer earlier than the handler's own — so it is
      // surfaced in the same shape rather than as a thrown error, and a caller
      // branching on `code` sees the same thing either way.
      const text = result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
      if (result.isError === true) {
        return { ok: false, code: "validation_failed", message: text, fromProtocol: true };
      }
      throw new Error(`${name} answered no structured content: ${text}\n${stderr}`);
    },
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    close: async () => {
      await client.close();
    },
  };
};

/** Spawns a process and resolves when it has exited. For killing a worker by pid. */
export const killPid = (pid: number, signal: NodeJS.Signals = "SIGKILL"): void => {
  try {
    // The group, so the worker's own MCP server goes too. A surviving
    // grandchild would keep writing events after the node was recorded stopped.
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

/** Waits for a predicate to hold against the control plane, or gives up loudly. */
export const waitFor = async <T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (last !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
};

export { spawn };
