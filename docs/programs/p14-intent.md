# Program P14 — Intent

| Field | Value |
|-------|-------|
| Program ID | `p14-intent` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p14-intent` |
| Source stage | none: the owner's direction of 2026-09-30 (§3.1), after P13 |
| Status | **Built 2026-09-30**, T1 … T5 (§13); deployed; the build decisions of §13 and the owner's trial (SC-P14-11) follow |
| Depends on | P7 (planning, the contract, ratification), P9 (decisions and their `produced` commits), P13 (the Studio's run page, graph and node detail) |
| Blocking decisions | none: D-P14-01 … D-P14-12 ratified |

This contract is the stable authority for P14. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Keep **why a program exists**, in terms of the people it is for, and connect
every technical record to it. A plan gains **user stories**: who is affected,
what goes wrong for them today, and what is different for them afterwards,
each carrying the owner's own words from the planning conversation. Success
criteria say which story they serve. Everything below them (strands, jobs,
decisions, commits) reaches a story through links the record already has. The
planning conversation itself is kept as the evidence behind those words. The
Studio and the report lead with the stories. A reader then sees "a customer's
billing admin only ever sees their own company's invoices" before seeing
"SC-01 Tenant billing data is isolated".

**What P14 is not.** No change to how a run executes, routes, verifies,
examines or lands. No agent is asked to write user-facing prose at run time.
No backfill of programs ratified before P14.

### What exists today

- **Success criteria are one line each**, `{id, outcome}`, written to be
  checked, not to be understood cold. "Tenant billing data is isolated" says
  nothing about which tenant, isolated how, or who would notice.
- **The chain from a decision to a criterion already exists.** A decision is
  made on a node; a job node belongs to a strand; a strand claims success
  criteria (`strand.successCriteria`); a planned decision `touches` strands.
  Only the top of the chain, the human reason, is missing.
- **The plan document is stored at ratification and served back** (D-P7-02,
  `planDocumentObjectKey`), and the MCP server reads it. The Studio never shows
  it.
- **The planning conversation is not kept.** It is where the owner said what
  they wanted and why, corrected the framing and rejected ideas. It lives only
  in the harness's own session files on the planner's machine. A Claude Code
  session exposes its id (`CLAUDE_CODE_SESSION_ID`), and its transcript is a
  file under `~/.claude/projects/`. Codex keeps session rollouts under
  `~/.codex/sessions/`.
- **Nightshift's own contracts** (this document's shape) already carry a
  §3.1 "owner's direction" table in the owner's words. That table is the thing
  this program generalises. `plan-program` contracts have no equivalent.

## 2. Environment and human prerequisites

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P14-01 | Ratify D-P14-01 … D-P14-12 | **satisfied 2026-09-30** |

**Explicitly not required.** No new AWS resource. The API and Studio stacks are
redeployed at the end.

## 3. Decisions

### 3.1 The owner's direction, 2026-09-30

| # | Question | Answer |
|---|----------|--------|
| Q1 | Store "what was said" during planning | **Yes**: the planning conversation is important user memory |
| Q2 | What is wrong with the Studio today | **Too technically dense**: hard to connect decisions to actual user stories |
| Q3 | What a criterion like "tenant billing data is isolated" lacks | **The why**: what tenant, isolated how, what the user impact is. Today it has to be reconstructed by thinking hard |
| Q4 | Where the kept conversation lives (D-P14-06) | **Committed with the plan and uploaded**, as proposed; "I assume it's a summary of the convo, not literally the entire thing. I sometimes wander off down explorations that end up totally irrelevant" |
| Q5 | What the kept file holds (D-P14-05) | **A summary and verbatim excerpts**; "tangents are fine if they led to a decision! I don't want to blindly rule that tangents get left out" |

### 3.2 Ratified decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P14-01 | **User stories are a planned record in the contract.** `stories[]`, each `{id: "US-nn", who, problem, outcome, words[]}`: *who* is affected (a role, not a person: "a customer's billing admin"); *problem*, what goes wrong for them today; *outcome*, what is different for them afterwards; *words*, the owner's own sentences from the planning conversation (D-P14-04). A success criterion gains `serves: ["US-nn", …]`. Criteria stay terse and checkable; the story is where the explanation lives. | Q3. Two homes for two jobs: the checker reads the criterion, a person reads the story. Several criteria usually serve one story, so a story is its own record rather than a longer criterion. |
| D-P14-02 | **`plan check` requires them.** A plan with no story, a criterion that serves no story, a story no criterion serves, or a story missing *who*, *problem* or *outcome* is not `READY`, with every reason at once as today. Contracts ratified before P14 still parse, run and report; the fields are optional in the schema and required by the check. | An optional field is skipped under time pressure, which is how the why was lost in the first place. The check is where Nightshift already says "not yet". |
| D-P14-03 | **The link from technical to human is derived, never written at run time.** A job or strand node reaches stories through its strand's criteria; a planned decision through the strands it touches (`"all"` reaches every story); a run-time decision through the node it was made on; a commit through the decision or node that produced it. One function in `core`, `storiesOf(record, contract)`, used by the Studio, the report and the MCP server. No agent tags anything. | One home per fact (the plan-program rule). An agent asked to write "user impact" on each decision produces filler at 3 a.m.; the chain is exact and costs nothing. |
| D-P14-04 | **The owner's words are verbatim, and checked.** Each `words` entry is a quotation of something the human typed. `plan check` refuses a quote that does not appear, whitespace-normalised, in the kept file's excerpts (D-P14-05), which are verbatim by construction. The skill may choose which sentences to quote; it may not paraphrase and call it a quote. When the conversation is off (D-P14-06) quotes cannot be checked, and the Studio marks them unverified. | Q1. The value of "what was said" is that it was said. A deterministic check is what keeps a paraphrase from passing as the owner's voice. |
| D-P14-05 | **What is kept: a summary and the exchanges that shaped the plan, verbatim.** The file opens with a short **summary** of how the plan came about, labelled as the model's. Under it are **excerpts**: each exchange that led to a story, a criterion, a scope boundary, a decision or a rejected alternative, however far from the brief it wandered, with the question it answered. The owner's Q4 and Q5: a tangent that led somewhere stays; one that led nowhere is omitted, and the file says how many messages were. Only the human's messages and the assistant's visible replies are candidates, never tool calls, tool output, file contents or reasoning. **The skill chooses; the CLI copies.** The skill picks messages by number from `plan conversation --list` and writes the summary; `plan conversation --keep` copies the chosen messages from the raw transcript word for word, so no excerpt can be a paraphrase. A pattern scan masks anything shaped like a credential. The raw transcript is only read, on the planner's machine, and is never written or uploaded. | Q4, Q5. The owner wanders on purpose, and the wandering is often where a decision came from, so relevance is judged by what it led to, not by distance from the topic. The summary makes the file readable; the excerpts make it evidence. |
| D-P14-06 | **Where it goes: `docs/programs/{id}/conversation.md`, committed with the plan and uploaded at ratification** beside the plan document, its digest in the ratification. The human reads it, and can edit or cut it, before committing. `nightshift.config.json` can turn it off (`planning.keepConversation: false`); then nothing is written or uploaded, and quotes are unverified (D-P14-04). | Ratified by the owner (Q4). The repository is where the plan lives, so the evidence sits beside it and git versions it; review before commit is the privacy control. A public repository publishes it, which is why the switch exists. |
| D-P14-07 | **Capture is per harness, in the harness packages.** `nightshift plan conversation {id}` reads the current session's transcript through the harness the planner runs in: `harness-claude` from `CLAUDE_CODE_SESSION_ID` and its session file, `harness-codex` from its session rollout. `--session <path>` names one explicitly. The skill updates the file at the end of every planning round; a session already in it is extended, never duplicated. | Transcript formats are provider-specific, and AR-2 keeps provider-specific code in `harness-*`. Updating every round means the conversation survives a session that ends or compacts before ratification. |
| D-P14-08 | **`plan-program` plans stories first.** Before strands, the skill asks who the program is for and what changes for them, writes the stories with the human, quotes them, and links every criterion. It writes criteria in plain words a newcomer could check. It runs `plan conversation` each round (D-P14-07). | The stories are the frame the rest of the plan is judged by; written last, they are rationalised from the strands. |
| D-P14-09 | **The Studio leads with the why.** (a) Each program's card shows its stories' outcomes, the first two and "+n more". (b) The run page gains a **Why** tab after *Status*: each story in full (who, problem, outcome, the owner's words), its criteria met or not, the strands serving it, and the decisions reaching it; then the plan document rendered; then the conversation. (c) The *Status* tab opens with one line per story and its criteria met or not. (d) The node detail and the decision page open with **Serves**: the stories they reach. | Q2. The go-to question stays first (P13's Status tab); the why is one click away and is also the first thing on every detail. |
| D-P14-10 | **The run graph can be read by story.** A story picker beside the decision picker lights the strands and jobs that serve it, with P13's highlight. | Q2's "connect decisions to stories", seen: the whole program coloured by the reason for it. It reuses D-P13-10's mechanism. |
| D-P14-11 | **The report leads with stories.** `report.md` and `nightshift report` open with each story and its criteria met or not, before strands. | The CLI reader has the same problem as the Studio's. |
| D-P14-12 | **Markdown is rendered with `react-markdown` (MIT), without raw HTML.** It renders the plan document and the conversation. | The plan document is markdown; raw HTML off means a document cannot inject markup into the Studio. |

### Non-guarantees

- **Stories are as good as the planning conversation.** The check proves they
  exist, are linked and quote the owner verbatim, not that they are wise.
- **The derived chain is structural.** "Serves US-02" means the node sits under
  a strand that claims a criterion of US-02, not that each line of it mattered
  to that user.
- **The secret scan is a net, not a guarantee.** The human's review before
  commit is the control (D-P14-06).

## 4. Design

### 4.1 The records

```ts
// contracts: plan.ts
StorySchema = { id: /^US-\d{2,}$/, who, problem, outcome, words: string[] }
// contracts: program-contract.ts
SuccessCriterionSchema = { id, outcome, serves?: StoryId[] }
ProgramContract.stories?: Story[]
Ratification.conversation?: PlanDocumentRef   // absent when not kept
```

`stories` enters the plan hash with the rest of the planned part. The
conversation does not: it is evidence, not plan, and a round of talk after the
plan was settled must not unsettle it.

### 4.2 The chain

```text
story ◀─ criterion.serves ◀─ strand.successCriteria ◀─ job node (in strand)
                                   ▲                        ▲
            planned decision.touches            run-time decision.executionNodeId
                                                commit ◀─ decision.produced / node landing
