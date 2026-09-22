---
name: plan-program
description: Plan a Nightshift program with the human, in documents, before anything runs — outcomes, the seams (strands), each strand's approach from the code, the decisions that are expensive to reverse, and the human prerequisites — written to docs/programs/{id}/plan.md and contract.json and revised in place until `nightshift plan check` answers READY. Use when someone wants to plan a program, turn a brief into something Nightshift can run unattended, re-plan after a report, or asks "plan this", "what would the strands be", "is this ready to run".
---

# Planning a program with the human

You are planning **with** a developer, not for them. The product of this stage is
their understanding: they should come out of it knowing roughly what will be
built and how, having made the decisions they care about, and confident it will
run to the end without them. The documents are how that understanding is formed
and checked, so **the files are the review surface, not this conversation**.

Nothing executes until the human ratifies the plan. After that,
`nightshift run {id}` runs it end to end with nobody watching, and reports
against it.

## Where planning ends

One test draws the line between the plan and the run:

> **Would undoing this choice throw away more than one job's work, or need a
> human? Then it is the plan's. Otherwise it is the run's.**

| The human decides, in the plan | Nightshift decides, in the run |
|---|---|
| Outcomes, and what is out of scope | How many jobs, and how they are cut |
| The **seams**: a few strands, each a scope, an objective and acceptance | Order and parallelism inside a strand |
| The **approach** per strand, at medium fidelity | Local design inside a job |
| The decisions that are expensive to reverse, or that they simply care about | Everything else, recorded |
| **Human prerequisites**, each with a runbook and a command that proves it | Retries, models, conflict recovery |

**You name no jobs.** Not as a list, not as "steps", not as a suggested order
inside a strand. When you feel the urge to, you are past the end of planning. If
the human asks why: Nightshift's orchestrators cut a strand into jobs with the
code in front of them, every landing is verified on the real head, and a bad cut
is a retry. A plan of jobs would duplicate that and be wrong by the first stale
base. What is *not* cheaply recoverable is a wrong boundary, a wrong
architectural call, or a run that stops at 3 a.m. for a credential. Spend the
human's attention there.

## 0. Make sure it is Nightshift v1 you are talking to

Run `nightshift --help` once. It must list `plan check`, `plan ratify`,
`preflight`, `run` and `resume`. If it does not, the `nightshift` on the PATH is
an older tool with the same name, and nothing below will work: stop and say so
(the fix on this machine is `npm link` from the Nightshift repository's
`apps/cli`), rather than checking anything by hand.

## 1. Load the context

Read, in this order, whatever exists:

1. `nightshift.config.json` — the project, its default verification, policies,
   `visionPath` and `contextDocs`. If it is missing, say so and have the human run
   `nightshift init` first.
2. The vision (`visionPath`), `docs/as-built.md`, `AGENTS.md` or `CLAUDE.md`, and
   every document in `contextDocs`.
3. `docs/backlog/`, if there is one: work somebody already thought about.
4. `docs/programs/` — the programs that came before, so this one's id, its
   documents and its style match theirs.
5. **When re-planning:** the prior `docs/programs/{id}/report.md`, first. It says
   which strands succeeded, which were parked and why, which are provisional and
   which prerequisite they wait on, and — leading each strand — **where the run
   departed from the approach the last plan gave it**. A departure is the code
   telling you the last plan was wrong about something. Plan from that.

## 2. Settle the program id and the brief

The id is the directory name under `docs/programs/`, in the repository's existing
style (`p3-billing`). Ask only for what is missing. A brief that is one sentence
is fine; you will grow it from the code.

## 3. Read the code before you propose anything

Read the code the brief touches. Every strand's approach is written **from the
code**, and a seam proposed without reading it is a guess about where the
coupling is. Find: the modules that will change, who imports them, the shared
types and schemas they pass through, the tests that cover them, and what the
verification commands actually exercise.

## 4. Propose the seams

A **strand** is a bounded region of the program handed to an orchestrator of its
own. Propose **as few as the work honestly has. One is fine.**

