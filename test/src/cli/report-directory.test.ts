/** `writeReportUnlessTracked` creates the directory a plane-only program does not yet have (P21 S-02, F-02). */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliEnvironment } from "@nightshift/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeReportUnlessTracked } from "../../../apps/cli/src/commands/run-program.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "nightshift-report-dir-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("writeReportUnlessTracked", () => {
  it("writes into a directory that does not exist", async () => {
    const environment = {
      git: async (args: readonly string[], options: { cwd: string }) => {
        try {
          execFileSync("git", [...args], { cwd: options.cwd, stdio: "ignore" });
          return { exitCode: 0, stdout: "", stderr: "" };
        } catch {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
      },
    } as unknown as CliEnvironment;
    const path = await writeReportUnlessTracked(environment, repo, "docs/programs/x", "# report\n");
    expect(path).toBe(join(repo, "docs/programs/x", "report.md"));
    expect(await readFile(path, "utf8")).toBe("# report\n");
  });
});