```

`storiesOf` walks it up. The Studio already holds the contract, the nodes and
the decisions for a run, so nothing new is fetched but the two documents.

### 4.3 The conversation file

```markdown
## Summary

<!-- nightshift:summary claude-opus-5-5 -->
The owner found the Studio too dense to connect decisions to user stories …

## Excerpts

<!-- nightshift:session claude 91be3293-… messages 14–17 -->
**Human** · 2026-09-30 14:02
couldn't we store "what was said" during planning …

**Claude** · 14:03
Yes, and it fills a real gap. …

*12 messages omitted: they led to nothing in the plan.*
```

```text
nightshift plan conversation {id} --list                  numbered human and assistant messages of this session
nightshift plan conversation {id} --keep 14-17,22 --summary <file>
```

Session markers name the messages each excerpt was copied from, so a second
round extends the file and never duplicates an excerpt.

## 5. Scope

### In scope

The schemas and the check (D-P14-01, -02, -04); `storiesOf` in `core`; the
conversation capture in both harnesses and its CLI command, masking, the config
switch, upload at ratification and an API route that serves it (as the plan
document's does); the `plan-program` skill; the Studio's card, Why tab, Status
lines, Serves blocks and story picker; the report; the as-built; redeploying the
API and Studio stacks.

### Out of scope

- Backfilling stories into programs ratified before P14.
- Writing stories from a conversation automatically, with no human in the
  planning session.
- Stories for Nightshift's own programs, which are hand-written documents like
  this one and keep their §3.1 table.
- Search across conversations, or a conversation viewer beyond rendering the
  file.

## 6. Success criteria

- **SC-P14-01** A contract with stories and `serves` parses; one ratified before
  P14 still parses, runs and reports, proven over the P7 … P9 fixtures.
- **SC-P14-02** `plan check` refuses, with every reason at once: no story; a
  criterion serving none; a story no criterion serves; a story missing *who*,
  *problem* or *outcome*; an unknown story id.
- **SC-P14-03** `plan check` refuses a quote absent from the kept file's
  excerpts, accepts one that differs only in whitespace, and with the
  conversation off passes the quote as unverified.
- **SC-P14-04** `storiesOf` maps a job, a strand, a planned decision (by strand
  and by `"all"`), a run-time decision and a produced commit to their stories,
  over the P6 tree fixture.
- **SC-P14-05** From a recorded Claude transcript and a recorded Codex rollout,
  `plan conversation --list` numbers only the human's and the assistant's visible
  messages; `--keep` copies exactly the chosen ones, byte for byte after masking,
  under the summary, and states how many were omitted; a second round adds only
  new excerpts; a planted credential is masked; nothing is written from a tool
  call or its output.
- **SC-P14-06** Ratification uploads the conversation beside the plan document
  and records its digest; the API serves it to a member of the program's org and
  refuses anyone else, on the local instance and the hosted smoke.
- **SC-P14-07** The skill: its test (`test/src/skills/plan-program.test.ts`)
  holds the new steps, including the rule that an exchange is kept for what it
  led to, not for staying on topic; a planning fixture run produces stories with
  verbatim quotes that pass the check.
- **SC-P14-08** The Studio: the card shows story outcomes; the Why tab shows each
  story, its criteria met or not, its strands and decisions, the rendered plan
  document and the conversation; the Status tab's story lines; Serves on the node
  detail and decision page; the story picker lights exactly the strands and jobs
  `storiesOf` names. Under the theme guard (A-49).
- **SC-P14-09** The report leads with stories and their criteria.
- **SC-P14-10** `npm run verify` green on both CI legs; API and Studio redeployed;
  `studio:smoke` green.

**Exit gate**

- **SC-P14-11** The owner's own: plan a real program in a real repository with
  `/plan-program`, run it, and read the Studio the next morning. The owner can
  say, from the Studio alone, why each strand and each recorded decision exists.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
npm run local:e2e
```

