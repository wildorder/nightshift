/**
 * The Studio's session on a local instance (P12, D-P12-04).
 *
 * `nightshift local` prints `http://127.0.0.1:<port>/#token=<secret>`. The
 * fragment never reaches a server. On first load the Studio takes the secret
 * from it, keeps it in this tab's `sessionStorage` (never `localStorage`, never a
 * query string), replaces the address so the secret is not left in the bar or in
 * history, and uses it as the bearer over the same transport the hosted Studio
 * uses. There is no refresh and nothing to revoke; signing out forgets it.
 */
import type { KeyValueStorage } from "./session.js";

export const LOCAL_TOKEN_KEY = "nightshift.studio.localToken";

export interface StartLocation {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

/**
 * The bearer for this tab: from the start URL's fragment the first time (and
 * then removed from it), from `sessionStorage` after.
 */
export const takeLocalToken = (
  location: StartLocation,
  storage: KeyValueStorage,
  replaceUrl: (url: string) => void,
): string | undefined => {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  if (fromHash !== null && fromHash !== "") {
    storage.setItem(LOCAL_TOKEN_KEY, fromHash);
    replaceUrl(`${location.pathname}${location.search}`);
    return fromHash;
  }
  return storage.getItem(LOCAL_TOKEN_KEY) ?? undefined;
};

export const forgetLocalToken = (storage: KeyValueStorage): void =>
  storage.removeItem(LOCAL_TOKEN_KEY);

/** Who a local instance's operator is (D-P12-03). */
export const LOCAL_IDENTITY = {
  subject: "local-operator",
  email: "local-operator",
  activeOrgClaim: undefined,
} as const;
