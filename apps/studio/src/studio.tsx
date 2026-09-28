/**
 * What every page is given (D-P11-07): the store ports, and who is signed in.
 *
 * Pages take `ProjectStores` from this context and nothing else, which is what
 * lets a test mount them over `@nightshift/persistence/memory` with no browser
 * session and no network: the same pages, the same records.
 */
import type { OrgId } from "@nightshift/contracts";
import type { ProjectStores } from "@nightshift/core";
import { createContext, useContext } from "react";
import type { Identity } from "./auth/session.js";

export interface Studio {
  readonly stores: ProjectStores;
  readonly identity: Identity;
  /**
   * The organisation the session acts for, once known. The API has no identity
   * route: `GET /projects` lists the acting org and only it, so the org of any
   * project it answered *is* the acting org (as `nightshift whoami` reasons);
   * with no projects yet, the claim is the next best word.
   */
  readonly orgId: OrgId | undefined;
  readonly signOut: () => Promise<void>;
}

const StudioContext = createContext<Studio | undefined>(undefined);

export const StudioProvider = StudioContext.Provider;

export const useStudio = (): Studio => {
  const studio = useContext(StudioContext);
  if (studio === undefined) throw new Error("useStudio outside a StudioProvider");
  return studio;
};
