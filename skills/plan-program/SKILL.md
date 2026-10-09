---
name: plan-program
description: Plan a Nightshift program with the human, in documents, before anything runs — who it is for and why (user stories in the human's own words), outcomes, the seams (strands), each strand's approach from the code, the decisions that are expensive to reverse, and the human prerequisites — written to docs/programs/{id}/plan.md and contract.json, with the conversation that shaped them kept in conversation.md; it audits the repository's gates against Nightshift's gate standard first, with the human, and turns each finding into a decision and a gate-health strand S-00; and it is revised in place until `nightshift plan check` answers READY. Also plans a correction after the human reverses a decision, from its brief. Use when someone wants to plan a program, turn a brief into something Nightshift can run unattended, re-plan after a report, correct a reversed decision, or asks "plan this", "what would the strands be", "is this ready to run", "correct D-…".
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
| **Who it is for and why**: the user stories | Nothing: a run never writes a story |
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

## 2a. Who is it for: the stories, first

Before any seam, find out **who this program is for and what changes for
them**, and write it down as **user stories**. Everything after is judged by
them, and the Studio and the report lead with them the next morning, when the
human has forgotten the details and a criterion like "tenant billing data is
isolated" means nothing on its own: which tenant, isolated how, and who would
notice?

A story (`US-nn`) has:

- **who**: a role, not a person. "A customer's billing admin", not "users".
- **problem**: what goes wrong for them **today**, concretely. "A support query
  can return another company's invoices", not "data is not isolated".
- **outcome**: what is different for them **afterwards**, in terms they would
  notice. "They only ever see their own company's invoices."
- **words**: the human's own sentences that say why, **copied exactly** from
  what they typed in this conversation, typos and all. Choose the sentences; never
  reword one. `nightshift plan check` refuses a quote that is not, word for word,
  in the human's kept messages (§8a). If they never said it, leave `words` out
  rather than put words in their mouth.

Ask the human when you do not know. Most programs have one to three stories; a
refactor still has one (who suffers from the code as it is?).

Then write each **success criterion** in plain words a newcomer could check, and
say which stories it `serves`. Every criterion serves a story and every story is
served by a criterion, or the plan is not ready.

## 3. Read the code before you propose anything

Read the code the brief touches. Every strand's approach is written **from the
code**, and a seam proposed without reading it is a guess about where the
coupling is. Find: the modules that will change, who imports them, the shared
types and schemas they pass through, the tests that cover them, and what the
verification commands actually exercise.

## 3a. Audit the gates

Nightshift can only be as good as the repository's gates, and the human is here
now, not at 3 a.m. Audit them **before you propose any seam**, in the
foreground. **The human waits for it, on purpose**: they are initialising
Nightshift on this repository, and every fix is theirs to decide up front, not
the run's to discover. Say so when you start, and roughly how long the gates
took last time if you know.

**First, a draft to audit from.** The gate commands read
`docs/programs/{id}/contract.json` and `plan.md`, and check out the program
branch. If they do not exist yet, make them now:

- write a first `contract.json` (as in step 8, `"status": "planning"`) with what
  you already have: the fields it always states, the stories and success
  criteria from step 2a, and `setup` and `verification` only where they differ
  from `nightshift.config.json`. No strands yet;
- write `plan.md` from `templates/plan.md`, as far as you have got;
- create the program branch from the base **without** checking it out, if it
  does not exist: `git branch program/{id} main`. The audit runs on its head,
  which is the base until anything lands.

The rest of the plan is written into these same files in step 8.

1. **Is there a record that still holds?**
   `nightshift gates {id} --recorded` reads the project's gate-health record
   from the control plane and says whether it still holds for the gates on the
   program's commit. It runs no gate. **Exit 0** means a healthy record matches
   the current fingerprint (the setup and gate commands, the lockfiles, the
   gate-machinery files the last audit named): skip the rest of this step and
   tell the human the gates were audited before and nothing they depend on has
   changed. Anything else (no record, a changed gate-machinery file, a
   `repairing` record, not signed in) means audit; say which it was.
2. **Run the gates.** `nightshift gates {id}`, in the foreground. It runs setup
   and every check once in a fresh checkout of the base, exactly as
   verification will, and prints each gate's verdict and time.
3. **Review the gate machinery** against `gate-standard.md` beside this skill:
   its seven numbered rules, how to check each, and the typical fixes. Read the
   package scripts and their `pre`/`post` hooks, the test and build configs,
   anything that assumes CI's environment, the registries a new test or module
   must be added to, and the `setup` and `verification` in
   `nightshift.config.json` and the contract. **Name every gate-machinery path
   you read**: they are what the record is fingerprinted on.
4. **Each finding becomes a decision** `D-nn`, in the contract's `decisions`
   and in `plan.md`'s Decisions: the rule it breaks, what you found, the fix
   options and your leaning. The human answers it like any other. A finding
   they wave off is still a decision, answered "leave it" with their reason, and
   is not argued again. Keep findings few and real (the standard says why).
5. **Anything to fix becomes the gate-health strand `S-00`.** Its scope is the
   gate machinery the answers touch; its acceptance is the answered decisions
   built and `nightshift gates {id}` green. **Every other strand's `dependsOn`
   includes `"S-00"`**, so nothing is built on gates that are about to change.
   With nothing to fix there is no S-00.
6. **Record it.** Write the audit to a file **outside** `docs/programs/{id}/`
   (a temp path: the control plane holds the record, not the repository):

   ```text
   {
     "machinery": ["package.json", "vitest.config.ts", "scripts/suites.json"],
     "findings": [
       {
         "id": "F-01",
         "rule": 1,
         "found": "`pretest` runs `npm ci`, so every test gate reinstalls",
         "decisionId": "D-03",
         "paths": ["package.json"]
       }
     ]
   }
   ```

   `machinery` lists **every** gate-machinery path you named, so changing any of
   them later brings the audit back; `findings` may be empty; each finding's
   `rule` is the standard's number (1–7) and its `paths` are the machinery it
   touched. Then `nightshift gates {id} --record --findings <file>`. It runs the
   mechanical audit itself and writes the record: `healthy` with no findings
   and green gates, `repairing` otherwise. It needs the human signed in
   (`nightshift login`).

Revise the record when the answers change what is to be fixed: write the file
again and run `--record --findings` again. `nightshift plan check` reads it
(step 10).

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

A strand's scope is **planning information, never a fence** (the owner's ruling,
2026-10-09). It is how `plan check` finds strands that may overlap, and its
orchestrator is told it as where the plan expects the work. No job is confined
to it, refused for leaving it or failed for a path outside it: a job changes
whatever the work needs. Draw scopes honestly so the overlap check means
something, not tightly to keep a job in.
- **Ordered only where it is causal.** `dependsOn` means "cannot be built until
  that exists", not "feels like it comes after". Every unnecessary edge is work
  that waits for no reason.

