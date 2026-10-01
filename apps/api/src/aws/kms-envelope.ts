/**
 * The envelope's data keys from KMS (P10, D-P10-23).
 *
 * `GenerateDataKey` under `CredentialsKey` with the org and the provider as the
 * encryption context, and `Decrypt` with the same context to unwrap. The key
 * policy grants both to the API function alone, and only with a context that
 * names an org, so the Lambda can read a credential and nothing else can.
 */
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import type { Envelope } from "@nightshift/core";
import { createEnvelope, type DataKeyWrapper, type EncryptionContext } from "../envelope.js";

export interface KmsEnvelopeOptions {
  readonly kms: KMSClient;
  /** The symmetric key's id, alias or ARN. The stack passes the ARN. */
  readonly keyId: string;
}

const contextOf = (context: EncryptionContext): Record<string, string> => ({
  orgId: context.orgId,
  provider: context.provider,
});

export const createKmsDataKeyWrapper = ({ kms, keyId }: KmsEnvelopeOptions): DataKeyWrapper => ({
  generate: async (context) => {
    const response = await kms.send(
      new GenerateDataKeyCommand({
        KeyId: keyId,
        KeySpec: "AES_256",
        EncryptionContext: contextOf(context),
      }),
    );
    if (response.Plaintext === undefined || response.CiphertextBlob === undefined) {
      throw new Error(`KMS returned no data key for ${keyId}`);
    }
    return { plaintextKey: response.Plaintext, wrappedKey: response.CiphertextBlob };
  },
  unwrap: async (context, wrappedKey) => {
    const response = await kms.send(
      new DecryptCommand({
        KeyId: keyId,
        CiphertextBlob: wrappedKey,
        EncryptionContext: contextOf(context),
      }),
    );
    if (response.Plaintext === undefined) {
      throw new Error(`KMS could not unwrap a data key under ${keyId}`);
    }
    return response.Plaintext;
  },
});

export const createKmsEnvelope = (options: KmsEnvelopeOptions): Envelope =>
  createEnvelope(createKmsDataKeyWrapper(options));