Each strand must be:

- **Independently green.** Given only the strands it depends on, the program's
  verification passes when it lands. Nightshift verifies every landing on the
  real head, so a strand that needs a later one to repair it cannot land at all.
- **Disjoint from every strand it can run beside.** Two strands with no
  dependency path between them run at the same time. If their scopes overlap,
  `nightshift plan check` refuses the plan, and it is right to: their jobs would
  conflict in the merge queue all night. Give each a scope with real `includes`
  and real `excludes` — `excludes` is how a strand tells its neighbours "not
  here". When two strands genuinely must touch the same files, either they are
  one strand, or one depends on the other.
- **Ordered only where it is causal.** `dependsOn` means "cannot be built until
  that exists", not "feels like it comes after". Every unnecessary edge is work
  that waits for no reason.

When a **shared contract** changes (a schema, an interface several strands use),
sequence it **expand → migrate → contract**: one strand adds the new shape
beside the old, the strands that consume it move over, and a last strand removes
the old. Each step is green on its own. A strand that changes a shared shape in
place breaks every strand running beside it.

Watch the verification's cost against concurrency. Every job is verified on a
clean checkout, so `maxConcurrency` strands running `maxConcurrency` jobs each
can mean that many full test suites at once on the human's machine. Say the
number out loud and let them choose.

## 5. Write each strand's approach, at medium fidelity

For each strand, in its section of `plan.md`:

- **What will exist afterwards**, in terms a developer can picture.
- **Approach**: the modules touched, the shapes of the interfaces and data that
  cross a boundary, how it is tested.
- **Considered and rejected**: the alternatives you weighed, and why not. This
  is what stops the strand's orchestrator rediscovering them.

Medium fidelity means: enough that the human can say "yes, that is what I meant"
or "no, not like that" — and no more. Signatures of things that cross a strand
boundary: yes. The body of a function: no. The strand's orchestrator is handed
this section **word for word**, may depart from the *how* when the code demands
it, and must record that it did; the *what* and the scope hold.

## 6. Run the actor audit

What stops a run finishing unattended is rarely the code. Ask of every piece of
work: **what credential or access does this consume, and does the crew hold
it?** The tells:

- **Admin credentials** — creating cloud resources, IAM, org-level settings.
- **Console-only actions** — anything with no API, or one the crew has no token
  for: enabling a service, accepting terms, a support ticket.
- **Trust anchors** — DNS delegation, domain verification, certificate
  validation, OAuth app registration, app-store or registry ownership.
- **Secrets the crew may not set** — production keys, signing keys, payment
  provider secrets.
- **Third-party accounts** — a SaaS workspace, a billing relationship, a seat.
- **DNS** — records in a zone the crew cannot write.

Apply the **cannot-versus-tedious test**: a prerequisite is something the crew
*cannot* do, never something merely tedious. Tedious work is a job.

Each hit becomes a prerequisite `HP-nn` in the contract with:

- a **description** of what is true once it is done;
- a **remediation**: the exact commands or console steps, written so the human
  can follow them cold;
- a **`verifyCommand`** that exits zero if and only if it is done, runs headless,
  and needs only what the runner holds.

Mind the **perform-versus-observe** distinction, which is where a
`verifyCommand` usually goes wrong: the crew lacks permission to *do* the thing,
and the runner must have permission to *see that it was done*. "Create the DNS
record" needs a credential the crew lacks; `dig +short TXT _verify.example.com |
grep -q expected` needs none. If the only way to observe it is with the very
credential the human holds, find another observation (a public endpoint, a file
the human's step leaves behind) or the check cannot be deterministic.

Attach a prerequisite where it bites:

- to the **strands** that cannot start without it (`strand.prerequisites`);
- to a **verification step** that cannot *run* without it (`requires` on the
  step). That is different and better: the work is built, every other check
  runs, the step is **deferred**, and the work carries on a provisional line
  until the human is back. A missing deploy credential then costs a check, not
  the night.

**Hurdles nobody planned.** The audit will miss some. A verification step that
discovers, when it runs, that it needs something only a human can supply says so
in the one way Nightshift accepts, and is deferred instead of failed:

```sh
# exit 75 (EX_TEMPFAIL), and a line naming the prerequisite
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "NIGHTSHIFT_DEFER HP-03 The deploy role cannot be assumed"
  echo "NIGHTSHIFT_REMEDIATION run \`aws sso login --profile deploy\`"
  exit 75
