import { describe, expect, it } from "vitest";
import { publicationPathsAllowed } from "./publication.js";

describe("publicationPathsAllowed", () => {
  const name = "p21-plans";
  it("accepts the four files under the program's directory", () => {
    expect(
      publicationPathsAllowed(name, [
        "docs/programs/p21-plans/contract.json",
        "docs/programs/p21-plans/plan.md",
        "docs/programs/p21-plans/conversation.md",
        "docs/programs/p21-plans/report.md",
      ]),
    ).toBe(true);
  });

  it("refuses any other path", () => {
    for (const path of [
      "README.md",
      "docs/programs/other/plan.md",
      "docs/programs/p21-plans/notes.md",
      "docs/programs/p21-plans/sub/plan.md",
      "docs/programs/p21-plans/../other/plan.md",
      "docs/programs/p21-plans/../../../etc/passwd",
      "../docs/programs/p21-plans/plan.md",
      "/docs/programs/p21-plans/plan.md",
      "docs/programs/p21-plans",
      "docs/programs/p21-plans/",
      "docs/programs/p21-plans/plan.md/x",
      "docs/programs/p21-plans-2/plan.md",
    ]) {
      expect(publicationPathsAllowed(name, [path]), path).toBe(false);
    }
  });

  it("refuses the lot when one path is outside", () => {
    expect(publicationPathsAllowed(name, ["docs/programs/p21-plans/plan.md", "package.json"])).toBe(
      false,
    );
  });

  it("refuses a program name that is not one directory name", () => {
    expect(publicationPathsAllowed("..", ["docs/programs/../plan.md"])).toBe(false);
    expect(publicationPathsAllowed("a/b", ["docs/programs/a/b/plan.md"])).toBe(false);
    expect(publicationPathsAllowed("", ["docs/programs//plan.md"])).toBe(false);
  });
});
