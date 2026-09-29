import { describe, expect, it } from "vitest";
import { forgetLocalToken, LOCAL_TOKEN_KEY, takeLocalToken } from "./token-session.js";

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
};

describe("the local token session (D-P12-04)", () => {
  it("takes the token from the fragment once, keeps it for the tab, and strips it from the URL", () => {
    const tab = storage();
    const replaced: string[] = [];
    const token = takeLocalToken(
      { hash: "#token=secret", pathname: "/projects/p", search: "?x=1" },
      tab,
      (url) => void replaced.push(url),
    );
    expect(token).toBe("secret");
    expect(replaced).toEqual(["/projects/p?x=1"]);
    expect(tab.map.get(LOCAL_TOKEN_KEY)).toBe("secret");
    // A reload has no fragment: the tab remembers.
    expect(takeLocalToken({ hash: "", pathname: "/", search: "" }, tab, () => {})).toBe("secret");
  });

  it("has nothing without a fragment or a remembered token, and forgets on sign-out", () => {
    const tab = storage();
    expect(takeLocalToken({ hash: "", pathname: "/", search: "" }, tab, () => {})).toBeUndefined();
    tab.setItem(LOCAL_TOKEN_KEY, "s");
    forgetLocalToken(tab);
    expect(takeLocalToken({ hash: "", pathname: "/", search: "" }, tab, () => {})).toBeUndefined();
  });
});
