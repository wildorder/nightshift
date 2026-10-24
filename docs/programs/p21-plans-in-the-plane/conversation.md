# Planning conversation: p21-plans-in-the-plane

<!--
  Kept by `nightshift plan conversation`. The summary is the planning model's.
  The excerpts are copied word for word from the planning session, and only the
  exchanges that shaped the plan are kept. Cut anything you would rather not
  keep before committing; do not reword an excerpt, a story's quote is checked
  against it.
-->

## Summary

The owner asked, while discussing how simultaneous work and backlog intake should fit Pipkin, whether the strand model would remove the ceremony of committing plan documents to a program branch before a run. Claude explained the commit's real jobs (an immutable hash, the machine's copy, the branch the work lands on), that none needs the plan to live in git, and that the control plane already stores plans by hash. The owner summarised it as plans stored in Nightshift rather than as repository files; Claude refined that a plan is still a document, only not a file in the repository, and placed it as PK-15, the first step of Pipkin's intake track, which the owner approved.

Planning P21 itself, the owner said hand-editing a draft is unnecessary but reading it is, and chose the plane as a draft's only home (D-01), so they can take it anywhere. They added the future they want it to support: a request or bug comes in, an agent writes the plan, and its decisions reach the owner on a channel of their choice with enough context to decide, the first being whether to accept the request at all. That shaped the draft record: versions with authors, decisions answered one at a time by a person, and approval, decline and change requests as a person's recorded acts. They chose that Nightshift commits the plan, contract, conversation and report into docs/programs/{id}/ when a run finishes (D-02), as history for future agents.

## Excerpts

<!-- nightshift:session claude cbbd6508-eba8-481c-8ffe-5bae828890eb 139 -->
### Claude session `cbbd6508`

*Kept 18 of 139 messages; the rest led to nothing in the plan.*

<!-- nightshift:message 29 human 2026-10-21T05:44:05.834Z -->
**Human** · 2026-10-21 05:44 UTC

i'm thinking long term, when an agent starts pulling things off a backlog and putting it into production automatically, or when a project owner finds a bug and submits it... we need to handle simultaneous work elegantly. i'm not sure what the right seam is between what gets allocated as a "run" vs a "strand" inside an existing run... idk... what do you think is the right abstraciton level?

<!-- nightshift:message 30 assistant 2026-10-21T05:44:47.956Z -->
**Claude** · 2026-10-21 05:44 UTC

My answer: **the strand is the unit of work; the run should stop being one.**

Today a run bundles three different things: the unit of *intent* (a ratified plan), the unit of *compute* (one machine, one orchestrator, one lease), and the unit of *outcome* (end gate, report, verdict). That bundle is right for "I planned a program tonight, run it." It is wrong for work that arrives one item at a time, because a bug report is not a program and shouldn't have to wait for one to exist or be grafted into one that's already running.

The strand is already the smallest thing that carries everything a contribution needs: an objective and acceptance, a reviewed plan, its own branch and orchestrator, fix rounds, landing once with evidence. A bug fix is strand-shaped. A backlog feature is strand-shaped, or two strands with a dependency. So:

- **Strand = the work item.** What a backlog-pulling agent or a bug report creates is a strand contract — story, acceptance, dependencies, risk policy — checked READY the same way a plan is. Its ratification binds *it*, not a run.
- **Program = optional, for coupled work.** When items share expensive decisions or depend on each other, a human (or the planner) bundles them into a program and hoists the decisions. Independent items never need one. Programs become the exception, not the entry point.
- **Run = a compute envelope.** "This machine is executing strands for this project for a while." Whether a new strand joins an existing run's machine or gets its own is a *scheduling* choice — capacity, a warm volume, isolation needs — not an identity choice. The question "run or strand inside a run" dissolves.
- **Outcome moves to the delivered thing.** The end gate becomes snapshot verification of the composition (PK-2/PK-7); the report and the thumbs up/down attach to the delivered strand (and the candidate), not to the envelope it happened to run in. That is a change to P20's D-04 (verdict per run) — worth deciding deliberately.

Your two scenarios under that model: a bug report becomes a strand with the report as its story and a reproduction test as acceptance; it lands on the project line, gets proven in composition with whatever else is there, rides the next candidate, and the reporter rates the fix. A backlog agent turns items into strand contracts and queues them; the scheduler places them; coupled items get planned into a program first.

What it costs: the run's "held to one hash" guarantee has to be restated as "each strand held to its hash", and the lifecycle/report/Studio code that assumes run-as-outcome has to move. It doesn't change the Pipkin order; it sharpens PK-3 (project-scoped line, decide now) and adds one issue after PK-7 — "strands as the unit of intake, runs as compute envelopes" — if you want it filed.

<!-- nightshift:message 31 human 2026-10-21T06:00:27.459Z -->
**Human** · 2026-10-21 06:00 UTC

