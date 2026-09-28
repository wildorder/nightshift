/**
 * Mounting the Studio over the memory stores (D-P11-07): what every page test
 * starts from. Nothing here opens a socket or reads a browser session.
 */
import type { OrgId } from "@nightshift/contracts";
import { createFixtures, type Fixtures } from "@nightshift/core";
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

export const mountStudio = async (
  seed: (stores: InMemoryStores, f: Fixtures, orgId: OrgId) => Promise<void>,
  at = "/",
): Promise<Mounted> => {
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
  };
  render(
    <MemoryRouter initialEntries={[at]}>
      <App studio={studio} client={client} />
    </MemoryRouter>,
  );
  return { stores, f, orgId, signedOut, client };
};
