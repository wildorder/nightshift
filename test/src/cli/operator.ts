/**
 * A signed-in operator for the CLI suites: a real config directory holding a
 * real profile and real credentials, pointed at a real local control plane.
 * Shared by `commands.test.ts` (P3) and `planning.test.ts` (P7).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalControlPlane, startLocalControlPlane } from "@nightshift/api/testing";
import type { CliEnvironment } from "@nightshift/cli";
import type { OrgId } from "@nightshift/contracts";
import {
  createSteppingClock,
  createUlidIdGenerator,
  type IdGenerator,
  makeMembership,
  nowIso,
  systemClock,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import type { FetchLike } from "@nightshift/persistence/http";
import { writeCredentials, writeProfile } from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";

export const SUBJECT = "11111111-2222-3333-4444-555555555555";
export const AUTH_DOMAIN = "nightshift-test.auth.us-west-2.amazoncognito.com";
export const CLIENT_ID = "test-interactive-client";
const START_MS = Date.parse("2026-09-15T12:00:00.000Z");

/** A JWT with no signature: the CLI reads claims, the gateway verifies them. */
const idTokenFor = (claims: Record<string, unknown>): string => {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    exp: Math.floor(START_MS / 1000) + 3600,
    ...claims,
  })}.`;
};

export interface Operator {
  readonly plane: LocalControlPlane;
  readonly environment: CliEnvironment;
  readonly out: string[];
  readonly err: string[];
  readonly orgId: OrgId;
  readonly ids: IdGenerator;
  /** How many times the CLI went to the token endpoint. */
  tokenMints(): number;
  cleanup(): Promise<void>;
}

/**
 * A signed-in operator: a real config directory holding a real profile and real
 * credentials, pointed at a real control plane.
 */
export interface SignInOptions {
  /**
   * The system clock rather than the stepping one. A suite that runs real
   * worker processes needs it: the stepping clock advances a second per reading,
   * and a worker's execution token expires within one run's worth of readings.
   */
  readonly realTime?: boolean;
}

export const signIn = async (options: SignInOptions = {}): Promise<Operator> => {
  const ids = createUlidIdGenerator();
  const clock = options.realTime === true ? systemClock : createSteppingClock(START_MS, 1_000);
  const backing: InMemoryStores = createInMemoryStores({ deferSequencing: true });
  const orgId = ids.next("org") as OrgId;
  await backing.memberships.put(makeMembership(SUBJECT as never, orgId));

  const plane = await startLocalControlPlane({
    stores: backing,
    principal: { kind: "user", userId: SUBJECT as never, activeOrg: orgId },
    clock,
  });

  const root = await mkdtemp(join(tmpdir(), "nightshift-cli-suite-"));
  const paths = {
    env: { NIGHTSHIFT_CONFIG_DIR: join(root, "config"), NIGHTSHIFT_STATE_DIR: join(root, "state") },
    platform: process.platform,
    home: root,
  };
  await writeProfile(
    { apiEndpoint: plane.url, authDomain: AUTH_DOMAIN, clientId: CLIENT_ID, stage: "test" },
    paths,
  );
  await writeCredentials(
    {
      refreshToken: "a-refresh-token-that-must-never-be-printed",
      subject: SUBJECT,
      clientId: CLIENT_ID,
      obtainedAt: nowIso(clock),
    },
    paths,
  );

  let mints = 0;
  const real = globalThis.fetch as unknown as FetchLike;
  const fetch: FetchLike = async (url, init) => {
    if (!url.startsWith(`https://${AUTH_DOMAIN}/`)) return real(url, init);
    // Cognito's token endpoint, and only it.
    mints += 1;
    const body = JSON.stringify({
      id_token: idTokenFor({
        sub: SUBJECT,
        email: "operator@example.test",
        // Valid on whichever clock the suite runs by.
        exp: Math.floor(clock.now() / 1000) + 3600,
      }),
      access_token: "unused",
      expires_in: 3600,
      token_type: "Bearer",
    });
    return { status: 200, text: async () => body };
  };

  const out: string[] = [];
  const err: string[] = [];
  const environment: CliEnvironment = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    cwd: root,
    paths,
    fetch,
    openBrowser: async () => false,
    // Nobody pastes anything in these tests; the callback path is the one under test.
    readPaste: () => ({ line: new Promise<undefined>(() => undefined), cancel: () => undefined }),
    clock,
    ids,
    git: nodeGitRunner,
    startLoopback: async () => {
      throw new Error("no command in this suite opens a loopback listener");
    },
  };

  return {
    plane,
    environment,
    out,
    err,
    orgId,
    ids,
    tokenMints: () => mints,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};