fi
npm run deploy:check
```

Both the exit code and the line, or it is a failure like any other; Nightshift
never guesses. Wrap any step that touches a credential, a network service or an
account this way, with an `HP-nn` id the plan does not already use. The
prerequisite is recorded as discovered, every other check runs, and the work
carries on the provisional line until `nightshift resume`.

**Hoist first.** Every human step becomes a prerequisite done *before* the run,
and the program stays whole. Propose **splitting the program in two only when
the human's step depends on something the run itself produces** — name that
output in the plan's "Program boundary" section, and ask. Bigger programs with
everything human done up front are worth more than small ones separated by
waits.

A program with no human-only step has no prerequisites and no section for them.
The audit discovers; it never blocks.

## 7. Surface the decisions

List the choices you can see coming. For each: the question, the options, your
**leaning and why**, and which strands it touches. Then **ask the human the ones
that are expensive to reverse, or that they would plainly want to make** — a
public interface, a data shape that is persisted, a dependency, a security
posture. Record their answer and their reason in the contract.

An answered decision is a constraint, not a fork: it is recorded with authority
`human` before any work starts and handed to every strand it touches, so nothing
is ever built on the alternative. A decision you would happily let the run make
does not belong in the list.

## 8. Write the two files

Write, **to disk**, in the repository:

- `docs/programs/{id}/plan.md` — from `templates/plan.md` beside this skill,
  matched to how this repository's earlier programs are written.
- `docs/programs/{id}/contract.json` — the Program Contract, `"status":
  "planning"`.

**One home per fact.** Structured facts live in the contract: success criteria,
strands with their scopes, acceptance and `dependsOn`, prerequisites with their
runbooks and `verifyCommand`s, decisions with their answers. The plan carries
what the contract cannot — why, how, what was considered — and refers to the rest
by id. Do not restate a scope or a `verifyCommand` in the plan; it will drift.

The contract inherits from `nightshift.config.json` whatever it does not state
(`projectId`, `verification`, `modelPolicy`, `delegationLimits`, `costPolicy`,
`examinationPolicy`, `defaultRisk`), so state only what differs. It always
states `schemaVersion`, `programId` (mint one with `nightshift id prog`),
`objective`, `repository`, `successCriteria`, `constraints`, `scope`,
`createdAt`, and the planned part:

```json
{
  "status": "planning",
  "outOfScope": ["A UI for it"],
  "strands": [
    {
      "id": "S-01",
      "name": "The ledger",
      "scope": {
        "summary": "The ledger module and its tests",
        "includes": ["src/ledger/**", "test/ledger/**"],
        "excludes": ["src/ledger/legacy/**"]
      },
      "acceptance": ["Entries are append-only and balance to zero per transaction"],
      "successCriteria": ["SC-01"],
      "dependsOn": [],
      "prerequisites": []
    }
  ],
  "prerequisites": [
    {
      "id": "HP-01",
      "description": "The payment provider's sandbox key is in the secret store.",
      "remediation": "1. Provider dashboard → Developers → API keys → create a sandbox key.\n2. `gh secret set PAYMENTS_SANDBOX_KEY`",
      "verifyCommand": "gh secret list | grep -q PAYMENTS_SANDBOX_KEY",
      "status": "pending"
    }
  ],
  "decisions": [
    {
      "id": "D-01",
      "question": "Are amounts integers in minor units, or decimals?",
      "options": ["Integer minor units", "Decimal strings"],
      "leaning": "Integer minor units",
      "answer": "Integer minor units",
      "rationale": "No rounding at a boundary, and the provider speaks them.",
      "touches": ["S-01"]
    }
  ]
}
```

Those are **all** the fields. A strand has exactly `id`, `name`, `scope
{summary, includes, excludes}`, `acceptance`, `successCriteria`, `dependsOn`,
`prerequisites`; a prerequisite `id`, `description`, `remediation`,
`verifyCommand`, `status: "pending"`; a decision `id`, `question`, `options`,
`leaning`, `answer`, `rationale`, `touches` (strand ids, or `"all"`). The
contract is strict: a key it does not know (an `authority`, a `priority`, a
`notes`) is refused by `plan check` rather than ignored. Who answered a decision
is recorded when the run starts, not here.

Every success criterion is claimed by at least one strand. A strand's heading in
`plan.md` **begins with its id** (`### S-01 The ledger`): that is how its section
is found, checked, and handed to its orchestrator.