still have questions about that. one of the super annoying things about the planning is the ceremony around commiting your docs to it's own branch before running the program. would this eliminate it? how should we think about "planning" in this newer model?

<!-- nightshift:message 32 assistant 2026-10-21T06:01:00.126Z -->
**Claude** · 2026-10-21 06:01 UTC

Two separate things are tangled in that ceremony, and only one of them goes away with the strand model.

**What the commit is actually doing.** The plan is committed to the program branch because (1) the run is held to a hash and a commit is the hash we had, (2) the remote machine reads the plan from what is pushed, and (3) the program branch *is* the base the work lands on, so the plan had to be there first. Those are real needs — approved intent must be immutable, addressable, and readable by the machine — but none of them requires the plan to be a *git commit in the repo*. The control plane already holds the ratification (A-58) and already stores plan artifacts (there are 55 objects under `plans/` in the artifact bucket). The repo copy is tradition, not necessity.

**So: the ceremony is removable now, independently of Pipkin.** The contract becomes a control-plane record, content-hashed; `nightshift run` ratifies *that* hash; the machine fetches it from the plane, not from GitHub; the docs land in the repo *afterwards*, written by Nightshift into the strand's branch as the record of what was built, if you want them there at all. Plan check stays — it's the gate that answers READY — the branch dance goes. The strand model doesn't do this for you; it just makes it unavoidable, because a bug report can't wait for a docs commit.

**How to think about planning in the new model: planning is proportional to risk, and its product is a strand contract, not a document set.**

- **A bug report or small backlog item:** the strand contract *is* the plan — story in the reporter's words, acceptance (a reproduction test), approach from the code. Authored by the planner agent, reviewed by an examiner before anything is built (A-59 already does this for a strand's job plan), checked READY, and ratified automatically when the risk policy allows. No human session, no documents, no branch. The human sees it on the "Needs you" strip only if the policy says so.
- **Coupled or expensive work:** the human-led `plan-program` session stays, because its real job was never the files — it was hoisting the decisions that are expensive to reverse and getting them made *before* agents build on them. Its output becomes a program record bundling several strand contracts plus decisions; same gate, same ratification, no commit.
- **Decisions remain the human seam** either way. That's the part of P7 worth keeping exactly: a wrong choice becomes cheap because it's named, recorded, and reversible by correction (A-47).
- **The kept conversation** becomes an artifact attached to the contract, not `conversation.md`.

What you lose: the plan diffing alongside the code in a PR. What you keep: `nightshift plan check` on a draft, the hash pin, the report. If you want, I'll file "the plan lives in the plane; the repo copy is a publication" as an issue — it's a pre-Pipkin follow-up, not a Pipkin dependency.

<!-- nightshift:message 33 human 2026-10-21T06:11:53.198Z -->
**Human** · 2026-10-21 06:11 UTC

think i got it? so plans aren't docs anymore, they become stored in nightshift via mcp

<!-- nightshift:message 34 assistant 2026-10-21T06:12:00.421Z -->
**Claude** · 2026-10-21 06:12 UTC

Nearly. Two refinements:

