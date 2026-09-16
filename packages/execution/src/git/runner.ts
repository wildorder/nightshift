/**
 * Running `git`, and the identity every command runs under.
 *
 * ## Why every invocation carries `-c` overrides
 *
 * Nightshift owns every commit (A-29). A snapshot commit authored by whoever
 * happens to be sitting at the machine would make the history lie about who
 * produced the work, and a repository with `commit.gpgsign = true` would block
 * on a passphrase prompt in a process nobody is watching. So the identity and
 * the settings that matter are forced per invocation rather than read from the
 * operator's configuration — and forced on *every* command, not just `commit`,
 * because a `merge` can create a commit too.
 *
 * `core.hooksPath` is pointed at nothing for the same reason `--no-verify` is
 * passed: a target repository's hooks are arbitrary code written by someone
 * else, and Nightshift's own commit is not the place to run it.
 */
import { execFile } from "node:child_process";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitOptions {
  readonly cwd: string;
  /** Epoch milliseconds stamped as both author and committer date, where relevant. */
  readonly atMs?: number;
}

/** The seam to `git`, so tests can drive the whole layer without a repository. */
export type GitRunner = (args: readonly string[], options: GitOptions) => Promise<GitResult>;

export const NIGHTSHIFT_AUTHOR_NAME = "Nightshift";
export const NIGHTSHIFT_AUTHOR_EMAIL = "nightshift@nightshift.invalid";

/** Prepended to every command. See the module comment for why each is here. */
export const identityOverrides = (): readonly string[] => [
  "-c",
  `user.name=${NIGHTSHIFT_AUTHOR_NAME}`,
  "-c",
  `user.email=${NIGHTSHIFT_AUTHOR_EMAIL}`,
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  // Not `/dev/null`, which does not exist on Windows: an empty relative path
  // resolves to the repository root, where there is no `pre-commit` to run.
  "-c",
  "core.hooksPath=",
  // Line endings are Nightshift's, not the machine's.
  //
  // A-29 says Nightshift owns every commit, and owning a commit means owning
  // its bytes: `completeJob` snapshots the worktree, and `cleanCheckout` then
  // materialises that commit again for verification. With `core.autocrlf=true`
  // — the default on a Windows installation, and on the GitHub Windows runner —
  // those two are not the same bytes, so a worker writes `\n`, verification
  // reads `\r\n`, and a step that compares file contents fails for a reason
  // nobody can see in the diff. Found by CI: `operations.test.ts` read back
  // `committed\r\n` from a file it had written as `committed\n`.
  //
  // This disables the *implicit* platform conversion only. A repository that
  // declares `text eol=crlf` in `.gitattributes` still gets CRLF, because
  // attributes outrank both of these — so an operator who means it keeps it,
  // and one who never asked gets what they wrote.
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
];

export class GitError extends Error {
  override readonly name = "GitError";

  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly result: GitResult,
  ) {
    super(
      `git ${args.join(" ")} failed in ${cwd} with exit ${result.exitCode}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
}

/**
 * The environment a `git` child gets.
 *
 * An allowlist, like a verification step's (T4) and for the same reason: a
 * repository's configuration can invoke arbitrary programs, and a `git` child
 * has no business seeing the operator's Cognito token or AWS credentials. The
 * date variables are set per invocation so a snapshot commit is deterministic
 * under a fixed clock, which is what makes a test able to assert on a sha.
 */
const gitEnvironment = (atMs: number | undefined): Record<string, string> => {
  const allowed = [
    "PATH",
    "HOME",
    "SystemRoot",
    "windir",
    "SystemDrive",
    "COMSPEC",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TZ",
  ];
  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Never a terminal: a prompt in a process nobody is watching is a hang.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  if (atMs !== undefined) {
    const iso = new Date(atMs).toISOString();
    env.GIT_AUTHOR_DATE = iso;
    env.GIT_COMMITTER_DATE = iso;
  }
  return env;
};

/** The real runner. Never inherits the parent's environment (see above). */
export const nodeGitRunner: GitRunner = (args, options) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...identityOverrides(), ...args],
      {
        cwd: options.cwd,
        env: gitEnvironment(options.atMs),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout,
          stderr,
          // A failure to spawn `git` at all has no numeric code; 127 is the
          // shell's "could not execute", and it is a failure either way.
          exitCode: error === null ? 0 : typeof code === "number" ? code : 127,
        });
      },
    );
  });

/** Runs a command, throwing {@link GitError} on a non-zero exit. */
export const git = async (
  runner: GitRunner,
  args: readonly string[],
  options: GitOptions,
): Promise<string> => {
  const result = await runner(args, options);
  if (result.exitCode !== 0) throw new GitError(args, options.cwd, result);
  return result.stdout;
};

/** Runs a command, returning the result rather than throwing. */
export const tryGit = (
  runner: GitRunner,
  args: readonly string[],
  options: GitOptions,
): Promise<GitResult> => runner(args, options);
