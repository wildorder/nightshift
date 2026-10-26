# Report: Make every verification evidence that can be relied on later: it records what it ran against, it counts as landing evide

Run `run_01M5X6AQMD39PZZ52BKRX190C8` of plan `1eeeeb0a70cf`: **succeeded**. The plan's only strand, S-01 (Evidence that names its inputs), is integrated at fdf0bb0d. Verification passed: setup, build, typecheck, lint, test, synth and sterility. The independent examination also passed. The first examination raised two material findings: F-01, identical-retry comparison in the SQLite/DynamoDB verification stores, and F-02, gateFingerprintOf. The strand's orchestrator fixed both before landing. No root-level retries, repairs, raised timeouts or skipped steps. PK-2 stays deferred to M2 (D-02).

1 of 1 strands succeeded; 0 deferred; 0 parked. Wall clock 56 min 35 s.

## Completion histories

none recorded: nightshift completion create ... groups the runs that delivered one outcome. This run's own outcome is not completion.

GitHub has every landing: `program/p22-evidence-names-its-inputs` is at `fdf0bb0d03ce`.

## Stories

### US-01 Every verification names its inputs, counts as landing evidence only when its phase is one that lands, and can never be : done

- **Who:** Anyone who later relies on a verification: the owner reading why something landed, and the Pipkin work that will reuse and compare evidence
- **Today:** A verification does not record what it ran against (the base, the gate definitions, the machine), so two results cannot be compared or trusted later; the code counts a verification as landing evidence by excluding the phases that do not land, so any new kind of verification would silently let work land; and two of the three stores let a verification be overwritten.
- **Afterwards:** Every verification names its inputs, counts as landing evidence only when its phase is one that lands, and can never be rewritten once recorded.
> "seems like PK-1 and PK-2 are lightweight and low risk. I could execute those, run a couple tests, before doing PK-3 which seems higher risk?"

Criteria: SC-01 met, SC-02 met, SC-03 met, SC-04 met. Strands: S-01.

## Gate health

Audit: **healthy** at `ec4bd064`, 2026-10-09T17:29:07.301Z.

### Verification time

11m 28s across 2 verifications and 0 landings.

Retained rerun time: 0.0s across 0 flaky first run(s) and failed rerun(s), included in the totals.

| Step | Runs | Total | Reruns | Per run | Quiet start | Queue / candidate / end | Forecast per run |
|------|------|-------|--------|---------|-------------|-------------------------|------------------|
| `setup:install` | 2 | 13.4s | none | 6.7s | 0.1s | 2 / 0 / 0 | — |
| `build` | 2 | 7.1s | none | 3.5s | 0.1s | 2 / 0 / 0 | — |
| `typecheck` | 2 | 5.3s | none | 2.7s | 0.1s | 2 / 0 / 0 | — |
| `lint` | 2 | 2.0s | none | 1.0s | 0.1s | 2 / 0 / 0 | — |
| `test` | 2 | 10m 17s | none | 5m 08s | 0.1s | 2 / 0 / 0 | — |
| `synth` | 2 | 42.9s | none | 21.5s | 0.1s | 2 / 0 / 0 | — |
| `sterility` | 2 | 0.3s | none | 0.2s | 0.1s | 2 / 0 / 0 | — |

No recommendations: run `nightshift gates <program> --record` before a run to keep what the gates resolve to, and the report prices them here.

## Strands

### S-01 Evidence that names its inputs: succeeded

Acceptance, as planned:
- Every verification written by runVerification and by the candidate check carries baseSha, gateFingerprint and its environment identity; a record written before reads unchanged
- One core rule names the landing phases, every acceptor of landing evidence uses it, and an exhaustive test over the phase vocabulary fails for a phase nobody classified
- Memory, SQLite and DynamoDB refuse a second, different write of a verification and accept an identical one; the conformance suite proves it on all three
- The phases are declared once in contracts, and the report, verification time and the Studio read them from there
- docs/architecture.md records the decision
- build, typecheck, lint, test, synth and sterility are green

