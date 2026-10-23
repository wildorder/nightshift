# P21 Plans in the Plane

## Overview

A plan has to be committed before it can run. `nightshift plan ratify` refuses
a plan whose `docs/programs/{id}/` differs from HEAD, "its hash would name
nothing git can reproduce" (`packages/execution/src/start-run.ts`, via
`ratifyPlan`), and the plan-program skill's last step is to create
`program/{id}`, commit the plan onto it and push it. That is the ceremony the
owner wants gone.

It is incidental. The control plane already holds everything a run executes:
the merged contract, the plan text and the conversation, each stored by its
sha256 (`apps/api/src/operations/plans.ts`, the `plans/` artifact prefix). The
plane re-hashes and re-checks them itself at ratification. A remote machine
fetches the plan by hash and re-checks it (`RunnerPlane.planDocument`), and the
headless root, every strand's brief and the Studio already read only the plane.
Git is load-bearing for code alone: the base commit, landings, strand branches
and carry-over. What still reads the plan from the repository is a short list:
the ratify refusal, the commands that find a program by scanning
`docs/programs/*/contract.json` on disk, `run.start` and `decision brief`
reading `plan.md` from disk, and three engine paths that read the *committed*
contract at a commit (gate repair, project setup, a strand's step tools).

P21 makes the plane the plan's only home:

- **A draft lives in the plane**, as content-hashed versions, written by
  whoever plans (a person, or later an agent) and readable from anywhere.
- **Approval is a stored hash**: ratifying a draft version needs no file on
  disk, no commit and no branch made by a person.
- **`nightshift run` makes the program branch itself** and pushes it.
- **Nothing reads the plan from git.** When a planned run finishes, Nightshift
  commits `docs/programs/{id}/` (plan, contract, conversation, report) onto the
  program branch as a publication of the history, and nothing reads it back.

It is shaped for what comes after it (Pipkin PK-16 and PK-17): a request comes
in, an agent writes the plan, and the owner reads it, answers its decisions one
at a time, asks for changes or approves it, from wherever they are. P21 builds the
records and the API that flow needs. The channels it arrives on are not P21's.

Out of scope, in prose:

- Delivering a plan or a decision to Slack, WhatsApp, email or any channel.
- Taking requests or bug reports in, and agents writing plans from them.
- Approving or answering decisions in the Studio (D-04).
- Changing how a plan is hashed: existing ratifications stay valid.

## Who it is for

US-01 is the owner as they plan today: every program ends with a branch made by
hand and a commit of documents nobody reads in git. US-02 is the same owner
away from their desk, and the people and agents who will propose work to them: the
plan is theirs to read and decide on from anywhere, so it cannot live on one
laptop. US-03 is a future agent working in the repository, for whom the history
of what was planned and what happened is useful context; that copy is a record,
not an input.

## Architecture

**The draft.** A new project-scoped `PlanDraft` record per program, holding an
ordered list of versions. A version is three content-hashed documents (the
contract, `plan.md`, the kept conversation), stored through the existing plan
document upload path, plus its author: a human principal, or an execution
principal (an agent's identity), recorded from the caller, never claimed. A
draft has a state: `draft`, `awaiting_owner` (an author says it is ready for a
decision), `ratified`, `declined`. Writing a version never changes an earlier
one. The plan hash is computed exactly as today (`planHashOf`), so a version is
ratified by its hash and an existing ratification still names the same thing.

**Who may do what.** Any principal with access to the project may write a
version. Answering one decision, requesting changes (a recorded note on a
version), declining and ratifying are acts of a human principal only, through
the API: an agent proposes, a person disposes. Answering a decision writes a
new version whose contract carries the answer, so the hash moves and the
history shows who answered what. The existing `program.ratify` operation
ratifies a draft version by hash; the check it runs today (re-hash, `checkPlan`)
is unchanged.

**Finding a program.** Every command that today finds a program by reading
`docs/programs/*/contract.json` (local `run.attach`, `run.start`, `resume`,
`report`, `preflight`, `gates`, `rate`, `decision`) finds it by its directory
name in the plane, so a repository holds no plan files at all. A program
planned the old way, with committed files, keeps working: its files are the
first version of a draft, put on the first `run` that sees them.

**The engine.** Gate repair, project setup and a strand's step tools read the
plane's contract instead of the committed one (`authoredContractAt` in
`packages/execution/src/gate-repair.ts`), and a strand's token gains reading of
its own program's contract. `decision brief` reads the plan the run executed
(`rootNode.plan`), not the disk.

**The publication.** At the end of a planned run, Nightshift writes the
ratified contract, plan, conversation and the report into
`docs/programs/{id}/` and commits them onto the program branch (D-03). The
program branch has moved only by verified landings until now; this is the one
other commit, and only ever for that directory.

## Strands

### S-01 Drafts and approval in the plane

#### Approach

- **Contract and storage.** `PlanDraft` and `PlanDraftVersion` in
  `packages/contracts` (a project-scoped aggregate, as `GateHealth` is), its
  store port and every adapter (memory, SQLite, DynamoDB, HTTP), and the
  conformance suite. Versions reference documents by sha256 through the existing
  `plan-documents` upload; nothing large lives in the record.
- **API.** Under the program: put a version; list versions; read the latest or
  one version with its `checkPlan` result (computed by the plane, from the
  stored documents, so it is the same answer everywhere); answer one decision;
  request changes; set `awaiting_owner`; decline; ratify a version by hash.
  Authorization in `packages/core/src/rules/authorize.ts`: writing a version is
  open to the project's principals, an agent's included; answering, requesting
  changes, declining and ratifying are human-only.
- **CLI.** `nightshift plan put <id> --dir <scratch>` writes a version from a
  directory of the three files (the planning session's scratch, outside any
  repository); `nightshift plan show <id> [--version n]` prints it and its
  check; `nightshift plan check <id>` checks the plane's latest version (and
  `--dir` a scratch before putting it); `nightshift plan ratify <id>` ratifies
  the latest version; `nightshift plan conversation` stores the kept
  conversation into the next version instead of a repository file.
