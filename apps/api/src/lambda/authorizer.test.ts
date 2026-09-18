/**
 * The Nightshift authorizer, offline (T3 deliverable 1).
 *
 * A fake JWKS and two local key pairs, so both token kinds are exercised
 * through the real verifying code with nothing deployed. SC-P4-05 is the claim
 * these assertions make: a request with no token, an expired execution token, an
 * execution token signed by another key, or a Cognito token for another audience
 * is rejected **here**, never by the handler.
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign as signWith,
} from "node:crypto";
import { EXECUTION_TOKEN_AUDIENCE } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { encodeSegment } from "../tokens/jwt.js";
import { mintExecutionToken } from "../tokens/mint.js";
import { publicKeyFromSpki } from "../tokens/verify.js";
import {
  bearerTokenFrom,
  createAuthorizer,
  createCognitoVerifier,
  type JwksFetch,
} from "./authorizer.js";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const COGNITO_ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TestPool";
const EXECUTION_ISSUER = "https://api.dev.nightshift.wildorder.dev";
const INTERACTIVE_CLIENT = "interactive-client-id";
const MACHINE_CLIENT = "machine-client-id";
const KID = "cognito-key-1";

const pool = generateKeyPairSync("rsa", { modulusLength: 2048 });
const nightshift = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** The pool's JWKS, as Cognito publishes it. */
const jwksOf = (key: KeyObject, kid: string): JwksFetch => {
  const jwk = key.export({ format: "jwk" });
  return async () => ({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
};

let jwksFetches = 0;
const countingJwks: JwksFetch = async (url) => {
  jwksFetches += 1;
  return jwksOf(pool.publicKey, KID)(url);
};

const cognitoTokenFor = (
  claims: Record<string, unknown>,
  options: { readonly key?: KeyObject; readonly kid?: string; readonly alg?: string } = {},
): string => {
  const prefix = `${encodeSegment({ alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? KID })}.${encodeSegment(
    {
      iss: COGNITO_ISSUER,
      exp: Math.floor(NOW / 1000) + 3600,
      iat: Math.floor(NOW / 1000),
      token_use: "id",
      ...claims,
    },
  )}`;
  const signature = signWith(
    "sha256",
    Buffer.from(prefix, "ascii"),
    options.key ?? pool.privateKey,
  );
  return `${prefix}.${signature.toString("base64url")}`;
};

const f = createFixtures();
const root = makeRootNode(f);
const node = makeNode(f, root.executionNodeId);
const world = {
  run: makeRun(f, { rootNodeId: root.executionNodeId }),
  program: makeProgramContract(f),
  node,
  agent: makeAgent(f, node.executionNodeId, { status: "started" }),
};

const executionTokenFrom = (privateKey: KeyObject, issuer = EXECUTION_ISSUER) =>
  mintExecutionToken(
    { sign: async (input) => signWith("sha256", input, privateKey) },
    { ...world, issuer, now: NOW },
  );

const nightshiftPublicKey = publicKeyFromSpki(
  nightshift.publicKey.export({ format: "der", type: "spki" }),
);

const authorizer = createAuthorizer({
  cognito: createCognitoVerifier({
    issuer: COGNITO_ISSUER,
    audiences: [INTERACTIVE_CLIENT, MACHINE_CLIENT],
    now: () => NOW,
    fetchJwks: countingJwks,
  }),
  executionIssuer: EXECUTION_ISSUER,
  executionKey: async () => nightshiftPublicKey,
  now: () => NOW,
});

const eventWith = (authorization?: string): APIGatewayRequestAuthorizerEventV2 =>
  ({
    headers: authorization === undefined ? {} : { authorization },
  }) as unknown as APIGatewayRequestAuthorizerEventV2;

const principalOf = (result: { context: { principal?: string } }): unknown =>
  JSON.parse(result.context.principal ?? "null");

describe("bearerTokenFrom", () => {
  it("reads the header whatever its case, and nothing that is not a bearer", () => {
    expect(bearerTokenFrom({ Authorization: "Bearer abc" })).toBe("abc");
    expect(bearerTokenFrom({ authorization: "bearer abc" })).toBe("abc");
    expect(bearerTokenFrom({ authorization: "  Bearer   abc  " })).toBe("abc");
    for (const value of ["abc", "Basic abc", "Bearer", "Bearer a b", ""]) {
      expect(bearerTokenFrom({ authorization: value })).toBeUndefined();
    }
    expect(bearerTokenFrom(undefined)).toBeUndefined();
  });
});

describe("a Cognito token", () => {
  it("becomes a user token, with the org claim when there is one", async () => {
    const orgId = f.ids.next("org");
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor({
          sub: "58819310-5081-70f2-81fe-66601586db46",
          aud: INTERACTIVE_CLIENT,
          "custom:active_org": orgId,
        })}`,
      ),
    );
    expect(result.isAuthorized).toBe(true);
    expect(principalOf(result)).toEqual({
      kind: "user",
      userId: "58819310-5081-70f2-81fe-66601586db46",
      activeOrg: orgId,
    });
  });

  it("accepts a machine caller's access token, whose audience is `client_id`", async () => {
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor({
          sub: MACHINE_CLIENT,
          client_id: MACHINE_CLIENT,
          token_use: "access",
        })}`,
      ),
    );
    expect(result.isAuthorized).toBe(true);
    expect(principalOf(result)).toEqual({ kind: "user", userId: MACHINE_CLIENT });
  });

  it("refuses a token for the wrong audience, however well signed", async () => {
    const result = await authorizer(
      eventWith(`Bearer ${cognitoTokenFor({ sub: "someone", aud: "some-other-app" })}`),
    );
    expect(result.isAuthorized).toBe(false);
  });

  it("refuses a token signed by a key the pool never published", async () => {
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor(
          { sub: "someone", aud: INTERACTIVE_CLIENT },
          { key: attacker.privateKey },
        )}`,
      ),
    );
    expect(result.isAuthorized).toBe(false);
  });

  it("refuses a token naming a `kid` the JWKS does not list", async () => {
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor({ sub: "someone", aud: INTERACTIVE_CLIENT }, { kid: "nope" })}`,
      ),
    );
    expect(result.isAuthorized).toBe(false);
  });

  it("refuses an algorithm it does not expect, before it fetches anything", async () => {
    const before = jwksFetches;
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor({ sub: "someone", aud: INTERACTIVE_CLIENT }, { alg: "none" })}`,
      ),
    );
    expect(result.isAuthorized).toBe(false);
    expect(jwksFetches).toBe(before);
  });

  it("refuses an expired token", async () => {
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor({
          sub: "someone",
          aud: INTERACTIVE_CLIENT,
          exp: Math.floor(NOW / 1000) - 60,
        })}`,
      ),
    );
    expect(result.isAuthorized).toBe(false);
  });

  it("refuses a token from another pool", async () => {
    const result = await authorizer(
      eventWith(
        `Bearer ${cognitoTokenFor({
          sub: "someone",
          aud: INTERACTIVE_CLIENT,
          iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OtherPool",
        })}`,
      ),
    );
    expect(result.isAuthorized).toBe(false);
  });

  it("caches the JWKS per instance, and refetches only for an unknown kid", async () => {
    const verifier = createCognitoVerifier({
      issuer: COGNITO_ISSUER,
      audiences: [INTERACTIVE_CLIENT],
      now: () => NOW,
      fetchJwks: countingJwks,
    });
    const token = cognitoTokenFor({ sub: "someone", aud: INTERACTIVE_CLIENT });
    const before = jwksFetches;
    for (let i = 0; i < 5; i += 1) expect(await verifier.verify(token)).toBeDefined();
    expect(jwksFetches).toBe(before + 1);

    // A `kid` nobody has seen is what a pool key rotation looks like from here.
    await verifier.verify(
      cognitoTokenFor({ sub: "someone", aud: INTERACTIVE_CLIENT }, { kid: "new" }),
    );
    expect(jwksFetches).toBe(before + 2);
  });
});

