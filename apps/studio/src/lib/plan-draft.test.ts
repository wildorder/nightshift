import { PrincipalSchema } from "@nightshift/contracts";
import { createFixtures, makePlanDraftVersion, makeProgramContract } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  decisionAnswers,
  type ParsedContract,
  parseContract,
  principalLabel,
  versionChanges,
} from "./plan-draft.js";

const f = createFixtures();
const alice = PrincipalSchema.parse({
  kind: "user",
  userId: "alice",
  orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
});
const bob = PrincipalSchema.parse({ ...alice, userId: "bob" });

const decision = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  question: `Question ${id}?`,
  options: ["a", "b"],
  touches: "all",
  ...extra,
});
const contractOf = (overrides: Record<string, unknown> = {}): ParsedContract =>
  parseContract(JSON.stringify(makeProgramContract(f, overrides)));
const contractAt = (overrides: Record<string, unknown> = {}) => {
  const parsed = contractOf(overrides);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.contract;
};
const version = (n: number, overrides: Record<string, unknown> = {}) =>
  makePlanDraftVersion(f, { version: n, ...overrides });

describe("parseContract", () => {
  it("parses a contract document", () => {
    expect(contractOf().ok).toBe(true);
  });
  it("says why a document is not a contract", () => {
    const bad = parseContract("{not json");
    expect(bad.ok).toBe(false);
    const wrong = parseContract('{"objective": 3}');
    expect(wrong.ok === false && wrong.reason).toContain("schemaVersion");
  });
});

describe("decisionAnswers", () => {
  it("attributes an answer to the newest answer act", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "a" })] });
    const versions = [
      version(1),
      version(2, { author: alice, act: { kind: "answer", decisionId: "D-01", answer: "b" } }),
      version(3, { author: bob, act: { kind: "answer", decisionId: "D-01", answer: "a" } }),
    ];
    const [one] = decisionAnswers(latest, versions, new Map());
    expect(one?.source).toMatchObject({ how: "answered", version: 3 });
    expect(principalLabel(one?.source?.by ?? alice)).toBe("bob");
  });

  it("attributes an answer written into the plan to the earliest version carrying it", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "a" })] });
    const versions = [
      version(1, { author: alice }),
      version(2, { author: bob }),
      version(3, { author: alice }),
    ];
    const contracts = new Map<number, ParsedContract>([
      [1, contractOf({ decisions: [decision("D-01")] })],
      [2, contractOf({ decisions: [decision("D-01", { answer: "a" })] })],
      [3, contractOf({ decisions: [decision("D-01", { answer: "a" })] })],
    ]);
    const [one] = decisionAnswers(latest, versions, contracts);
    expect(one?.source).toMatchObject({ how: "written", version: 2 });
    expect(principalLabel(one?.source?.by ?? alice)).toBe("bob");
  });

  const withAnswer = (answer?: string) =>
    contractOf({ decisions: [decision("D-01", answer === undefined ? {} : { answer })] });
  const act = (answer: string) => ({ kind: "answer", decisionId: "D-01", answer });

  it("names the writer when a later write replaces an answered value", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "b" })] });
    const versions = [version(1, { author: alice, act: act("a") }), version(2, { author: bob })];
    const contracts = new Map([
      [1, withAnswer("a")],
      [2, withAnswer("b")],
    ]);
    const [one] = decisionAnswers(latest, versions, contracts);
    expect(one?.source).toMatchObject({ how: "written", version: 2 });
    expect(principalLabel(one?.source?.by ?? alice)).toBe("bob");
  });

  it("keeps the answerer across an unrelated later write", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "a" })] });
    const versions = [version(1, { author: alice, act: act("a") }), version(2, { author: bob })];
    const contracts = new Map([
      [1, withAnswer("a")],
      [2, withAnswer("a")],
    ]);
    const [one] = decisionAnswers(latest, versions, contracts);
    expect(one?.source).toMatchObject({ how: "answered", version: 1 });
    expect(principalLabel(one?.source?.by ?? bob)).toBe("alice");
  });

  it("names the answerer when an answer act replaces a written value", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "c" })] });
    const versions = [version(1, { author: bob }), version(2, { author: alice, act: act("c") })];
    const contracts = new Map([
      [1, withAnswer("a")],
      [2, withAnswer("c")],
    ]);
    const [one] = decisionAnswers(latest, versions, contracts);
    expect(one?.source).toMatchObject({ how: "answered", version: 2 });
  });

  it("attributes a removed then re-added answer to the re-adding version", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "a" })] });
    const versions = [
      version(1, { author: alice }),
      version(2, { author: bob }),
      version(3, { author: alice }),
    ];
    const contracts = new Map([
      [1, withAnswer("a")],
      [2, withAnswer()],
      [3, withAnswer("a")],
    ]);
    const [one] = decisionAnswers(latest, versions, contracts);
    expect(one?.source).toMatchObject({ how: "written", version: 3 });
  });

  it("names nobody when the tracked answer is not the latest one", () => {
    const latest = contractAt({ decisions: [decision("D-01", { answer: "z" })] });
    const [one] = decisionAnswers(latest, [version(1, { act: act("a") })], new Map());
    expect(one?.source).toBeUndefined();
  });

  it("leaves an unanswered decision unattributed", () => {
    const latest = contractAt({ decisions: [decision("D-01")] });
    const [one] = decisionAnswers(latest, [version(1)], new Map());
    expect(one?.source).toBeUndefined();
  });
});

