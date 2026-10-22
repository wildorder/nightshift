---
status: captured
captured: 2026-10-20
---

# Pipkin continuous engineering and verified releases

## What the session hit and where

Pipkin is the codename for a proposed next direction for Nightshift: continuously advance development through many concurrent agent contributions, make integration and repair ongoing activities, and independently select, verify, and deploy immutable release candidates. GitHub remains useful, but its pull requests and CI events should not dictate every internal step of engineering.

This is a substantial planning brief, not a ratified Program Contract or an implementation specification. The owner endorsed the direction described below and requested a durable, verbose capture so another session can organize it into bite-sized, testable iterations. Detailed mechanisms, record names, policies, and iteration boundaries here are proposals. No new execution behavior, deployment permission, provider migration, or first-party agent harness is authorized by this document.

The conversation initially sought a current assessment of agentic coding: parallel work, different agent roles, native delegation, and whether Nightshift's execution architecture needed evolution or replacement. It then separated two concerns: measuring the system we have, and creating alternative ways to execute work. Measurements became P20. Pipkin concerns the latter, plus the integration and release architecture needed to make greater concurrency useful.

### The owner's ambition and explicit endorsements

The owner described the scale and the frustration directly:

> so, speed is everything in todays world. we won't be pushing 30K PR's per day in the world I live in. but I certainly would love to get it up in the hundreds with just myself and nightshift. and i do find the gihub ceremony and constant ci checks to be a major bottlenck... what lessons can we take from scion, on a much smaller scale? if we don't think big about this, there's no point. so think big

The ensuing proposal had five parts:

1. Make a change, rather than a PR, the unit of agent work. Maintain its provenance and evidence internally; publish coherent outcomes through GitHub.
2. Treat verification as reusable evidence about specific inputs, rather than reflexively rerunning every check for every commit.
3. Make integration a continuous service that composes work, tests combinations, and coordinates repairs while other agents continue.
4. Allow intermediate agreements to unblock dependent agents before the producer finishes all its code.
5. Keep workers isolated while making their environments cheap to prepare and reuse.

The owner particularly endorsed **1 and 3**, then extended the proposal:

> I like that thinking. I particularly LOVE 1 and 3. I also think... and you'll disagree based on the product as it's framed today... that "willingness to find itegration failures after merging" should be integrated into the product. this is clearly the future.. its exactly what we've been struggling with when we built stuff like: moving e2e testing to the end. it's like the test stage should be constantly evolving and being evaluated, and then the trick i supposed becomes when do you freeze it, run full integration testing, and deploy it

This is an intentional change to the product's integration promise. Do not reduce it to faster CI on the same serial critical path. Equally, the owner did not request unverified production deployments. The proposed interpretation is that development can contain newly combined, not-yet-proven work, while release promotion has an explicit evidence boundary.

“Freeze a candidate, not the engineering team” was the resulting design proposal. Snapshot 120 can undergo full release testing while development advances through snapshots 121–135. Passing 120 permits promotion of exactly the artifact tested for 120, subject to the release policy. It does not certify 135. A failed 120 stays a failed immutable candidate; a repair produces another candidate.

### What preceded Pipkin and remains relevant

The earlier assessment did not conclude that Nightshift was fundamentally wrong. It identified three independently assessable improvements: reliable measurement and later controlled comparisons; more flexible collaboration within the existing control plane; and stronger evidence that completed work satisfies the product's needs. Keeping identity, authority, verification, integration ownership, and reporting in Nightshift remained valuable even when delegating reasoning and tools to Claude or Codex.

The owner distinguished collecting useful measurements from running alternative approaches on identical inputs. P20 addresses measurement. Same-input comparison scenarios were explicitly deferred until there are genuinely different execution paths to compare. Pipkin should eventually make those comparisons possible, not require a benchmark project before any architectural progress.

The owner also rejected manual retrospective bookkeeping:

> 2 is fine. 1 - tbh, no human is ever going to retroactively go back to input that. they are simply going to give the run a thumbs up/down. did work, or not.

