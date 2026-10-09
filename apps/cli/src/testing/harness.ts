/**
 * The stand-ins this package's tests drive the CLI with.
 *
 * `CliEnvironment` exists so the commands can be exercised with no network, no
 * browser and no real home directory; this is the other half of that bargain.
 * Every test in `apps/cli` builds one of these, and none of them touches
 * `process.env`, `process.stdout`, a socket outside loopback, or the operator's
 * `~/.config/nightshift`.
 *
 * It is an ordinary module rather than a `*.test.ts` file because several test
 * files share it, and a test file that other test files import would have its
 * own suites run once per importer. It is deliberately **not** re-exported from
 * `index.ts`: it is support for this package's tests, not part of the CLI's
 * surface, and nothing outside `apps/cli` should build a fake operator session.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator } from "@nightshift/core";
import { createCountingIdGenerator, createFixedClock } from "@nightshift/core";
import type { GitResult, GitRunner } from "@nightshift/execution";
import type { FetchLike } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";

export const FIXED_NOW = Date.parse("2026-09-15T12:00:00.000Z");

/** One request a fake `fetch` received, with its body already read. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** What a fake `fetch` answers with. `body` is the raw response text. */
export interface FakeResponse {
  readonly status: number;
  readonly body: string;
}

export type FakeHandler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeFetch {
  readonly fetch: FetchLike;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** The last request whose URL contains `fragment`, for a readable assertion. */
  find(fragment: string): RecordedRequest | undefined;
  /** A request body parsed as form encoding. */
  form(request: RecordedRequest): Record<string, string>;
}

export const createFakeFetch = (handler: FakeHandler): FakeFetch => {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    requests.push(request);
    const response = await handler(request);
    return { status: response.status, text: async () => response.body };
  };
  return {
    fetch,
    requests,
    find: (fragment) => [...requests].reverse().find((request) => request.url.includes(fragment)),
    form: (request) => Object.fromEntries(new URLSearchParams(request.body ?? "")),
  };
};

/** A `fetch` that fails the test if anything calls it. */
export const noFetch: FetchLike = async (url) => {
  throw new Error(`the test made an unexpected request to ${url}`);
};

/**
 * A JWT with the given claims and no signature.
 *
 * Unsigned on purpose: the CLI only ever *reads* an ID token's claims (the
 * gateway is what verifies one), so a signature here would test nothing and
 * would suggest the CLI validates something it does not.
 */