describe("an execution token", () => {
  it("becomes the execution principal it carries", async () => {
    const minted = await executionTokenFrom(nightshift.privateKey);
    const result = await authorizer(eventWith(`Bearer ${minted.token}`));
    expect(result.isAuthorized).toBe(true);
    expect(principalOf(result)).toEqual({
      kind: "execution",
      projectId: world.agent.projectId,
      programId: world.agent.programId,
      runId: world.agent.runId,
      nodeId: world.node.executionNodeId,
      agentId: world.agent.agentId,
      role: "worker",
    });
  });

  it("refuses one signed by another key", async () => {
    const minted = await executionTokenFrom(attacker.privateKey);
    expect((await authorizer(eventWith(`Bearer ${minted.token}`))).isAuthorized).toBe(false);
  });

  /**
   * The right signature and the wrong issuer: a token this key really did sign,
   * for another stage's API. Accepting it would make one key serve every stage.
   */
  it("refuses one with the right signature and the wrong issuer", async () => {
    const minted = await executionTokenFrom(
      nightshift.privateKey,
      "https://api.prod.nightshift.wildorder.dev",
    );
    expect((await authorizer(eventWith(`Bearer ${minted.token}`))).isAuthorized).toBe(false);
  });

  it("refuses an expired one", async () => {
    const expiring = createAuthorizer({
      cognito: createCognitoVerifier({
        issuer: COGNITO_ISSUER,
        audiences: [INTERACTIVE_CLIENT],
        now: () => NOW,
        fetchJwks: countingJwks,
      }),
      executionIssuer: EXECUTION_ISSUER,
      executionKey: async () => nightshiftPublicKey,
      // Nine hours later: past the eight-hour ceiling, whatever the program said.
      now: () => NOW + 9 * 60 * 60 * 1000,
    });
    const minted = await executionTokenFrom(nightshift.privateKey);
    expect((await expiring(eventWith(`Bearer ${minted.token}`))).isAuthorized).toBe(false);
  });

  it("never reaches the Cognito verifier: its audience is Nightshift's own", async () => {
    const minted = await executionTokenFrom(nightshift.privateKey);
    const before = jwksFetches;
    expect((await authorizer(eventWith(`Bearer ${minted.token}`))).isAuthorized).toBe(true);
    expect(jwksFetches).toBe(before);
    expect(EXECUTION_TOKEN_AUDIENCE).toBe("nightshift-api");
  });
});

