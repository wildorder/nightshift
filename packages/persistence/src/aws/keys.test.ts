import { createFixtures, nextUserId } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { artifactPrefix, keys } from "./keys.js";

const f = createFixtures();
const { projectId: p, programId: g, runId: r } = f.scope;
const org = f.ids.next("org");

describe("key schema matches contract §4.1 and §4.2", () => {
  it.each([
    ["project", keys.project(p), `PROJ#${p}`, "META"],
    ["org pointer", keys.orgProject(org, p), `ORG#${org}`, `PROJ#${p}`],
    ["program contract", keys.programContract(p, g), `PROJ#${p}`, `PROG#${g}`],
    ["run", keys.run(f.scope, r), `PROJ#${p}#PROG#${g}`, `RUN#${r}`],
    [
      "execution node",
      keys.runRecord(f.scope, "NODE", "node_X"),
      `RUN#${p}#${g}#${r}`,
      "NODE#node_X",
    ],
    ["artifact", keys.runRecord(f.scope, "ART", "art_X"), `RUN#${p}#${g}#${r}`, "ART#art_X"],
    ["event", keys.event(f.scope, "evt_X"), `EVT#${p}#${g}#${r}`, "ULID#evt_X"],
    ["counter", keys.counter(f.scope), `EVT#${p}#${g}#${r}`, "COUNTER"],
    ["idempotency marker", keys.idempotency(f.scope, "k#1"), `EVT#${p}#${g}#${r}`, "IDEM#k#1"],
  ])("%s", (_name, key, pk, sk) => {
    expect(key).toEqual({ PK: pk, SK: sk });
  });

  it("indexes a child node under its parent, and a record under its own node", () => {
    expect(keys.nodeIndex(f.scope, "node_P", "CHILD", "node_C")).toEqual({
      GSI1PK: `NODE#${p}#${g}#${r}#node_P`,
      GSI1SK: "CHILD#node_C",
    });
    expect(keys.nodeIndex(f.scope, "node_N", "VER", "ver_X").GSI1SK).toBe("VER#ver_X");
  });

  it("places identity above every project, the one D-P2-17 exception", () => {
    const user = nextUserId(f);
    expect(keys.user(user)).toEqual({ PK: `USER#${user}`, SK: "META" });
    expect(keys.membership(user, org)).toEqual({ PK: `USER#${user}`, SK: `MEMBER#${org}` });
  });

  it("begins every project-owned partition with the project (D-P2-03)", () => {
    const projectOwned = [
      keys.project(p),
      keys.programContract(p, g),
      keys.run(f.scope, r),
      keys.runRecord(f.scope, "DEC", "dec_X"),
      keys.event(f.scope, "evt_X"),
      keys.counter(f.scope),
      keys.idempotency(f.scope, "k"),
    ];
    for (const key of projectOwned) {
      expect(key.PK.split("#")[1]).toBe(p);
    }
  });

  it("prefixes artifact objects with the full ownership chain (D-P2-08)", () => {
    expect(artifactPrefix(f.scope)).toBe(`${p}/${g}/${r}/`);
  });
});