When a **shared contract** changes (a schema, an interface several strands use),
sequence it **expand → migrate → contract**: one strand adds the new shape
beside the old, the strands that consume it move over, and a last strand removes
the old. Each step is green on its own. A strand that changes a shared shape in
place breaks every strand running beside it.

**Setup is not verification.** Every checkout Nightshift creates starts from
what is committed: no installed dependencies, no generated code. What makes one
usable (`npm ci`, a codegen step) goes in `setup`, which Nightshift runs in each
checkout before an agent works there and before every verification. Never put an
install into `verification`, and never make a check install conditionally: that
hides a missing `setup` behind a slower gate. Setup runs often, so prefer a
command that is quick when there is nothing to do.

You ran `nightshift gates {id}` in step 3a, and the gate-health strand `S-00`
(if there is one) comes before every strand you propose here. If the plan
changes `setup` or `verification` after that, the fingerprint no longer matches
the record: run the audit of step 3a again (`nightshift gates {id}`, then
`--record --findings`) before you check.

Watch the verification's cost against concurrency (the standard's rule 7). Every
job is verified on a clean checkout with every gate, so `maxConcurrency`
strands running `maxConcurrency` jobs each can mean that many full test suites
at once on the human's machine. Say the number out loud, from the times the
audit printed, and let them choose.

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
it, and must record that it did; the *what* holds. The scope is where the
plan expects the work, not a limit on it.

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