From a developer machine: `npm run deploy`, `npm run studio:smoke`.

## 8. Constraints

- No run-time behaviour changes: routing, verification, examination and landing
  are untouched.
- Every dependency pinned exactly (AR-6); transcript parsing only in `harness-*`
  (AR-2).
- One home per fact: a story's text lives in the contract only; the plan
  document refers to stories by id.
- The Studio's colours only through `theme.css` (A-49).

## 9. Permissions and forbidden actions

Permitted: editing `packages/contracts`, `core`, `harness-claude`,
`harness-codex`, `persistence`, `apps/*`, `skills/plan-program`, the documents;
deploying the API and Studio stacks; running the suites.

Forbidden:

- Writing or uploading the raw transcript, or anything from it beyond D-P14-05's chosen messages.
- Letting a model write a quote the check has not verified, or recording a
  paraphrase as the owner's words.
- Weakening an assertion of an earlier program.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Contracts and core: `StorySchema`, `serves`, the ratification's `conversation`; the checks of D-P14-02 and -04; `storiesOf`; the report's story section | — | — |
| T2 | Capture: the transcript readers in `harness-claude` and `harness-codex`, masking, `nightshift plan conversation`, the config switch; upload at ratification, the API route, the browser client | T1 | — |
| T3 | The skill: stories first, quoting, plain criteria, capture every round; its tests and a planning fixture | T1, T2 | — |
| T4 | The Studio: the card, the Why tab with the rendered documents, the Status lines, Serves, the story picker | T1, T2 | — |
| T5 | Proofs, the as-built, the API and Studio redeploy | T3, T4 | AWS |