export const fakeIdToken = (claims: Record<string, unknown>): string => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    exp: Math.floor(FIXED_NOW / 1000) + 3600,
    ...claims,
  })}.`;
};

/** A `git` runner over a table of canned answers, keyed by the first two arguments. */
export const createFakeGit = (answers: Readonly<Record<string, string>> = {}): GitRunner => {
  const run: GitRunner = async (args): Promise<GitResult> => {
    const key = args
      .filter((argument) => argument !== "-c")
      .slice(0, 2)
      .join(" ");
    for (const [prefix, stdout] of Object.entries(answers)) {
      if (key.startsWith(prefix) || args.join(" ").includes(prefix)) {
        return { stdout, stderr: "", exitCode: 0 };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return run;
};

export interface TestEnvironment {
  readonly environment: CliEnvironment;
  /** Lines written to stdout. */
  readonly out: string[];
  /** Lines written to stderr. */
  readonly err: string[];
  readonly configDir: string;
  readonly stateDir: string;
  /** Presses Ctrl-C: calls every interrupt handler the command has installed and not removed. */
  interrupt(): void;
  /** How many interrupt handlers are installed now. */
  interruptHandlers(): number;
  /** Removes the temporary directories. Call from `afterEach`. */
  cleanup(): Promise<void>;
}

export interface TestEnvironmentOptions {
  readonly fetch?: FetchLike;
  readonly openBrowser?: (url: string) => Promise<boolean>;
  /** What the operator pastes. Default: nobody types anything. */
  readonly readPaste?: CliEnvironment["readPaste"];
  readonly ids?: IdGenerator;
  readonly git?: GitRunner;
  readonly cwd?: string;
  readonly nowMs?: number;
  /** Default: returns at once. */
  readonly sleep?: CliEnvironment["sleep"];
  /** Default: not a terminal. */
  readonly stdoutIsTTY?: boolean;
  /** Default: the fixed clock at `nowMs`. */
  readonly clock?: CliEnvironment["clock"];
}

/**
 * A CLI environment over a fresh temporary config directory.
 *
 * `NIGHTSHIFT_CONFIG_DIR` and `NIGHTSHIFT_STATE_DIR` are set in the environment
 * record the path helpers read, and `process.env` is left alone — so these tests
 * are safe to run in parallel and on a machine whose operator is signed in.
 */
export const createTestEnvironment = async (
  options: TestEnvironmentOptions = {},
): Promise<TestEnvironment> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-cli-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const out: string[] = [];
  const err: string[] = [];
  const interrupts = new Set<() => void>();

  const environment: CliEnvironment = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    cwd: options.cwd ?? root,
    paths: {
      env: { NIGHTSHIFT_CONFIG_DIR: configDir, NIGHTSHIFT_STATE_DIR: stateDir },
      // Pinned so a path assertion does not depend on the machine running it.
      platform: process.platform,
      home: root,
    },
    fetch: options.fetch ?? noFetch,
    openBrowser: options.openBrowser ?? (async () => false),
    readPaste:
      options.readPaste ??
      (() => ({ line: new Promise<undefined>(() => undefined), cancel: () => undefined })),
    clock: options.clock ?? createFixedClock(options.nowMs ?? FIXED_NOW),
    ids: options.ids ?? createCountingIdGenerator(),
    git: options.git ?? createFakeGit(),
    // The real listener, on a port the operating system picks. The flow under
    // test is the real one; only the port is not.
    startLoopback: async (loopbackOptions) => {
      const { startLoopback } = await import("../loopback.js");
      return startLoopback({ port: 0, timeoutMs: 10_000, ...loopbackOptions });
    },
    sleep: options.sleep ?? (async () => undefined),
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    onInterrupt: (handler) => {
      const own = (): void => handler();
      interrupts.add(own);
      return () => {
        interrupts.delete(own);
      };
    },
  };

  return {
    environment,
    out,
    err,
    configDir,
    stateDir,
    interrupt: () => {
      for (const handler of [...interrupts]) handler();
    },
    interruptHandlers: () => interrupts.size,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

/**
 * A stand-in control plane, over the injected `fetch`.
 *
 * `apps/cli` may not reference `apps/api` — the layer table (`test/src/
 * architecture/rules.ts`) gives the CLI `contracts`, `core`, `persistence` and
 * `execution`, and nothing else — so these tests cannot drive
 * `startLocalControlPlane` the way `apps/api/src/http-adapter.test.ts` does.
 * That reference is not something this package may add, so the commands are
 * tested against the transport instead.
 *
 * What it therefore does **not** prove: that the routes the CLI builds are the
 * routes the API serves, or that a domain rule fires. Both are proven elsewhere,
 * and T7 deliverable 8 asks for the second explicitly — so
 * `test/src/cli/commands.test.ts` drives `whoami`, `project create`, `run` and
 * `id` through this package's **own** `openSession` against
 * `startLocalControlPlane`, the production handler on loopback. `test`
 * references both packages and may do that; this one may not. A route the CLI
 * spells differently from the API is a 404 over there, and a body the API
 * refuses is a refusal over there.
 *
 * What is left for these tests is what the CLI itself decides, with the control
 * plane's answer held fixed: which route, which body, which output, and which
 * failure — including the ones a real plane cannot easily be made to produce.
 */
export interface FakeControlPlaneOptions {
  readonly apiEndpoint: string;
  readonly authDomain: string;
  /** The claims of the ID token the refresh grant returns. */
  readonly claims: Record<string, unknown>;
  /** The acting org the fake assigns to a stored project. */
  readonly orgId?: string;
  /** Overrides `GET /projects`, for a typed refusal. */
  readonly projects?: FakeResponse;
  /**
   * The stored projects `GET /projects/{id}` can find.
   *
   * Empty by default, so `nightshift run` against a contract naming an unknown
   * project takes the `ProjectMissingError` path — which is the interesting one.
   */
  readonly stored?: readonly { readonly projectId: string }[];
  /** Overrides any request whose path starts with one of these prefixes. */
  readonly overrides?: readonly { readonly path: string; readonly response: FakeResponse }[];
}

export const DEFAULT_TEST_ORG = "org_00000000000000000000000001";

/** Every request the fake received, with the path split out for readable assertions. */
export interface ControlPlaneCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakeControlPlane extends FakeFetch {
  /** Control-plane requests only; the token endpoint is not one. */
  readonly calls: ControlPlaneCall[];
  call(method: string, path: string): ControlPlaneCall | undefined;
}

export const createFakeControlPlane = (options: FakeControlPlaneOptions): FakeControlPlane => {
  const orgId = options.orgId ?? DEFAULT_TEST_ORG;
  const calls: ControlPlaneCall[] = [];
  const json = (status: number, body: unknown): FakeResponse => ({
    status,
    body: JSON.stringify(body),
  });

  const notFound = (message: string): FakeResponse =>
    json(404, { error: { code: "not_found", message } });

  const ONE_PROJECT = /^\/projects\/proj_[^/]+$/;

  const readProject = (path: string): FakeResponse => {
    const found = (options.stored ?? []).find(
      (project) => path === `/projects/${project.projectId}`,
    );
    return found === undefined ? notFound(`no project at ${path}`) : json(200, found);
  };

  const read = (path: string): FakeResponse => {
    if (path === "/projects") return options.projects ?? json(200, { items: [] });
    if (ONE_PROJECT.test(path)) return readProject(path);
    return notFound(`no route for GET ${path}`);
  };

  const write = (method: string, path: string, body: unknown): FakeResponse => {
    // The control plane assigns the org from the token; it is never sent.
    if (method === "PUT" && ONE_PROJECT.test(path)) {
      return json(201, { ...(body as Record<string, unknown>), orgId });
    }
    // Every other write is create-or-confirm and answers with what it stored.
    if (method === "PUT") return json(201, body);
    if (method === "POST" && path.endsWith("/events")) {
      return json(201, {
        stored: true,
        event: { ...(body as object), sequence: null, recordedAt: "2026-09-15T12:00:00.000Z" },
      });
    }
    return notFound(`no route for ${method} ${path}`);
  };

  const fake = createFakeFetch((request) => {
    if (request.url === `https://${options.authDomain}/oauth2/token`) {
      return json(200, { id_token: fakeIdToken(options.claims), expires_in: 3600 });
    }
    if (!request.url.startsWith(options.apiEndpoint)) {
      return notFound(`no such host: ${request.url}`);
    }

    const path = new URL(request.url).pathname;
    const body: unknown = request.body === undefined ? undefined : JSON.parse(request.body);
    calls.push({ method: request.method, path, body });

    const override = (options.overrides ?? []).find((candidate) => path.startsWith(candidate.path));
    if (override !== undefined) return override.response;

    return request.method === "GET" ? read(path) : write(request.method, path, body);
  });

  return {
    ...fake,
    calls,
    call: (method, path) => calls.find((entry) => entry.method === method && entry.path === path),
  };
};

