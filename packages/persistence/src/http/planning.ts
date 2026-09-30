/**
 * Planning through the control plane (P7; D-P7-02, D-P7-05, D-P7-10).
 *
 * Ratifying is three steps, and the order is the point, as it is for an artifact
 * body: sign an upload, `PUT` the plan document, and only then ask for the
 * ratification, which the control plane checks against the bytes **it** holds. If
 * the upload fails nothing is ratified, because nothing was asked for yet.
 *
 * What is uploaded is the plan with LF line endings, the text `planHash` hashes,
 * so a Windows checkout and a Linux one ratify the same document.
 */
import { createHash } from "node:crypto";
import {
  type PlanDocumentResponse,
  PlanDocumentResponseSchema,
  PlanDocumentUploadResponseSchema,
  type Prerequisite,
  PrerequisiteListResponseSchema,
  PrerequisiteSchema,
  type ProgramContract,
  ProgramContractSchema,
  type RunId,
} from "@nightshift/contracts";
import { normalizePlanText, type ProgramScope, planHash } from "@nightshift/core";
import type { UploadFetch } from "./artifact-bodies.js";
import { ControlPlaneError } from "./errors.js";
import { routes } from "./routes.js";
import { send, type Transport } from "./transport.js";

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

export interface DiscoveredPrerequisite {
  readonly runId: RunId;
  readonly description: string;
  readonly remediation: string;
  readonly verifyCommand: string;
}

export interface PlanningClient {
  /**
   * Uploads the plan document, and the kept conversation when there is one
   * (P14, D-P14-06), then ratifies. Returns the contract as the control plane
   * recorded it.
   */
  ratify(
    contract: ProgramContract,
    planText: string,
    conversationText?: string,
  ): Promise<ProgramContract>;
  /** The ratified document, by its hash. `undefined` when the control plane holds none. */
  planDocument(scope: ProgramScope, sha256: string): Promise<PlanDocumentResponse | undefined>;
  prerequisites(scope: ProgramScope): Promise<readonly Prerequisite[]>;
  /** The preflight's only word: the exit code of the `verifyCommand` it ran. */
  recordCheck(scope: ProgramScope, prerequisiteId: string, exitCode: number): Promise<Prerequisite>;
  recordDiscovered(
    scope: ProgramScope,
    prerequisiteId: string,
    hurdle: DiscoveredPrerequisite,
  ): Promise<Prerequisite>;
}

export interface HttpPlanningOptions {
  readonly transport: Transport;
  readonly fetch?: UploadFetch;
}

export const createHttpPlanning = (options: HttpPlanningOptions): PlanningClient => {
  const upload = options.fetch ?? (globalThis.fetch as unknown as UploadFetch);
  const { transport } = options;

  /**
   * One document into the program's plan-document store, named by its own
   * SHA-256 (D-P7-02). The conversation is stored the same way: it is a
   * document of the plan's, only outside its hash.
   */
  const store = async (
    scope: ProgramScope,
    what: string,
    text: string,
    sha256: string,
  ): Promise<void> => {
    const bytes = new TextEncoder().encode(text);
    const target = PlanDocumentUploadResponseSchema.parse(
      await send(
        transport,
        {
          method: "POST",
          path: routes.planDocumentUploadUrl(scope, sha256),
          body: { sizeBytes: bytes.length },
        },
        [200],
      ),
    );
    const response = await upload(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": target.contentType, "content-length": String(bytes.length) },
      body: bytes,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ControlPlaneError(
        response.status,
        "plan_upload_failed",
        `the signed upload of the ${what} answered ${response.status}, so nothing was ratified: ${(
          await response.text()
        ).slice(0, 500)}`,
      );
    }
  };

  return {
    ratify: async (contract, planText, conversationText) => {
      const scope = { projectId: contract.projectId, programId: contract.programId };
      const hash = planHash(contract, planText, sha256Hex);
      await store(scope, "plan document", normalizePlanText(planText), hash.plan);
      const conversation =
        conversationText === undefined ? undefined : normalizePlanText(conversationText);
      const conversationSha256 = conversation === undefined ? undefined : sha256Hex(conversation);
      if (conversation !== undefined && conversationSha256 !== undefined) {
        await store(scope, "planning conversation", conversation, conversationSha256);
      }

      return ProgramContractSchema.parse(
        await send(transport, {
          method: "POST",
          path: routes.ratifications(scope),
          body: {
            contract,
            planHash: hash.hash,
            planSha256: hash.plan,
            ...(conversationSha256 === undefined ? {} : { conversationSha256 }),
          },
        }),
      );
    },

    planDocument: async (scope, sha256) => {
      const response = await transport({ method: "GET", path: routes.planDocument(scope, sha256) });
      if (response.status === 404) return undefined;
      if (response.status !== 200) {
        throw new ControlPlaneError(
          response.status,
          "plan_document_unreadable",
          `reading plan document ${sha256} answered ${response.status}`,
        );
      }
      return PlanDocumentResponseSchema.parse(response.body);
    },

    prerequisites: async (scope) =>
      PrerequisiteListResponseSchema.parse(
        await send(transport, { method: "GET", path: routes.prerequisites(scope) }, [200]),
      ).items,

    recordCheck: async (scope, prerequisiteId, exitCode) =>
      PrerequisiteSchema.parse(
        await send(transport, {
          method: "PUT",
          path: routes.prerequisite(scope, prerequisiteId),
          body: { kind: "check", exitCode },
        }),
      ),

    recordDiscovered: async (scope, prerequisiteId, hurdle) =>
      PrerequisiteSchema.parse(
        await send(transport, {
          method: "PUT",
          path: routes.prerequisite(scope, prerequisiteId),
          body: { kind: "discovered", ...hurdle },
        }),
      ),
  };
};