Preserve that constraint. Do not introduce manual human-hours logs, defect attribution forms, or per-finding review questionnaires as dependencies for judging Pipkin. A simple Worked / Did not work / unrated signal is the intended human contribution; operational evidence should be collected automatically.

### Capture baseline

This brief was prepared against local HEAD `0dde042691d82764dfda8fbc1aa9c94b32303de2` on `program/p20-measurements`. P20 had been dispatched remotely as `run_01M5DKEPRMEEYE1MV3XX5YCJN7`, under program `prog_01M5DJ0E71480YAHVNBH1EEEFB`. Dispatch was known; completion and landed implementation were not established during this capture. A later session must inspect the then-current source before assuming P20 capabilities exist.

The owner originally wanted Linear issues. Linear was unavailable in the session, so they explicitly requested `docs/backlog/` or `docs/programs/` instead. This single backlog brief preserves the larger picture without pretending that execution contracts or final issue boundaries have been agreed.

## Why it is bigger than this session

Pipkin changes the relationship between work completion, integration, verification, run completion, release readiness, and deployment. Those meanings appear in contracts, scheduling, recovery, publication, reports, and the Studio. Moving a gate or changing one status check would leave the rest of the system telling a contradictory story.

There is nevertheless substantial machinery to retain. Nightshift already owns commits and identities, delegates through harness adapters, isolates workspaces, verifies immutable commits, records evidence, publishes durable work, and recovers runs. The likely scope is a major evolution of the execution and release model, not a rewrite of storage, tenancy, the entire scheduler, or the agent harnesses. The exact size depends especially on whether development becomes a project-level service spanning several runs.

### The throughput problem to solve

The desired result is many useful changes delivered with one person's attention, not a large count of artificial PRs or tiny jobs. More parallel agents help only if coordination, integration, testing, and review do not immediately serialize them again.

For intuition only: 200 accepted changes in an eight-hour day implies one every 2.4 minutes. A strictly serial ten-minute full gate can process at most 48 in that period before counting setup, failures, or repair. This is arithmetic, not an estimate of current Nightshift performance or a throughput promise. It illustrates why changing the unit and timing of verification can matter more than adding agents.

Current bottlenecks still need measured attribution: worker time, queue wait, environment preparation, verification, examination, publication, and human interruption are different costs. The owner's experience is the product motivation; it is not a controlled benchmark proving every GitHub operation is expensive.

### The proposed operating model

These terms should become precise during planning. They are conceptual distinctions, not prescribed schema names:

| Concept | Meaning |
| --- | --- |
| Change | An attributable contribution with intent, source identity, dependencies, and evidence; it may be produced by an existing job. |
| Development snapshot | An exact composition of contributions on an advancing development line; composition alone makes no verification claim. |
| Verification evidence | Results bound to exact inputs, environment, policy, and execution identity. |
| Release candidate | An immutable snapshot and associated build artifacts selected for a specific release policy. This is distinct from the existing verification phase named `candidate`. |
| Release eligibility | A decision that the candidate satisfies the applicable promotion policy, with evidence and authority recorded. |
| Deployment | An external action placing an exact artifact/configuration into a particular environment, with its own outcome and recovery history. |
| Publication | Making source or evidence durable/visible elsewhere; a push or PR does not itself certify or deploy anything. |
| Human outcome | The owner's simple assessment that the work did or did not work; independent of whether configured checks passed. |

A normal operating cycle would be: agents contribute changes; Nightshift composes development snapshots and launches appropriate checks; failures create owned repair work; selected snapshots become immutable release candidates; release checks run while development continues; eligible artifacts are promoted under explicit authority. Development, candidate verification, and deployment each have observable lifecycles. None is inferred merely from the others finishing.

## Constraints discovered

### Current Nightshift already does part of this

P18 is essential context. Do not design against the older assumption that every planned job waits for the full program gate:

