import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentStateDir,
  configDir,
  createLocalPaths,
  credentialsPath,
  idTail,
  profilePath,
  runStateDir,
  spoolPath,
  stateDir,
  transcriptPath,
  worktreePath,
} from "./paths.js";

const HOME = join("/", "home", "operator");

describe("config and state directories", () => {
  it("honours the explicit overrides above everything else", () => {
    const env = {
      NIGHTSHIFT_CONFIG_DIR: "/tmp/cfg",
      NIGHTSHIFT_STATE_DIR: "/tmp/state",
      XDG_CONFIG_HOME: "/ignored",
      LOCALAPPDATA: "C:/ignored",
    };
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(configDir({ env, platform, home: HOME })).toBe("/tmp/cfg");
      expect(stateDir({ env, platform, home: HOME })).toBe("/tmp/state");
    }
  });

  it("uses the XDG layout on Linux and macOS alike", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(configDir({ env: {}, platform, home: HOME })).toBe(
        join(HOME, ".config", "nightshift"),
      );
      expect(stateDir({ env: {}, platform, home: HOME })).toBe(
        join(HOME, ".local", "state", "nightshift"),
      );
    }
  });

  it("honours XDG_CONFIG_HOME and XDG_STATE_HOME when they are set", () => {
    const env = { XDG_CONFIG_HOME: "/x/cfg", XDG_STATE_HOME: "/x/state" };
    expect(configDir({ env, platform: "linux", home: HOME })).toBe(join("/x/cfg", "nightshift"));
    expect(stateDir({ env, platform: "linux", home: HOME })).toBe(join("/x/state", "nightshift"));
  });

  it("uses LOCALAPPDATA on Windows, falling back to the profile", () => {
    expect(
      configDir({
        env: { LOCALAPPDATA: "C:/Users/op/AppData/Local" },
        platform: "win32",
        home: HOME,
      }),
    ).toBe(join("C:/Users/op/AppData/Local", "nightshift"));
    expect(configDir({ env: {}, platform: "win32", home: "C:/Users/op" })).toBe(
      join("C:/Users/op", "AppData", "Local", "nightshift"),
    );
  });

  it("treats an empty override as absent rather than as the current directory", () => {
    expect(configDir({ env: { NIGHTSHIFT_CONFIG_DIR: "" }, platform: "linux", home: HOME })).toBe(
      join(HOME, ".config", "nightshift"),
    );
  });

  it("keeps config and state apart, so a run never litters the operator's settings", () => {
    const env = {};
    expect(configDir({ env, platform: "linux", home: HOME })).not.toBe(
      stateDir({ env, platform: "linux", home: HOME }),
    );
  });
});

describe("the files and directories underneath", () => {
  const env = { NIGHTSHIFT_CONFIG_DIR: "/cfg", NIGHTSHIFT_STATE_DIR: "/state" };
  const at = { env, platform: "linux" as const, home: HOME };

  it("names the profile and credentials inside the config directory", () => {
    expect(profilePath(at)).toBe(join("/cfg", "profile.json"));
    expect(credentialsPath(at)).toBe(join("/cfg", "credentials.json"));
  });

  it("names a run's spool, agent directory and transcript inside the state directory", () => {
    expect(runStateDir("run_abc", at)).toBe(join("/state", "runs", "run_abc"));
    expect(spoolPath("run_abc", at)).toBe(join("/state", "runs", "run_abc", "spool.ndjson"));
    expect(agentStateDir("run_abc", "agent_x", at)).toBe(
      join("/state", "runs", "run_abc", "agents", "agent_x"),
    );
    expect(transcriptPath("run_abc", "agent_x", at)).toBe(
      join("/state", "runs", "run_abc", "agents", "agent_x", "transcript.jsonl"),
    );
  });

  /**
   * Windows still enforces a 260-character limit in many APIs, and a worktree
   * holds a whole repository under this prefix. The prefix must stay small.
   */
  it("keeps a worktree path short, using identifier tails", () => {
    const runId = "run_01M2K3A96ZZ7EJE93PQWR845T3";
    const nodeId = "node_01M2K3A96ZZ7EJE93PQWR845T4";
    expect(worktreePath(runId, nodeId, at)).toBe(
      join("/state", "wt", idTail(runId), idTail(nodeId)),
    );
    // The prefix Nightshift adds, on top of whatever the state directory is.
    expect(worktreePath(runId, nodeId, at).length - "/state".length).toBeLessThan(30);
  });

  it("gives two nodes of the same run distinct worktrees", () => {
    expect(worktreePath("run_aaaaaaaaaa", "node_11111111", at)).not.toBe(
      worktreePath("run_aaaaaaaaaa", "node_22222222", at),
    );
  });

  it("never places anything under the current working directory", () => {
    // The prefixes through `join` too: on Windows `join("/state", …)` yields
    // `\state\…`, so a literal `"/state"` would be comparing against a
    // separator this platform never produces.
    const cfg = join("/cfg");
    const state = join("/state");
    for (const path of [
      profilePath(at),
      credentialsPath(at),
      spoolPath("run_a", at),
      worktreePath("run_a", "node_b", at),
    ]) {
      expect(path.startsWith(cfg) || path.startsWith(state)).toBe(true);
    }
  });
});

describe("the LocalPaths port", () => {
  const at = { env: { NIGHTSHIFT_STATE_DIR: "/state" }, platform: "linux" as const, home: HOME };

  it("answers the same paths the module's own functions do", () => {
    const paths = createLocalPaths(at);
    expect(paths.worktree("run_a", "node_b")).toBe(worktreePath("run_a", "node_b", at));
    expect(paths.runDir("run_a")).toBe(runStateDir("run_a", at));
    expect(paths.spool("run_a")).toBe(spoolPath("run_a", at));
    expect(paths.transcript("run_a", "agent_c")).toBe(transcriptPath("run_a", "agent_c", at));
  });

  it("puts nothing inside the program checkout", () => {
    const paths = createLocalPaths(at);
    for (const path of [
      paths.worktree("run_a", "node_b"),
      paths.runDir("run_a"),
      paths.spool("run_a"),
      paths.transcript("run_a", "agent_c"),
    ]) {
      expect(path.startsWith(join("/state"))).toBe(true);
    }
  });
});