## 6a. Say how much each strand could hurt

Every strand's work is routed and examined by its **risk**, under the org's
policy (`nightshift org config get` shows it): usually low is not examined, medium
is examined by a different model and high by another provider's frontier model,
and at both a material finding stops it landing until it is fixed or ruled on. The contract's `defaultRisk` is what a strand's jobs get when nobody
says otherwise, so set it to what this program actually risks, and say in a
strand's section when part of it is riskier than the rest: its orchestrator will
mark those jobs high. Do not lower risk to make a run cheaper; the cost of a
wrong answer is the point of the setting. A repository or a contract may ask for
**more** scrutiny than the org (`examinationPolicy`) and **fewer** models
(`routing`), never less and never more.

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

Write, **to disk**, in the repository (over the drafts of step 3a):

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
(`projectId`, `setup`, `verification`, `modelPolicy`, `delegationLimits`, `costPolicy`,
`examinationPolicy`, `defaultRisk`), so state only what differs. It always
states `schemaVersion`, `programId` (mint one with `nightshift id prog`),
`objective`, `repository`, `successCriteria`, `constraints`, `scope`,
`createdAt`, and the planned part. The program's `scope` is `{ includes,
excludes, forbiddenActions }`: where its work is expected (every strand's scope
lies inside it) and the actions no agent may take ("deploy any stack", "push to
main"), which every agent's brief lists. It confines no job, and a `permissions`
list is no longer read.

```json
{
  "status": "planning",
  "stories": [
    {
      "id": "US-01",
      "who": "A developer reconciling the ledger",
      "problem": "Entries can be edited after posting, so month-end totals drift and nobody can say why.",
      "outcome": "Every transaction balances to zero and a posted entry can never change.",
      "words": ["I need to trust the ledger without re-adding it by hand"]
    }
  ],
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

Each success criterion is `{ "id", "outcome", "serves": ["US-01"] }`.

Those are **all** the fields. A story has exactly `id`, `who`, `problem`,
`outcome` and, when the human said it, `words`. A strand has exactly `id`, `name`, `scope
{summary, includes, excludes}`, `acceptance`, `successCriteria`, `dependsOn`,
`prerequisites`; a prerequisite `id`, `description`, `remediation`,
`verifyCommand`, `status: "pending"`; a decision `id`, `question`, `options`,
`leaning`, `answer`, `rationale`, `touches` (strand ids, or `"all"`). The
contract is strict: a key it does not know (an `authority`, a `priority`, a
`notes`) is refused by `plan check` rather than ignored. Who answered a decision
is recorded when the run starts, not here.

When the gate audit (step 3a) left anything to fix, the first strand is
`S-00`, the gate-health strand, scoped to the gate machinery, and every other
strand's `dependsOn` includes `"S-00"`.

Every success criterion is claimed by at least one strand. A strand's heading in
`plan.md` **begins with its id** (`### S-01 The ledger`): that is how its section
is found, checked, and handed to its orchestrator.

Then keep the conversation (§8a), and reply with a **short** summary — the
stories and the strands in a line each, the decisions you need from them, the
prerequisites — and the paths. Do not paste the documents into the conversation.

## 8a. Keep the conversation, every round

The human's reasons live in this conversation, and they are gone once it ends.
At the end of **every** round, keep what shaped the plan in
`docs/programs/{id}/conversation.md`:

1. `nightshift plan conversation {id}` lists this session's messages, numbered
   (the human's and yours, never a tool's), with `*` beside those already kept.
2. Choose the numbers of every exchange that **led to something in the plan**: a
   story, a criterion, a scope boundary, a decision and its answer, an
   alternative that was rejected. Judge a message by **what it led to, not by
   how far from the brief it wandered**: a tangent that ended in a decision stays;
   one that led nowhere does not. Keep the question an answer answered, or the
   answer means nothing.
3. Write a **short summary** of how the plan came about (what the human wanted,
   what changed their mind, what they ruled out) to a scratch file outside the
   repository. It is labelled as yours.
4. `nightshift plan conversation {id} --keep 3,7-9 --summary <file>`. It copies
   the chosen messages from the transcript word for word, masks anything shaped
   like a credential, and extends the file without duplicating what is there.

Tell the human the file is there and that they should **read it before it is
committed**: they may cut anything, and should not reword an excerpt, since the
stories' quotes are checked against it. When the repository or the contract says
`"keepConversation": false`, skip this step and leave `words` out.

## 9. Revise in place, for as many rounds as it takes

Every revision is an edit to those files. The human may edit them by hand; read
them again before you change anything, and never overwrite their edits with your
last draft. Keep going until they are happy. There is no round limit and no
hurry: this is the cheap place to be wrong.

## 10. Check, and say what is not ready

Run `nightshift plan check {id}`. It is deterministic and answers `READY` or
every reason at once: no story, a story missing who, problem or outcome, a
story no criterion serves or a criterion that serves no story, a quote the kept
conversation does not hold, an unclaimed success criterion, a strand scope outside the
program's, a cycle or an unknown `dependsOn`, a strand with no section, a
prerequisite with no remediation or `verifyCommand` or that nothing uses, an
unanswered decision, two independent strands whose scopes overlap; and for the
gates (D-P15-08): no gate-health record for the project, a record whose
fingerprint no longer matches the gates (re-audit, step 3a), a `repairing`
record with a finding whose decision is missing or unanswered, no `S-00` strand
or a strand that does not depend on it, and the control plane out of reach (it
says so: it cannot read the record). Fix what is
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
   from the base branch if it does not exist (step 3a usually made it), and check it out:
   `git checkout -b program/{id} main` (or `git checkout program/{id}` if it does).
   The working tree must be otherwise clean; if it is not, stop and say what is
   in the way.
2. **Commit the plan on that branch.** `nightshift.config.json`, if it is new,
   and `docs/programs/{id}/` (the plan, the contract and the conversation), and
   nothing else:
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

## Correcting a reversed decision

When the human has reversed a decision (`nightshift decision reverse`) and asks
you to correct the program under their new one, the correction is a program like
any other, planned with them from its **brief**:

```text
nightshift decision brief <program> <decisionId> --out docs/programs/<correction-id>/brief.md
```

Read the whole brief before proposing anything. It holds the fork in the road:
what was decided and why, the alternatives weighed and why each was rejected
(the human's new decision is often one of those, and why it was rejected is
what to watch for), the human's reason for reversing it, the commits the
decision produced and the files they touched, everything that landed after it,
and later decisions it may have shaped.

Then plan as in steps 2a to 10, with these differences:

- **The stories are the reversal's.** Who is hurt by the old choice and what
  changes for them under the new one; the human's reason for reversing is
  usually the quote.

- **Plan the change the new decision calls for, wherever it reaches.** The
  commits the decision produced are where to start looking, not a boundary:
  work that landed after it may depend on the old choice, and the new one may
  need changes nobody made yet. Say in the plan what the correction keeps, what
  it changes and why.
- **Write `corrects` into the contract**, one entry per decision corrected:
  `{ "programId", "runId", "decisionId", "reversedBy" }`, all from the brief.
  `plan check` refuses a `corrects` naming a decision the human has not reversed.
- **A decision whose effects reach outside the repository** (the brief flags it
  as irreversible or compensatable): say in the plan what happens to those
  effects. When something must be undone by a human, make it a prerequisite with
  a remediation, as in step 6. `plan check` flags it, and `nightshift run` asks
  the human to confirm (`--confirm-irreversible <decisionId>`) before it runs.
- The human ratifies it as always. Never ratify or run a correction without them.

## What you must not do

- Reword the human and call it a quote, or keep a message that is not theirs as
  their words.
- Drop an exchange that led to something in the plan because it wandered, or keep
  a tool's output in the conversation.
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