export const TEST_API = "https://api.test.invalid";
export const TEST_AUTH_DOMAIN = "nightshift-test.auth.us-west-2.amazoncognito.com";
export const TEST_CLIENT_ID = "test-interactive-client";
export const TEST_SUBJECT = "11111111-2222-3333-4444-555555555555";
export const TEST_EMAIL = "operator@example.invalid";
/** The secret, in the one place a test is allowed to know it. */
export const TEST_REFRESH_TOKEN = "eyJ.THE-REFRESH-TOKEN.zzz";

/**
 * Seeds a signed-in session, as `nightshift login` would have left one.
 *
 * Every command except `login`, `logout` and `id` starts from this state, and
 * writing the two files through the real `store.ts` writers rather than by hand
 * keeps the tests honest about what a session is.
 */
export const signIn = async (environment: CliEnvironment): Promise<void> => {
  const { writeCredentials, writeProfile } = await import("@nightshift/persistence/http");
  await writeProfile(
    {
      apiEndpoint: TEST_API,
      authDomain: TEST_AUTH_DOMAIN,
      clientId: TEST_CLIENT_ID,
      stage: "dev",
    },
    environment.paths,
  );
  await writeCredentials(
    {
      refreshToken: TEST_REFRESH_TOKEN,
      subject: TEST_SUBJECT,
      clientId: TEST_CLIENT_ID,
      obtainedAt: "2026-09-15T12:00:00.000Z",
    },
    environment.paths,
  );
};