- **The plan is still a document; it's just not a *file in your repo* anymore.** The content — stories in the human's words, strands, acceptance, decisions — stays prose plus a contract. What changes is its home: a content-hashed record in the control plane. The hash is what gets ratified and what the run is held to; the Studio renders it; Nightshift can still *publish* a copy into the repo when the work lands, as the record of what was built, if you want that.
- **"Via MCP" is one way in, not the only one.** A planning session with you writes it through the MCP tools (today's `plan-program` session, minus the branch dance). A planner agent pulling a backlog item writes it the same way. A bug report lands through the API or Studio. The CLI's `plan check` reads from the plane instead of the directory. Same record, several authors.

The thing that's gone is the coupling of "approved" to "committed on a branch." That's the whole win: approval is a stored hash, not a git event.

<!-- nightshift:message 35 human 2026-10-21T06:16:02.545Z -->
**Human** · 2026-10-21 06:16 UTC

i think i really like this. where would something like this live in the bigger pipkin plan?

<!-- nightshift:message 36 assistant 2026-10-21T06:16:18.271Z -->
**Claude** · 2026-10-21 06:16 UTC

It's a second track inside Pipkin. The thirteen as filed are the **lifecycle track**: how finished work lands, gets composed, proven, cut and shipped. What we just worked out is the **intake track**: how work enters. They meet at two points.

**Intake track, in order:**

1. **Plans live in the plane; the repo copy is a publication.** No dependencies on anything — it removes today's ceremony immediately and nothing in the lifecycle track needs it. It belongs *first*, because it's the cheapest win and because every later intake step assumes it.
2. **PK-3 widened to a project-scoped line.** Already filed; this conversation changes its recommendation from "program-scoped first" to "project-scoped now", since both the simultaneous-runs scenario and intake need one line per project.
3. **Strands as the unit of intake; runs as compute envelopes.** After PK-7 (continuous landing), because a strand arriving alone needs somewhere to land without a program's end gate, and that's what PK-7 provides. Includes moving the verdict from run to delivered strand (amends P20 D-04) and risk-proportional ratification.
4. **Bug reports and backlog pull as strand authors.** After 3: the API/Studio intake for a report, and a planner agent that turns a backlog item into a READY strand contract. This is the "agent pulls from the backlog into production" endpoint.

**Where they meet:** PK-3 (one line, one owner) and PK-7 (land without the run's gate). Everything else in the lifecycle track is indifferent to how the work arrived.

Want me to file 1, 3 and 4 as PK-15…17 in the Pipkin project and amend PK-3's description to project scope?

<!-- nightshift:message 37 human 2026-10-21T06:18:52.576Z -->
**Human** · 2026-10-21 06:18 UTC

yes i think so

<!-- nightshift:message 130 human 2026-10-23T19:18:07.614Z -->
**Human** · 2026-10-23 19:18 UTC

ok great. are we good to plan the next pipkin milestone?

<!-- nightshift:message 131 assistant 2026-10-23T19:18:35.914Z -->
**Claude** · 2026-10-23 19:18 UTC

Yes. Nothing blocks it.

- **The next milestone is M0, "No ceremony" (PK-15, plans live in the plane).** It has no dependencies on the rest of Pipkin, and P20 being merged was the only thing in the way.
- **The foodfly run doesn't get in the way.** Planning is documents. When M0 is built and deployed, a running machine keeps working: API and Studio deploys don't touch it, and runner changes only take effect on new dispatches.

Two open items to know about. Neither blocks planning:
- `main` is still red on Windows: the tree and benchmark timeouts.
- When every route is at a usage limit at once, a run still ends `setup_failed`.

Want me to start the plan for M0 with you, using `plan-program`?

<!-- nightshift:message 132 human 2026-10-23T19:35:00.030Z -->
**Human** · 2026-10-23 19:35 UTC

oh my god... if this is the last time we use plan-program and have it create a wonky program branch and all that shit I will be so so so so happy

<!-- nightshift:message 133 assistant 2026-10-23T19:35:17.458Z -->
**Claude** · 2026-10-23 19:35 UTC

That's exactly what M0 removes, so this should be the last plan that goes through the program-branch ceremony. Starting it.

Starting with context and the code. First, `nightshift` on the PATH is v1, and the project config:

While that maps the code, the program id. The last was P20, so I'm proposing **`p21-plans-in-the-plane`**. I'll come back with the stories and decisions once the map lands.

I've mapped the code. The good news: **the plane already holds everything a run executes.** That's the merged contract, the plan text and the conversation, each stored by hash. The runner fetches the plan by hash, re-checks it on the machine, and briefs the root and the strands from the plane. Git is genuinely needed only for code: the base commit, landings, strand branches and carry-over.

The ceremony survives for incidental reasons:
- `plan ratify` refuses uncommitted plan files;
- the plan-program skill tells me to create the branch and commit the plan;
- several commands find a program by scanning `docs/programs/*/contract.json` on disk;
- a few engine paths (gate repair, a strand's step tools, `report.md`) read the *committed* contract instead of the plane's.

**Story (draft)**
- **US-01:** you, planning a program. Today, before anything runs, the plan has to sit on its own program branch, committed and pushed. Afterwards: plan, then `nightshift run`, with nothing to branch or commit. In your words: *"one of the super annoying things about the planning is the ceremony around commiting your docs to it's own branch before running the program."*

**Strands (draft)**, run in sequence:
- **S-01 Plans from the plane:**
  - `plan check`, `ratify` and `run` read drafts that live outside the repository;
  - `run` stores the plan by hash, and creates and pushes `program/{id}` itself;
  - every command that finds a program by scanning the repo asks the plane instead.
- **S-02 The engine stops reading the plan from git:** gate repair, a strand's step tools, and `decision brief` read the plane's contract and plan; the report goes to the plane.
- **S-03 The skills and docs:** `plan-program` and `run-program` lose their branch and commit steps, and the docs record the ruling as an amendment to A-58.

**Two decisions that are yours:**

1. **Where does a draft live while we plan?**
   - (a) Files outside the repo, e.g. `~/.nightshift/plans/<project>/<id>/`. You can still edit them by hand; they never touch the checkout, so they can't block landings.
   - (b) The plane only, as a draft record.
   - (c) In the repo, untracked. Every landing would then need an exemption.

   I lean (a): it keeps hand-editing, and the plane takes over at ratify.

2. **Does a copy of the plan end up in the repo at all?**
   - (a) Never: the plane and Studio are the home.
   - (b) Nightshift commits `docs/programs/{id}/` (plan, contract, conversation, report) onto the program branch when the run finishes, so the PR shows what was planned and what happened.
   - (c) Nightshift commits it at run start.

   I lean (b): the record lands with the work, and nobody commits it by hand.

What do you pick?

<!-- nightshift:message 134 human 2026-10-23T19:57:59.579Z -->
**Human** · 2026-10-23 19:57 UTC

not sure hand-editign is necessary, but reading is... let's discuss 1 a bit more. on 2: I'm ok committing that to the docs.. i suppose that helps future agents know the history.

<!-- nightshift:message 135 assistant 2026-10-23T19:59:38.789Z -->
**Claude** · 2026-10-23 19:59 UTC

Reading rather than editing changes the answer. It means the draft needs one home that both you and I can read from anywhere, not a file on your laptop. On that basis:

**(a) Files outside the repo** is the smallest build. But the draft lives on one machine and is invisible until the run. If the laptop dies mid-planning, the plan is gone, which is your "never lose finished work" rule again. And you can only read it where I wrote it.

**(b) The plane, as a draft record:**
- **How I write it:** I keep a scratch copy while drafting, and every round I store it with `nightshift plan put <id>`. Each put is a new version, content-hashed, so the history of the plan is kept for free.
- **How you read it:**
  - in **Studio**: a plan page showing the latest draft, its `plan check` result, and earlier versions;
  - or with `nightshift plan show <id>` in a terminal;
  - later, through the Studio agent (PK-19).
- **Checking and running:** `plan check` runs where the draft is. `run` ratifies the version you're looking at, with no files on disk anywhere.
- **Cost:** about one strand more than (a): a draft record, two commands and a Studio page.

I'd now lean **(b)**. It's the one home the rest of Pipkin assumes (PK-16 strand intake and PK-18 memory both read plans from the plane), and nothing is held only on a machine.

**On 2:** recorded. When the run finishes, Nightshift commits `docs/programs/{id}/` (plan, contract, conversation, report) onto the program branch, so the PR carries the history for future agents. That copy is a *publication*: nothing reads it back as the truth.

Does (b) work for you?

<!-- nightshift:message 136 human 2026-10-23T20:11:52.119Z -->
**Human** · 2026-10-23 20:11 UTC

yes, i want it cloud... so i can take it with me. i could - in future - have another person put in a feature request or bug, agent picks it up and writes the plan, and sends to me (wherever I am - maybe phone) to read and approve or request edits (not hand-rolled edits, agent written edits). more likely in this flow, feature request or bug comes in through some other channel... a plan gets written with decisions to make, and those decisions just get sent to me on my channel of choice (slack, whats app, email, whatever user decides)... it comes with enough context to make the decision. of course, the first decision is... should we accept the request or deny it. perhaps it's not in the vision just some reviewers comment.. bugs of course should be validated in code before sent along. That is a long way of saying: option B only in the cloud. i wanted to provide that context to make sure we built it in a way that supports that collaboration in the future

<!-- nightshift:message 137 assistant 2026-10-23T20:12:41.548Z -->
**Claude** · 2026-10-23 20:12 UTC

That context changes the shape of the build, so I'm recording it with the decision, not just in my head:

- **D-01: drafts live in the plane only.**
- **Built so that, later, an agent can write a plan from a request or bug, and you can read it, answer its decisions one at a time, or ask for an edit, from any channel.**

For this program that means four things in the data model, even though the channels themselves come later:
- **Who wrote it:** a human or an agent's execution identity.
- **A state:** draft, waiting on you, approved, declined.
- **Decisions answered individually through the API:** you answer D-02 from a phone without touching D-03.
- **Approve, decline and request-changes as recorded acts of a human.** An agent can propose; only a person ratifies, from any client, CLI included.

Out of scope: Slack, WhatsApp and email delivery, and request intake. Those are PK-16 and PK-17.

Writing the draft now, the old way one last time:

Writing the two files now:

I wrote "he" and "his" for you in that plan; I shouldn't assume pronouns. Correcting it to neutral wording:

Pronouns are fixed. Now the contract:

Unanswered decisions mustn't carry empty answers, so I'm removing those fields and re-checking:

Only the expected gaps are left: the two open decisions and the kept conversation. The scope-overlap checks pass. Choosing the exchanges to keep:

Keeping 29–37 (where plans-in-the-plane came from, and its place in Pipkin) and 130–137 (this planning session). Writing the summary and storing them:

<!-- nightshift:message 138 human 2026-10-23T20:24:28.358Z -->
**Human** · 2026-10-23 20:24 UTC

huh? we're gonna run verify after we commit some docs?? that seems wasteful doesn't it? 

studio cleanup comes later - it's a much bigger issue
