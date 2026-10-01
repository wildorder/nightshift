/**
 * Envelope encryption for an org's secrets (P10, D-P10-23).
 *
 * One data key per secret, AES-256-GCM over the plaintext, and the data key
 * itself wrapped by a master key the caller supplies: KMS in the Lambda
 * (`aws/kms-envelope.ts`), a key file beside the database in the local instance
 * (`local/envelope.ts`). The context (org, provider) is bound into the GCM
 * additional data as well as into the wrap, so a ciphertext moved to another
 * org's row fails at both layers.
 *
 * Nothing here is provider-specific: the two implementations differ only in
 * how a data key is made and unwrapped.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { OrgId, Provider } from "@nightshift/contracts";
import type { Envelope, Sealed } from "@nightshift/core";

/** How a data key is generated and later unwrapped, under one context. */
export interface DataKeyWrapper {
  generate(
    context: EncryptionContext,
  ): Promise<{ plaintextKey: Uint8Array; wrappedKey: Uint8Array }>;
  unwrap(context: EncryptionContext, wrappedKey: Uint8Array): Promise<Uint8Array>;
}

export interface EncryptionContext {
  readonly orgId: string;
  readonly provider: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

const additionalData = (context: EncryptionContext): Buffer =>
  Buffer.from(`nightshift-credential-v1\n${context.orgId}\n${context.provider}`, "utf8");

export const createEnvelope = (wrapper: DataKeyWrapper): Envelope => ({
  seal: async (orgId: OrgId, provider: Provider, plaintext: string): Promise<Sealed> => {
    const context = { orgId, provider };
    const { plaintextKey, wrappedKey } = await wrapper.generate(context);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", plaintextKey, iv);
    cipher.setAAD(additionalData(context));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, body]).toString("base64"),
      wrappedKey: Buffer.from(wrappedKey).toString("base64"),
    };
  },
  open: async (orgId: OrgId, provider: Provider, sealed: Sealed): Promise<string> => {
    const context = { orgId, provider };
    const plaintextKey = await wrapper.unwrap(context, Buffer.from(sealed.wrappedKey, "base64"));
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    const iv = bytes.subarray(0, IV_BYTES);
    const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = bytes.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", plaintextKey, iv);
    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  },
});

/**
 * A wrapper over one in-process master key: the local instance's (a key file
 * beside the database, D-P10-23) and the offline suites'. The data key is
 * wrapped by AES-256-GCM under the master key with the context as additional
 * data, which is what KMS does with an encryption context.
 */
export const createLocalDataKeyWrapper = (masterKey: Uint8Array): DataKeyWrapper => {
  if (masterKey.byteLength !== 32) {
    throw new Error(`a master key is 32 bytes; this one is ${masterKey.byteLength}`);
  }
  return {
    generate: async (context) => {
      const plaintextKey = randomBytes(32);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
      cipher.setAAD(additionalData(context));
      const wrapped = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
      return {
        plaintextKey,
        wrappedKey: Buffer.concat([iv, cipher.getAuthTag(), wrapped]),
      };
    },
    unwrap: async (context, wrappedKey) => {
      const bytes = Buffer.from(wrappedKey);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, bytes.subarray(0, IV_BYTES));
      decipher.setAAD(additionalData(context));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
};

export const createLocalEnvelope = (masterKey: Uint8Array): Envelope =>
  createEnvelope(createLocalDataKeyWrapper(masterKey));

/** A fresh master key, for a key file's first write or a test. */
export const generateMasterKey = (): Uint8Array => randomBytes(32);
