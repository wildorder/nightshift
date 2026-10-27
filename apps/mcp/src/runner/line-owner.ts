/**
 * The line owner on its machine (Pipkin M1b, S-04): what runs between `ready`
 * and the stop on a machine tagged as a line's.
 *
 * It reports `running`, waits for the GitHub read token and the provider
 * credentials the heartbeat brings, keeps a mirror and a checkout of the line's
 * repository on the workspace, and prepares the project's environment as a run
 * does. Then it builds S-03's ports over the plane and the checkout and loops:
 * wait out a push left pending (an earlier generation's), take the whole queue
 * as one batch, fetch every head it names, compose and publish it
 * (`drainLine`), and compose again when a push was rejected. When the queue has
 * been empty with no push pending for `LINE_IDLE_SECONDS` it ends, and the
 * runner's last heartbeat is `stopped` with no failure; the plane's own stop and
 * cleanup take the machine away.
 *
 * Only the publisher writes to GitHub: the owner holds the read token, packs
 * the commits it composed, and uploads the pack through a presigned PUT.
 */
import { writeFile } from "node:fs/promises";
import {
  type CommitSha,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type EffectivePolicy,
  type LineRecord,
  type LineView,
  NIGHTSHIFT_CONFIG_FILE,
  type NightshiftConfig,
  NightshiftConfigSchema,
  type Provider,
} from "@nightshift/contracts";
import { type Clock, type IdGenerator, LINE_IDLE_SECONDS } from "@nightshift/core";
import {
  createLineCheckout,
  createLineVerifier,
  drainLine,
  type GateDefinitions,
  type GitRunner,
  git,
  type LineCheckoutPort,
  type LineComposerPorts,
  type LinePublisherPort,
  type LineQueuePort,
  type LineResolverAgentPort,
  lineWorktreeRoot,
  packCommits,
  resolveLineFailure,
  type ScratchPaths,
  tryGit,
} from "@nightshift/execution";
import { commandAs, type Harness, type RunAs } from "@nightshift/harness";
import type { StepInvocation } from "@nightshift/verification";
import { createLineAgents } from "./line-agents.js";
import { awaitGithubToken, type LineRunnerContext, type RunnerWorkEnd } from "./main.js";
import { awaitProviderCredentials } from "./root.js";
import { gitWithToken, prepareProject } from "./workspace.js";

/** How often the owner reads the line while it waits for work or for a push to resolve. */
export const LINE_POLL_MS = 5_000;

export interface LineOwnerOptions {
  /** Runs the git that works on the checkout; every commit it makes is Nightshift's. */
  readonly git: GitRunner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Where each worktree's verification scratch lives. */
  readonly paths: ScratchPaths;
  /**
   * Uploads the file at `file` with a presigned PUT. The bytes are the pack;
   * a refusal throws.
   */
  readonly upload: (target: {
    readonly url: string;
    readonly contentType: string;
    readonly file: string;
  }) => Promise<void>;
  /** The harnesses by `RouteTarget.harness`, given the environment the agents run in. */
  readonly createHarnesses: (env: Readonly<Record<string, string>>) => {
    get(harness: string): Harness | undefined;
  };
  /**
   * Places the provider credentials where their harnesses read them and
   * answers the variables naming them (`placeProviderCredentials`).
   */
  readonly placeCredentials?: (
    credentials: Partial<Record<Provider, string>>,
  ) => Promise<Readonly<Record<string, string>>>;
  /**
   * The project user's execution context, as the run root's workers get it,
   * given the project environment it runs in (known once the checkout is prepared).
   */
  readonly runAs?: (projectEnv: Readonly<Record<string, string>>) => RunAs | undefined;
  /** This process's environment, for the PATH and HOME agents need. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** The empty-queue time after which the owner ends; `LINE_IDLE_SECONDS` unless a test shortens it. */
  readonly idleSeconds?: number;
  /** How often the line is read while waiting; `LINE_POLL_MS` by default. */
  readonly pollMs?: number;
  /** The composition's own limits, which a test may shorten. */
  readonly limits?: { readonly seconds?: number; readonly attempts?: number };
  /** Takes a granted path back for the engine, when worktrees are handed to the project user. */
  readonly reclaim?: (dir: string) => Promise<void>;
}

