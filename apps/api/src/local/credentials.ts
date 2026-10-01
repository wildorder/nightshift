/**
 * The local instance's two secrets (P12, D-P12-03): the operator's bearer token
 * and the key execution tokens are signed with. Both are made on first start,
 * written owner-only, and read back on every start after, so a worker's token
 * survives a restart within its lifetime.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The issuer a loopback plane's execution tokens carry. Never a real stage's. */
export const LOCAL_TOKEN_ISSUER = "https://api.local.nightshift.invalid";

export interface SigningKeys {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

const writeOwnerOnly = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  // `mode` applies only on create; a file made earlier by something else is tightened.
  // A no-op on Windows, as the CLI's credentials file is.
  chmodSync(path, 0o600);
};

export const tokenPath = (stateDir: string): string => join(stateDir, "token");
export const keyPath = (stateDir: string): string => join(stateDir, "signing-key.pem");

/** The operator's bearer: 32 random bytes, base64url, made once. */
export const loadOrCreateSecret = (path: string): string => {
  if (existsSync(path)) {
    const secret = readFileSync(path, "utf8").trim();
    if (secret.length >= 32) return secret;
  }
  const secret = randomBytes(32).toString("base64url");
  writeOwnerOnly(path, `${secret}\n`);
  return secret;
};

/** The RS256 key execution tokens are signed with, as KMS holds one in AWS. */
export const loadOrCreateKeys = (path: string): SigningKeys => {
  if (existsSync(path)) {
    const privateKey = createPrivateKey(readFileSync(path, "utf8"));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeOwnerOnly(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return { privateKey, publicKey };
};

/** A key for this process only: the harness's, which no restart needs. */
export const ephemeralKeys = (): SigningKeys => generateKeyPairSync("rsa", { modulusLength: 2048 });

export const masterKeyPath = (stateDir: string): string => join(stateDir, "credentials.key");

/**
 * The master key an org's provider keys are sealed under in the local instance
 * (P10, D-P10-23): 32 bytes, base64, owner-only, beside the database, as the
 * token key is. KMS holds the equivalent in AWS.
 */
export const loadOrCreateMasterKey = (path: string): Uint8Array => {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.byteLength === 32) return key;
  }
  const key = randomBytes(32);
  writeOwnerOnly(path, `${key.toString("base64")}\n`);
  return key;
};
