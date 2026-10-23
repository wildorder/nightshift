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
  type CheckDispatch,
  type PlanDocumentResponse,
  PlanDocumentResponseSchema,
  PlanDocumentUploadResponseSchema,
  type PlanDraft,
  PlanDraftSchema,
  type PlanDraftVersion,
  type PlanDraftVersionResponse,
  PlanDraftVersionResponseSchema,
  PlanDraftVersionSchema,
  type Prerequisite,
  PrerequisiteListResponseSchema,
  PrerequisiteSchema,
  type ProgramContract,
  ProgramContractSchema,
  pageResponseSchema,
  type RunId,
} from "@nightshift/contracts";
import { normalizePlanText, type ProgramScope, planHash } from "@nightshift/core";
import type { UploadFetch } from "./artifact-bodies.js";
import { ControlPlaneError, toThrowable } from "./errors.js";
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

/** The documents of a draft version, as text; the client uploads them and names them by hash. */
export interface DraftDocuments {
  /** The contract, or its JSON text as the writer holds it (kept byte for byte). */
  readonly contract: ProgramContract | string;
  readonly planText: string;
  readonly conversationText?: string;
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
  /**
   * Puts the next version of the program's draft (P21): uploads the documents
   * first, then puts. `basedOn` is the latest version the writer saw, `null` for
   * the first; a stale one is refused (409). The author is the caller's.
   */
  putVersion(
    scope: ProgramScope,
    documents: DraftDocuments,
    basedOn: number | null,
  ): Promise<PlanDraftVersionResponse>;
  /** The draft record; `undefined` when the program has none. */
  getDraft(scope: ProgramScope): Promise<PlanDraft | undefined>;
  /** Version `version`, or the latest, with the plane's check of its stored documents. */
  getVersion(scope: ProgramScope, version?: number): Promise<PlanDraftVersionResponse | undefined>;
  listVersions(scope: ProgramScope): Promise<readonly PlanDraftVersion[]>;
  /** Answers one decision on the latest version; the plane makes the new version. */
  answerDecision(
    scope: ProgramScope,
    answer: { decisionId: string; answer: string; rationale?: string; basedOn?: number },
  ): Promise<PlanDraftVersionResponse>;
  requestChanges(scope: ProgramScope, version: number, note: string): Promise<PlanDraft>;
  markAwaitingOwner(scope: ProgramScope, version: number, note?: string): Promise<PlanDraft>;
  decline(scope: ProgramScope, version: number, note?: string): Promise<PlanDraft>;
  /** Ratifies the latest version by its plan hash: the plane ratifies the documents it holds. */
  ratifyVersion(scope: ProgramScope, planHash: string): Promise<ProgramContract>;
  /** The ratified document, by its hash. `undefined` when the control plane holds none. */
  planDocument(scope: ProgramScope, sha256: string): Promise<PlanDocumentResponse | undefined>;
  prerequisites(scope: ProgramScope): Promise<readonly Prerequisite[]>;
  /** The preflight's only word: the exit code of the `verifyCommand` it ran, on the laptop. */
  recordCheck(scope: ProgramScope, prerequisiteId: string, exitCode: number): Promise<Prerequisite>;
  /**
   * A run's machine's check, under the dispatch it ran under (P16, D-08): kept
   * apart from the laptop's, and never moving `status`.
   */
  recordMachineCheck(
    scope: ProgramScope,
    prerequisiteId: string,
    exitCode: number,
    dispatch: CheckDispatch,
  ): Promise<Prerequisite>;
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

  /** A 200's body; any other status is the typed failure. */
  const ok = (response: { status: number; body: unknown }): unknown => {
    if (response.status !== 200) throw toThrowable(response.status, response.body);
    return response.body;
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

    putVersion: async (scope, documents, basedOn) => {
      const contract =
        typeof documents.contract === "string"
          ? documents.contract
          : `${JSON.stringify(documents.contract, null, 2)}\n`;
      const plan = normalizePlanText(documents.planText);
      const conversation =
        documents.conversationText === undefined
          ? undefined
          : normalizePlanText(documents.conversationText);
      const contractSha256 = sha256Hex(contract);
      const planSha256 = sha256Hex(plan);
      await store(scope, "contract", contract, contractSha256);
      await store(scope, "plan document", plan, planSha256);
      const conversationSha256 = conversation === undefined ? undefined : sha256Hex(conversation);
      if (conversation !== undefined && conversationSha256 !== undefined) {
        await store(scope, "planning conversation", conversation, conversationSha256);
      }
      return PlanDraftVersionResponseSchema.parse(
        await send(
          transport,
          {
            method: "POST",
            path: routes.planDraftVersions(scope),
            body: {
              contractSha256,
              planSha256,
              ...(conversationSha256 === undefined ? {} : { conversationSha256 }),
              basedOn,
            },
          },
          [201],
        ),
      );
    },

    getDraft: async (scope) => {
      const response = await transport({ method: "GET", path: routes.planDraft(scope) });
      if (response.status === 404) return undefined;
      return PlanDraftSchema.parse(await ok(response));
    },

    getVersion: async (scope, version) => {
      const response = await transport({
        method: "GET",
        path:
          version === undefined
            ? routes.planDraftLatest(scope)
            : routes.planDraftVersion(scope, version),
      });
      if (response.status === 404) return undefined;
      return PlanDraftVersionResponseSchema.parse(await ok(response));
    },

    listVersions: async (scope) => {
      const items: PlanDraftVersion[] = [];
      let cursor: string | undefined;
      do {
        const page = pageResponseSchema(PlanDraftVersionSchema).parse(
          await send(transport, {
            method: "GET",
            path: routes.planDraftVersions(scope),
            query: cursor === undefined ? {} : { cursor },
          }),
        );
        items.push(...page.items);
        cursor = page.cursor;
      } while (cursor !== undefined);
      return items;
    },

    answerDecision: async (scope, answer) =>
      PlanDraftVersionResponseSchema.parse(
        await send(
          transport,
          { method: "POST", path: routes.planDraftAnswers(scope), body: answer },
          [201],
        ),
      ),

    requestChanges: async (scope, version, note) =>
      PlanDraftSchema.parse(
        await send(transport, {
          method: "POST",
          path: routes.planDraftChangeRequests(scope),
          body: { version, note },
        }),
      ),

    markAwaitingOwner: async (scope, version, note) =>
      PlanDraftSchema.parse(
        await send(transport, {
          method: "POST",
          path: routes.planDraftAwaitingOwner(scope),
          body: { version, ...(note === undefined ? {} : { note }) },
        }),
      ),

    decline: async (scope, version, note) =>
      PlanDraftSchema.parse(
        await send(transport, {
          method: "POST",
          path: routes.planDraftDecline(scope),
          body: { version, ...(note === undefined ? {} : { note }) },
        }),
      ),

    ratifyVersion: async (scope, planHash) =>
      ProgramContractSchema.parse(
        await send(transport, {
          method: "POST",
          path: routes.ratifications(scope),
          body: { planHash },
        }),
      ),

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
          body: { kind: "check", exitCode, where: "laptop" },
        }),
      ),

    recordMachineCheck: async (scope, prerequisiteId, exitCode, dispatch) =>
      PrerequisiteSchema.parse(
        await send(transport, {
          method: "PUT",
          path: routes.prerequisite(scope, prerequisiteId),
          body: { kind: "check", exitCode, where: "machine", dispatch },
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