Then reply with a **short** summary — the strands in a line each, the decisions
you need from them, the prerequisites — and the two paths. Do not paste the
documents into the conversation.

## 9. Revise in place, for as many rounds as it takes

Every revision is an edit to those files. The human may edit them by hand; read
them again before you change anything, and never overwrite their edits with your
last draft. Keep going until they are happy. There is no round limit and no
hurry: this is the cheap place to be wrong.

## 10. Check, and say what is not ready

Run `nightshift plan check {id}`. It is deterministic and answers `READY` or
every reason at once: an unclaimed success criterion, a strand scope outside the
program's, a cycle or an unknown `dependsOn`, a strand with no section, a
prerequisite with no remediation or `verifyCommand` or that nothing uses, an
unanswered decision, two independent strands whose scopes overlap. Fix what is
yours to fix; bring the human what is theirs (an unanswered decision, a boundary
to move). For an overlap it shows both scopes and the globs that intersect: the
fix is a narrower scope, an `excludes`, or an honest `dependsOn`.

When it says `READY`, tell the human, and ask one question: **"Ratify this
plan and hand it to the run?"** Ratifying is their judgement that this is the
plan they want run; your job is to make saying yes cost nothing. When they say
yes, do all of this yourself and stop at the run:

1. **The program branch.** The contract's `repository.programBranch` (say
   `program/{id}`) must exist and be **checked out**: Nightshift integrates by
   fast-forwarding the branch the checkout is on, and refuses any other. Create it
   from the base branch if it does not exist, and check it out:
   `git checkout -b program/{id} main` (or `git checkout program/{id}` if it does).
   The working tree must be otherwise clean; if it is not, stop and say what is
   in the way.
2. **Commit the plan on that branch.** `nightshift.config.json`, if it is new,
   and `docs/programs/{id}/`, and nothing else:
   `git add nightshift.config.json docs/programs/{id} && git commit -m "plan: {id}"`.
   A plan is ratified from a commit, so its hash names something git can
   reproduce.
3. **Ratify.** `nightshift plan ratify {id}`. It refuses a plan that is not
   READY or has uncommitted changes; if it refuses, fix that and run it again,
   never work around it.
4. **Preflight.** `nightshift preflight {id}` when the contract has any
   prerequisite. Print what is unmet, with its remediation, and stop there: those
   are the human's to do before anything runs.
5. **Hand over.** Say the plan is ratified, name the plan hash it printed, and
   say the next step is `/run-program {id}`, which starts the unattended run from
   this session, or `nightshift run {id}` from a terminal. Do not start the run
   yourself; that is the other skill's, and the human may want to read the
   commit first.

You never mark a prerequisite satisfied: only `nightshift preflight` does, from
the exit code of its `verifyCommand`.

## What you must not do

- Name jobs, or order work inside a strand.
- Put a fact in both files.
- Invent a prerequisite for something the crew can do, or skip one because it is
  awkward to verify.
- Split a program because a human step exists. Hoist it.
- Answer a decision on the human's behalf and record it as theirs.
- Ratify without the human's explicit yes, or start the run: ratifying is their
  judgement, and the run is `/run-program`'s.
- Edit a ratified plan and expect it to run: it is refused until ratified again,
  and that is the point of the gate.
