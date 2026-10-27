# P23 Project Line

## Overview

Pipkin M1b: PK-3 (PIP-9), "one owner per development line". A project gets one
development line (`nightshift/develop`) where every program's landed work meets.
A single **line owner**, started by the control plane when work is queued and
stopped when the line has caught up, composes it: it merges main and each
program branch's new range onto the line head, checks the result, and publishes
the line. Conflicts and breaks between programs are repaired by a resolver agent
on the same machine and recorded. Separately, a program gets at most one live
run at a time.

Runs do not change. They land on their program branches exactly as today, never
wait on the line, and cannot be failed by it. Programs still reach main through
their own pull requests (D-05). Release candidates (M2) and landing on targeted
checks (PK-7) build on this line later.

## Who it is for

US-01 is the owner running several programs at once, who today finds out two
programs break each other only when their pull requests meet main. US-02 is the
owner starting runs, who can today start two runs of one program by accident and
is left with runs that were recorded but never started.

## Architecture

How the design was reached (the conversation holds the reasons): the owner chose
an optimistic line with no lease, then a single line owner over each run
composing for itself (D-01), measured against Scion: server-side merging, one
authority moving the shared ref, producers never blocked. Its one departure,
checking before the line moves, is deliberate for now; PK-7 turns it into
Scion's post-merge proving in one place, with batch and bisect.

```
 run A ─ lands on program/A (as today) ─ publisher pushes program/A ─┐
 run B ─ lands on program/B (as today) ─ publisher pushes program/B ─┤ queue entry
                                                                     ▼  { line, program, upTo }
                          control plane: no live line owner? start one (a "line" dispatch,
                          at most one per line, generation-fenced; self-started compute cap)
                                                                     ▼
                          LINE OWNER (runner image, warm snapshot)
                          take everything queued → merge main, then each program range,
                          onto the line head → landing checks (`line` phase)
                          green → publisher pushes the line (compare-and-swap) → outcome back
                          red / conflict → one range at a time → resolver on the failing one
                          idle for the idle period → exit, machine stops
```

What the code map (2026-10-27) found, and why the design avoids it:

- A strand that has integrated cannot be reopened (`integrated` is terminal and
  its worktree and branch are released), so repairs belong to the line, not the
  strand.
- A run's engine has no GitHub read path mid-run (its checkout's origin is the
  machine's mirror, deliberately), and publication is fire-and-forget, so the
  engine never learns a push's outcome. The line owner is a machine of its own
  that reads GitHub as any machine does at boot, and S-02 gives it the push
  outcome.
- The publisher already pushes by compare-and-swap (receive-pack with the
  expected old value), and its write token is branch-agnostic; its branch is
  hard-wired to the run's program branch and its strand path refuses anything
  but a run's own branches, so the line needs a third, explicit path validated
  against the configured line. A line refusal must never block a run's chain.
- Runs are written unconditionally and nothing ends a run that never started;
  S-01 adds the guard, modelled on the conditional-put publish lock and the plan
  drafts' transactional writes.

The word "line" already names the provisional line in the code; docs say
"project line" (D-08).

## Strands

### S-01 One live run per program

**What will exist afterwards.** Starting a run of a program that has a live run
is refused by the control plane, naming the live run, and the CLI says so. A run
that was recorded but never attached or dispatched stops counting once it is old
enough. Ending a run, however it ends, frees the program.

#### Approach

A per-program live-run marker written in the same atomic operation as the run
(the DynamoDB transactional write the plan drafts use; the memory/SQLite store's
equivalent), released on every terminal transition. At start, a pending run past
the grace period with no attach and no dispatch is ended as interrupted, "never
started", first (D-07). The refusal travels as a typed conflict through the API
to `nightshift run` and `remote` dispatch. The conformance suite proves the guard
on all three stores.

#### Considered and rejected

- A check-then-create in the CLI: two starts race between them.
- A sweeper Lambda for stale pending runs: more moving parts for a case the next
  start can settle.

### S-02 The project line in the plane

**What will exist afterwards.** A project can name a line in
`nightshift.config.json`. When the publisher pushes a remote run's program
branch, its new range is queued for the line, and if no line owner is live the
plane starts exactly one. The publisher can push the line by compare-and-swap
and tell the owner what happened. Self-started compute has its own monthly cap.
`nightshift line status` shows the line.