describe("anything else", () => {
  it("refuses a request with no Authorization header at all", async () => {
    expect((await authorizer(eventWith())).isAuthorized).toBe(false);
  });

  it("refuses rubbish, and carries no context when it does", async () => {
    for (const value of ["Bearer x", "Bearer a.b.c", "Bearer ...", "Basic dXNlcjpwYXNz"]) {
      const result = await authorizer(eventWith(value));
      expect(result.isAuthorized).toBe(false);
      expect(result.context).toEqual({});
    }
  });

  it("puts a token in no allowed result's context but the principal", async () => {
    const orgId = f.ids.next("org");
    const token = cognitoTokenFor({
      sub: "58819310-5081-70f2-81fe-66601586db46",
      aud: INTERACTIVE_CLIENT,
      "custom:active_org": orgId,
    });
    const result = await authorizer(eventWith(`Bearer ${token}`));
    expect(Object.keys(result.context)).toEqual(["principal"]);
    expect(JSON.stringify(result.context)).not.toContain(token);
  });
});

/** Referenced so the import is not merely decorative; the key is a real private key. */
describe("the fixtures themselves", () => {
  it("uses genuine RSA keys", () => {
    expect(
      createPrivateKey(nightshift.privateKey.export({ format: "pem", type: "pkcs8" })).type,
    ).toBe("private");
  });
});