- **Ratification without git.** `ratifyPlan` loses its uncommitted-files
  refusal: the hash names the stored documents, which is what git used to
  vouch for.
- Tests: a version is immutable; a stale write (from an older version) is
  refused; an agent can write but not ratify, answer or decline; answering a
  decision makes a new version that `plan check` accepts; ratifying a version
  records the same ratification shape as today.

#### Considered and rejected

- Drafts as files outside the repository: one machine's, invisible to the
  owner away from it, and lost with the laptop.
- Drafts untracked inside the repository: every landing would need an
  exemption from the clean-checkout check.
- Editing a version in place: it would lose who wrote what, which the review
  flow depends on.

### S-02 Runs that need no plan in the repository

#### Approach

- **Finding a program from the plane** for every command listed in the
  Architecture, by directory name and project, with the old on-disk path kept
  only for the first-run import of committed files.
- **`nightshift run` makes the program branch**: when `program/{id}` does not
  exist locally or at origin, it is created from `repository.baseBranch` at its
  head and pushed, then used exactly as today (`publishProgramBranch`,
  `startRun`). A local run checks it out first; a remote one needs only the
  push.
- **The engine reads the plane's contract**: gate repair and project setup
  (`gateDefinitionsAt`, `projectSetupProgram`) and the strand's step timeout and
  skip tools (`contractGatesAt`), with a strand token allowed to read its own
  program's contract. `run.start` takes the plan text from the plane.
  `decision brief` reads the executed plan from `rootNode.plan`.
- **The publication at finish** (D-03): after `run.finish` writes the report,
  the engine commits `docs/programs/{id}/{contract.json,plan.md,conversation.md,report.md}`
  from the plane's ratified documents onto the program branch, and the
  publisher pushes it. A core rule refuses that commit if it touches any other
  path.
- Tests: an end-to-end run of a plan that exists only in the plane, from no
  branch, through landing and finish, with the published directory on the
  branch and nothing else changed by it; an old program with committed files
  imports and runs; a strand's step tools work with no committed contract.

#### Considered and rejected

- Keeping the committed contract as a fallback the engine reads: a stale copy
  would be read as the truth and disagree with the plane.
- Publishing the docs at run start: the run's own history would not be in it.

### S-03 Reading a draft in the Studio

#### Approach

A plan page per program in `apps/studio`: the latest version rendered (stories,
strands, decisions with their answers and who gave them, prerequisites), its
`plan check` result, its state, and earlier versions with what changed. Read
only (D-04). Linked from the project page and from a run's plan.

#### Considered and rejected

- Answering and approving here now: deferred to D-04's answer.

### S-04 The skills and the record

#### Approach

The `plan-program` skill writes drafts with `nightshift plan put` from a
scratch directory, reads them back with `plan show`, and its last step is
`nightshift run {id}`: no branch, no commit. The `run-program` skill drops its
program-branch and committed-plan preconditions. `test/src/skills/` pins the
new wording. `docs/architecture.md` records the ruling as a decision that
amends A-58; `AGENTS.md` and `docs/vision.md` say where a plan lives.

#### Considered and rejected

- Leaving the old steps as an alternative: two ways to plan is one too many.

## Decisions

The answers and rationales are in the contract. D-01 and D-02 were the owner's
in the planning conversation; D-03 and D-04 are open.

## Risks

- **Old programs.** Every program before P21 has committed files; the import on
  first run is the compatibility path and needs its own test.
- **Authorization.** Drafts are writable by agents; the human-only acts are the
  safety, and their tests are the program's most important.