#### Approach

- Contracts: the `line` setting (D-08); a line record per project line (head;
  queue entries `{program, upTo}`; composed commits with their program ranges,
  verification id and any resolver decision; parked compositions); a `line`
  dispatch kind; the publication of a line head with its expected predecessor;
  a `line` verification phase, not landing evidence.
- Plane: the publisher, after a program branch push succeeds, appends a queue
  entry when the project has a line; a conditional write keeps one live line
  dispatch per line, fenced by generation like a run's; a line push path in the
  publisher with a real lease and its outcome readable by the owner (a refusal
  is an outcome, never a block on the run's chain); the self-started cap (D-04),
  metered like runs' compute, recorded on the line when reached.
- The provisioning path learns the `line` dispatch kind (it launches the same
  image and the project's warm snapshot), with whatever infra grant it needs.
- CLI: `nightshift line status`.

#### Considered and rejected

- Reusing the run's publication chain for the line: a refused line push would
  block the run's own landings.
- A lease held by runs: it would recreate Scion's lock, and the owner already
  serialises the line.

### S-03 Composition and the resolver

**What will exist afterwards.** A composition engine in
`packages/execution/src/line/`, behind ports for the queue, the git checkout,
verification, publication and agent launch, so it is tested offline and S-04
only wires it.

#### Approach

- Take every queued entry up to a cap; group by program; for each program, its
  range is "everything on the program branch since it was last composed". Merge
  main, then each range, onto the line head in a fresh worktree; run the landing
  checks (never `at: "end"` steps) as a `line` verification (the phase S-02 adds
  to P22's vocabulary, classified as not landing evidence); record the batch's
  members on it.
- Green: the line head to publish. Red or conflict: compose the ranges one at a
  time; the first that fails goes to the resolver (D-02).
- The resolver: an agent launched with the failure as its brief, working from the
  line head; its fix goes through the same checks and an examination by a
  different model before it is published; recorded as a decision with the line
  as its authority; three failed attempts or an hour parks the composition and
  the queue moves on (D-03, D-04).
- Ports keep it free of the plane and the runner; tests drive real git
  repositories, as the strand-build tests do.

#### Considered and rejected

- Composing strand by strand: a program's strands are already proven together on
  its branch, and its branch's history is the order.
- Rebasing ranges onto the line: it rewrites commits main will later receive
  through the program's pull request; merges keep them identical.

### S-04 The line owner on a machine

**What will exist afterwards.** A line dispatch boots the runner as the line
owner: it reads GitHub as a machine does, drains the queue with S-03's engine
through S-02's plane, recomposes when the publisher refuses, and exits when the
queue has been idle for the idle period. A replacement after a lost machine picks
the queue up where it stood. An end-to-end test proves it.

#### Approach

- Runner: a line mode beside the run mode, sharing boot, heartbeat, token and
  snapshot handling; it fetches the line, main and the queued program heads into
  its mirror and checkout, then runs S-03's engine with the plane's ports.
- Idle exit and lost-machine recovery reuse the dispatch lease and generation.
- End to end: a local plane, the git HTTP server the publisher tests already use,
  two programs' landings, a composed line, and a conflict the resolver repairs.
- Docs: a decision row in `docs/architecture.md` for the project line and the
  line owner; the run-program skill mentions the line where it talks about
  landings.

#### Considered and rejected

- Composing on the run's own machine: it ends with its run, and two runs would
  be two composers.
- A serverless composer: the checks need the project's prepared environment.

## Decisions

D-01 to D-08 are answered in the contract.

## Risks

- The line owner is a single point: the queue lives in the plane and the owner
  is generation-fenced so a lost machine is replaced and two never run at once.
  Its jobs, and S-02's publisher path, are high risk and examined.
- The publisher changes: a line refusal must not block a run's chain; S-02's
  tests drive both paths against a real git server.
- Squash merges into main would make the line see the same change twice; D-05
  requires merge commits, and the docs say so.
- Self-started spend: the cap and the per-composition limits are tested at their
  edges.
