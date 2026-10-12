import { createHash } from "node:crypto";
import { createFixtures, makeDispatch, makeProgramContract, planHash } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.js";
import { layoutOf, prepareCheckout, prepareProject } from "./workspace.js";

const f = createFixtures();
const layout = layoutOf("/workspace", f.scope.runId);
const program = makeProgramContract(f, { setup: [{ id: "deps", command: "npm ci" }] });
const planText = "# Authorized plan\n";
const dispatch = makeDispatch(f, {
  input: {
    repositoryUrl: program.repository.url,
    branch: program.repository.programBranch,
    baseSha: "a".repeat(40),
    planHash: planHash(program, planText, (text) => createHash("sha256").update(text).digest("hex"))
      .hash,
  },
});
const moveFile = (files: Map<string, string>, args: readonly string[]) => {
  const from = args.at(-2) ?? "";
  const to = args.at(-1) ?? "";
  const value = files.get(from);
  if (value !== undefined) files.set(to, value);
  files.delete(from);
};
const outputOf = (command: string): string => {
  if (command.includes("branch --show-current")) return program.repository.programBranch;
  if (command.endsWith("/node --version")) return "v22.11.0";
  if (command.includes("mise ls-remote node")) return "22.11.0";
  return "";
};
const fake = (options: { checkoutExists?: boolean } = {}) => {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const machine: Machine = {
    exec: async (file, args) => {
      const command = [file, ...args].join(" ");
      commands.push(command);
      if (file === "mv") moveFile(files, args);
      if (command.includes("rev-parse --git-dir")) {
        return { exitCode: options.checkoutExists === false ? 1 : 0, stdout: ".git", stderr: "" };
      }
      return { exitCode: 0, stdout: outputOf(command), stderr: "" };
    },
    readFile: async (path) => files.get(path),
    writeFile: async (path, value) => {
      files.set(path, value);
    },
    http: async () => ({ status: 404, text: "" }),
    now: () => 0,
    sleep: async () => undefined,
  };
  return { machine, files, commands };
};
const input = { layout, program, dispatch, planText, githubToken: "test", log: () => undefined };

describe("checkout recovery and explicit project preparation", () => {
  it("preserves the same run's head, worktrees, dirty files and project environment", async () => {
    const world = fake();
    world.files.set(
      `${layout.run}/checkout.json`,
      JSON.stringify({
        runId: dispatch.runId,
        baseSha: dispatch.input.baseSha,
        branch: program.repository.programBranch,
      }),
    );
    world.files.set(`${layout.run}/project.env`, "PATH=/already/installed/node/bin\n");
    world.files.set(`${layout.checkout}/unfinished.ts`, "valuable uncommitted work");
    const result = await prepareCheckout(world.machine, {
      ...input,
      githubToken: async () => {
        throw new Error("recovery must not wait for a clone credential");
      },
    });
    expect(result.environment.PATH).toBe("/already/installed/node/bin");
    expect(world.files.get(`${layout.checkout}/unfinished.ts`)).toBe("valuable uncommitted work");
    expect(
      world.commands.some(
        (line) =>
          line.startsWith("git ") &&
          /\b(reset|clean|checkout|fetch|clone)\b/.test(line.replaceAll(layout.checkout, "REPO")),
      ),
    ).toBe(false);
    expect(world.commands.join("\n")).toContain("merge-base --is-ancestor");
    expect(world.commands.join("\n")).not.toContain("npm ci");
  });

  it("a replacement machine also preserves the recovered checkout without a marker", async () => {
    const world = fake();
    await prepareCheckout(world.machine, { ...input, dispatch: { ...dispatch, generation: 2 } });
    expect(world.commands.join("\n")).not.toMatch(/checkout (?:-q )?-B/);
    expect(world.commands.join("\n")).not.toContain("reset --hard");
  });

  it("a replacement after failure before checkout can bootstrap an empty workspace", async () => {
    const world = fake({ checkoutExists: false });
    await prepareCheckout(world.machine, { ...input, dispatch: { ...dispatch, generation: 2 } });
    expect(world.commands.join("\n")).toMatch(/checkout (?:-q )?-B/);
    expect(world.commands.join("\n")).not.toContain("merge-base --is-ancestor");
    expect(JSON.parse(world.files.get(`${layout.run}/checkout.json`) ?? "{}")).toMatchObject({
      runId: dispatch.runId,
    });
  });

  it("refuses another checkout identity without attempting to repair it destructively", async () => {
    const world = fake();
    world.files.set(`${layout.run}/checkout.json`, JSON.stringify({ runId: "another-run" }));
    await expect(prepareCheckout(world.machine, input)).rejects.toThrow("different run");
    expect(world.commands.some((line) => line.startsWith("git "))).toBe(false);
  });

  it("prepares as the project user, honors corrected repository runtime pins, and never resets git", async () => {
    const world = fake();
    world.files.set(`${layout.checkout}/.node-version`, "22\n");
    const prepared = await prepareProject(world.machine, {
      ...input,
      projectUser: "project",
      dispatch: {
        ...dispatch,
        input: {
          ...dispatch.input,
          toolchain: [
            {
              runtime: "node",
              version: "20.10.0",
              source: { kind: "pin", file: ".node-version", spec: "20" },
            },
          ],
        },
      },
    });
    expect(prepared.environment.PATH).toContain("node/22.11.0/bin");
    expect(world.commands.join("\n")).not.toContain("node@20.10.0");
    expect(
      world.commands.some(
        (line) => line.startsWith("sudo -n -u project -H env ") && line.endsWith("npm ci"),
      ),
    ).toBe(true);
    expect(world.commands.some((line) => line.startsWith("git "))).toBe(false);
  });
});