```text
T1 ── T2 ──┬── T3 ──┐
           └── T4 ──┴── T5
```

## 11. Risks

| Risk | Handling |
|------|----------|
| The Claude Code or Codex transcript format changes | Each reader is tested against a recorded transcript; an unreadable one fails with the format it saw, and `--session` plus a hand-edited file still works |
| A planning session compacts or ends before ratification | Capture runs every round (D-P14-07), so each session is kept as it goes |
| The skill drops an exchange that mattered, or keeps noise | The file states how many messages were omitted; the human reads it before committing and can ask for an exchange back by number |
| The conversation holds something private the scan misses | The human reads the file before committing it (D-P14-06); the switch turns capture off |
| Stories become ceremony: written once, never read | They lead the Studio and the report (D-P14-09, -11), and the exit gate is the owner reading them |
| Planning feels slower with a new step | The stories are drafted from what the human already said; the quotes come from the conversation, not a new interview |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-30 | **Built.** T1 … T5 on `program/p14-intent`, in the worktree `nightshift-p14`; `npm run verify` green under Node 24 (3,369 tests); the API and Studio stacks deployed; `studio:smoke` and `smoke` green. The build decisions of §13 are provisional until the owner ratifies or reverses them. | Agent, for human ratification |
| 2026-09-30 | **Contract ratified.** The owner chose D-P14-02 (stories required by `plan check`) and D-P14-09 (a Why tab after Status) as proposed. D-P14-01, -03, -04, -07, -08, -10, -11 and -12 are low-risk and ratified as written, per the owner's review style. | **Human** |
| 2026-09-30 | **D-P14-06 ratified** as proposed. **D-P14-05 revised** with the owner: a summary and verbatim excerpts, not the whole conversation; an exchange is kept for what it led to, so a tangent that led to a decision stays (the owner's amendment); the skill chooses, the CLI copies. D-P14-04 follows: quotes are checked against the excerpts. | **Human** |
| 2026-09-30 | Contract drafted from the owner's direction (§3.1): twelve decisions proposed for ratification. | Agent, for human ratification |

## 13. As built

Built 2026-09-30 on `program/p14-intent`, T1 … T5 in one sitting, in a
separate worktree so the owner could plan in the main checkout meanwhile.

### Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | **done** | `StorySchema`, `serves`, `keepConversation`, the ratification's and contract's `conversation`; seven new `checkPlan` reasons; `storiesOf`, `storyStatuses`; the conversation file's format in `core`; the report's Stories section |
| T2 | **done** | transcript readers in both harnesses; `nightshift-transcript`; `nightshift plan conversation`; check and ratify read `conversation.md`; the control plane checks the quotes and records the conversation |
| T3 | **done** | `plan-program`: stories first (§2a), quoting exactly, plain criteria, keep the conversation every round (§8a); the template's "Who it is for" |
| T4 | **done** | the card's stories, the Status tab's story lines, the Why tab (stories, plan, conversation), Serves on a node's detail and a decision's page, the graph read by story |
| T5 | **done** | the proofs below, a look at a seeded run in the browser, this as-built, the API and Studio redeploy |

### What was proven, and where

| SC | State | By |
|----|-------|----|
| SC-P14-01 | met | `test/src/planning/hash-compat.test.ts`: a pre-P14 contract hashes to main's own golden value, and empty `stories`/`serves` hash the same as absent ones; the P7 … P9 suites unchanged |
| SC-P14-02 | met | `core/rules/plan.test.ts`: no story; every story reason at once |
| SC-P14-03 | met | `plan.test.ts` (whitespace, the assistant's words refused, the switch off); `test/src/cli/planning.test.ts` (a paraphrase refused through the CLI); `apps/api/.../plans.test.ts` (refused by the control plane whatever the client checked) |
| SC-P14-04 | met | `core/report/stories.test.ts`: strand, criterion, job, the program's node, planned decision by strand and by `all`, run-time decision, commit |
| SC-P14-05 | met | `harness-claude/src/transcript.test.ts` and `harness-codex/src/transcript.test.ts` over recorded sessions with every kind of entry that is not the conversation; `core/rules/conversation.test.ts` (kept exactly, extended, the human's cut kept, masking); the CLI end to end through the real binary |
| SC-P14-06 | met | `planning.test.ts` (ratified over the test control plane, which is the local instance's server); `apps/api/src/smoke/p2.smoke.ts` against the deployed stage: stored, a paraphrase refused, recorded, served back |
| SC-P14-07 | met | `test/src/skills/plan-program.test.ts`: the new steps, and a planning round whose stories pass against the conversation it kept, the tangent left out |
| SC-P14-08 | met | `apps/studio/src/pages/why.test.tsx`: the card, the Status lines, the Why tab (no raw HTML), Serves on a node and a decision, the story picker lighting exactly the strands and jobs built for it |
| SC-P14-09 | met | `core/report/report.test.ts`: Stories before Strands; none for a program planned before stories |
| SC-P14-10 | met | `npm run verify` green; `studio:smoke` and `smoke` green against dev |
| SC-P14-11 | **the owner's** | below |

### Build decisions, provisional until the owner ratifies or reverses them

1. **The CLI reaches the transcript readers through a process,
   `nightshift-transcript`, in the MCP app.** D-P14-07 put the readers in the
   harness packages, and the layer table lets only `apps/mcp/src/compose.ts`
   name a harness. Letting the CLI import them would have widened a rule whose
   comment warns against exactly that. `nightshift resume` already works this
   way.
2. **The conversation is stored as a plan document**: the same program-scoped,
   content-addressed store and route, named by its own SHA-256. No new route,
   bucket prefix or IAM grant.
3. **`keepConversation` is a contract field inherited from the config.** The
   config alone never reaches the control plane (A-06), and the control plane
   has to know whether to demand a conversation for the quotes.
4. **The contract carries the current `conversation` beside `planDocument`**,
   written by the control plane only. A client's copy is dropped at ratify.
5. **What a Claude session "said"** is the human's typed prompts, their answers
   to multiple-choice questions with any note they typed, and all the
   assistant's text between two human messages as one message. Slash-command
   echoes, task notifications, interruptions, meta entries, compaction summaries,
   side chains, tool calls and their output, and injected reminders are dropped.
   For Codex it is the `response_item` messages, with injected instructions,
   environment and skill blocks dropped and `event_msg` ignored as a duplicate.
6. **`remark-gfm` beside `react-markdown`** (both MIT), because plans are full of
   tables.
7. **A story card's heading is its outcome**, so the card shows who and today and
   no separate "afterwards" row, found by looking at a seeded run.
8. **The program's own node is left unmarked when the graph is read by story.**
   It serves every story, and lighting it for all of them says nothing.
9. **`plan conversation` with no flag lists the session.** `--list` exists for
   clarity and refuses to be combined with `--keep`.

### What changed in earlier programs' suites, and why

Nothing asserted changed.

- **Fixtures gained stories.** The shared factory (`makeProgramContract`), the
  example contract and the slice fixture's contract now carry stories and
  `serves`, because every ratified plan needs them now.
- **`StrandReport` gained `nodeIds`.** Two literal fixtures add it.
- **`stamp.ts` uses `plannedDecisionIdOf` from `core`.** The regex is unchanged;
  it moved so `storiesOf` shares it.

### Known and not P14's

- **The dev account's Lambda concurrency limit is 10.** Parallel smoke requests
  are throttled into occasional 503s: 86 throttles and 0 errors on the API
  function during this build. The proper fix is a Service Quotas increase for
  Lambda concurrent executions in us-west-2, which is the owner's to request.
  Nothing works around it here.
- **Skills installed on this machine** under `~/.claude/skills` are the P13
  copies until `nightshift init` runs again after the merge.

### For the owner's trial (SC-P14-11)

1. After the merge, run `nightshift init` in a real repository, which refreshes
   the skills.
2. `/plan-program` something real. It should ask who the program is for first,
   quote you, and keep `conversation.md`. Read that file before committing.
3. Ratify and run it. The next morning, open the run: Status, then Why, then
   Graph read by story. Say whether you can tell, from the Studio alone, why each
   strand and each decision exists.
