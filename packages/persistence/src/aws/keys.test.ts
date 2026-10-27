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
    ["gate health", keys.gateHealth(p), `PROJ#${p}`, "GATE-HEALTH"],
    ["plan draft", keys.planDraft(p, g), `PROJ#${p}`, `PLANDRAFT#${g}`],
    [
      "plan draft version",
      keys.planDraftVersion(p, g, 12),
      `PROJ#${p}#PROG#${g}`,
      "PLANDRAFTV#0000000012",
    ],
    ["run feedback", keys.feedback(f.scope), `PROJ#${p}#PROG#${g}`, `FEEDBACK#${r}`],
    ["completion history", keys.completionHistory(p, "comp_X"), `PROJ#${p}`, "COMPLETION#comp_X"],
    ["line", keys.line(p, "nightshift/develop"), `PROJ#${p}`, "LINE#nightshift/develop"],
    [
      "line dispatch",
      keys.lineDispatch(p, "nightshift/develop"),
      `PROJ#${p}`,
      "LINEDISPATCH#nightshift/develop",
    ],
    [
      "project self-started usage",
      keys.projectSelfStartedUsage(p, "2026-01"),
      `PROJ#${p}`,
      "SELFSTARTED#2026-01",
    ],
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
      keys.planDraft(p, g),
      keys.planDraftVersion(p, g, 1),
      keys.run(f.scope, r),
      keys.feedback(f.scope),
      keys.completionHistory(p, "comp_X"),
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

describe("the line indexes on the node GSI", () => {
  it("places a line with work in one partition, ordered by project and branch", () => {
    expect(keys.lineWorkIndex(p, "line/x")).toEqual({
      GSI1PK: keys.lineWorkIndexPartition().GSI1PK,
      GSI1SK: `${p}#line/x`,
    });
  });

  it("places a line dispatch under its status, oldest update first", () => {
    expect(keys.lineDispatchIndex("running", "2026-01-01T00:00:00.000Z", p, "line/x")).toEqual({
      GSI1PK: "LINEDISPATCH#running",
      GSI1SK: `2026-01-01T00:00:00.000Z#${p}#line/x`,
    });
    expect(keys.lineDispatchIndexPartition("running").GSI1PK).toBe("LINEDISPATCH#running");
  });
});