describe("versionChanges", () => {
  const v1 = version(1);

  it("lists stories, strands, decisions and prerequisites added, removed and changed", () => {
    const strand = {
      id: "S-01",
      name: "One",
      scope: { summary: "s", includes: ["a/**"], excludes: [] },
      acceptance: ["ok"],
      successCriteria: [],
      dependsOn: [],
      prerequisites: [],
    };
    const before = contractOf({
      strands: [strand],
      decisions: [decision("D-01"), decision("D-02")],
    });
    const after = contractOf({
      strands: [strand, { ...strand, id: "S-02", dependsOn: ["S-01"] }],
      decisions: [decision("D-01", { answer: "a" })],
      stories: [],
    });
    const v2 = version(2, {
      plan: { uri: "s3://x", sha256: "3".repeat(64), sizeBytes: 1 },
      act: { kind: "answer", decisionId: "D-01", answer: "a" },
    });
    const changes = versionChanges(v2, v1, after, before);
    expect(changes.planChanged).toBe(true);
    expect(changes.conversationChanged).toBe(false);
    if ("unparseable" in changes.contract) throw new Error("parsed");
    expect(changes.contract.strands).toEqual({ added: ["S-02"], removed: [], changed: [] });
    expect(changes.contract.decisions).toEqual({
      added: [],
      removed: ["D-02"],
      changed: ["D-01"],
    });
    expect(changes.contract.stories.removed).toEqual(["US-01"]);
  });

  it("lists other contract fields that differ", () => {
    const base = contractOf();
    const v2 = version(2);
    const one = versionChanges(v2, v1, contractOf({ objective: "something else" }), base);
    const two = versionChanges(
      v2,
      v1,
      contractOf({
        verification: [
          { ...(base.ok ? base.contract.verification[0] : {}), command: "echo changed" },
        ],
      }),
      base,
    );
    if ("unparseable" in one.contract || "unparseable" in two.contract) throw new Error("parsed");
    expect(one.contract.fields).toEqual(["objective"]);
    expect(two.contract.fields).toEqual(["verification"]);
  });

  it("sets contractChanged with no field differences for a hash-only change", () => {
    const v2 = version(2, { contract: { uri: "s3://y", sha256: "9".repeat(64), sizeBytes: 1 } });
    const changes = versionChanges(v2, v1, contractOf(), contractOf());
    expect(changes.contractChanged).toBe(true);
    if ("unparseable" in changes.contract) throw new Error("parsed");
    expect(changes.contract.fields).toEqual([]);
  });

  it("says so when a contract does not parse", () => {
    const bad = parseContract("nope");
    const changes = versionChanges(version(2), v1, bad, contractOf());
    expect("unparseable" in changes.contract).toBe(true);
    const missing = versionChanges(version(2), v1, undefined, contractOf());
    expect("unparseable" in missing.contract).toBe(true);
  });
});