| Job | Status | Commit | Attempts |
|---|---|---|---|
| Contracts: in packages/contracts/src/v1/verification.ts declare the verification phase vocabulary once and add the evide | merged | 0f685ca6 | 1 |
| Persistence: make `verifications.put` create-only in every store. Memory (packages/persistence/src/memory/index.ts) and  | merged | 2796f17b | 1 |
| Docs: add a settled-decision row to docs/architecture.md §2 (the '/ # / Decision / Consequence /' table; use the next fr | merged | aa4f9bdf | 1 |
| Core: add `isLandingEvidence(phase: VerificationPhase / undefined): boolean` in packages/core/src/rules/verification.ts  | merged | aaaaf7d1 | 1 |
| Execution: fill baseSha, gateFingerprint and environment (fields added to VerificationSchema in @nightshift/contracts) o | merged | 4f174f55 | 1 |
| Studio: read verification phases from @nightshift/contracts' VERIFICATION_PHASES (order queue, candidate, run) instead o | merged | 5b198b42 | 1 |
| Execution acceptors: replace every ad-hoc landing-evidence exclusion on a verification's phase with core's `isLandingEvi | merged | 44c15b61 | 1 |
| Strand integration check: this branch now holds the whole strand (verification phase vocabulary and evidence-identity fi | cancelled |  | 1 |
| Tests only: close the gap the provenance job left against acceptance 1. Every verification built by the end gates (packa | merged | ebc98034 | 1 |
| Strand integration check: this branch now holds the whole strand (verification phase vocabulary and evidence-identity fi | merged | a4297603 | 1 |
| Fix examiner finding F-01 (persistence): verifications.put's identical-retry check compares the parsed input with the st | merged | 87fcb422 | 1 |
| Fix examiner finding F-02 (execution): gateFingerprintOf in packages/execution/src/verification-provenance.ts (~L36-49)  | merged | fdf390d1 | 1 |

- Contracts: in packages/contracts/src/v1/verification.ts declare the verification phase vocabulary once and add the evide
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Persistence: make `verifications.put` create-only in every store. Memory (packages/persistence/src/memory/index.ts) and 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Docs: add a settled-decision row to docs/architecture.md §2 (the '/ # / Decision / Consequence /' table; use the next fr
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Core: add `isLandingEvidence(phase: VerificationPhase / undefined): boolean` in packages/core/src/rules/verification.ts 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Execution: fill baseSha, gateFingerprint and environment (fields added to VerificationSchema in @nightshift/contracts) o
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Studio: read verification phases from @nightshift/contracts' VERIFICATION_PHASES (order queue, candidate, run) instead o
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Execution acceptors: replace every ad-hoc landing-evidence exclusion on a verification's phase with core's `isLandingEvi
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Tests only: close the gap the provenance job left against acceptance 1. Every verification built by the end gates (packa
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Strand integration check: this branch now holds the whole strand (verification phase vocabulary and evidence-identity fi
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-01 (persistence): verifications.put's identical-retry check compares the parsed input with the st
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded
- Fix examiner finding F-02 (execution): gateFingerprintOf in packages/execution/src/verification-provenance.ts (~L36-49) 
  - Route: claude-sonnet-5-5 (implementer's choice 1) by implementer: succeeded

## Success criteria

| Criterion | State | By |
|---|---|---|
| SC-01 A verification made from now on records its base commit, the fingerprint of the gate definitions it ran, and where it ran (laptop, or machine with its dispatch generation and image version); a verification recorded before reads and renders unchanged. | met | S-01 |
| SC-02 One rule in core names the phases that are landing evidence; every place that accepts landing evidence uses it, and a test over every phase fails if a phase is added without deciding whether it lands. | met | S-01 |
| SC-03 Writing a verification that already exists with a different body is refused by every store (memory, SQLite, DynamoDB) as well as the API; writing the identical record again is harmless. | met | S-01 |
| SC-04 The verification phases are declared once, and the report and the Studio read them from there, so a phase added later renders without editing either. | met | S-01 |

## Parked

Nothing was parked.

## Deferred

Nothing was deferred.

## Human prerequisites still pending

None.

## Decision graph

Every decision the run recorded: what was weighed, what it produced, and whether you
reversed it. To reverse one: `nightshift decision reverse <program> <decisionId> --choice … --reason …`.

- **Plan:** D-01: Does a verification record a separate setup hash beside the gate fingerprint? (`dec_01M5X6ARET4P0MF3FN6YT7YBSV`)
  Chose: No: the gate fingerprint already hashes the setup steps, the verification steps, the gate machinery and every lockfile. One home per fact; a separate setup hash would record what the fingerprint already does.
  Weighed: Yes: a hash of the lockfiles and setup commands of its own
  Reversible.
  Produced: nothing that landed.
- **Plan:** D-02: Is PK-2 (verify any commit on demand) built now, or with M2? (`dec_01M5X6ASP6A1BQNVRYPDE1WXGQ`)
  Chose: With M2, beside PK-4 and PK-5, where a commit has a record to file evidence under and candidate qualification uses it. Built once, where it is used: before PK-4 a verification outside a run has no honest home, and its main consumers are PK-5 and PK-7.
  Weighed: Now, limited to verifying within a live run
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 1 — 7 jobs, 3 starting at once (`dec_01M5X6KS1FH519GSSNMVNK3GVK`)
  Chose: J1: Contracts: in packages/contracts/src/v1/verification.ts declare the verification phase vocabulary once and add the evidence-identity fields. Export `VERIFICATION_PHASES = ["candidate","queue","run"] as const`, `type VerificationPhase`, and `VerificationPhaseSchema = z.enum(VERIFICATION_PHASES)`; `VerificationSchema.phase` becomes `VerificationPhaseSchema.optional()` (absent still reads as queue). Export `VERIFICATION_PHASE_HAS_JOB: Readonly<Record<VerificationPhase, boolean>>` ({candidate:true, queue:true, run:false}) and rephrase the `jobContractId ⇔ phase` refine over it (an absent phase is `queue`), so a new phase must state whether it has a job. Add three optional fields to VerificationSchema: `baseSha: CommitShaSchema.optional()` (the commit the verified commit was checked against/landed onto), `gateFingerprint: z.string().min(1).optional()` (the P15 gate fingerprint at the verified commit), and `environment: VerificationEnvironmentSchema.optional()` where `VerificationEnvironmentSchema = z.discriminatedUnion("where", [z.strictObject({where: z.literal("laptop")}), z.strictObject({where: z.literal("machine"), generation: z.int().min(1), imageVersion: z.string().min(1)})])`, exported with its type. Doc-comment each field. Export everything from the contracts index as the other verification exports are.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/verification.ts, packages/contracts/src/v1/*.test.ts, packages/contracts/src/index.ts, packages/contracts/src/v1/index.ts
  - VERIFICATION_PHASES, VerificationPhase, VerificationPhaseSchema, VERIFICATION_PHASE_HAS_JOB, VerificationEnvironmentSchema/VerificationEnvironment are exported from @nightshift/contracts
  - A record without baseSha/gateFingerprint/environment (e.g. the existing examples and fixtures) parses unchanged; a test asserts an old-shaped record parses and round-trips identically
  - Tests: a laptop and a machine environment parse; a machine environment missing generation or imageVersion is refused; the jobContractId/phase refine still refuses a run verification with a job and a queue/candidate/absent-phase verification without one
  - npm run build, typecheck, lint and the contracts tests pass

J2: Core: add `isLandingEvidence(phase: VerificationPhase | undefined): boolean` in packages/core/src/rules/verification.ts beside markVerified: true for queue (and an absent phase, which reads as queue), false for candidate and run. Implement it as an exhaustive classification `Record<VerificationPhase, boolean>` (so the type system forces a new phase to be classified) and add a test in the style of the transition tables that iterates VERIFICATION_PHASES from contracts and fails for any phase not explicitly classified in the test's own expected table. Use it in explainEvidenceMismatch in place of `verification.phase === "candidate"` (reason text may name the phase). Export it from @nightshift/core. Make the report read phases from contracts: packages/core/src/report/verification-time.ts drops its own VerificationPhase type/VERIFICATION_PHASES list and builds byPhase from contracts' VERIFICATION_PHASES (re-export the names from core if other code imports them from there); the report's phase breakdown in packages/core/src/report/report.ts (the 'Queue / candidate / end' column) is produced by iterating that constant rather than naming the three keys. Rendered report text must stay the same for existing phases.
  depends on: J1
  touches: packages/core/src/rules/verification.ts, packages/core/src/rules/verification.test.ts, packages/core/src/index.ts, packages/core/src/report/verification-time.ts, packages/core/src/report/report.ts, packages/core/src/report/*.test.ts
  - isLandingEvidence is exported from @nightshift/core and is the only check explainEvidenceMismatch makes on phase
  - An exhaustive test over VERIFICATION_PHASES fails if a phase is added to contracts without being classified (demonstrate in the test by asserting the test's expected table keys equal VERIFICATION_PHASES)
  - verification-time.ts and report.ts no longer hard-code the phase list; existing report tests pass unchanged
  - npm run build, typecheck, lint and core tests pass

J3: Execution acceptors: replace every ad-hoc landing-evidence exclusion on a verification's phase with core's `isLandingEvidence`. Sites: packages/execution/src/integrate.ts (~L141, `record.phase !== "candidate"`), packages/execution/src/merge-queue.ts (~L292, recovery's passing-queue-verification lookup), packages/execution/src/strand.ts (~L223, `phase !== "candidate" && phase !== "run"`), packages/execution/src/dataset.ts (~L78 and ~L112, the queue's verdict preferred over a candidate check). Search packages/ and apps/ for any other `phase !== "candidate"`/`=== "candidate"` test on a Verification used to decide evidence and convert it too (end-gates.ts selecting `phase === "run"` records is not a landing acceptor; leave it). Behaviour for existing records must not change.
  depends on: J2
  touches: packages/execution/src/integrate.ts, packages/execution/src/merge-queue.ts, packages/execution/src/strand.ts, packages/execution/src/dataset.ts, packages/execution/src/integrate.test.ts, packages/execution/src/*.test.ts
  - No code outside core's isLandingEvidence compares a Verification's phase to decide whether it is landing evidence (grep shows none)
  - Existing integrate, merge-queue, strand and dataset tests pass; add a test that a passing candidate verification for the commit is refused as evidence by integrate
  - npm run build, typecheck, lint and the execution tests pass

J4: Execution: fill baseSha, gateFingerprint and environment on every verification built by runVerification (packages/execution/src/verify.ts) and by the candidate builder in packages/execution/src/examine.ts (~L1220, phase "candidate"). baseSha: in runVerification use input.baseSha (the queue's base); for the end gates (phase run, no base passed) record the commit the run's program branch started from if the session/environment already knows it, otherwise omit it; for the candidate, the job's base (input.base). gateFingerprint: compute with fingerprintAtCommit(gitBlobReader(repo), commitSha, gates, record.machinery) where record is the project's gate-health record read as gate-repair.ts reads it (environment.stores.gateHealth); when there is no store or no record (no machinery), omit the field — never fail the verification for it. environment: from ExecutionEnvironment.site — absent or laptop gives {where:"laptop"}; a machine gives {where:"machine", generation, imageVersion} when the site carries an imageVersion (omit environment if a machine site has none). Plumb the image version as the dispatch generation already is: extend the machine variant of RunSite in packages/core/src/rules/prerequisite-checks.ts with optional `imageVersion?: string` (prerequisite logic untouched); in apps/mcp/src/runner/root.ts set `NIGHTSHIFT_IMAGE_VERSION` in the root's environment from the dispatch attempt for this generation's `amiVersion` (packages/contracts dispatch.ts), add it to any env allow-list (apps/mcp/src/headless.ts lists NIGHTSHIFT_DISPATCH_GENERATION), and have machineSiteOf in apps/mcp/src/compose.ts carry it when set (absence must not change whether the site is a machine).
  depends on: J1
  touches: packages/execution/src/verify.ts, packages/execution/src/examine.ts, packages/execution/src/environment.ts, packages/execution/src/verify.test.ts, packages/execution/src/examine*.test.ts, packages/core/src/rules/prerequisite-checks.ts, apps/mcp/src/compose.ts, apps/mcp/src/runner/root.ts, apps/mcp/src/headless.ts, apps/mcp/src/**/*.test.ts
  - A queue verification, an end-gate verification and a candidate verification written in tests carry environment {where:"laptop"} on a laptop environment and a machine environment with generation and imageVersion when the site has them; queue and candidate carry baseSha
  - With a gate-health record present the verification carries the same gateFingerprint fingerprintAtCommit gives for that commit; with none the field is absent and the verification still succeeds (tested)
  - machineSiteOf returns imageVersion from NIGHTSHIFT_IMAGE_VERSION and its existing behaviour without it is unchanged (tested); the runner root env names NIGHTSHIFT_IMAGE_VERSION (tested where root env is already tested)
  - npm run build, typecheck, lint and the execution and mcp tests pass

J5: Persistence: make `verifications.put` create-only in every store. Memory (packages/persistence/src/memory/index.ts) and SQLite (packages/persistence/src/local, which backs the same table abstraction): if a record with that key exists and its stored body differs (deep/canonical comparison of the parsed record) refuse with a typed conflict error consistent with the repository's existing conflict errors; an identical body is a no-op success. DynamoDB (packages/persistence/src/aws/stores.ts): a conditional put (`attribute_not_exists` on the key); on ConditionalCheckFailed read the stored item and answer success when it is identical, otherwise the same conflict error. Make the HTTP store/route surface the refusal as the existing conflict mapping does (409 or equivalent) if verification puts go through it. Check no existing caller re-puts a verification with a changed body; if one does, report it in the hand-in. Extend the store conformance suite (test/src/harness/adapter-conformance.test.ts / test/src/conformance, whichever runs stores against memory, SQLite and the DynamoDB fake) with: a second different put is refused and the first stays; an identical second put succeeds.
  depends on: nothing (starts at once)
  touches: packages/persistence/src/memory/index.ts, packages/persistence/src/local/**, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/stores.test.ts, packages/persistence/src/http/**, test/src/conformance/**, test/src/harness/adapter-conformance.test.ts
  - Memory, SQLite and DynamoDB (fake table) all refuse a second, different verification put with a conflict error and keep the original; all accept an identical second put; the conformance suite proves it on all three
  - No existing test or caller relies on overwriting a verification
  - npm run build, typecheck, lint and persistence + test package tests pass

J6: Studio: read verification phases from @nightshift/contracts' VERIFICATION_PHASES instead of its own keys: apps/studio/src/components/run/gate-health.tsx (the 'Queue / candidate / end' cell naming byPhase.queue/candidate/run), apps/studio/src/components/run/parts.tsx (`v.phase ?? "queue"`) and any other Studio place that names verification phases literally (not the operation-lifecycle phases in overview/timeline, which are a different vocabulary). Rendered text stays the same for existing phases.
  depends on: J1
  touches: apps/studio/src/**
  - No Studio file lists the verification phases literally; they come from contracts' VERIFICATION_PHASES
  - Studio tests pass; rendering of the gate-health table is unchanged for existing data
  - npm run build, typecheck, lint pass

J7: Docs: add a settled-decision row to docs/architecture.md §2 (next free A- number) for evidence identity and the landing-evidence rule: a verification records baseSha, gateFingerprint (which already covers setup, steps, machinery and lockfiles, so no separate setup hash, D-01) and its environment (laptop, or machine with dispatch generation and image version); the verification phases are declared once in contracts and core's isLandingEvidence alone says which are landing evidence (queue; not candidate or run), with an exhaustive test forcing every new phase to be classified; verification records are immutable: every store refuses a different second write and accepts an identical one. Note PK-2 (verify any commit on demand) is deferred to M2. Do not edit docs/programs/.
  depends on: nothing (starts at once)
  touches: docs/architecture.md
  - docs/architecture.md has one new row in the settled-decisions table stating the above, in the style of neighbouring rows
  - No file under docs/programs/ is changed; lint passes. J1 (contracts) is the foundation: J2 core rule/report, J4 field filling and J6 Studio need its vocabulary and fields and run in parallel after it. J3 (execution acceptors) needs J2's isLandingEvidence; it touches integrate/merge-queue/strand/dataset, disjoint from J4's verify/examine/environment and mcp files, so they do not conflict. J5 (create-only stores) and J7 (docs) depend on nothing and start at once. J2 and J3 are high risk: every landing passes through that rule. J5 is high risk (data immutability). Departure-free except one detail I record: the machine image version is optional on RunSite so prerequisite judging is untouched, and environment is omitted on a machine site lacking it (the runner always names it).
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 1 of 2 — revise (`dec_01M5X6PSMNNSE82KG1ZXH6KEX3`)
  Chose: The main dependency chain and implementation boundaries are sensible, and the landing-rule jobs are correctly marked high risk. However, the split weakens the evidence-identity acceptance, prescribes inconsistent display ordering, and leaves the full strand verification unowned.
- [MATERIAL] J4 explicitly permits newly written end-gate verifications to omit baseSha and machine verifications to omit environment, whereas criterion 1 requires both on every producer path. The strand explicitly allows missing gateFingerprint without gate-health machinery, but does not grant these additional exceptions. RunSession and Run do not directly carry the starting SHA, and end-gates.ts calls runVerification without baseSha, so 'if already known, otherwise omit' does not deliver the requirement. Specify how the starting base is obtained and how machine identity is guaranteed, and require tests asserting these fields on end-gate and machine records rather than only queue/candidate bases. (J4)
- [MATERIAL] J1 fixes VERIFICATION_PHASES to candidate,queue,run, while J2 and J6 must iterate it and preserve existing rendered output. The current core constant is queue,candidate,run, and both report.ts:1719 and gate-health.tsx:90 render counts under 'Queue / candidate / end' in that order. Following the proposed iteration swaps candidate and queue counts or changes output, violating the jobs' own acceptance. Align the shared ordering and rendering instructions before independent workers implement them. (J1, J2, J6)
- [MATERIAL] Criterion 6 is not covered by any job's acceptance or an explicit integration check: jobs run selected package tests plus build/typecheck/lint, but none owns the complete npm test, npm run synth and npm run check:sterility on the assembled strand. These commands are configured in package.json (also composed by npm run verify). Assign responsibility for running and resolving the full final checks. (J1, J2, J3, J4, J5, J6, J7)
- [minor] The image-version source is misstated: DispatchAttemptSchema has no amiVersion; DispatchSchema.amiVersion is required and documents that recovery reuses the same image. Point the runner plumbing at context.dispatch.amiVersion, rather than an attempt for the current generation, so the worker does not invent per-attempt schema changes. (J4). An independent examiner reviewed decision dec_01M5X6KS1FH519GSSNMVNK3GVK against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN: round 2 — 8 jobs, 3 starting at once (`dec_01M5X6RNKBAKCJHFMXBTPBPBAD`)
  Chose: J1: Contracts: in packages/contracts/src/v1/verification.ts declare the verification phase vocabulary once and add the evidence-identity fields. Export `VERIFICATION_PHASES = ["queue","candidate","run"] as const` (this order: it is the order the report and Studio render, 'Queue / candidate / end'), `type VerificationPhase`, and `VerificationPhaseSchema = z.enum(VERIFICATION_PHASES)`; `VerificationSchema.phase` becomes `VerificationPhaseSchema.optional()` (absent still reads as queue). Export `VERIFICATION_PHASE_HAS_JOB: Readonly<Record<VerificationPhase, boolean>>` ({queue:true, candidate:true, run:false}) and rephrase the `jobContractId ⇔ phase` refine over it (an absent phase is `queue`), so a new phase must state whether it has a job. Add three optional fields to VerificationSchema: `baseSha: CommitShaSchema.optional()` (the commit the verified commit was checked against/landed onto), `gateFingerprint: z.string().min(1).optional()` (the P15 gate fingerprint at the verified commit), and `environment: VerificationEnvironmentSchema.optional()` where `VerificationEnvironmentSchema = z.discriminatedUnion("where", [z.strictObject({where: z.literal("laptop")}), z.strictObject({where: z.literal("machine"), generation: z.int().min(1), imageVersion: z.string().min(1)})])`, exported with its type. Doc-comment each field. Export everything from the contracts index as the other verification exports are.
  depends on: nothing (starts at once)
  touches: packages/contracts/src/v1/verification.ts, packages/contracts/src/v1/*.test.ts, packages/contracts/src/index.ts, packages/contracts/src/v1/index.ts
  - VERIFICATION_PHASES (order queue, candidate, run), VerificationPhase, VerificationPhaseSchema, VERIFICATION_PHASE_HAS_JOB, VerificationEnvironmentSchema/VerificationEnvironment are exported from @nightshift/contracts
  - A record without baseSha/gateFingerprint/environment (e.g. the existing examples and fixtures) parses unchanged; a test asserts an old-shaped record parses and round-trips identically
  - Tests: a laptop and a machine environment parse; a machine environment missing generation or imageVersion is refused; the jobContractId/phase refine still refuses a run verification with a job and a queue/candidate/absent-phase verification without one
  - npm run build, typecheck, lint and `npm run test` for the contracts workspace pass

J2: Core: add `isLandingEvidence(phase: VerificationPhase | undefined): boolean` in packages/core/src/rules/verification.ts beside markVerified: true for queue (and an absent phase, which reads as queue), false for candidate and run. Implement it as an exhaustive classification `Record<VerificationPhase, boolean>` (so the type system forces a new phase to be classified) and add a test in the style of the transition tables that iterates VERIFICATION_PHASES from contracts and fails for any phase not explicitly classified in the test's own expected table. Use it in explainEvidenceMismatch in place of `verification.phase === "candidate"` (reason text may name the phase). Export it from @nightshift/core. Make the report read phases from contracts: packages/core/src/report/verification-time.ts drops its own VerificationPhase type/VERIFICATION_PHASES list and builds byPhase from contracts' VERIFICATION_PHASES (keep re-exporting the names from core if other code imports them from there); the report's phase breakdown in packages/core/src/report/report.ts (the 'Queue / candidate / end' column, currently `${byPhase.queue.runs} / ${byPhase.candidate.runs} / ${byPhase.run.runs}`) is produced by mapping VERIFICATION_PHASES in its order (queue, candidate, run) and joining with ' / '. Rendered report text must stay byte-identical for existing data.
  depends on: J1
  touches: packages/core/src/rules/verification.ts, packages/core/src/rules/verification.test.ts, packages/core/src/index.ts, packages/core/src/report/verification-time.ts, packages/core/src/report/report.ts, packages/core/src/report/*.test.ts
  - isLandingEvidence is exported from @nightshift/core and is the only check explainEvidenceMismatch makes on phase
  - An exhaustive test over VERIFICATION_PHASES fails if a phase is added to contracts without being classified (the test asserts its expected table's keys equal VERIFICATION_PHASES)
  - verification-time.ts and report.ts no longer hard-code the phase list; existing report tests pass unchanged
  - npm run build, typecheck, lint and `npm run test` for the core workspace pass

J3: Execution acceptors: replace every ad-hoc landing-evidence exclusion on a verification's phase with core's `isLandingEvidence`. Sites: packages/execution/src/integrate.ts (~L141, `record.phase !== "candidate"`), packages/execution/src/merge-queue.ts (~L292, recovery's passing-queue-verification lookup), packages/execution/src/strand.ts (~L223, `phase !== "candidate" && phase !== "run"`), packages/execution/src/dataset.ts (~L78 and ~L112, the queue's verdict preferred over a candidate check). Search packages/ and apps/ for any other `phase !== "candidate"`/`=== "candidate"` test on a Verification used to decide evidence and convert it too (end-gates.ts selecting `phase === "run"` records is not a landing acceptor; leave it). Behaviour for existing records must not change.
  depends on: J2
  touches: packages/execution/src/integrate.ts, packages/execution/src/merge-queue.ts, packages/execution/src/strand.ts, packages/execution/src/dataset.ts, packages/execution/src/integrate.test.ts, packages/execution/src/merge-queue*.test.ts, packages/execution/src/strand*.test.ts, packages/execution/src/dataset*.test.ts
  - No code outside core's isLandingEvidence compares a Verification's phase to decide whether it is landing evidence (grep shows none)
  - Existing integrate, merge-queue, strand and dataset tests pass; add a test that a passing candidate verification for the commit is refused as evidence by integrate
  - npm run build, typecheck, lint and `npm run test` for the execution workspace pass

J4: Execution: fill baseSha, gateFingerprint and environment on EVERY verification built by runVerification (packages/execution/src/verify.ts; called by the queue's verifyNode and by end-gates.ts) and by the candidate builder in packages/execution/src/examine.ts (~L1220, phase "candidate"). baseSha (always set): queue = input.baseSha already passed to runVerification (make it required where the queue calls it); candidate = the job's base (input.base); end gates (phase run) = `git merge-base <head> <repository.baseBranch>` in the session repo (try the local branch, then `origin/<baseBranch>`), falling back to the head itself when neither resolves, since the end gates verify a head with no change onto anything; end-gates.ts passes it in. Do NOT change NIGHTSHIFT_BASE_SHA told to end-gate steps (keep verificationFacts' input as today). gateFingerprint: compute with fingerprintAtCommit(gitBlobReader(repo), commitSha, gates, record.machinery) where record is the project's gate-health record read as gate-repair.ts reads it (environment.stores.gateHealth); when there is no store or no record (no machinery), omit the field — never fail the verification for it. environment (always set): from ExecutionEnvironment.site — absent or laptop gives {where:"laptop"}; a machine gives {where:"machine", generation, imageVersion: site.imageVersion ?? "unknown"}. Plumb the image version as the dispatch generation already is: extend the machine variant of RunSite in packages/core/src/rules/prerequisite-checks.ts with optional `imageVersion?: string` (prerequisite logic untouched); in apps/mcp/src/runner/root.ts set `NIGHTSHIFT_IMAGE_VERSION = context.dispatch.amiVersion` (DispatchSchema.amiVersion, which recovery reuses; not a per-attempt field) beside NIGHTSHIFT_DISPATCH_GENERATION; add it wherever NIGHTSHIFT_DISPATCH_GENERATION is listed for passing through (apps/mcp/src/headless.ts); machineSiteOf in apps/mcp/src/compose.ts carries it when set (its absence must not change whether the site is a machine).
  depends on: J1
  touches: packages/execution/src/verify.ts, packages/execution/src/examine.ts, packages/execution/src/end-gates.ts, packages/execution/src/environment.ts, packages/execution/src/verify*.test.ts, packages/execution/src/examine*.test.ts, packages/execution/src/end-gates*.test.ts, packages/core/src/rules/prerequisite-checks.ts, apps/mcp/src/compose.ts, apps/mcp/src/runner/root.ts, apps/mcp/src/headless.ts, apps/mcp/src/**/*.test.ts
  - Tests show a queue verification, an end-gate (run) verification and a candidate verification each carry baseSha and environment: {where:"laptop"} with no site/laptop site, and {where:"machine", generation, imageVersion} with a machine site (imageVersion "unknown" when the site lacks one)
  - End-gate baseSha is the merge-base with the base branch in a test repo, and the head when the base branch cannot be resolved (tested)
  - With a gate-health record present the verification carries the same gateFingerprint fingerprintAtCommit gives for that commit; with none the field is absent and the verification still succeeds (tested)
  - machineSiteOf returns imageVersion from NIGHTSHIFT_IMAGE_VERSION and its behaviour without it is unchanged (tested); the runner root env names NIGHTSHIFT_IMAGE_VERSION from the dispatch's amiVersion (tested where root env is already tested)
  - npm run build, typecheck, lint and `npm run test` for the execution, core and mcp workspaces pass

J5: Persistence: make `verifications.put` create-only in every store. Memory (packages/persistence/src/memory/index.ts) and SQLite (packages/persistence/src/local, which backs the same table abstraction): if a record with that key exists and its stored body differs (deep/canonical comparison of the parsed record) refuse with a typed conflict error consistent with the repository's existing conflict errors; an identical body is a no-op success. DynamoDB (packages/persistence/src/aws/stores.ts): a conditional put (`attribute_not_exists` on the key); on ConditionalCheckFailed read the stored item and answer success when it is identical, otherwise the same conflict error. Make the HTTP store/route surface the refusal as the existing conflict mapping does (409 or equivalent) if verification puts go through it. Check no existing caller re-puts a verification with a changed body; if one does, report it in the hand-in. Extend the store conformance suite (test/src/harness/adapter-conformance.test.ts / test/src/conformance, whichever runs stores against memory, SQLite and the DynamoDB fake) with: a second different put is refused and the first stays; an identical second put succeeds.
  depends on: nothing (starts at once)
  touches: packages/persistence/src/memory/index.ts, packages/persistence/src/local/**, packages/persistence/src/aws/stores.ts, packages/persistence/src/aws/stores.test.ts, packages/persistence/src/http/**, test/src/conformance/**, test/src/harness/adapter-conformance.test.ts
  - Memory, SQLite and DynamoDB (fake table) all refuse a second, different verification put with a conflict error and keep the original; all accept an identical second put; the conformance suite proves it on all three
  - No existing test or caller relies on overwriting a verification
  - npm run build, typecheck, lint and `npm run test` for the persistence and test workspaces pass

J6: Studio: read verification phases from @nightshift/contracts' VERIFICATION_PHASES (order queue, candidate, run) instead of its own keys: apps/studio/src/components/run/gate-health.tsx (the 'Queue / candidate / end' cell, currently naming byPhase.queue/candidate/run; produce it by mapping VERIFICATION_PHASES in order joined with ' / '), apps/studio/src/components/run/parts.tsx (`v.phase ?? "queue"`: use the contracts' default, e.g. VERIFICATION_PHASES[0] or a named constant if J1 provides none) and any other Studio place that names verification phases literally (not the operation-lifecycle phases in overview/timeline, which are a different vocabulary). Rendered text stays identical for existing phases.
  depends on: J1
  touches: apps/studio/src/**
  - No Studio file lists the verification phases literally; they come from contracts' VERIFICATION_PHASES
  - Studio tests pass; the gate-health table renders the same text for existing data
  - npm run build, typecheck, lint and `npm run test` for the studio workspace pass

J7: Docs: add a settled-decision row to docs/architecture.md §2 (next free A- number) for evidence identity and the landing-evidence rule: a verification records baseSha, gateFingerprint (which already covers setup, steps, machinery and lockfiles, so no separate setup hash, D-01) and its environment (laptop, or machine with dispatch generation and image version); the verification phases are declared once in contracts and core's isLandingEvidence alone says which are landing evidence (queue; not candidate or run), with an exhaustive test forcing every new phase to be classified; verification records are immutable: every store refuses a different second write and accepts an identical one. Note PK-2 (verify any commit on demand) is deferred to M2. Do not edit docs/programs/.
  depends on: nothing (starts at once)
  touches: docs/architecture.md
  - docs/architecture.md has one new row in the settled-decisions table stating the above, in the style of neighbouring rows
  - No file under docs/programs/ is changed; lint passes

J8: Strand integration check: on the branch holding J1–J7, run the full gates exactly as the landing will: npm run build, npm run typecheck, npm run lint, npm run test, npm --workspace @nightshift/cdk run synth, npm run check:sterility. Fix any failure the strand's changes caused (e.g. fixtures, snapshots, exhaustive switches or call sites elsewhere in the repo that the new contract fields, the create-only put or isLandingEvidence affected), without weakening any test or changing the strand's intended behaviour. If everything is green, hand in with no change.
  depends on: J1, J2, J3, J4, J5, J6, J7
  touches: any file needing a repair, most likely tests and fixtures under packages/**, apps/**, test/**
  - All six commands exit 0 on the job's final tree
  - Any fix is limited to repairing breakage from this strand and is explained in the hand-in. Revised per review: VERIFICATION_PHASES is ordered queue, candidate, run so report and Studio iterate it with byte-identical output; J4 now always sets baseSha (end gates: merge-base with the base branch, falling back to the head) and environment (machine imageVersion from DispatchSchema.amiVersion, 'unknown' if absent), tested on queue, run and candidate records; J8 owns the full six gates on the assembled strand. Parallelism unchanged: J1, J5, J7 start at once; J2, J4, J6 after J1; J3 after J2; J8 last. J2/J3 high risk (every landing passes through isLandingEvidence), J5 high risk (immutability).
  Weighed: the plan as authored
  Weighed: one job for the whole strand, rejected because it builds nothing in parallel and is reviewed as one
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** STRAND PLAN REVIEW: round 2 of 2 — sound (`dec_01M5X6TDP4YE8MY8QNA9F0R0XW`)
  Chose: The split covers the strand’s acceptance criteria, with real dependencies and separate implementation files for the parallel jobs. The existing code supports the proposed phase centralization, evidence identity plumbing and store immutability; J8 supplies the full assembled-strand verification, and the landing-rule and persistence jobs are appropriately marked high risk.. An independent examiner reviewed decision dec_01M5X6RNKBAKCJHFMXBTPBPBAD against the strand's brief and acceptance.
  Weighed: build the plan as authored
  Weighed: revise the plan before building
  Reversible.
  Produced: nothing that landed.
- **Strand S-01:** How a verification fills baseSha and its environment where the plan left it open: the end gates have no base passed to them, and the machine's image version might not reach the engine. (`dec_01M5X6TM3HSS80SXNG3G0KSFWZ`)
  Chose: An end-gate verification's baseSha is git merge-base(head, repository.baseBranch), falling back to the head itself. A machine records the imageVersion from DispatchSchema.amiVersion, named by the runner as NIGHTSHIFT_IMAGE_VERSION, and records "unknown" when it is absent. RunSite gains an optional imageVersion, so prerequisite judging is unchanged.. This keeps every new record complete without adding contract surface beyond the plan's, and it leaves the prerequisite logic untouched.
  Weighed: Omit baseSha on end-gate records and environment on a machine without an image version, rejected because Acceptance 1 requires every record from runVerification to carry both
  Weighed: Add a starting SHA to Run/RunSession, rejected because New contract surface for one consumer; merge-base answers it from git
  Reversible.
  Produced: nothing that landed.

## Usage

Token counts are what each harness reported and are not comparable across harnesses.
A cost marked * is estimated from the price table, not reported by the harness. A cost
that is unknown had neither: give the org's price table a price for that model to estimate it.
Each attempt counts one figure in the cost column (reported when it has one, else estimated). The
Reported and Estimated columns split that by kind; provider-reported dollars are never summed with
an API-equivalent estimate.

| Harness | Model | For | Routes | Input tokens | Output tokens | Cost per attempt (USD) | Reported (n: USD) | Estimated (n: USD) | Basis |
|---|---|---|---|---|---|---|---|---|---|
| claude | claude-opus-5-5 | work | 2 | 8026852 | 41671 | 3.44 | 2: $3.44 | none | provider-reported; 2 of 2 attempts valued |
| codex | gpt-6-astra | examine | 4 | 1974681 | 7029 | unknown | none | none | unknown; 0 of 4 attempts valued |
| claude | claude-sonnet-5-5 | work | 11 | 4380578 | 55548 | 2.38 | 11: $2.38 | none | provider-reported; 11 of 11 attempts valued |
| claude | claude-opus-5-5 | root | 1 | 2959453 | 6420 | 1.25 | 1: $1.25 | none | provider-reported; 1 of 1 attempts valued |

## Where the time went

Elapsed not observed (as of 2026-10-26T23:43:40.621Z); elapsed is the run's window and phase figures below are interval unions. Peak concurrency 4.

- **summed work (overlapping; not elapsed):** 1h 19m, each closed work interval counted in full

- **By phase (union, counted once):** work 39m 16s, wait 9m 20s, queue 0.0s, integration 14m 23s, examination 5m 02s, setup 1m 32s, startup 1m 42s, verification 11m 30s
- **Wait by blocker kind:** parent_slot 8m 10s, job 9m 06s
- **Unattributed:** not observed. **Ambiguous (open or incomplete, in no union):** 54m 33s
- **Endings:** integrated 1, merged 11, integration conflict 0, verification failed 0, failed 0, deferred 0, examination stopped 1, examination skipped 0, other 0

Observed chain (not a claim about a faster schedule): covers 53m 48s of not observed, coverage not observed, complete; 0 ambiguous step(s).

1. node_01M5X6FMDF077V1G3B6YRY1APR integration 2026-10-26T23:36:55.633Z to 2026-10-26T23:43:36.448Z (6m 41s, via end)
1. node_01M5X6FMDF077V1G3B6YRY1APR work 2026-10-26T23:30:09.211Z to 2026-10-26T23:36:55.159Z (6m 46s, via work)
1. node_01M5X6FMDF077V1G3B6YRY1APR startup 2026-10-26T23:30:08.393Z to 2026-10-26T23:30:09.211Z (0.8s, via attempt)
1. node_01M5X6FMDF077V1G3B6YRY1APR wait 2026-10-26T23:30:08.275Z to 2026-10-26T23:30:08.393Z (0.1s, via attempt)
1. node_01M5X6FMDF077V1G3B6YRY1APR integration 2026-10-26T23:22:29.500Z to 2026-10-26T23:30:07.579Z (7m 38s, via retry)
1. node_01M5X6FMDF077V1G3B6YRY1APR work 2026-10-26T22:49:59.261Z to 2026-10-26T23:22:29.026Z (32m 30s, via work)
1. node_01M5X6FMDF077V1G3B6YRY1APR startup 2026-10-26T22:49:46.940Z to 2026-10-26T22:49:59.261Z (12.3s, via attempt)
1. node_01M5X6FMDF077V1G3B6YRY1APR wait 2026-10-26T22:49:46.823Z to 2026-10-26T22:49:46.940Z (0.1s, via attempt)

## Delivery

12 work item(s) and 0 repair job(s) in 1 strand(s); 11 attempt(s), 4 helper call(s).

- **First-attempt success:** all jobs: 11/12 (92%), 0 unfinished; coverage partial (1 settled job node(s) have no routing decision (legacy))
- **Excluding repair jobs:** jobs: 11/12 (92%), 0 unfinished
- **Outcomes:** landed 11, cancelled 1; failed by none
- **Rework:** 0 attempt(s), each counted once
  - unknown cause: 0 attempt(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
- **First attempts:** input 4380578, output 55548 tokens (complete coverage: complete 11); estimated not observed, reported $2.38 (provider-reported)
- **All rework:** input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed

## Human verdict

A person's one-click verdict on whether the run worked. It is not a verification and says nothing about why.

- Verdict: **not rated**
- This program: 0 of 0 ended run(s) rated; 0 worked, 0 did not; positive share among rated n/a; 0 unrated.

## Review

- **Coverage:** 1 node(s) examined, 11 examined by strand, 0 landed unexamined, 0 skipped; 2 examination(s) (passed 1, findings_raised 1)
- **Dispositions:** 2 unique finding(s); latest fixed 2; rulings none. fixed means the finding was not raised again; upheld means the arbiter agreed. Neither is independently established truth.
- **Overhead by role (apart from repairs):**
  - examiner: 2 call(s); input 1230279, output 3767 tokens (partial coverage: partial 2); estimated not observed, reported not observed; 2 unpriced
  - answerer: 0 call(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
  - arbiter: 0 call(s); input not observed, output not observed tokens (complete coverage); estimated not observed, reported not observed
  - plan review: 2 call(s); input 744402, output 3262 tokens (partial coverage: partial 2); estimated not observed, reported not observed; 2 unpriced
- **Repairs caused by review:** 1 attempt(s); input 1916873, output 4605 tokens (complete coverage: complete 1); estimated not observed, reported $0.58 (provider-reported)
- **Linkage:** findings linked 2; 0 helper call(s) unlinked; 0 repair(s) without findings

## Machine

- **Lifetime:** not observed (coverage unknown; 0 observed ending(s), 0 runner-only ending(s); last machine ending not observed, last runner ending not observed; 1 attempt(s) without an observed end; gaps between attempts 0.0s)
  - attempt 1 (dispatch): machine end unobserved, runner not ended
- **Instance:** $0.42 for 3378s (runner-metered 3378s), runner-metered seconds; machine end unobserved (lower bound) (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2; unknown)
- **Volume:** $0.01 for 3390.091s, open (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2)
- **Total:** $0.43 (Instance: 3378 s from runner-metered seconds; machine end unobserved (lower bound) at 0.44352 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2); volume: 3390.091 s from request to asOf (not yet deleted) at 0.010958904109589041 USD/h (priceBasis COMPUTE_TIERS (AWS on-demand price feed, D-P10-26), as of 2026-09-25, region us-west-2).)
- **Recorded spend:** {"estimatedUsd":10.907493698630137,"ceilingSeconds":86400,"meteredUsd":0.4264527050228311,"meteredSeconds":3378}; computed $0.43 against metered $0.43 over 3378s (computedUsd prices instance and volume together over spend.meteredSeconds, as meteredUsd does; the components above use each one's own observed lifetime.)
- **Occupancy:** coverage partial; busy 0.0s at least, idle not claimed (No attempt has an observed machine end (terminatedAt), so idle time is not claimed; busy time is observed busy time, at least.), provisioning 1m 54s, setup not observed; peak 0 concurrent occupant(s)
- **Per-node shares:** none. No attempt has an observed machine end (terminatedAt), so cost cannot be apportioned to nodes. Each observed-closed attempt costs its observed machine lifetime (terminatedAt - startedAt) at the instance rate, split by occupied time within that same window (concurrent occupants share each moment equally). The cost of attempts without an observed machine end (open, or machine end unobserved) is never apportioned and is listed per attempt, together with unoccupied time within closed attempts and the whole volume, as unapportioned.

## Request evidence

Per-request ledgers are stored as artifacts. Fetch one through the authorized download route:
operation `artifact.createDownloadUrl`, `POST .../artifacts/{artifactId}/download-url`.

| Attempt | Artifacts | Ids |
|---|---|---|
| node_01M5X6FMDF077V1G3B6YRY1APR work #1 | 26 | art_01M5X6J9ZKMHF4S2S3F34159VD, art_01M5X6MK0CJECYFZ8JSEZ7GHTS, art_01M5X6Q1D0H9DNSTYZDDR2D3X7, art_01M5X6S5FX9JNKJ3HPJKVV7B31, art_01M5X6V4A9G5HVZBYQYSQ4HNEW, art_01M5X6XQZKQD79E5CGE4QCSP5C, art_01M5X6ZJYR5Y6XYG7RYDB5JTBM, art_01M5X71PBTZZT8WPMG11RD4K86, art_01M5X7451ZJJPWDNZ8AMQNX3KR, art_01M5X76JN786E2BVT9WH1ZQ59G, art_01M5X78QHNPGD0KAKSNXX251AC, art_01M5X7BFE3T84XKSZAGBH7VHK0, art_01M5X7DZ23JFGQBTBVB1T5EMTD, art_01M5X7G1XKE6SKFH546CGRY6WW, art_01M5X7JST3613SMJA4R79EVS62, art_01M5X7MVSSJNN1WGRMZG9S9FQG, art_01M5X7QC9PDD8TPVCXFKDR86G4, art_01M5X7T0WVFSFN7B3EQH96DKQM, art_01M5X7VYS4MMRF3AYWE1QKT7JP, art_01M5X7YPNMHN5PAWBZTRW18GRJ, art_01M5X80YM5BY7BF1636H3AZ4DS, art_01M5X83955DZHHNR42MJBNJRVX, art_01M5X8611NVBGY7THYW8EJAQNE, art_01M5X88RY5ECP553MHBYC0VGXW, art_01M5X8AZ01KN66C6P1NEE95002, art_01M5X8BH0CRYMKFK2W52QQTBNB |
| node_01M5X6FMDF077V1G3B6YRY1APR examine #1 | 2 | art_01M5X6PHS354D0MEMNR4Z2TE94, art_01M5X6PSC7JS2D53G1XXZWDEN5 |
| node_01M5X6FMDF077V1G3B6YRY1APR examine #1 | 1 | art_01M5X6TDEP03PKZ11420YM939B |
| node_01M5X6FMDF077V1G3B6YRY1APR examine #1 | 2 | art_01M5X8S46VJH68AK9Y740NNWQV, art_01M5X8SFK49ASX4VF86VPHZRG0 |
| node_01M5X6FMDF077V1G3B6YRY1APR work #2 | 6 | art_01M5X8W19HX7MD6RYCV82APNZA, art_01M5X8Y4GBN1X89D9DNGF057MJ, art_01M5X9008W3ZGB3R18X06AWPEP, art_01M5X92PZX8HM62Z6RKZKRW8E2, art_01M5X956ADJ3R8JS59HVNZRESN, art_01M5X95YTXVMYQMD4K4J8SMYKB |
| node_01M5X6FMDF077V1G3B6YRY1APR examine #1 | 1 | art_01M5X9J4AVMFBGG4DY0AWDQPTR |
| node_01M5X6TTJMW68A9D9N4WQ9NQ5B work #1 | 1 | art_01M5X6WPG1WVESZ7HQAK7ESF7X |
| node_01M5X6TYWZ29CBYKNVS87J4J2A work #1 | 4 | art_01M5X6X5ZENDKE7BCZK5Y35YJS, art_01M5X77SXWEA9PGCS0BJZT7S20, art_01M5X79ZZHBQ7KGBA7CMXPYYMN, art_01M5X7A8S9G7HX1MK2QRCDRE32 |
| node_01M5X6V2HYWHS909FM03QV7K5D work #1 | 1 | art_01M5X6XJZ03BVMT3RA8RBVZJK5 |
| node_01M5X6V9P3D043ESBHWAWHBVWZ work #1 | 1 | art_01M5X6ZT010J3DKKTC86SPMMXV |
| node_01M5X6VJS2DE0WM4ASF4EF2V3Z work #1 | 3 | art_01M5X723TARACKZ573H8HNW7TJ, art_01M5X7477787NVG1V1YRZ993KN, art_01M5X74FBT5VHST12BFH288N36 |
| node_01M5X6VPF6AHWKYY8CG96MT9E3 work #1 | 1 | art_01M5X76EY3VJQF39JWA2W3Q2N8 |
| node_01M5X6VVRJ6549Q3QGSMF6KRM7 work #1 | 2 | art_01M5X78NQJDCST3NY2ZSTAATBA, art_01M5X78R3XJ3W8BYR22PXE4CKH |
| node_01M5X751BAVYAYZB3CJN4W239M work #1 | 2 | art_01M5X7B0S2SMEDED0YVS8SQJX9, art_01M5X7C4B0QDJV2H77KQ2E4WGT |
| node_01M5X7566E7VJZTWAWMWEF3F31 work #1 | 4 | art_01M5X7F58EDVFCV2C55KBJKKN0, art_01M5X7QCY1N0Z0A50MZ881Q8Q4, art_01M5X82CG5310J0SHF1PR97SBA, art_01M5X8ATN0Y5JZK0BS5BKM39D6 |
| node_01M5X8T0DHX4YRQ2CFWHTKE250 work #1 | 2 | art_01M5X8X0NBNWVHN8WFVAFKVA3B, art_01M5X95DECCTTBNFYMCA40FYTJ |
| node_01M5X8T65RJ0CQA47KFWX2CB1P work #1 | 2 | art_01M5X8WC4V13STCDCWEVWN4030, art_01M5X8WD95MZPD203FZXYDF7S6 |
| node_01M5X6AQMD39PZZ52BKRX190C9 root #1 | 42 | art_01M5X6H63B7DXBKM6Y227M785D, art_01M5X6KQNF0XHFJYS00MXCCR3T, art_01M5X6NRJYM3E9C09DKGDY7EAC, art_01M5X6RGFE1RFCCJM2NSS5MWA7, art_01M5X6TSFF7J9X7N7SFMDG5DDB, art_01M5X6X2YZMDWKAJQRJBCWTSY3, art_01M5X6ZTVKN0CZQHFY2AFH0HRR, art_01M5X71X7ZTWFAZW7K62DF1QTD, art_01M5X74DB2DXC42ZZ60VDXYG0H, art_01M5X7757M4NY8NFMRQ71EWPFD, art_01M5X7910G6BGVJKJ1HDYJSTAA, art_01M5X7BQQ6K12RSQ3DQ24321EC, art_01M5X7ED1QC0SEM1T398B1AJT3, art_01M5X7GA6NAEFR77102JVNMTFH, art_01M5X7K237GA96TN2R0XGQR9AZ, art_01M5X7NFT5PE9C4APJB4BCEF25, art_01M5X7QMJTDCQ8SF7N6JW512C2, art_01M5X7TCF8EFP1ZSD3SMPMSJ65, art_01M5X7WKJDEXD8CFJEQDJM97K3, art_01M5X7YYYSAY5E7VBQJ7HHQGHK, art_01M5X81PVJTFHNH3Y0XYT9EFY6, art_01M5X83QA5ZS5GJ19KKQZ3KEHS, art_01M5X869AWVQR2KZZQ2AYR13BS, art_01M5X8917CVCETWJE2FFCQX6SR, art_01M5X891EC94K18RW7N6QAR50D, art_01M5X8BS46S54TWPJMWW3JZ0D1, art_01M5X8EDDQJ4FAT1Q412D6BVFX, art_01M5X8GBKF6W76RTRPE937T0JD, art_01M5X8K3G0T23FBXB3FSCVTFNQ, art_01M5X8NJ4HA6G75F1TGYB4NRYD, art_01M5X8QNZH5XNBM15FBC7YAS9R, art_01M5X8TDW201R0KZEPWBXSM6QF, art_01M5X8WSTB4NQGQEP621BAYB6T, art_01M5X8Z0BNC1R9QFFHQARR7Y1T, art_01M5X91R86DY2QBJX9TYBPVMHQ, art_01M5X93ZGFP6TCSHSJG7C5SBCM, art_01M5X96AQVWRN37HV4K7W167KP, art_01M5X992MEM8BR027B37A0N8SM, art_01M5X9B56SRA4XV2K2N7ZSKK1P, art_01M5X9DN3ZCFC3NA5WVDH8EFE2, art_01M5X9GD0KGRVBS1FZAZZJN7R1, art_01M5X9JBWK925KZ07CVPCQEK6H |

## Definitions

- **Active seconds** (`active_seconds`): Seconds during which something was executing for the run, as recorded by the control plane. Idle gaps are excluded. Denominator: Runs with recorded activity intervals.
- **Agent time** (`agent_time`): Harness execution time of an agent, from its start to its end. It excludes verification, queueing and integration. Denominator: Agents with both a recorded start and end.
- **API-equivalent estimate** (`api_equivalent_estimate`): An estimate of what the measured tokens would cost at a price table's list rates. It is an estimate from a price table, not a bill, and subscription or negotiated pricing may differ. Denominator: Attempts with a price-table entry for their model and measured tokens; others are unpriced.
- **Combined estimate** (`combined_estimate`): The model estimate plus the machine estimate. It is a lower bound when either part is incomplete. Denominator: Runs with both parts measured count fully; the rest are listed as incomplete.
- **Completion lead time** (`completion_lead_time`): Time from a story or goal being planned to its work being delivered, as recorded on a completion checkpoint. Denominator: Completion checkpoints whose members all have recorded times.
- **Coverage** (`coverage`): How completely an attempt's resources were observed: complete, partial, unknown, legacy (route figures only) or missing. Missing evidence is never shown as zero. Denominator: All attempts in the selected population, tallied by coverage class.
- **Delivered outcomes** (`delivered_outcomes`): Jobs whose work was verified and integrated, counted once each however many attempts it took. Denominator: All jobs in the selected population, delivered or not.
- **Elapsed completion time** (`elapsed_completion_time`): Wall-clock time from the start of the run or story to its completion, measured on the clock; overlapping work is counted once. Denominator: Completed runs or stories only; unfinished ones are excluded and counted in the sample size.
- **Examination time** (`examination_time`): Time examiners and the helper routes serving them (answering, arbitrating) spent on examinations of the work. Denominator: Examination routes with a recorded start and end.
- **Examiner dispositions** (`examiner_dispositions`): How examiners' findings were resolved: upheld, rejected, fixed or still open. Denominator: Findings raised in the selected population.
- **First-attempt success** (`first_attempt_success`): Delivered jobs whose first attempt (attempt 1) was verified and integrated without a later attempt. Association with rework is not causation. Denominator: Jobs that reached a terminal state in the selected population; jobs still running are not counted.
- **Human verdict** (`human_verdict`): The person's binary verdict on whether a run worked, captured with its attribution. It is separate from deterministic verification and does not change recorded outcomes. Denominator: Runs that received a verdict; unrated runs have none.
- **Infrastructure estimate** (`infrastructure_estimate`): An estimate of the machine expense of runs executed on Nightshift-provisioned machines, from their utilization and a rate table. Denominator: Runs with a machine report; local runs have none and are absent, not zero.
- **Integration time** (`integration_time`): Time spent integrating verified work onto its target branch, after verification passed. Denominator: Integrated jobs with recorded integration intervals.
- **Provider-reported cost** (`provider_reported_estimate`): The dollar figure the provider or harness itself reported, kept apart from the price-table estimate and never summed with it. It is an estimate of spend, not an invoice. Denominator: Attempts whose harness reported a cost; others are unpriced.
- **Queue time** (`queue_time`): Time verification requests waited for the verification queue before they started running. Denominator: Verifications in the selected population that recorded a queue phase.
- **Rating coverage** (`rating_coverage`): The share of completed runs that carry a human verdict. Denominator: Completed runs in the selected population.
- **Review overhead** (`review_overhead`): Resources and time spent by examination and arbitration routes, shown beside the work they reviewed. It is not a measure of review quality. Denominator: Helper routes in the selected population compared with all routes.
- **Rework attempts** (`rework_attempts`): Attempts made after a node's first attempt: escalations and retries of the same node's work. Association with other factors is not proof of causation. Denominator: Attempts of jobs in the selected population; the first attempt of each job is not rework.
- **Rework by cause** (`rework_by_cause`): Rework attempts grouped by the cause recorded when the attempt was made (for example verification failure or examiner finding). An attempt with several causes appears under each. Denominator: Rework attempts with a recorded cause; those without one are counted as unattributed.
- **Run completion time** (`run_completion_time`): Time from a run's start to its completion, measured on the clock. Denominator: Runs that completed.
- **Sample size** (`sample_size`): How many rows matched a filter and how many there were in all, so a figure is read against its population. Denominator: Matched rows out of all rows before filtering.
- **Settlement time** (`settlement_time`): Time from an attempt's start until its node settled, including verification, queue and integration. It is longer than agent time. Denominator: Routing decisions that recorded a wall-clock figure.
- **Summed work time** (`summed_work_time`): The sum of every attempt's working time. It is not elapsed time: work overlaps, so the sum can exceed the clock time of the run. Denominator: Attempts with a recorded start and end; attempts without both add nothing and are counted as missing.
- **Cache-read tokens** (`tokens_cache_read`): Tokens served from the provider's prompt cache, where reported. Denominator: Attempts whose provider reports cache reads; others are not counted as zero.
- **Cache-write tokens** (`tokens_cache_write`): Tokens written to the provider's prompt cache, where reported. Denominator: Attempts whose provider reports cache writes; others are not counted as zero.
- **Input tokens** (`tokens_input`): Input tokens the provider reported, normalized to include cache reads and writes where the convention is known; an unknown convention is flagged and the raw figure kept. Denominator: Attempts with a measured input counter; attempts without one are counted in coverage, never as zero.
- **Output tokens** (`tokens_output`): Output tokens the provider reported for the attempts. Denominator: Attempts with a measured output counter; absent counters are not zero.
- **Reasoning tokens** (`tokens_reasoning`): Reasoning or thinking tokens, where the provider reports them apart from output. Denominator: Attempts whose provider reports reasoning tokens; others are not counted as zero.
- **Wait time** (`wait_time`): Time the run spent waiting rather than working: for a human, for capacity, or for a prerequisite, as recorded on the control plane. Denominator: Runs with recorded waiting intervals; absent intervals are unknown, not zero.
