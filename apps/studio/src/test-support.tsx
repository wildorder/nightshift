/**
 * Mounting the Studio over the memory stores (D-P11-07): what every page test
 * starts from. Nothing here opens a socket or reads a browser session.
 */
import type { OrgId } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  type Fixtures,
  type IdGenerator,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { App } from "./app.js";
import type { Studio } from "./studio.js";

export interface Mounted {
  readonly stores: InMemoryStores;
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly signedOut: boolean[];
  readonly client: QueryClient;
}

export interface MountOptions {
  /** Where to start; a function is evaluated after the seed, with its fixtures. */
  readonly at?: string | ((f: Fixtures) => string);
  readonly pollMs?: number;
  readonly artifacts?: Studio["artifacts"];
  /** The program's stored documents, by SHA-256 (P14). */
  readonly documents?: Readonly<Record<string, string>>;
  readonly ids?: IdGenerator;
  readonly now?: () => string;
}

export const mountStudio = async (
  seed: (stores: InMemoryStores, f: Fixtures, orgId: OrgId) => Promise<void>,
  options: string | MountOptions = "/",
): Promise<Mounted> => {
  const opts: MountOptions = typeof options === "string" ? { at: options } : options;
  const stores = createInMemoryStores();
  const f = createFixtures();
  const orgId = f.ids.next("org");
  await seed(stores, f, orgId);
  const signedOut: boolean[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const studio: Studio = {
    stores,
    identity: { subject: "u1", email: "tim@example.test", activeOrgClaim: undefined },
    orgId,
    signOut: async () => void signedOut.push(true),
    ids: opts.ids ?? createCountingIdGenerator(9000),
    now: opts.now ?? (() => "2026-09-28T12:00:00.000Z"),
    ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }),
    ...(opts.documents === undefined
      ? {}
      : {
          documents: {
            planDocument: async (_scope, sha256) => opts.documents?.[sha256],
          },
        }),
    ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
  };
  const at = typeof opts.at === "function" ? opts.at(f) : (opts.at ?? "/");
  render(
    <MemoryRouter initialEntries={[at]}>
      <App studio={studio} client={client} />
    </MemoryRouter>,
  );
  return { stores, f, orgId, signedOut, client };
};

/** The run page's path for a fixture world's own run. */
export const runPathOf = (f: Fixtures): string =>
  `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
