/**
 * Publication intents (P10, T4, D-P10-01, D-P10-22).
 *
 * On a machine the program branch the engine fast-forwards is a local branch of
 * a clone; GitHub's copy moves only when the publisher pushes it, and the
 * publisher holds the only write credential. The engine's part is the intent:
 * after every landing it packs the commits the branch moved by, uploads the
 * pack as a `bundle` artifact so the objects are durable before anything is
 * pushed, and asks the plane to move the branch from the head it last asked
 * for to the head it has now. One intent per landing, in landing order, each
 * one's predecessor the previous one's head, so the publisher's lease is exact.
 *
 * The program branch moves only by those landings: the provisional line,
 * which lands nothing on it, raises no intent, because that hook is called
 * from `integrateNode` and from nowhere else. A strand's branch is published
 * too, every time it moves (A-60, amending D-P10-01): `createStrandPublication`,
 * the newest head of each branch, from a pack of everything since the base,
 * so a run that dies leaves its finished work at GitHub. A local run has no
 * hook at all: the composition root installs them only on a machine.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CommitSha,
  PublicationIntentBody,
  StrandPublicationBody,
} from "@nightshift/contracts";

/** What `integrateNode` reports after a landing moved the program branch. */
export interface Landing {
  readonly head: CommitSha;
  readonly programBranch: string;
  readonly repoPath: string;
}

export type PublishLanding = (landing: Landing) => Promise<void>;

/** A strand's branch moved (A-60): a job merged onto it, or the program head merged in. */
export interface StrandMove {
  readonly branch: string;
  readonly head: CommitSha;
  readonly repoPath: string;
}

/** Never rejects: a strand that cannot be published now is published at its next move. */
export type PublishStrand = (move: StrandMove) => Promise<void>;

export interface PublicationQueueOptions {
  /** The branch's head at GitHub when the run was dispatched: the first intent's predecessor. */
  readonly baseSha: CommitSha;
  /** Where packs are written before upload; under the run's directory. */
  readonly packDir: string;
  /** Uploads the pack; answers its key in the artifact bucket (`bundleKey`). */
  readonly upload: (pack: Uint8Array, head: CommitSha) => Promise<{ readonly key: string }>;
  /** `POST …/runs/{runId}/publication`. */
  readonly request: (body: PublicationIntentBody) => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * `git pack-objects` of everything reachable from `head` and not from
 * `exclude`, **not thin**: every object the remote could lack is in the pack
 * whole, so the publisher needs nothing but the pack to push it.
 */
export const packCommits = async (
  repoPath: string,
  packDir: string,
  head: CommitSha,
  exclude: CommitSha,
): Promise<Uint8Array> => {
  await mkdir(packDir, { recursive: true });
  const prefix = join(packDir, head);
  const hash = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["pack-objects", "--revs", "--quiet", prefix],
      { cwd: repoPath, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git pack-objects failed: ${stderr || error.message}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(`${head}\n^${exclude}\n`);
  });
  const packPath = `${prefix}-${hash}.pack`;
  const bytes = new Uint8Array(await readFile(packPath));
  await rm(`${prefix}-${hash}.idx`, { force: true });
  await rm(packPath, { force: true });
  return bytes;
};

/**
 * The hook `integrateNode` calls. Intents go out strictly in landing order,
 * one at a time, each after the previous one's request was accepted, because
 * the publisher resolves them in order and a later intent's predecessor is an
 * earlier one's head. A failure to raise an intent is logged and leaves the
 * predecessor where it was, so the next landing's intent covers both ranges.
 */
export const createPublicationQueue = (options: PublicationQueueOptions): PublishLanding => {
  let predecessor: CommitSha = options.baseSha;
  let chain: Promise<void> = Promise.resolve();
  return (landing) => {
    chain = chain.then(async () => {
      if (landing.head === predecessor) return;
      try {
        const pack = await packCommits(
          landing.repoPath,
          options.packDir,
          landing.head,
          predecessor,
        );
        const { key } = await options.upload(pack, landing.head);
        await options.request({
          head: landing.head,
          expectedPredecessor: predecessor,
          bundleKey: key,
        });
        options.log(
          `publication requested: ${landing.programBranch} ${predecessor.slice(0, 12)} → ${landing.head.slice(0, 12)} (${pack.length} bytes)`,
        );
        predecessor = landing.head;
      } catch (error) {
        options.log(
          `publication of ${landing.head.slice(0, 12)} could not be requested: ${error instanceof Error ? error.message : String(error)}; the next landing will carry it`,
        );
      }
    });
    return chain;
  };
};

export interface StrandPublicationOptions {
  /** What GitHub surely has: the dispatch's base. Every pack carries everything since. */
  readonly baseSha: CommitSha;
  readonly packDir: string;
  readonly upload: (pack: Uint8Array, head: CommitSha) => Promise<{ readonly key: string }>;
  /** `POST …/runs/{runId}/publication/strands`. */
  readonly request: (body: StrandPublicationBody) => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * The hook a strand's moves call (A-60). One branch at a time and the newest
 * head wins: a move made while an older one is still being packed waits, and
 * only the latest of those waiting goes. Each pack stands alone, so a lost
 * request costs nothing but the time until the strand moves again.
 */
export const createStrandPublication = (options: StrandPublicationOptions): PublishStrand => {
  const sent = new Map<string, CommitSha>();
  const newest = new Map<string, StrandMove>();
  const sending = new Map<string, Promise<void>>();

  const send = async (branch: string): Promise<void> => {
    for (;;) {
      const move = newest.get(branch);
      if (move === undefined) {
        // Gone in the same turn as the last look, so a move from now starts afresh.
        sending.delete(branch);
        return;
      }
      newest.delete(branch);
      if (sent.get(branch) === move.head) continue;
      try {
        const pack = await packCommits(move.repoPath, options.packDir, move.head, options.baseSha);
        const { key } = await options.upload(pack, move.head);
        await options.request({ branch, head: move.head, bundleKey: key });
        sent.set(branch, move.head);
        options.log(
          `strand published: ${branch} at ${move.head.slice(0, 12)} (${pack.length} bytes)`,
        );
      } catch (error) {
        options.log(
          `strand ${branch} at ${move.head.slice(0, 12)} could not be published: ${error instanceof Error ? error.message : String(error)}; its next move will carry it`,
        );
      }
    }
  };

  return (move) => {
    newest.set(move.branch, move);
    const running = sending.get(move.branch);
    if (running !== undefined) return running;
    // Recorded before it begins, so its own end can clear it.
    const started = Promise.resolve().then(() => send(move.branch));
    sending.set(move.branch, started);
    return started;
  };
};