- Jobs inside a strand already merge into its branch without individual gate, examination, or queue turns. They end as `merged`. Their own targeted testing remains useful but is not an authoritative Nightshift verification.
- A strand lands as a whole. Its integration with the program head still requires verification and examination according to policy. Independent jobs can run concurrently; job dependencies currently wait for predecessor jobs to merge.
- Root-level jobs and unplanned runs retain the earlier integration path. Describing all execution with either path alone is inaccurate.
- End gates already run against a detached immutable program-head checkout, but they are tied to finishing the run. This is a useful primitive, not an independent release-candidate lifecycle.
- Publication already preserves unverified strand work. A-60 was added because completed but unlanded work otherwise survived only on a machine. Removing frequent GitHub publication without another durable replacement would reintroduce that failure.
- Changes are already represented through jobs, nodes, commits, and records independently of PRs. Pipkin should improve that model where needed rather than invent an unrelated second source of change identity.

The historical P18 motivation included the `room-bookings` run spending approximately 840 minutes building, 540 minutes in gates, and 247 minutes waiting for a serial queue. Those figures describe a pre-P18 workload and explain changes already made. They are not a measurement of today's implementation or proof that Pipkin will produce a particular speedup.

Pipkin's substantial extension is continuous composition across today's verified strand/program boundary, with release readiness independent of run completion. It is not the first introduction of unverified merging anywhere in Nightshift.

### Existing authority must change explicitly where the product changes

Today `integrate.ts` requires a passing verification for the exact candidate commit before moving the program branch. Queue reconciliation preserves that relationship when the base moves. Core rules, terminal statuses, checkpoints, decision stamps, reporting, and recovery rely on those meanings.

The owner has endorsed a broader development model. Planning must explicitly amend the applicable architectural and contract promises. Simply deleting the integration check, or calling unchecked work `verified`, would be a workaround that destroys evidence semantics. Conversely, inventing an indefinitely provisional branch while retaining all the old serial gates on the actual useful work would dodge the requested change.

The durable distinction is between a development merge and a verified release boundary. Exact naming and backward compatibility remain decisions. Old records must continue to mean what they meant when written. The existing `Verification.phase: candidate | queue | run` vocabulary has specific semantics; its `candidate` value must not silently acquire the meaning “release candidate.”

Some older prose also predates later decisions. For example, reversal is correction under A-47, not automatic replay or reversal of a downstream cone. Dependencies introduced by Pipkin must not accidentally resurrect the superseded model. O-06 on remote publication is already resolved in current architecture, despite older instructions listing it as open; A-60 further evolved publication. Read current decisions rather than treating historical summaries as the latest authority.

### Guarantees to preserve

Every executing agent still needs a Nightshift execution identity. Project and organization boundaries remain enforced. Children may narrow inherited authority, never widen it. Workers do not become commit or release authorities simply because they can communicate. Provider-specific behavior stays in harness adapters. Large evidence belongs in artifact storage, not database records. Irreversible external effects must not be described as reversible.

An agent saying “done,” a branch accepting a merge, an examiner approving reasoning, a deterministic test passing, and a human saying “worked” are different facts. Pipkin must retain those distinctions while improving throughput. A release satisfies a named verification policy; no test suite proves the absence of every possible defect.

The owner's current role-routing model is an ordered list of models per role. This direction does not authorize replacing it with learned routing, reinstating tiers, or imposing path scopes on workers. Planning information about likely touched files is not a permissions boundary.

### Development failures need ownership and containment

Allowing integration failures after merging is useful only if failures become visible, attributable to an exact tested composition, and actionable. A failed combination does not prove that the latest individual change caused the failure. Evidence may implicate an interaction, environment, flaky test, or outdated assumption.

A repair needs a responsible execution identity, sufficient logs and context, an explicit relationship to the failed snapshot, and a new contribution. Preserve the failed evidence after repair. Do not rewrite a failed candidate into a passing one. Do not roll back other people's work by guessing a causal cone.

Not every broken development state should receive the same scheduling treatment. An isolated feature regression may permit unrelated work; a broken compiler setup, shared schema, or foundational interface may make new work wasteful. The policy for pausing affected work, choosing a usable base, or stopping advancement needs explicit design. “Keep all agents running regardless” can turn a speed feature into cascading rework.

