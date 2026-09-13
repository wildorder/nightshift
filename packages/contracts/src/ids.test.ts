import { describe, expect, it } from "vitest";
import {
  ID_PREFIXES,
  ID_SCHEMAS,
  type IdPrefix,
  idPrefixOf,
  isId,
  ProjectIdSchema,
  parseId,
} from "./ids.js";

const VALID_ULID = "01HF7YAT00GGGGGGGGGGGGGGGG";

describe("identifier prefixes", () => {
  it("covers exactly the prefixes ratified in D-P1-07", () => {
    expect([...ID_PREFIXES].sort()).toEqual(
      [
        "agent",
        "art",
        "ckpt",
        "dec",
        "evt",
        "exam",
        "job",
        "node",
        "proj",
        "prog",
        "route",
        "run",
        "ver",
      ].sort(),
    );
  });

  it.each(ID_PREFIXES)("accepts a well-formed %s identifier", (prefix) => {
    expect(ID_SCHEMAS[prefix].safeParse(`${prefix}_${VALID_ULID}`).success).toBe(true);
  });

  it.each(ID_PREFIXES)("rejects another prefix's identifier for %s", (prefix) => {
    const other: IdPrefix = prefix === "proj" ? "run" : "proj";
    expect(ID_SCHEMAS[prefix].safeParse(`${other}_${VALID_ULID}`).success).toBe(false);
  });
});

describe("identifier shape", () => {
  it.each([
    ["missing prefix", VALID_ULID],
    ["missing separator", `proj${VALID_ULID}`],
    ["too short", "proj_01HF7YAT00"],
    ["too long", `proj_${VALID_ULID}0`],
    ["lowercase payload", `proj_${VALID_ULID.toLowerCase()}`],
    ["excluded letter I", `proj_I${VALID_ULID.slice(1)}`],
    ["excluded letter L", `proj_L${VALID_ULID.slice(1)}`],
    ["excluded letter O", `proj_O${VALID_ULID.slice(1)}`],
    ["excluded letter U", `proj_U${VALID_ULID.slice(1)}`],
    ["hyphen in payload", `proj_${VALID_ULID.slice(0, 25)}-`],
    ["leading whitespace", ` proj_${VALID_ULID}`],
    ["trailing newline", `proj_${VALID_ULID}\n`],
  ])("rejects %s", (_label, candidate) => {
    expect(ProjectIdSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects non-string input", () => {
    for (const candidate of [42, null, undefined, {}, []]) {
      expect(ProjectIdSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("parseId", () => {
  it("returns the branded identifier", () => {
    expect(parseId("proj", `proj_${VALID_ULID}`)).toBe(`proj_${VALID_ULID}`);
  });

  it("throws on the wrong prefix", () => {
    expect(() => parseId("proj", `run_${VALID_ULID}`)).toThrow();
  });
});

describe("isId", () => {
  it("narrows without throwing", () => {
    expect(isId("run", `run_${VALID_ULID}`)).toBe(true);
    expect(isId("run", `proj_${VALID_ULID}`)).toBe(false);
    expect(isId("run", undefined)).toBe(false);
  });
});

describe("idPrefixOf", () => {
  it("identifies each prefix", () => {
    for (const prefix of ID_PREFIXES) {
      expect(idPrefixOf(`${prefix}_${VALID_ULID}`)).toBe(prefix);
    }
  });

  it("returns undefined for a non-identifier", () => {
    expect(idPrefixOf("not-an-id")).toBeUndefined();
  });
});