/** The owner was told to stop while it waited. */
class LineStopped extends Error {
  override readonly name = "LineStopped";
}

const DEFAULT_POLICY: EffectivePolicy = {
  routingPolicy: DEFAULT_ROUTING_POLICY,
  examinationPolicy: DEFAULT_EXAMINATION_POLICY,
  orgConfigVersion: 0,
};

/** `https://github.com/o/r` is cloned as `…/r.git`; anything else (a path in a test) as it is. */
const cloneUrlOf = (repositoryUrl: string): string =>
  /^https?:\/\//.test(repositoryUrl) && !repositoryUrl.endsWith(".git")
    ? `${repositoryUrl}.git`
    : repositoryUrl;

const headRef = (branch: string): string => `refs/heads/${branch}`;
const remoteRef = (branch: string): string => `refs/remotes/origin/${branch}`;

export const runLineOwner = async (
  context: LineRunnerContext,
  options: LineOwnerOptions,
): Promise<RunnerWorkEnd | undefined> => {
  try {
    return await ownLine(context, options);
  } catch (error) {
    if (error instanceof LineStopped) {
      context.log("the line owner was told to stop");
      return undefined;
    }
    throw error;
  }
};

const ownLine = async (
  context: LineRunnerContext,
  options: LineOwnerOptions,
): Promise<RunnerWorkEnd | undefined> => {
  const { machine, heartbeat, plane, layout, log, identity } = context;
  const branch = identity.branch;
  const idleMs = (options.idleSeconds ?? LINE_IDLE_SECONDS) * 1000;
  const pollMs = options.pollMs ?? LINE_POLL_MS;
  const credentialTimeoutMs = context.credentialTimeoutMs ?? 2 * 60_000;

  const ensureRunning = (): void => {
    if (heartbeat.last?.stop === true) throw new LineStopped("told to stop");
  };
  const wait = async (ms: number): Promise<void> => {
    await machine.sleep(ms);
    ensureRunning();
  };
  const say = (detail: string): void => {
    heartbeat.progress({ stage: "orchestrating", detail: detail.slice(0, 500) });
  };

  // The plane hands the org's provider keys to a running engine and to
  // nothing else, on the next beat; the read token comes on the beats before.
  heartbeat.report("running");
  const providers = await awaitProviderCredentials(heartbeat, machine, credentialTimeoutMs);
  ensureRunning();
  await awaitGithubToken(heartbeat, machine, credentialTimeoutMs);
  const githubToken = (): string => {
    const token = heartbeat.last?.credentials?.github;
    if (token === undefined) throw new Error("the plane sent no GitHub credential");
    return token;
  };
  const providerEnv = await (options.placeCredentials?.(providers) ??
    Promise.resolve<Readonly<Record<string, string>>>({}));

  // The repository: a mirror of GitHub and a checkout of it, on the workspace.
  const view0 = await plane.line();
  const cloneUrl = cloneUrlOf(view0.record.repositoryUrl);
  const mirrored = await machine.exec("git", [
    "-C",
    layout.mirror,
    "rev-parse",
    "--is-bare-repository",
  ]);
  if (mirrored.exitCode !== 0 || mirrored.stdout.trim() !== "true") {
    say("cloning the mirror");
    log("cold volume: cloning the mirror");
    const cloned = await gitWithToken(machine, undefined, githubToken(), [
      "clone",
      "--mirror",
      cloneUrl,
      layout.mirror,
    ]);
    if (cloned.exitCode !== 0) throw new Error(`clone: ${cloned.stderr.trim()}`);
  }
  const mainBranch = await (async (): Promise<string> => {
    const named = await machine.exec("git", [
      "-C",
      layout.mirror,
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    return named.exitCode === 0 && named.stdout.trim() !== "" ? named.stdout.trim() : "main";
  })();

  /** Fetches the line, main and every program branch the line view names; answers the line's and main's heads. */
  const fetchHeads = async (view: LineView): Promise<{ lineHead: string; mainHead: string }> => {
    const required = [branch, mainBranch];
    const refspec = (name: string) => `+${headRef(name)}:${headRef(name)}`;
    const mainFetched = await gitWithToken(machine, layout.mirror, githubToken(), [
      "fetch",
      "origin",
      refspec(mainBranch),
    ]);
    if (mainFetched.exitCode !== 0)
      throw new Error(`fetch ${mainBranch}: ${mainFetched.stderr.trim()}`);
    // A line that has never been pushed has no ref at GitHub yet: it starts at main's head.
    const lineFetched = await gitWithToken(machine, layout.mirror, githubToken(), [
      "fetch",
      "origin",
      refspec(branch),
    ]);
    let lineAbsent = false;
    if (lineFetched.exitCode !== 0) {
      if (!/couldn't find remote ref/i.test(lineFetched.stderr))
        throw new Error(`fetch ${branch}: ${lineFetched.stderr.trim()}`);
      lineAbsent = true;
      log(`line ${branch} does not exist at the remote yet; composing onto ${mainBranch}`);
    }
    for (const program of view.programs) {
      if (required.includes(program.branch)) continue;
      const result = await gitWithToken(machine, layout.mirror, githubToken(), [
        "fetch",
        "origin",
        refspec(program.branch),
      ]);
      if (result.exitCode !== 0) {
        log(
          `could not fetch ${program.program}'s branch ${program.branch}: ${result.stderr.trim()}`,
        );
      }
    }
    const hasCheckout = await tryGit(options.git, ["rev-parse", "--git-dir"], {
      cwd: layout.checkout,
    })
      .then((result) => result.exitCode === 0)
      .catch(() => false);
    if (!hasCheckout) {
      const cloned = await machine.exec("git", [
        "clone",
        "--no-checkout",
        layout.mirror,
        layout.checkout,
      ]);
      if (cloned.exitCode !== 0) throw new Error(`clone the checkout: ${cloned.stderr.trim()}`);
      await machine.exec("git", [
        "-C",
        layout.checkout,
        "config",
        "core.sharedRepository",
        "group",
      ]);
    }
    await git(options.git, ["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
      cwd: layout.checkout,
    });
    const head = async (name: string): Promise<string> =>
      (
        await git(options.git, ["rev-parse", "--verify", `${remoteRef(name)}^{commit}`], {
          cwd: layout.checkout,
        })
      ).trim();
    const mainHead = await head(mainBranch);
    return { lineHead: lineAbsent ? mainHead : await head(branch), mainHead };
  };

  say("fetching the line and its programs");
  const first = await fetchHeads(view0);
  // The checkout is the reference the project environment is prepared in; the
  // composition happens in worktrees of its object store.
  await git(options.git, ["checkout", "-q", "-f", "--detach", first.lineHead], {
    cwd: layout.checkout,
  });
  await tryGit(options.git, ["worktree", "prune"], { cwd: layout.checkout });

  /** The project's gates and secrets, read from the checkout at the line's head as runs read them. */
  const readConfig = async (commit: string): Promise<NightshiftConfig> => {
    const shown = await tryGit(options.git, ["show", `${commit}:${NIGHTSHIFT_CONFIG_FILE}`], {
      cwd: layout.checkout,
    });
    if (shown.exitCode !== 0) {
      throw new Error(`the line has no ${NIGHTSHIFT_CONFIG_FILE} at ${commit.slice(0, 12)}`);
    }
    return NightshiftConfigSchema.parse(JSON.parse(shown.stdout));
  };
  const secretsOf = (config: NightshiftConfig): Record<string, string> => {
    const held = heartbeat.last?.secrets ?? {};
    return Object.fromEntries(
      (config.secrets ?? []).flatMap((name) =>
        held[name] === undefined ? [] : [[name, held[name]]],
      ),
    );
  };

  const config0 = await readConfig(first.lineHead);
  const prepared = await prepareProject(machine, {
    layout,
    program: { setup: config0.setup },
    log,
    onProgress: (progress) => heartbeat.progress(progress),
    secrets: secretsOf(config0),
    ...(context.inheritedPath === undefined ? {} : { inheritedPath: context.inheritedPath }),
    ...(context.projectUser === undefined ? {} : { projectUser: context.projectUser }),
  });
  log(`project environment ready (setup ${prepared.setupSeconds.toFixed(1)}s)`);

  // What the verifier reads, refreshed at each line head.
  let gates: GateDefinitions = {
    setup: config0.setup ?? [],
    verification: config0.verification,
  };
  const gateView: GateDefinitions = {
    get setup() {
      return gates.setup;
    },
    get verification() {
      return gates.verification;
    },
  };
  const stepEnv: Record<string, string> = { ...secretsOf(config0), ...prepared.environment };
  const refreshGates = async (commit: string): Promise<void> => {
    const config = await readConfig(commit);
    gates = { setup: config.setup ?? [], verification: config.verification };
    for (const key of Object.keys(stepEnv)) delete stepEnv[key];
    Object.assign(stepEnv, secretsOf(config), prepared.environment);
  };

  const agentEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "TERM", "USER", "LOGNAME"]) {
    const value = options.parentEnv?.[name];
    if (value !== undefined && value !== "") agentEnv[name] = value;
  }
  Object.assign(agentEnv, prepared.environment, providerEnv);
  const harnesses = options.createHarnesses(agentEnv);
  const runAs = options.runAs?.(prepared.environment);

  // --- S-03's ports -------------------------------------------------------------------

  let lastView = view0;
  const heads = async (): Promise<{ lineHead: string; mainHead: string }> => {
    ensureRunning();
    lastView = await plane.line();
    const fetched = await fetchHeads(lastView);
    await refreshGates(fetched.lineHead);
    return fetched;
  };

  const queue: LineQueuePort = {
    takeBatch: () => plane.takeBatch(),
    lastComposed: async (program) => {
      const record = (await plane.line()).record;
      let newest: { at: number; upTo: CommitSha } | undefined;
      for (const composition of record.compositions) {
        for (const range of composition.ranges) {
          const at = Date.parse(composition.composedAt);
          if (range.program === program && (newest === undefined || at >= newest.at)) {
            newest = { at, upTo: range.upTo };
          }
        }
      }
      return newest?.upTo;
    },
    settle: async (settlement) => {
      await plane.settle({
        batchId: settlement.batchId,
        ...(settlement.composition === undefined ? {} : { composition: settlement.composition }),
        ...(settlement.push === undefined ? {} : { push: settlement.push }),
        parked: settlement.parked,
      });
    },
  };

  const bundles = `${layout.run}/bundles`;
  const publisher: LinePublisherPort = {
    stage: async ({ head, expectedPredecessor }) => {
      await machine.exec("mkdir", ["-p", bundles]);
      const file = `${bundles}/${head}.pack`;
      // A raw pack, not a `git bundle`: the publisher has no git and hands the
      // bytes to the remote as they are, as for a run's landing (`packCommits`).
      const pack = await packCommits(layout.checkout, bundles, head, expectedPredecessor);
      await writeFile(file, pack);
      const target = await plane.bundleUploadUrl(`${head}-${expectedPredecessor.slice(0, 12)}`);
      await options.upload({ url: target.uploadUrl, contentType: target.contentType, file });
      return { bundleKey: target.key };
    },
    outcome: async ({ head }) => {
      for (;;) {
        ensureRunning();
        const record = (await plane.line()).record;
        const push = record.push;
        if (push?.head === head && push.status !== "pending") {
          return push.status === "published"
            ? { status: "published" }
            : { status: "rejected", detail: push.detail ?? `the push was ${push.status}` };
        }
        if (push?.head !== head) {
          if (record.compositions.some((c) => c.commit === head && c.pushed !== undefined)) {
            return { status: "published" };
          }
          return { status: "rejected", detail: "the push was replaced before it resolved" };
        }
        await wait(pollMs);
      }
    },
  };

  const checkout: LineCheckoutPort = createLineCheckout({
    runner: options.git,
    repo: layout.checkout,
    scratchDir: `${layout.run}/worktrees`,
  });
  const verifier = createLineVerifier({
    gates: gateView,
    ids: options.ids,
    clock: options.clock,
    runner: options.git,
    paths: options.paths,
    env: stepEnv,
    ...(options.reclaim === undefined ? {} : { reclaim: options.reclaim }),
    // Every setup and check step runs as the project user (D-P10-30).
    ...(runAs === undefined
      ? {}
      : {
          grant: (path: string) => runAs.grant(path),
          as: (invocation: StepInvocation): StepInvocation => {
            const command = commandAs(runAs, invocation.file, invocation.args, invocation.env);
            return { file: command.file, args: command.args, env: command.env };
          },
        }),
  });

  // An agent runs as the project user in a worktree the engine made: the user
  // is given the whole path, its temporary parent included, for the launch,
  // and the engine takes it back before it merges, verifies or closes it.
  // Built per use: the policy is the line's as last read.
  const rawAgents = (): LineResolverAgentPort =>
    createLineAgents({
      harnesses,
      policy: lastView.policy ?? DEFAULT_POLICY,
      ids: options.ids,
      env: agentEnv,
      ...(runAs === undefined ? {} : { runAs }),
      announce: async ({ agentId, role, target }) => {
        await plane.announce({
          agentId,
          role,
          model: target,
          announcedAt: new Date(options.clock.now()).toISOString(),
        });
      },
    });
  const handedToProject = async <T>(
    worktree: { readonly path: string },
    launch: () => Promise<T>,
  ): Promise<T> => {
    if (runAs === undefined) return launch();
    const root = lineWorktreeRoot(worktree.path);
    try {
      await runAs.grant(root);
      return await launch();
    } finally {
      await options.reclaim?.(root);
    }
  };
  const agents: LineResolverAgentPort = {
    resolve: (input) => handedToProject(input.worktree, () => rawAgents().resolve(input)),
    examine: (input) => handedToProject(input.worktree, () => rawAgents().examine(input)),
  };

  const resolve: LineComposerPorts["resolve"] = (failure) =>
    resolveLineFailure(
      {
        checkout,
        verifier,
        agents,
        decisions: {
          record: async (decision) => {
            await plane.decide(decision);
          },
        },
        clock: options.clock,
        ...(options.limits?.attempts === undefined
          ? {}
          : { limits: { attempts: options.limits.attempts } }),
      },
      failure,
    );

  const ports: LineComposerPorts = {
    queue,
    checkout,
    verifier,
    publisher,
    resolve,
    clock: options.clock,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };

  // --- The loop -----------------------------------------------------------------------

  const pendingPush = (record: LineRecord) =>
    record.push?.status === "pending" ? record.push : undefined;
  const hasWork = (record: LineRecord): boolean =>
    record.queue.length > 0 || record.batch !== undefined || pendingPush(record) !== undefined;

  let idleSince: number | undefined;
  for (;;) {
    ensureRunning();
    const record = (await plane.line()).record;

    // A push an earlier generation left pending is waited for before anything is taken.
    const pending = pendingPush(record);
    if (pending !== undefined) {
      idleSince = undefined;
      say(`waiting for the push to ${pending.head.slice(0, 12)}`);
      const outcome = await publisher.outcome({ head: pending.head });
      log(`push ${pending.head.slice(0, 12)}: ${outcome.status}`);
      continue;
    }

    if (record.queue.length > 0 || record.batch !== undefined) {
      idleSince = undefined;
      say(record.batch === undefined ? "composing the queue" : "composing the held batch");
      const outcomes = await drainLine(ports, heads);
      for (const outcome of outcomes) {
        log(
          `batch ${outcome.batchId}: composed ${outcome.composed.length}, parked ${outcome.parked.length}` +
            (outcome.published === undefined ? "" : `, push ${outcome.published.status}`),
        );
      }
      // A rejected push ends the drain: the line is read again and the ranges
      // the plane gave back are composed onto its new head.
      continue;
    }

    // Nothing queued, held or pending: wait, and end once it has stayed so.
    idleSince ??= machine.now();
    if (machine.now() - idleSince >= idleMs) {
      log(`the line has been idle for ${Math.round(idleMs / 1000)}s; the owner ends`);
      return undefined;
    }
    say("waiting for work");
    await wait(pollMs);
    const after = (await plane.line()).record;
    if (hasWork(after)) idleSince = undefined;
  }
};