### Freezing a candidate must freeze enough

An immutable Git SHA is necessary but insufficient. A release candidate needs a reproducible account of its source, dependency resolution, toolchain, build configuration, relevant environment, verification policy, and resulting artifact identities. Floating packages, mutable image tags, or rebuilding a different artifact after testing break the claimed relationship.

Candidate tests should run against the candidate's artifacts where applicable, and deployment should use those exact artifacts. Configuration and migrations also affect what is actually deployed; they must be represented honestly. Environment-dependent validation may be a distinct promotion step rather than something falsely claimed by a unit-test result.

The suite can evolve continuously on development. Once a candidate is selected, its required checks and acceptance policy must be identifiable. A newly discovered critical requirement may invalidate eligibility or require additional evidence, but that change must be explicit. Do not let an agent make a failing candidate green by silently removing the failing test or weakening the requirement. Legitimate test corrections remain possible through the appropriate authority and recorded rationale.

“Full integration testing” needs a project-specific definition. It cannot mean whatever happened to run successfully. Skips, missing prerequisites, deferrals, and policy exceptions must remain distinguishable from evidence that a required check passed.

### Coordination before code is finished

The motivating example was agent A depending on agent B while both work concurrently. A reaches an interface question mid-build, asks B for a decision, waits for the answer, and proceeds before B finishes implementing.

This requires distinguishing a **decision dependency** from a **code-ready dependency**. A may need agreement on a request shape now, but B's executable implementation later. Waiting for the whole producer job for both needs unnecessarily serializes work.

A useful protocol would identify the question, producer and consumer identities, authoritative answer or proposal, version of the agreement, affected work, and whether the answer can unblock the consumer. Amendments must notify consumers and expose stale assumptions. Delivery must survive process restarts and duplicate messages. Waiting must be cancellable and bounded by an escalation policy; dependency cycles need detection or resolution.

An answer from another worker is not automatically a ratified product decision. Authority still comes from the inherited contract and decision model. An agent may answer an implementation detail it controls, propose a larger decision, or explicitly lack authority. Native harness messaging can carry this exchange where available, but the control plane needs enough lifecycle information to know what is blocked and why.

Harness-generated subagents are another capability question. Do not assume they inherit the right MCP identity, can all access the same tools, or provide complete usage and lifecycle events. Assess each pinned harness version and execution mode. A prompt saying “report through MCP” is not structural observability. None of this requires deciding now to build a first-party harness.

### Evidence reuse and environment reuse are separate

Verification reuse needs an input model. A different commit hash can contain the same relevant inputs; an unchanged test file can run against changed code, dependencies, settings, or services. Cache keys must cover the inputs that determine the result. Reuse must record its provenance, not impersonate a fresh execution.

Pure build steps may be good early candidates. Integration tests against changing external systems may require fresh observations. A missing or untrusted dependency model means a cache miss, not a guess that something is unchanged. Adopting Bazel or another build system has not been selected.

Prepared environments can separately reduce setup cost. Share immutable source objects, dependency artifacts, or verified images where safe. Keep writable checkouts, generated files, databases, ports, and mutable service state isolated. The existing shared `project` user and package-store rules address real filesystem ownership constraints; new isolation must account for them rather than reintroducing the old multi-user hard-link failure.

### Measurement and Studio must follow the product model

P20 is intended to improve usage accounting, model/context/cache detail, optional API-equivalent cost estimates, operational timings, rework, examiner outcomes, infrastructure cost, outcome histories, and a Studio overview. Subscription usage is not identical to a provider bill. Unknown usage or price must not be presented as zero.

Pipkin should extend that foundation with time from contribution to development inclusion, time to release eligibility, time to deployment, queue waits, failed combinations, repair latency, superseded candidates, evidence reuse, and environment preparation. Include failed and abandoned work in resource totals. Attribute shared checks without double counting them across every included change.

The Studio should make three different conditions immediately understandable: what is deployed, which candidate is being proven, and what development is doing now. A failing development snapshot must not visually imply that the current production release failed. A green older candidate must not paint newer untested work green. Show exact source/artifact identity and important evidence gaps without making the operator decode internal records.

