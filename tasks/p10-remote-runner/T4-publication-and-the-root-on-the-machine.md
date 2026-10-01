# T4 — Publication and the headless root on the machine

**Program:** `p10-remote-runner`
**Depends on:** T3; H-P10-04, H-P10-04b (satisfied)
**Gate before it starts:** the owner has run `nightshift org github install`
and `nightshift org github status` lists `wildorder/nightshift` and
`wildorder/nightshift-remote-fixture`.
**Unblocks:** T6
**Decisions applied:** D-P10-01, D-P10-02, D-P10-20, D-P10-22

## Objective

The headless root orchestrator starts on the machine under the engine's
authority and runs the program exactly as it does locally; every head the
merge queue lands is published to the program branch at GitHub by a publisher
that holds the only write credential, with a lease at the Git transport.

## Deliverables

1. **The root on the machine** (`apps/mcp/src/runner/root.ts`): after `ready`,
   `runHeadless` with the engine's `Runtime` (HTTP stores over the engine token,
   renewed by the heartbeat), `repoPath` = `/workspace/checkout`, the detached
   read checkout under `/workspace/runs/<runId>/root`, worktrees under
   `/workspace/runs/<runId>/worktrees`, each worker launched `runAs` its own
   user (T2). The orchestrator's harness session id is recorded on the dispatch
   (`rootSessionId`) so T6 can resume it. The engine's MCP server, the merge
   queue, verification, examination, routing and correction are the existing
   code, unchanged; the run's `executionLocation` is `remote`. `running` is
   written when the root's agent starts.
2. **Publication intent** (`packages/execution/src/publish.ts`): after each
   successful `integrateNode` (and after a checkpoint that moves the program
   branch), the engine writes a git bundle of `<previousPublishedHead>..<head>`
   to `/workspace/runs/<runId>/bundles/<head>.bundle`, uploads it to the
   artifact bucket under `runs/<runId>/bundles/<head>.bundle` (the instance
   role's one S3 grant), and `POST /runs/{runId}/publication` with `{ branch,
   head, expectedPredecessor, bundleKey }`. Local runs do none of this: the
   hook is installed by the runner's composition only (`publishOnLanding` on
   `EngineOptions`, absent locally). Only the program branch is ever named
   (D-P10-01); a provisional ref is never published.
3. **Publisher Lambda** (`apps/api/src/lambda/publisher.ts`, invoked by the
   publication route after the intent is recorded `pending`): one at a time per
   `(repository, branch)` through a conditional write on the intent (`inFlight`);
   fetches the bundle to `/tmp`, verifies it (`git bundle verify`) and that its
   head is the intent's; mints an installation token (Contents write) from the
   App key in Secrets Manager; `git push https://x-access-token:<tok>@github.com/<o>/<r>
   <head>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<expectedPredecessor>`.
   Outcomes: `published` (records the head on the dispatch's `publication`),
   `conflict` (lease rejected: the branch moved; `publication.blocked` with the
   remote head, never retried with force, the run carries on and the report
   says so), `protected` (branch rules refused; same treatment), `error`
   (transient: retried up to three times with backoff; then `blocked`). Before
   any retry, `GET .../branches/{branch}` is read: if the head is already
   `head`, the lost reply is recorded as `published`. A `git` binary is bundled
   with the Lambda (a layer built in the runner stack from the AL2023 package).
4. **Installation recording** (`apps/api/src/operations/github.ts`, from T1):
   `GET /github/app` returns the App's slug and installation URL from the
   secret's `appId` (the slug through `GET /app`); `PUT /orgs/{orgId}/github`
   verifies through the App that the installation id belongs to an account
   the caller's org may claim (the installation's account login is recorded,
   and a second org claiming the same installation is refused), lists its
   repositories, and stores them. T3's dispatch refusal reads this record.
5. **Engine token in practice** (`apps/api/src/tokens/mint.ts`): `role: engine`
   minted by the bootstrap route against the SSM secret (single use: the route
   deletes the parameter), carrying `generation`, lifetime 3600 s capped by the
   run's remaining wall clock; renewed by the heartbeat route with the current
   generation; the `mintAgentToken` route accepts an engine principal for its
   own run's agents. Worker tokens' lifetimes are renewed by the engine before
   expiry through the same route (`execution/environment.ts` gains a
   `renewToken` the runner composition supplies and the local one leaves
   absent). No agent mid-task sees an expired credential: a test runs a fake
   worker across two renewals.
6. **Tests, offline**: the publisher over a local bare repository as "GitHub"
   (push with lease succeeds; the branch moved → conflict and no force;
   predecessor already at head → published without a push; bundle head
   mismatch → refused); the engine's publication hook fires once per landing
   and never for a provisional ref; `role: engine` through `authorize` for
   every operation (the allowed set and the refused set both enumerated); a
   stale generation refused on the mint route; the installation claim refusal.

## Acceptance

- SC-P10-01's publication half and SC-P10-11's renewal half proven offline;
  SC-P10-04's parallel-worktrees half proven live.
- Live, from a developer machine: a dispatched fixture program runs to the
  end and `wildorder/nightshift-remote-fixture`'s program branch holds the
  expected commits, with the dispatch's `publication.head` equal to the
  branch's head.
- `npm run verify` green.