Useful overview measures include delivered outcomes, elapsed delivery time, active and waiting work, verification/repair time, consumed resources, and the simple human outcome rating. Counts of jobs, merges, or PRs alone are poor success measures and should not become incentives to fragment work artificially.

## Approaches considered or rejected, and why

### Direction proposed for planning

Use Nightshift as the accountable engineering control plane. Let harnesses supply agent execution and native capabilities where suitable. Treat GitHub as an important publication, collaboration, and interoperability endpoint whose ceremony can be separated from internal progress. Keep source durable even when publication and human review are batched differently.

The first concrete end-to-end goal should demonstrate overlapping development and release verification with honest failure handling. A sophisticated cache, new VCS, fleet of role types, or elaborate dashboard alone does not establish that product behavior.

### Alternatives discussed, without an adoption decision

Scion was the strongest provocation, not a selected dependency. Anthropic's October 2026 account describes an internal source-control system built for extreme agent concurrency, with server-side operations, content reuse, and a different division between merging and later validation. Its scale and operating context differ sharply from one person using Nightshift. Transfer the questions about critical paths and verification boundaries; do not assume the internal product is publicly available or that its reported throughput predicts ours.

Entire and Cursor Origin illustrate agent-aware Git hosting and richer context around coding work. They do not by themselves supply Nightshift's authority, candidate lifecycle, or repair policy. Jujutsu offers a different local change/conflict model with Git interoperability; GitButler supports parallel branch workflows in a shared workspace. Neither observation establishes that replacing Git fixes scheduling, runtime isolation, or repeated verification.

Speculative merge queues already demonstrate testing combinations before earlier queue entries finish. Their lesson can be applied with Git, although Pipkin's willingness to discover failures on an advancing development line goes beyond merely optimizing a conventional green-before-merge queue.

Claude team/subagent communication and AutoGen request/response primitives show ways to coordinate agents. Their capabilities and restrictions differ by mode and version. In particular, interactive team support cannot be assumed to work in Nightshift's headless invocation. Messaging is a mechanism; persistent authority, identity, and recovery remain product responsibilities.

### Approaches that would miss the point

- Increasing agent count while retaining one mandatory full-suite gate for every useful increment leaves the serial ceiling intact.
- Renaming a PR as a change without altering review, integration, or verification timing does not remove ceremony.
- Skipping tests to improve headline latency without a real release boundary weakens the product rather than implementing Pipkin.
- Treating a green branch name as evidence ignores that the branch can move during testing or deployment.
- Stopping publication of completed work without replacement durability repeats the failure A-60 fixed.
- Caching on commit ancestry or test filenames alone cannot establish equivalent inputs.
- Sharing writable workspaces or service state to save setup time makes independent agents interfere.
- Building a first-party harness merely to obtain control over every internal event is an unchosen, much larger project.
- Requiring retrospective human accounting contradicts the owner's explicit feedback preference.

### Decisions that need resolution before dependent implementation

These are questions to settle during planning, not a request for the owner to answer all of them at once.

| Decision | Why it matters |
| --- | --- |
| Is the development line program-scoped or project-scoped across runs? | Determines ownership, concurrency control, scheduling lifetime, and recovery. A per-run lock cannot fence multiple runs writing one shared line. |
| What replaces the current program-branch acceptance boundary? | Status meanings and downstream consumers must agree on merged, verified, accepted, and released work. |
| Is Git still the durable source representation throughout? | Git refs/packs may suffice. A new change ledger must justify itself and retain existing provenance rather than duplicate it. |
| When is a release candidate cut? | Time, feature completion, explicit request, accumulated evidence, and risk are possible triggers; none was selected. |
| Who may promote and deploy? | Human approval, preauthorized automation, and environment-specific authority have different contracts. This capture authorizes none of them. |
| What evidence makes a candidate eligible? | Required checks, examinations, product acceptance, skips, and exceptions need explicit policy. |
| How can new knowledge invalidate eligibility? | A critical defect or policy revision may affect a previously green candidate without changing its historical test results. |
| What happens when the development base is broken? | Continued work, affected-work suspension, and repair priority need a bounded policy. |
| How are intermediate agreements revised and escalated? | Determines whether consumers can proceed and how stale assumptions become visible. |
| What is published to GitHub, and when are PRs required? | Durability, external contributors, branch protections, and human review cannot be inferred from internal change identity. |
| How far does Nightshift own deployment? | Artifact promotion, environment configuration, observation, migrations, and recovery are new responsibilities, not just a shell command. |
| How do old programs and records coexist with the new semantics? | Requires explicit migration/versioning and tests, not permanent ambiguous statuses or silently weakened conformance. |

### Suggested planning slices and testable iterations

These are planning groups, deliberately not claimed to be single small issues. Each can be split into the smaller seams listed. Resolve decisions only as their dependent work approaches. Maintain a working, observable vertical path throughout; do not defer all Studio or recovery work until the end.

#### 1. Define the new evidence and lifecycle model

Establish the distinction between development inclusion, release-candidate eligibility, run completion, and deployment. Decide the initial scope of a development line and write the explicit amendments to existing promises.

Possible issue boundaries: pure state transitions and invariants; source/evidence identity contracts; compatibility readers; a small lifecycle simulator or fixture suite. No production scheduling behavior needs to change in the first increment.

Proof: an unverified development snapshot cannot acquire verified evidence through a status transition; a candidate is immutable; old records retain their meaning; unauthorized promotion is refused. Include cancellation, supersession, missing evidence, and conflicting writers rather than testing only a happy path.

#### 2. Preserve change lineage and durable snapshots

Connect existing job/node/commit provenance to exact development compositions and candidate membership. Reuse the current durable pack/publication machinery where it fits. Decide whether an additional record is necessary only after mapping what existing records already establish.

Possible issue boundaries: membership/lineage queries; snapshot creation with ownership fencing; durable publication/recovery; inclusion views in Studio. GitHub PR policy can remain unchanged until durability is proven independently.

Proof: a worker or machine can disappear after contribution completion without losing the contribution; a recovered controller reconstructs the exact snapshot; concurrent publishers cannot overwrite unrelated work; publication failure is visible without inventing verification failure.

#### 3. Separate verification execution from ending a run

Extract or generalize the useful immutable-checkout machinery so a selected snapshot can be verified independently of `run.finish`. Preserve exact evidence bindings and existing behavior for current programs until their explicit transition.

Possible issue boundaries: snapshot-based verification API; durable background execution/status; cancellation and restart; evidence presentation. Avoid a second verification runner with different outcome rules.

Proof: verification of snapshot N continues while development advances to N+1; results identify N only; restart does not create contradictory terminal results; stale success cannot certify the moving head.

#### 4. Introduce continuous development integration and repair

Allow the chosen development line to accept contributions under its new policy without blocking every advance on full release verification. Schedule checks and repairs as explicit work, retaining serialization only where actual source/state mutation requires it.

Possible issue boundaries: composition scheduling; failure records and ownership; repair delegation; affected-work containment; recovery and Studio status. The first end-to-end example can be deliberately small and deterministic.

Proof: two independently valid changes create a failing combined snapshot; the failure is recorded against that combination; repair produces a new snapshot; permitted unrelated work continues; a foundational failure triggers the chosen containment policy. Do not automatically blame or reverse the last merged change.

#### 5. Cut and qualify immutable release candidates

Bind selected snapshots to required policy and artifact identities. Keep eligibility separate from historical test outcomes and from whether development has moved ahead.

Possible issue boundaries: candidate creation; policy/evidence completeness; artifact binding; explicit invalidation/supersession; release overview in Studio. Product-facing acceptance evidence should be included where the project needs it, rather than assuming compilation means the feature works.

Proof: candidate 120 can become eligible while development is at 135, and its eligibility applies only to 120's artifacts. Missing mandatory evidence blocks qualification. A changed requirement is recorded explicitly. A failed candidate is never mutated into its replacement.

#### 6. Add an honest promotion and deployment lifecycle

If deployment ownership is selected, implement it as an authorized external-effect lifecycle. Start with a deterministic fake adapter to prove orchestration, then a deliberately chosen real target. Do not assume an existing verification command is a sufficient deployment record.

Possible issue boundaries: deployment intent and authority; exact artifact/configuration selection; idempotent adapter execution; observation/reconciliation after interruption; environment-specific recovery and Studio history.

Proof: duplicate requests do not deploy twice; a crash after an external action but before recording success can be reconciled; a moving tag cannot substitute a different artifact; failed rollout is distinct from failed candidate verification. Database migrations and other irreversible effects must not inherit an unjustified “rollback” promise.

#### 7. Allow decision dependencies during concurrent work

After the authority model is clear, add a persistent question/answer or agreement mechanism that can unblock work before another job finishes. Adapt native messaging where its capabilities suffice.

Possible issue boundaries: agreement identity and authority; awaited requests and resumes; revisions and stale-consumer notifications; harness capability adapters; blocked-work visibility. An initial controlled two-agent scenario is enough to prove the distinction without building a general chat system.

Proof: A and B run concurrently; A asks B a concrete interface question; B answers within authority; A resumes before B completes. Duplicate delivery, cancellation, unauthorized answers, revised agreements, and cyclic waits have defined outcomes.

#### 8. Reuse verification evidence where equivalence is demonstrable

Select one high-cost, well-understood class of computation. Define its complete relevant inputs and trust boundary before caching it. Broaden only when the dependency model supports it.

Possible issue boundaries: input fingerprints; artifact/result storage; reuse provenance; invalidation tests; measurements of avoided work. This can proceed alongside later lifecycle work once evidence identity is settled.

Proof: changed toolchain, dependency, configuration, or relevant source forces recomputation; identical valid inputs permit reuse; missing/corrupt evidence causes a miss; a check requiring fresh external observation is not silently reused. Measure total savings including cache preparation and misses.

#### 9. Reduce environment preparation without sharing mutable state

Measure and optimize setup separately from verification reuse. Investigate prepared images, dependency stores, checkout creation, and warm service startup using current runtime and ownership rules.

Possible issue boundaries: setup timing attribution; one prepared-environment path; integrity/invalidation; isolation/recovery tests. This group is relatively independent once snapshot and environment identities are clear.

Proof: two workers can build incompatible changes concurrently without generated-file, port, or database interference; stale preparation is invalidated; destroyed workers can be replaced; infrastructure savings and idle costs are visible.

#### 10. Evaluate the resulting execution alternatives

Bring back same-input comparison scenarios only after a useful alternative exists. Compare a strong solo path, the current strand path, and the Pipkin path on fixed starting code and acceptance criteria, with repeated runs and unsuccessful attempts included. Additional lead/investigator or parallel-implementer variants can follow when actually implemented.

Possible issue boundaries: reproducible scenario fixtures; automated outcome collection; aggregate reporting; selected real-agent trials. These should evaluate delivered results, elapsed time, resources, intervention events, and observed defects without demanding manual retrospectives.

Proof: comparisons can reproduce their input conditions and expose failures rather than dropping them. No routing policy changes automatically because one small sample favors a model or arrangement. Performance claims should distinguish controlled comparisons from different real-world tasks.

### Cross-cutting acceptance scenarios

The following scenarios should survive issue decomposition as end-to-end obligations:

1. Development advances while an older candidate is tested, and the exact older artifact is the one eligible for deployment.
2. A combined snapshot fails; the currently deployed release remains accurately represented as healthy or unhealthy from its own evidence.
3. A repair creates new source and evidence without erasing the failed snapshot or fabricating causal blame.
4. A controller restarts during verification, publication, or deployment and reconciles durable state without repeating an irreversible effect blindly.
5. Two runs contend for a shared development line and cannot bypass ownership through independent per-run queues.
6. A required check is unavailable or skipped; the candidate cannot be presented as fully proven merely because other commands passed.
7. An agreement changes after a dependent agent used it; that consumer is discoverable and its assumptions are visibly stale.
8. Reused evidence identifies its original execution and all required input matches; resources are not double counted.
9. The owner can understand deployed, candidate, and development status from the Studio overview and give a one-click outcome rating.
10. Existing programs and stored records retain their documented guarantees through the chosen migration.

## Pointers

### Repository orientation

- [Product vision](../vision.md) and [architectural decisions](../architecture.md): read with later amendments in mind, especially A-41, A-47, A-57, A-59, and A-60.
- [P18 strand builds](../programs/p18-strand-builds.md): the current execution foundation and the historical evidence that already led to fewer per-job gates.
- [P20 measurement plan](../programs/p20-measurements/plan.md), [contract](../programs/p20-measurements/contract.json), and [kept conversation](../programs/p20-measurements/conversation.md): measurement scope and owner feedback constraints. Verify implementation status afresh.
- [Strand execution](../../packages/execution/src/strand.ts), [integration](../../packages/execution/src/integrate.ts), and [merge queue](../../packages/execution/src/merge-queue.ts): current boundaries between merged and verified work.
- [End gates](../../packages/execution/src/end-gates.ts) and [verification schema](../../packages/contracts/src/v1/verification.ts): immutable verification machinery and the existing phase vocabulary.
- [Publication](../../packages/execution/src/publish.ts) and [remote publisher](../../apps/api/src/runner/publisher.ts): durable packs, publication intents, ordering, and leases.
- [Core integration rules](../../packages/core/src/rules/integration.ts): current requirements for integration and ending program nodes.
- [Studio run page](../../apps/studio/src/pages/run.tsx): product presentation to evolve alongside the lifecycle.

Useful existing test anchors include [strand builds](../../test/src/execution/strand-builds.test.ts), [recovery](../../test/src/execution/recovery.test.ts), [integrated slice](../../test/src/slice/integrated.test.ts), [end gates](../../packages/execution/src/end-gates.test.ts), [publication](../../packages/execution/src/publish.test.ts), [remote publication](../../apps/api/src/runner/publisher.test.ts), [integration rules](../../packages/core/src/rules/integration.test.ts), and [state transitions](../../packages/core/src/rules/transitions.test.ts). Extend real guarantees; do not weaken a conformance suite merely to accommodate ambiguous new states.

### Research discussed in the session

These are primary sources consulted for the discussion on 2026-10-20. Vendor capabilities and availability can change; revisit them when selecting an implementation dependency. They inform the possibilities, not evidence that a particular product fits Nightshift unchanged.

- [Anthropic: redesigning source control](https://www.anthropic.com/research/redesigning-source-control) — Scion and the motivation for rethinking source-control operations and validation timing at agent scale.
- [Bazel remote execution APIs](https://github.com/bazelbuild/remote-apis) — an established model for input-addressed actions and reusable results; no Bazel adoption is implied.
- [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) and [Mergify speculative merging](https://mergify.com/learn/merge-queue/speculative-merging) — existing approaches to overlapping validation of combined changes.
- [Entire](https://entire.io/) and [Cursor Origin](https://cursor.com/docs/origin) — agent-oriented hosting/context directions; investigate separately from execution architecture.
- [Jujutsu](https://github.com/jj-vcs/jj) and [GitButler parallel agents](https://docs.gitbutler.com/ai-agents/parallel-agents) — alternative local change workflows; distinguish shared-workspace convenience from runtime isolation.
- [Claude agent teams](https://code.claude.com/docs/en/agent-teams) and [subagents](https://code.claude.com/docs/en/sub-agents) — native delegation and communication capabilities whose headless/version restrictions matter.
- [AutoGen messaging](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html) — framework-level request/response patterns, not a ready-made Nightshift control plane.

A future planning session should retain the owner's ambition and the explicit change in integration philosophy, inspect the current implementation and P20 outcome, and resolve the nearest architectural decisions before specifying dependent iterations. It should not need to reconstruct this conversation or mistake the proposed details here for already-ratified decisions.
