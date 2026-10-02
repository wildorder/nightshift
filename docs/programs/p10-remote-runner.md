# Program P10 — Remote Runner

| Field | Value |
|-------|-------|
| Program ID | `p10-remote-runner` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p10-remote-runner` |
| Source stage | Stage 9, `00-source-program-plan.md`; P10 in `staging.md` |
| Status | **Ratified 2026-10-01** (D-P10-12 … D-P10-25 agreed; the A-14 amendment stands as A-51). **In build**: T1 and T2 landed 2026-10-01, T3 and T4's first chunk 2026-10-02, T4 live-accepted the same day (§15); T4 complete but for worker token renewal and the root's session id; D-P10-25 live-accepted 2026-10-02 |
| Depends on | P9 (correction), P12 (token profiles, one loopback server), P14 (stories); the implementation base is `main` after `fc20125` (program setup) |
| Outcome | Dispatch a program to a machine of the customer's chosen size, close the laptop, and return to verified, published output or a durable account of partial work; the machine is recommended from the project, starts warm, and is right-sized from the runs before it |
| Blocking decisions | none: D-P10-12 … D-P10-25 ratified; H-P10-01 … H-P10-06 satisfied. The two provider API keys are T5's gate |

This contract is the stable authority for P10. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §13. Nightshift v1 is
planned by the human in this document, not by Nightshift's planning tools.

## 1. Objective

Make Nightshift **walk-away**: `nightshift run <program> --remote` starts the
run on a machine Nightshift owns, returns a run id, and nothing more is needed
from the laptop. The run continues to verified output on the program branch at
GitHub, recovers from the machine's death on its own, and leaves a durable
account when it cannot finish.

Three product requirements shape the machine (§3.1):

1. **The customer chooses the hardware**, from three tiers: good, better, best.
2. **Nightshift recommends the tier** from the project before the first run, and
   from the measured use of earlier runs after it, so nobody overpays or runs
   out of memory at 3 a.m.
3. **Starts are warm.** A project's dependencies are not downloaded again on
   every run; a per-project cache volume holds the clone, the package stores and
   the last installed tree, and the program's `setup` runs against them.

The AgentCore harness worker with a Bedrock model (SC-04's third half, SC-05) is
built here, as a process on the run's machine (D-P10-12).

**What P10 is not.** No change to how a run delegates, routes, verifies,
examines or lands: the engine, merge queue, examination and correction run
unchanged on the remote machine. No private runners, no Nightshift-supplied
inference, no customer billing (§5). No Studio work beyond showing the records
this program adds.

### What exists today

- `apps/cli/src/commands/run.ts` accepts `--remote` and refuses it; `startRun`
  in `packages/execution` does the half that is the same local and remote
  (persist program, run, root node, initial checkpoint).
- `apps/mcp/src/headless.ts` starts the root orchestrator as an agent like any
  other, with the orchestrator-role MCP server hosting the run's engine. The
  remote runner starts exactly this, on another machine.
- A program's `setup` runs in every checkout Nightshift creates before the
  agent starts and before every verification (`fc20125`). The cache makes
  setup fast; it does not replace it.
- Workers hold execution tokens (A-35); the engine still holds the operator's
  session. Execution tokens cannot mint tokens and live at most eight hours.
- `packages/harness-agentcore/src/index.ts` is empty.
- The 2026-09-28 probe measured AgentCore Runtime Instances: ARM64, a persistent
  volume, and **zero Linux capabilities** (`NoNewPrivs=1`, seccomp on): no
  Docker daemon, no sandboxed Chromium, no choice of machine beyond a capacity
  provider. That evidence is why §3.1's answers move the substrate (§14).

## 2. Environment and human prerequisites

| # | Prerequisite | Verify | Status |
|---|--------------|--------|--------|
| H-P10-01 | Ratify D-P10-16 … D-P10-23 and the A-14 amendment (A-51) | this document's §13 carries the ruling | **satisfied 2026-10-01** |
| H-P10-02 | EC2 quota in `us-west-2` for the three tiers: at least 32 vCPUs of on-demand standard (A, C, D, H, I, M, R, T, Z) instances, so one `best` and one `better` run can overlap | `aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A` reports ≥ 32 | **satisfied 2026-10-01**: the account's quota is 64 vCPUs |
| H-P10-03 | Confirm the three instance classes and their on-demand prices in `us-west-2`, and record them in D-P10-13. **Done 2026-10-01**: $0.1632 / $0.3264 / $0.6528 per hour, offered in all four Oregon zones | `aws pricing get-products --region us-east-1 --service-code AmazonEC2 --filters Type=TERM_MATCH,Field=instanceType,Value=m7g.2xlarge Type=TERM_MATCH,Field=location,Value="US West (Oregon)" Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used` (per class) | **satisfied 2026-10-01** |
| H-P10-04 | **Operator.** Register the Nightshift GitHub App (Contents read and write, Metadata read, no webhooks) and put its App id and private key in Secrets Manager under `nightshift/github-app`: the service's own credential, the one secret an operator places by hand | `aws secretsmanager describe-secret --secret-id nightshift/github-app` succeeds | **satisfied 2026-10-01**: App `nightshift-publisher` (id 5152718) under `wildorder`, Contents write and Metadata read; the stored key signs a JWT GitHub accepts; local file deleted. Installed on `wildorder` as installation 166952409, currently on **all** repositories, to be narrowed to selected ones (this repo and the fixture) |
| H-P10-04b | **Customer.** Install the App on exactly the repositories Nightshift may touch: `wildorder/nightshift` and the fixture repository, with repository access set to selected, not all | With the stored App key, `GET /app/installations` then `GET /user/installations/{id}/repositories` (as the installation) lists exactly those two repositories; the smoke script carries this call | **satisfied 2026-10-01**: installation 166952409 is on selected repositories, and an installation token lists exactly `wildorder/nightshift` and `wildorder/nightshift-remote-fixture` (created private and empty the same day) |
| H-P10-05 | **Customer.** Enable the chosen cheap model in the paying account's Bedrock console (D-P10-04), and obtain an Anthropic and an OpenAI API key, kept in the owner's password manager until T5. The keys have no honest headless check before the verb that stores them exists, so handing them over is T5's first gate (§11), not a prerequisite | `aws bedrock get-foundation-model-availability --model-id anthropic.claude-haiku-4-5-20251001-v1:0` reports `AUTHORIZED` in the paying account | **satisfied 2026-10-01** for Bedrock: Haiku 4.5 authorized in `755348349819`, the owner's paying account as the first customer; the keys wait for T5 |
| H-P10-06 | **Operator.** Approve the shipped default ceilings of D-P10-19 (an org-wide monthly cap and a per-run cap), so no unpriced machine launches; an org lowers its own through `nightshift org config set` | recorded in D-P10-19 | **satisfied 2026-10-01**, provisionally: $300 a month, $50 a run, to be revisited against the first three live runs' metered cost |

**Operator and customer.** The owner is both today, and still takes the two
roles by their own paths: the service's credential (the App key) by hand, the
org's credentials (installation, provider keys, ceilings) through the CLI verbs
a second customer would use. The live fixture (§8) onboards its org through
those verbs, so the exit gate proves the customer path and not a shortcut.

**Explicitly not required.** No second AWS account (A-17). No customer-account
compute (D-P10-10). No Chromium or Docker promise beyond what T2 measures.

## 3. Decisions

### 3.1 The owner's direction, 2026-10-01

| # | Question | Answer |
|---|----------|--------|
| Q1 | Deliver P10 now? | **Yes**: "let's plan the remote runner work … it's time to deliver that" |
| Q2 | Who sizes the machine | **The customer**: "I want customers to be able to choose their hardware (at least a good/better/best)" |
| Q3 | Where a size comes from before the first run | **The project**: "I want us to be able to recommend a hardware based on the project" |
| Q4 | Starts | **Warm**: "I want caching to prevent super long startups with npm ci ... we shouldn't be downloading dependencies every time" |
| Q5 | Substrate, given the AgentCore evidence | **EC2 and EBS, superseding A-14**; the AgentCore harness worker stays in scope as a process on the instance |
| Q6 | Tier shape | **vCPU and memory steps on ARM64**, three tiers |
| Q7 | Where the recommendation comes from | **Both**: a deterministic probe of the project now, refined from past runs: "we definitely want that feature that aws lambda has where it can recommend the right memory adn compute based on past runs so you don't overpay." |
| Q8 | What is cached | **A per-project warm volume**: clone, package stores and the last installed tree, snapshotted when a run ends |

### 3.2 Decisions agreed before this plan (2026-09-27), unchanged

| ID | Decision |
|----|----------|
| D-P10-01 | **Git publication (O-06).** Push each verified integrated head to the program branch as it lands, fast-forward only; never worker branches, provisional work or main. Refuse concurrent branch movement; retain unpublished work. P10's explicit exception to A-29's no-push rule, for remote execution only. |
| D-P10-02 | **Dispatch input.** GitHub only. Remote dispatch requires a clean checkout, an already-pushed program branch and a ratified plan; it binds repository, branch, exact base SHA and plan hash, and refuses dirty or unpublished input. Customers install a GitHub App on selected repositories; runners receive read-only credentials; a trusted publisher outside the worker environment holds publication credentials. |
| D-P10-03 | **Harness authentication (O-05).** Claude Code and Codex through their subscriptions or provider API keys, plus Bedrock. Each supported remote sign-in, provisioning, renewal and revocation flow is established before the design is called done. No provider credentials in contracts, logs or record responses. |
| D-P10-04 | **Bedrock payer (O-05).** Bring-your-own inference for every mode; Bedrock is billed to the customer's account through A-25. Routing records the actual provider and model. |
| D-P10-05 | **Limits and retention (O-03, part).** Org-wide ceilings on run duration, concurrency and compute spend that a program may lower, never raise. Defaults: 24 hours per run, four concurrent jobs, three automatic recovery attempts, seven days of recoverable workspace, 90 days of reports and evidence. Recovery counts against the same limits. Stop compute when work ends. |
| D-P10-06 | **Recovery promise.** Recover from runner process or instance failure and continue the authorized run without the laptop. A replacement must not race a stale runner or duplicate publication. Three attempts within the run's limits. |
| D-P10-09 | **Inputs.** Remote execution requires a ratified planned program. |
| D-P10-10 | **Ownership.** Runners run in Nightshift's account, managed by the service. Customers bring inference, not infrastructure. |
| D-P10-11 | **Environment.** No customer images. Nightshift supplies the Linux environment; the program's `setup` handles project dependencies. |

D-P10-07 (remote identity) and D-P10-08 (seams) were open; they are answered
below as D-P10-20 and D-P10-21.

### 3.3 Decisions of this plan

D-P10-12 … D-P10-15 carry the owner's answers from §3.1; D-P10-16 … D-P10-23
were the planner's recommendations, each explained to and agreed by the owner
the same day (H-P10-01).

| ID | Decision | Rationale | Status |
|----|----------|-----------|--------|
| D-P10-12 | **The run's machine is one EC2 instance with an EBS workspace volume, launched from a Nightshift AMI. A-14 is superseded (A-51).** One instance per program run; the root orchestrator, the engine, the workers and the AgentCore harness worker are processes on it. Nightshift never runs a worker as a per-job hosted environment; that half of A-14 stands. AgentCore Runtime is not used for compute. | The 2026-09-28 probe: no capabilities, no Docker, no browser, no machine choice. Hardware tiers and a reusable disk need the machine and the disk. EC2 gives both and a volume that survives the instance, which is what recovery and the cache both want. | **agreed 2026-10-01** |
| D-P10-13 | **Three tiers on Graviton, `good` / `better` / `best`**: `m7g.xlarge` (4 vCPU, 16 GiB), `m7g.2xlarge` (8, 32), `m7g.4xlarge` (16, 64), with gp3 workspace volumes of 100, 200 and 400 GiB. One architecture, `arm64`. On-demand Linux in `us-west-2`, from the Pricing API on 2026-10-01: **$0.1632, $0.3264 and $0.6528 per hour**; all three classes are offered in every Oregon zone (2a … 2d). The classes and their hourly prices are a table in `contracts` (`COMPUTE_TIERS`), changed only by a decision. The CLI prints the tier, class and hourly price at dispatch. | Memory-optimised ratio suits installs, bundlers and test runners better than compute-optimised; Graviton is about a fifth cheaper per vCPU. One architecture keeps the AMI, the cache lineage and the conformance fixtures single. x86-only native dependencies are a reason to revisit, recorded when met. | **agreed 2026-10-01**; prices confirmed the same day (H-P10-03) |
| D-P10-14 | **The tier is recommended twice: from the project before the first run, from measured use after it.** (a) `nightshift init` and `plan check` run a deterministic **probe** over the repository: lockfile size and workspace count, Docker or Testcontainers in dependencies or CI, browser test dependencies (playwright, puppeteer, chromium), native or Rust toolchains, CDK bundling, and the contract's `maxConcurrency`. A rule table in `core` maps these to a tier with the reasons, recorded as `compute.recommended` in `nightshift.config.json` and shown by `plan check`. (b) The runner samples the machine every 30 seconds (CPU, memory, swap, disk high-water, OOM kills) into a run-scoped **`ComputeUtilization`** record. After three completed runs of a project on one tier, `core` recommends one tier down when every run's peak memory stayed under 45% and peak CPU under 50%, and one tier up when any run saw an OOM kill, swap, disk over 85% or CPU above 90% for a tenth of its wall clock. The recommendation appears in the report, in `nightshift compute recommend <program>` and on the Studio's program card. The customer chooses: `--compute <tier>` on `run --remote`, else `compute.tier` in the contract or config, else the recommendation, else `good`. | The owner's Q7: Lambda's power tuning, for a build machine. Both halves are pure functions over recorded facts, so they are tested offline and explainable in one sentence each. The schema carries the utilization from day one so a learned refinement later has data. | **agreed 2026-10-01** (thresholds are the planner's starting values) |
| D-P10-15 | **A per-project warm volume.** Every run's workspace is an EBS volume created from the project's latest **warm snapshot** (or empty for the first run). It holds a mirror clone of the repository, the package-manager stores (`npm`, `pnpm`, `cargo`, `pip`, `uv`) reached through environment the runner sets for every process, and the last run's prepared checkout. The program's `setup` runs unchanged in every worktree against those stores; a cache hit is never verification evidence. When a run ends and its setup passed at least once, the volume is snapshotted; the project's `WarmCache` record (snapshot, image version, architecture, lockfile hashes, source run) moves to it; older snapshots are deleted after seven days or when three newer exist. Concurrent runs of one project each get a volume from the same snapshot; the last to end writes the next. | The owner's Q4 and Q8. A snapshot is the one object that serves the cache, recovery (D-P10-18) and retention (D-P10-05): nothing is designed twice. The project keeps control of what setup means; `nightshift init` suggests `npm ci --prefer-offline`. | **agreed 2026-10-01** |
| D-P10-16 | **A Nightshift AMI, built by an EC2 Image Builder pipeline defined in CDK**, versioned, recorded on every dispatch. Amazon Linux 2023 arm64 with pinned Node 24, git, Docker (rootless per worker user, D-P10-17), Chromium's shared libraries, build tools, rustup, pnpm, Python 3 for the AgentCore export, the pinned `claude` and `codex` CLIs and the Nightshift runner tarball. The first task proves the pipeline; the fallback is a stock AMI with user-data, which costs minutes per start and is then its own decision. **Future seam, not built:** an org may later register its own image, either as a layer the same pipeline bakes over Nightshift's base (preferred: Nightshift keeps the runner, users and containment) or as an org-owned AMI that passes a boot conformance test; the dispatch already records which image ran. | Starts should be seconds of boot, not minutes of package installs. Image Builder keeps the image in CDK (A-09). The version on the dispatch is what recovery relaunches. | **agreed 2026-10-01** |
| D-P10-17 | **Containment on the machine is Linux users and the API, not a tool list.** The runner process runs as `engine` and holds the engine token and the instance's role; each worker runs as its own unprivileged user in its worktree, with rootless Docker, no access to `engine`'s files, and IMDS reachable only by `engine` (an owner-match firewall rule). Publication credentials are never on the machine (D-P10-22). The instance role can heartbeat, write its own run's logs and artifacts, and read its own run's secrets, and nothing else. The machine is the run's trust boundary: a worker that escaped its user could harm only its own run, and could not publish. Rootless Docker is measured in T2 against a Postgres service container and CDK bundling; if a project needs the rootful daemon, that is the owner's call for that project, recorded. | A-39: containment is the environment's job, and EC2 lets the environment do it. Honest about the boundary: the engine token's scope is already one run. | **agreed 2026-10-01** |
| D-P10-18 | **Dispatch is a record with a lease and a generation; a reconciler owns liveness.** A new run-scoped aggregate, **`Dispatch`**: `requested → provisioning → ready → running → stopping → stopped`, or `failed` with cause; `tier`, `amiVersion`, `instanceId`, `volumeId`, `availabilityZone`, `generation`, `leaseExpiresAt`, `attempts[]`, `publication`, `cleanup`. `POST /runs/{id}/dispatch` with an idempotency key records intent, then an asynchronous dispatch Lambda creates the volume from the warm snapshot and launches the instance with the dispatch id and a one-time bootstrap secret in user-data. The runner heartbeats every 20 seconds carrying its generation; **every write the API accepts from a runner must carry the current generation**, which is the fence: a stale runner is refused, not asked to stop. A scheduled reconciler marks the lease lost after three missed heartbeats, terminates the instance, increments the generation, and launches a replacement in the same zone with the same volume attached, up to D-P10-05's three attempts, then stops the run with the volume snapshotted. Cancellation sets `stopping`; the heartbeat response carries it; the reconciler terminates what does not stop. `nightshift remote resume <program> --run <id>` is the same path by hand, from the retained snapshot, within seven days. | The volume is the recovery point: worktrees, sealed refs, logs and the merge queue's checkouts survive the instance. The API already sees every mutation (A-06, A-40), so a generation check there is a real fence where a lease check before a push is not. Resume, recovery and retrieval are one mechanism. | **agreed 2026-10-01** |
| D-P10-19 | **Compute ceilings and spend.** `OrgConfig` gains `compute: { maxTier, maxConcurrentRuns, maxRunHours, maxUsdPerMonth }` with shipped defaults `best`, 2 concurrent runs, 24 hours, **$300 a month**, and a per-run cap of **$50** (`maxUsdPerRun`); a contract or config may only lower them. The two dollar figures are the owner's provisional numbers of 2026-10-01, chosen without data: the report's compute section shows every run's metered cost, and the figures are revisited after the first three live runs. A run's compute cost is hours × the tier's price plus its volume, estimated at dispatch, metered from heartbeats, written on the `Dispatch`, and counted toward the month. The reconciler stops a run at its `maxWallClockSeconds` or the org's hour ceiling, and refuses dispatch when the month's cap would be crossed. This cost is kept beside, never inside, the inference cost A-45 prices. | D-P10-05's limits, made concrete. No unpriced compute launches. Recovery counts against the same figures. | **agreed 2026-10-01** |
| D-P10-20 | **Engine authority is a run-scoped execution token of its own (resolves D-P10-07).** A new token role, `engine`, minted by the dispatch Lambda against the bootstrap secret and renewed by each heartbeat, bound to the dispatch's generation, expiring in one hour, within the run's ceiling. It can do what the orchestrator's session does today for its run and nothing else: create nodes and records, start, verify and integrate, mint worker, examiner and arbiter tokens for its own run, and request publication. It cannot ratify a plan, reverse a human decision, change org config, or touch another run. `authorize` in `core` gains the row; the API enforces it. Renewal is the engine's background work: the engine renews its own token and re-issues its workers' before expiry, so no agent mid-task ever sees an expired credential. The orchestrator's session lives on the volume and is resumed by id on a replacement, as the local engine resumes a headless session today; a fresh orchestrator starts only when the resume fails, from the ratified plan and the run's full record. | A-35 said P10 gives remote orchestrators tokens. Renewal on the heartbeat means authority and liveness are one exchange. | **agreed 2026-10-01** |
| D-P10-21 | **Seams (resolves D-P10-08).** `contracts`: `Dispatch`, `ComputeTier`, `ComputeUtilization`, `WarmCache`, the `compute` fields. `core`: dispatch and lease transitions, the recommendation rules, the `engine` authority row, the spend arithmetic. `persistence`: the new tables in both stores, and the `CredentialsStore` over its own table with envelope encryption (D-P10-23). `apps/api`: dispatch, heartbeat, reconciler and publisher Lambdas, an EC2/EBS/KMS client behind a `core` port (`apps/api/src/aws`). `apps/mcp`: a `nightshift-runner` bin that composes the adapters and starts the headless root on the machine. `harness-agentcore`: the exported harness as a process. `infra/cdk`: a `RunnerStack` (AMI pipeline, launch template, instance role, reconciler schedule, publisher), and in the data stack the `Credentials` table and `CredentialsKey`. `apps/cli`: `run --remote [--compute]`, `remote status|cancel|resume`, `compute recommend`, and the org's onboarding verbs `org github install|status` and `org providers set|status`, which reach the store only through the API. The CLI still imports no harness and no AWS SDK. | Follows A-31 and the layering of `architecture.md` §1. A separate stack keeps the control plane deployable without the runner. | **agreed 2026-10-01** |
| D-P10-22 | **Publication is a bundle and a lease at the Git transport.** The engine requests a publication intent (branch, verified commit, expected predecessor) and uploads a git bundle of the commits to the run's S3 prefix first. The publisher Lambda, holding the GitHub App key, fetches the bundle and pushes with `--force-with-lease=<branch>:<predecessor>`; a rejected lease is recorded as a conflict, never retried with force. Lost replies are reconciled against the actual branch head before any retry. One intent per repository and branch at a time. | D-P10-01 and D-P10-02 made concrete. The bundle makes the verified objects durable before the push; the lease check is in the transport, where the race actually is. | **agreed 2026-10-01** |
| D-P10-23 | **An org's secrets live in a credentials table of their own, envelope-encrypted under a dedicated key; Secrets Manager holds the service's credentials only.** A second DynamoDB table in the data stack, **`Credentials`**: no stream, no index, deletion protection, retained. One item per org and provider, holding the ciphertext, the wrapped data key, the set-at time and the last four characters, and nothing in plaintext. A new **symmetric KMS key**, `CredentialsKey` (A-35's token key is RSA sign-and-verify and cannot encrypt), whose `Decrypt` the key policy grants to the API function alone and only with an encryption context of `{orgId, provider}`, so a ciphertext moved to another org's row does not decrypt. The API function is the only principal with read or write on the table; the materializer, authorizer, Studio and runner hold neither. `org providers set` encrypts and writes; every read route returns presence, date and last four only; the plaintext is decrypted once per heartbeat response for the run's own org and handed to `engine`, which holds it in memory. The set route's request body is masked from every log, and a test asserts it. The memory and SQLite stores implement the same `CredentialsStore` over a key file beside the database, as the local token key already is, so the local instance and the offline suites run the identical code above `persistence`. The GitHub App's id and private key stay in Secrets Manager under `nightshift/github-app`: one secret, the service's own. | Secrets Manager bills per secret per month and per call: a secret per customer per provider grows with the customer count, for rotation and cross-service IAM a customer's API key never uses. Envelope encryption under one KMS key with a tenant encryption context is the standard SaaS pattern and costs a fraction of a cent per read. A table of its own costs nothing at this volume and buys deny-by-default: the main table's stream never carries a credential, and the read grant is one principal. The owner's ruling, 2026-10-01: set up properly from the beginning. | **agreed 2026-10-01** |
| D-P10-24 | **One real install per lineage of checkouts.** Setup runs in every checkout Nightshift makes (a worker's worktree, an examiner's checkout, before every verification), and `npm ci` deletes `node_modules` and extracts every package again whatever any cache holds. So: an install step (`npm ci`, `pnpm install`, `yarn`, `uv sync`, `pip install`) is skipped when the checkout's lockfiles hash exactly as the lockfiles its installed tree was made for, recorded in a marker inside the tree; a new checkout with no tree is seeded from the run's program checkout by hardlinking its tree when the two have the same lockfiles; a changed lockfile or a missing tree installs again. Steps that are not installs always run. A skipped step is recorded under its own id with the reason, so a cache hit is visible in the evidence and is never mistaken for a run of the command. The program checkout itself always installs for real: on a remote machine that is the one `npm ci` at boot, on a developer's machine it is their own tree. | Found 2026-10-02 while measuring the warm volume: the one install at boot was 6.6 s cold and 6.8 s warm, which is noise, but the same install ran again in every worktree and before every verification, thirty-odd times a run, a minute each on a real repository, on the critical path. The warm volume (D-P10-15) stays for what it is for: the mirror, the download stores, Rust's `target/`, browsers. Known residual: an agent that mutates `node_modules` outside the lockfile in the program checkout pollutes what later checkouts are seeded from; verification's own install runs when a lockfile changes, and a re-canonicalising install when the machine stops is the follow-up if this is ever seen. | **agreed 2026-10-02** |
| D-P10-25 | **Workers share a group; the engine's credentials are its own.** On a machine every job's agent (worker, examiner, arbiter) runs as one of the `worker-N` users, started through `sudo` by `engine`; all of them and `engine` are in one `nightshift` group, the workspace is group-writable with set-group-id directories and `core.sharedRepository=group`, so workers read each other's worktrees and the checkout and commit into the shared object store, as a team sharing one repository does. What a worker cannot read is `engine`'s: the engine token file and the placed credentials on tmpfs stay mode 0600 under `engine`, and a worker needing a credential file of its own (Codex's login) gets its own copy under its own user. The root orchestrator stays `engine`. | D-P10-17 asked for workers as their own users; the owner's ruling (2026-10-02) is that workers are collaborators, not tenants: isolating them from each other buys nothing a program needs and costs starts, clones and turns. The boundary that matters is the one between code a worker runs (an `npm install` postinstall script, say) and the engine's authority over the plane: with every agent as `engine`, such a script could read the engine's token and act as the engine. Separate users with a shared group close that and leave collaboration intact, exactly as a developer can read a colleague's branch but not their SSH key. | **agreed 2026-10-02** |

## 4. Design

### 4.1 One run, one machine, one volume

```text
nightshift run <program> --remote --compute better
   │  startRun (unchanged): program, run, root node, checkpoint
   │  refuses: dirty tree, unpublished head, unratified plan, tier over the org's ceiling
   ▼
POST /runs/{id}/dispatch  {tier, repo, branch, sha, planHash, idempotencyKey}
   │  Dispatch{requested}; prints run id, tier, class, $/h; the laptop may close
   ▼
dispatch Lambda ── create volume from WarmCache snapshot ── RunInstances(AMI, class, user-data)
   │                                                               │
   │                                   instance boots ─ nightshift-runner (user engine)
   │                                     bootstrap secret → engine token (generation 1)
   │                                     mount /workspace; mirror fetch; checkout sha
   │                                     verify plan hash; start headless root (A-44)
   │                                     heartbeat /20s: generation, utilization, spend
   ▼                                                               │
reconciler (EventBridge, 1 min) ─ lease lost? terminate; generation+1; relaunch with the volume
                                 ─ cancelled? wait for stop, then terminate
                                 ─ ended? snapshot volume → WarmCache; delete volume; Dispatch{stopped}
```

The engine, workers, examiners, the merge queue and the AgentCore worker run as
they do locally; the program checkout the engine integrates into is a clone on
the volume whose program branch the publisher mirrors to GitHub after each
landing (D-P10-22). Nothing a worker does differs from a local run.

### 4.2 Recommending the tier

The probe reads files, never runs them: `package.json` workspaces and the
lockfile, `.github/workflows/*`, `Dockerfile*` and `docker-compose*`,
`Cargo.toml`, `cdk.json`, test dependencies. Each signal is a row with a weight
and a sentence; the sum selects the tier and the sentences are the explanation.
The starting table:

| Signal | Tier |
|--------|------|
| none of the below | good |
| one of: Docker or Testcontainers; a browser test dependency; Rust or native build; CDK bundling; lockfile over 2 MiB or more than six workspaces | better |
| two or more of those, or any of them with `maxConcurrency ≥ 4` | best |

Right-sizing (D-P10-14b) is a second pure function over the last three
`ComputeUtilization` records of the project on its current tier. Its output is a
tier, a direction and the evidence (peak memory as a percentage, OOM count, CPU
saturation). The report's compute section and `nightshift compute recommend`
print it; the Studio's program card shows "recommend: good (peak memory 31%)".
Nothing changes a tier by itself: the customer's choice stands until they change it.

### 4.3 The warm volume's layout

```text
/workspace/
  mirror.git/          bare mirror of the repository, fetched each run
  stores/              npm, pnpm, cargo, pip, uv caches (env set for every process)
  checkout/            the program checkout the engine integrates into, with its last installed tree
  runs/<runId>/        worktrees, examination checkouts, logs, bundles for publication
```

Setup runs in every worktree as it does today. `nightshift init` writes
`npm ci --prefer-offline` for an npm project and `pnpm install --frozen-lockfile`
for pnpm, both of which resolve from the stores on the volume. The first run of a
project is cold; every run after it is warm.

### 4.4 Provider authentication on the machine

The three modes of D-P10-03, in the order they are proven:

1. **API keys.** Given by the org through `nightshift org providers set`, stored
   by the API in the `Credentials` table, envelope-encrypted under
   `CredentialsKey` with the org and provider as encryption context (D-P10-23), decrypted
   once per heartbeat for the run's own org and handed to `engine`, handed to each worker process's environment for
   its provider only, never written to disk. The existing Codex adapter's exclusion of API-key auth is lifted here.
2. **Bedrock.** The AgentCore worker assumes the project's role (A-25) and uses
   the cheap model the routing ladder names.
3. **Subscriptions.** Anthropic's hosting conditions require native sign-in and
   forbid platform storage of claude.ai session credentials; Codex's guidance
   warns against concurrent reuse of one auth file. T5 attempts native device
   sign-in on the machine through `nightshift remote login`, with credentials
   kept on the run's volume and never in the control plane. If a provider's
   terms or mechanics block it, the constraint is surfaced to the owner as a
   recorded finding and the mode is marked unavailable for that provider;
   nothing falls back to a differently billed mode.

## 5. Scope

**In.** Everything in §3.3; the AgentCore harness worker against the unchanged
conformance suite; `run --remote`, `remote status|cancel|resume`, `compute
recommend`, `org github install|status`, `org providers set|status`; the probe in `init` and `plan check`; the live walk-away fixture;
the records on the Studio's run status and program card.

**Out.** Private runners (customer accounts); Nightshift-supplied inference and
customer billing; non-GitHub hosts; customer images; x86 tiers; sibling
repository checkouts; publishing anything but the program branch; a push
transport for the Studio; learned right-sizing beyond D-P10-14's rule; teardown
verification (A-18).

## 6. Stories

| ID | Who | Today | After | Words |
|----|-----|-------|-------|-------|
| US-01 | The owner, with a program ratified at 11 p.m. | The laptop must stay open and online for the run; a sleep or a dropped connection ends it | They dispatch, close the laptop, and read the result in the morning | "it's time to deliver that" |
| US-02 | A customer with a heavy monorepo | The machine is whatever Nightshift picked | They pick good, better or best, and see the price before the run starts | "I want customers to be able to choose their hardware (at least a good/better/best)" |
| US-03 | A customer on their first run | They guess a size | Nightshift says which tier the project needs and why | "I want us to be able to recommend a hardware based on the project" |
| US-04 | Every run of a Node project | Each worktree downloads every dependency; the night's first hour is `npm ci` | The volume is warm; setup resolves from the stores in seconds | "I want caching to prevent super long startups with npm ci ... we shouldn't be downloading dependencies every time" |
| US-05 | A customer three runs in | They pay for `best` because they once feared running out of memory | The report says the runs peaked at a third of it and recommends `good` | "we definitely want that feature that aws lambda has where it can recommend the right memory adn compute based on past runs so you don't overpay." |

## 7. Success criteria

| ID | Outcome | Serves |
|----|---------|--------|
| SC-P10-01 | A ratified plan dispatched with `--remote` prints a run id; the CLI process and its network are killed; the run continues through central records to verified output on the program branch at GitHub (SC-14, SC-16) | US-01 |
| SC-P10-02 | Dirty checkouts, unpublished heads, missing remote branches, changed plans, tiers above the org ceiling and a month over its cap are refused before provisioning, by the API as well as the CLI | US-01, US-02 |
| SC-P10-03 | A retried dispatch under one idempotency key is one run and one instance; a second org cannot dispatch, inspect, cancel or resume the first's run | US-01 |
| SC-P10-04 | Several jobs run in parallel worktrees on one instance; one cheap job runs through the AgentCore harness on Bedrock and passes the unchanged conformance suite (SC-04, SC-05, SC-15) | US-01 |
| SC-P10-05 | Each of the three tiers launches its named class; the dispatch records tier, class, price and AMI version; the CLI printed them | US-02 |
| SC-P10-06 | The probe's rule table is a pure function with a table-driven test over fixture repositories (plain Node, Docker service tests, Rust, CDK bundling, a six-workspace monorepo), and `plan check` prints its tier and reasons | US-03 |
| SC-P10-07 | After three completed runs, the right-sizing rule recommends down for under-use and up for an OOM kill, in the report, the CLI and the Studio card; nothing changes the tier by itself | US-05 |
| SC-P10-08 | The second run of a project starts from the warm snapshot and fetches the mirror rather than cloning it; within a run, a checkout whose lockfiles match the program checkout's is seeded from its installed tree and runs no install, and a skipped install is recorded as skipped, never as a run of the command (restated 2026-10-02 with D-P10-24: the first setup's duration was the wrong measure, see §15 T3) | US-04 |
| SC-P10-09 | The runner process is killed and, separately, the instance terminated during a live run; the service recovers under the same run id with the same volume and continues to published output; the stale generation's writes are refused | US-01 |
| SC-P10-10 | Deterministic fault tests cover lost push acknowledgement, external branch movement, a stale runner returning after replacement, cancellation during recovery, preserved budgets, exhausted attempts and cleanup failure, each leaving a durable explanation | US-01 |
| SC-P10-11 | Engine tokens renew across their expiry without a human session; a worker's token cannot obtain engine or sibling authority; cancellation stops work within two heartbeats | US-01 |
| SC-P10-12 | An org's GitHub installation and provider keys arrive only through the CLI verbs, and the live fixture onboards its org through them; the keys rest in the `Credentials` table under `CredentialsKey`, a synthesized template shows no other principal can read or decrypt them, no read route returns more than presence, date and last four, and the set route's body is absent from the logs; Claude Code and Codex execute remotely with API keys; the Bedrock route executes under the project's role; each subscription mode either executes or is a recorded, surfaced constraint; no fallback changes the billing mode | US-01 |
| SC-P10-13 | A run that ends with provisional or unlanded work is retrievable by `remote resume` within seven days; after that the snapshot is gone and the report says so | US-01 |
| SC-P10-14 | Local behaviour and every earlier program's verification stay green; a local run and a remote run of one program produce the same canonical records apart from the `Dispatch` | US-01 |

## 8. Deterministic verification

```text
npm run verify
npm run check:architecture
npm run local:e2e
npm run conformance          # now including harness-agentcore, opt-in as before
```

Opt-in, from a developer machine, never in CI: `npm run deploy`, `npm run
smoke`, and the new `npm run remote`: the live walk-away fixture against a
disposable repository, which onboards a fixture org through `org github install` and `org providers set`, dispatches on `good`, kills the CLI, kills the
runner, terminates the instance, and asserts the published branch. Its cleanup
contract: every instance, volume and snapshot it created is tagged with the
fixture id and removed at the end, and the report lists what it could not remove.

## 9. Constraints

- The engine, merge queue, verification, examination, routing and correction are
  not forked for remote: one code path (SC-16).
- The CLI imports no harness and no AWS SDK; `persistence` is the only data SDK
  user; the EC2 client lives in `apps/api` behind a `core` port (D-P10-21).
- Every dependency pinned exactly; the AMI pins every binary it carries.
- No unpriced compute: a tier without a confirmed price cannot be dispatched.
- Nothing from the cache is verification evidence; setup runs every time.
- No provider credential in a contract, log, record response, plaintext column
  or snapshot that outlives its run, other than the subscription credentials D-P10-03 places on
  the run's own volume.

## 10. Permissions and forbidden actions

Permitted: editing every package and app named in D-P10-21 and the documents;
deploying the data, API, Studio and new runner stacks; launching instances of
the three classes under the fixture's tags; running the suites.

Forbidden:

- A worker as a per-job hosted environment, or a second engine for one run.
- Pushing anything but the program branch, or any push without a lease.
- Force-pushing, requesting branch-protection bypass, or weakening protection.
- Reinstating a harness tool allow-list, sandbox mode or approval policy.
- Copying an operator's Cognito session or refresh token to a machine.
- Storing a customer's secret anywhere but the `Credentials` table, in
  plaintext anywhere, in the main table or its stream, or in Secrets Manager; the App's own key is the
  service's and the one secret that lives there.
- Returning a stored secret from any read route, in any form but presence,
  date and last four characters; logging the set route's body.
- Granting `kms:Decrypt` on `CredentialsKey`, or read on the `Credentials`
  table, to any principal but the API function.
- Deleting a volume before its snapshot is confirmed, or a snapshot inside its
  retention.
- Weakening an assertion of an earlier program.

## 11. Tasks

Task specs follow ratification under `tasks/p10-remote-runner/`.

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | Contracts, rules and authority: `Dispatch`, tiers, utilization, `WarmCache`, `compute` fields, the `engine` row, the recommendation and spend functions, both stores, the API's dispatch, heartbeat and generation checks, the org onboarding routes and verbs (`org github`, `org providers`), the `CredentialsStore` over its own table with envelope encryption in both stores, the log mask and its test, offline | H-P10-01 | — |
| T2 | The machine and the vault: the `Credentials` table and `CredentialsKey` in the data stack, `RunnerStack`, AMI pipeline, launch template, instance role, users and firewall, rootless Docker and Chromium measured, `nightshift-runner` booting to a heartbeat | T1, H-P10-02, H-P10-03 | the account |
| T3 | Warm volume and dispatch: snapshot lineage, volume create and attach, mirror and checkout, setup on the stores, `run --remote`, refusals, the cold-to-warm measurement | T2 | — |
| T4 | Publication and the headless root on the machine: publisher Lambda, bundles, leases, installation tokens from the App key and the org's recorded installation, the engine's integrate-then-publish. **Gate before it starts:** the owner has run `org github install` and `org github status` lists both repositories | T3, H-P10-04, H-P10-04b | the disposable repository |
| T5 | Providers: the org's keys as `org providers set` stored them, Bedrock through A-25, the AgentCore harness worker against the conformance suite, subscription sign-in attempted and its result recorded. **Gate before it starts:** the owner has run `org providers set` for Anthropic and OpenAI and `org providers status` shows both | T1, T2, H-P10-05 | the paying account, the two keys |
| T6 | Recovery and cancellation: reconciler, generations, replacement with the volume, `remote cancel|resume|status`, the deterministic fault battery | T4 | — |
| T7 | Recommendation: the probe in `init` and `plan check`, utilization sampling, right-sizing, `compute recommend`, the report's compute section, the Studio card and run status | T3 | — |
| T8 | The live walk-away fixture (`npm run remote`), the regression battery, documentation, `staging.md`, `architecture.md` (A-51, O-03, O-05, O-06 resolved) and §15 as built | T5, T6, T7, H-P10-06 | the account |

Each task passes §8 before the next starts; T5 and T7 may run beside T4 and T6.

## 12. Risks

| Risk | Mitigation |
|------|------------|
| Image Builder on arm64 proves slow or brittle | T2's fallback is a stock AMI with user-data; the cost is minutes per start, decided as a §13 ruling if taken |
| Rootless Docker refuses a project's service containers | Measured in T2 against Postgres and CDK bundling; rootful is a per-project owner's call, never the default |
| Subscription sign-in is blocked by provider terms | Surfaced as a finding (SC-P10-12); API keys and Bedrock carry the exit gate |
| A replacement instance cannot attach the volume (zone capacity) | Same-zone launch is retried across the three attempts; the final failure snapshots and stops with the reason |
| Right-sizing thresholds are wrong | They are one table in `core`, changed by a decision; the record keeps the raw peaks |
| Spend runs past the cap during recovery | Recovery counts against the same figures (D-P10-05); the reconciler stops at the ceiling |

## 13. Decision log

| Date | Decision | Authority |
|------|----------|-----------|
| 2026-09-27 | D-P10-01 … D-P10-06, D-P10-09 … D-P10-11 agreed (§3.2) | Human |
| 2026-09-28 | Program deferred; AgentCore Instances capability probe recorded: ARM64 and the persistent volume pass; zero Linux capabilities; `dockerd` denied mount propagation and socket ownership; Chromium's `runuser` denied; the probe image had to be exported as Docker schema v2 for AgentCore to start it (`p10-agentcore-capability-evidence.json`) | Human |
| 2026-10-01 | Program reopened. D-P10-12 (EC2 and EBS, A-14 superseded), D-P10-13 (tiers), D-P10-14 (recommendation twice), D-P10-15 (warm volume) agreed; D-P10-16 … D-P10-23 proposed and, after explanation, agreed the same day: a separate `RunnerStack`; customer secrets envelope-encrypted in a table of their own under a dedicated key, not in Secrets Manager and not in the main table; containment by Linux users that limits nothing an agent legitimately does; the engine token renewed in the background with the orchestrator's session resumed from the volume. D-P10-19's shipped caps set provisionally at $300 a month and $50 a run, to be revisited against real metered cost | Human (§3.1) |

## 14. Retained research

The 2026-09-27 planning kept these; they still hold.

- **AgentCore Instances** (`runtime-instances-how-it-works`, `-data-management`,
  `-security`): one trust boundary per session, no privileged mode or Docker
  socket in `ContainerConfiguration`. Two 2026-09-27 cloud attempts failed at
  artifact download with an OCI manifest; the 2026-09-28 run started after a
  Docker schema v2 export and measured what §1 records.
- **GitHub Apps**: installation tokens are repository-scoped and renewable;
  Contents write publishes, Workflows permission is needed for workflow-file
  edits; a ref update is not atomic with any lease outside Git, hence D-P10-22.
- **Anthropic hosting conditions** (`code.claude.com/docs/en/legal-and-compliance`):
  hosted unmodified Claude Code with the user's own inference is permitted;
  native sign-in is required; platform storage of claude.ai session credentials
  is prohibited. **Codex** (`learn.chatgpt.com/docs/auth`, `/auth/ci-cd-auth`):
  headless device login exists; concurrent reuse of one auth file is warned
  against.
- **Project audit, 2026-09-27**: FoodFly needs ARM64 CDK bundling with Docker;
  Keki needs Chromium libraries; Prempt needs a Docker daemon, Rust and a large
  disk; Keyart needs real Chromium. These are the probe's signals in §4.2 and
  T2's measurements.

## 15. As built

Written as the tasks land; completed when the program closes.

### T1, 2026-10-01

Contracts, rules, stores, routes and the two onboarding verbs, all offline:
commit `3bf02c0`. Two details a later task needs: the engine's first token is
minted by the dispatch Lambda and waits in an SSM parameter under
`/nightshift/<stage>/dispatch/<runId>/<generation>`, read once and deleted by
the runner, so there is no bootstrap route; and the runner's every write is
held to the dispatch's generation by `enforce`, which reads the dispatch to
place an engine principal as it reads the tree to place an orchestrator's.

### T2, 2026-10-01

The data stack gained the `Credentials` table and `CredentialsKey`; the API
function alone reads either (its stack test enumerates the grants). The
`RunnerStack` is built only with `-c runnerCommit=<sha>`, and the image's
recipe is versioned with `-c imageVersion`: an Image Builder component is
immutable per version, so every change to the image is a new version (1.0.0
through 1.0.5 on the first day). The image clones this repository at the named
commit and builds it on the box, so the runner on a machine is exactly a
commit of `main`'s history. Amazon Linux 2023 packages neither `rootlesskit`
nor `slirp4netns`; both come from Docker's static builds and the project's
GitHub releases, pinned in `runner-image.ts`.

**Measured on the real machine** (`npm run runner:boot`, images 1.0.4 and
1.0.5, `m7g.xlarge`, 2026-10-01, three runs):

| Measurement | Result |
|-------------|--------|
| Launch to first `ready` heartbeat | 52 s, 63 s, 54 s |
| Cancel to the runner's own `stopped` report | within one heartbeat interval (1.0.5) |
| Rootless Docker, `postgres:16` service container, client connects | pass |
| Rootless Docker, `docker build` of an arm64 image | pass |
| Chromium through Playwright under a worker user | pass |
| `cargo build` under a worker user | pass on 1.0.5 (1.0.4 lacked `RUSTUP_HOME` for the shared toolchain) |
| Instance metadata from `engine` | reachable |
| Instance metadata from a worker user | blocked |
| Node on the image | v24.11.1 |
| Volume: fresh gp3 formatted, mounted, owned by `engine` | pass |

So D-P10-17's containment is real on the image, not promised: a worker can run
service containers, a browser and a Rust build, and cannot reach the machine's
role. What the proof plays by hand (the volume, the first token in SSM, the
launch with the run's tags, the record's move to `provisioning`) is exactly
what the dispatch Lambda does in T3. The first boot found two runner bugs that
only a machine could: a workless runner raced itself to exit, and a milestone
reported mid-beat was dropped; both are tested now. Image 1.0.5 is
`ami-07b137d61eacc9437`.

### T3, 2026-10-02

The customer's path runs end to end on real machines: commits `63f0736`
through the three live fixes that followed it. `nightshift run <program>
--remote` refuses what D-P10-02 says it must and posts the dispatch; the API
verifies the installation, the repository grant and the branch head through
the GitHub App and invokes the dispatch Lambda; the Lambda mints the first
token, picks a subnet by the run's hash, takes the project's warm snapshot
when there is one, and launches; the runner clones with the read token the
heartbeat carries, checks the plan hash before touching git, runs setup once
against the stores on the volume, and says `ready` with what setup took; the
reconciler snapshots a stopped run's volume, writes the project's warm cache,
and deletes the volume. The fixture is `wildorder/nightshift-remote-fixture`
(its source of truth is `test/fixtures/remote-fixture`), 105 packages in its
lockfile. The runner reaches the plane through a port the composition root
wires (AR-2), so nothing under `runner/` names the HTTP adapter.

**Measured on real machines** (`npm run runner:boot`, image 1.0.6,
`m7g.xlarge`, 2026-10-02):

| Measurement | Result |
|-------------|--------|
| API accepts the dispatch to `ready`, cold (clone, `npm ci`, three runs) | 92 s, 92 s, 83 s |
| Setup (`npm ci --prefer-offline`), cold | 5.9 s, 5.5 s, 6.6 s |
| API accepts the dispatch to `ready`, warm (from the snapshot) | 92 s |
| Setup, warm; the mirror fetched, the npm store on the volume | 6.8 s |
| Warm-to-cold setup ratio | **1.03** against SC-P10-08's 0.1 |
| Cancel to the runner's own `stopped` | one heartbeat interval |
| `stopped` to snapshot started | 2 reconciler ticks |
| Snapshot of the 100 GiB gp3 volume to completed, cache written, volume deleted | about 4 min |

**The warm path works and the boot-time number was the wrong one to chase.**
The second machine came up from the first's snapshot, the mirror was fetched
rather than cloned, and npm's store was on the volume. Setup took the same
time because `npm ci` deletes `node_modules` and extracts every package again
regardless of the cache, and on EC2 the download it saves is a fraction of a
second. Six seconds at boot is noise against a run measured in hours. What
the measurement exposed instead, when the owner asked how often setup runs,
is that the same install ran in every worker's worktree, in every examiner's
checkout and before every verification, from an empty tree each time: thirty
or more full installs a run, a minute each on a real repository, on the path
between a worker finishing and its verification starting. That is D-P10-24,
ruled the same day and built in `verification`: one real install per lineage
of checkouts, every later checkout seeded from the program checkout's tree by
hardlink when the lockfiles match, the install recorded as skipped when it is,
and run again when a lockfile changes. It applies to local runs as much as
remote ones. SC-P10-08 was restated to say what the volume and the seed are
for; the first setup's duration is no longer the measure. The runner itself
still installs for real once at boot, which is what makes the seed clean.

Three things only a live run could find, each now held by a test: the
reconciler's role could query the table but not the `gsi_node` index its
listing by status reads; the index query sent `begins_with(GSI1SK, "")`,
which DynamoDB refuses as an empty key value (the fake table now refuses it
the same way); and `ec2:CreateSnapshot` was conditioned on the snapshot's own
managed tag, which a snapshot that does not exist yet cannot carry. A cleanup
failure is now logged as well as recorded, because a reconciler failing every
minute read exactly like one waiting.

### T4, first chunk, 2026-10-02

The root orchestrator runs on the machine and the program branch is published
with a lease at the Git transport: commits `e58c25a` through `304e12c`, image
1.0.7. What is built, and how each piece departs from the task spec where it
does:

- **The root.** After `ready` the runner reports `running`, waits one beat for
  the org's provider keys (the plane hands them to a running engine and to
  nothing else, D-P10-23), and starts `runHeadless` over a runtime built by the
  composition root. The engine's token is in a file on tmpfs
  (`/dev/shm/nightshift/<runId>/engine-token`, 0600, `engine` only) that the
  heartbeat rewrites on every renewal; the orchestrator-role server the root
  launches reads it on each request (`NIGHTSHIFT_API_TOKEN_FILE`), so a renewal
  needs no restart and nothing is written to the volume. D-P10-20 names the
  renewal, not the file; this is the as-built mechanism.
- **Publication intents.** After every landing that moves the program branch,
  the engine packs the commits (`git pack-objects`, not thin), uploads the pack
  as a `bundle` artifact through the plane's signed upload, and posts an intent
  whose predecessor is the previous intent's head, in landing order. The hook
  is on the execution environment and is installed only when the runner set
  `NIGHTSHIFT_PUBLISH_BASE`, so a local run publishes nothing and the
  provisional line never can.
- **The publisher without `git`.** The spec bundled a `git` binary into the
  Lambda; there is no Docker on the developer machine to build such a layer,
  and a pure-JS git was a shallow fetch away from working. The publisher
  speaks git's smart HTTP protocol in `fetch` instead: the ref advertisement
  gives the branch's head; the receive-pack command `<predecessor> <head>
  <ref>` with a non-thin pack is the push, and the remote's check of
  `<predecessor>` **is** the lease, where the race actually is. The client and
  the publisher are held to a real `git http-backend` serving a local bare
  repository, so what passes offline is what GitHub accepts.
- **One push at a time.** The spec said reserved concurrency; this account's
  Lambda concurrency quota is the new-account minimum of 10, which leaves
  nothing to reserve, and the deploy was refused. The serial order per run is
  a lock row in the table, taken by conditional put (absent, or lease lapsed),
  released after the sweep, swept once more for an intent that arrived while
  held. A quota increase to 1000 is requested; the lock works at any quota.
- **One installation is one customer's.** Recording an installation claims it
  (a compare-and-set row per installation id); a second org is refused with
  409, the first may record again. The owner's org holds the dev stage's
  installation; the live proof borrows it for its throwaway org and hands it
  back.
- **The gate.** `nightshift org github install --installation 166952409` was
  run for the owner's org through the CLI and lists both repositories.

**Measured on real machines** (`npm run runner:boot`, image 1.0.7,
`m7g.xlarge`, 2026-10-02, two passing runs):

| Measurement | Result |
|-------------|--------|
| Dispatch accepted to `ready`, cold | 83 s, 92 s |
| Dispatch accepted to `ready`, warm, from the snapshot | 72 s, 82 s |
| Setup (`npm ci --prefer-offline`), cold / warm | 3.4 s / 4.2 s; 4.3 s / 5.3 s |
| Warm run fetched the mirror rather than cloning (SC-P10-08 as restated) | yes, both runs |
| Snapshot to warm cache written and volume deleted | about 4 min |
| Machines, volumes, snapshots left behind | none |

**Not yet in T4, carried to its second chunk**: workers as their own Linux
users (D-P10-17's `runAs`), which needs the two harness adapters to spawn
through `sudo`, each worktree chowned to its worker, and the program
checkout's git objects shared through a group, and so its own live iteration;
worker token renewal before expiry (today a worker's token lives
`min(wallClock, 8 h)`); the root's harness session id on the dispatch for T6's
resume. The live acceptance (a program run to the end, the fixture's branch
holding the published head) needs an Anthropic key sealed for the org:
`NIGHTSHIFT_SMOKE_ANTHROPIC_KEY` makes the proof run it; without a key the
proof lets the root start, reads its journal, and cancels.

Three things only a live run could find, each now held by a test or a rule:
the smoke's throwaway org and the owner's org cannot both claim one
installation, so the proof borrows and returns it; a `--no-checkout` clone
reports every file deleted, which the workspace took for a dirty tree; and a
heredoc-mangled string literal in the proof passed `tsc -b apps/api`, which
does not cover the smoke files, while biome's formatter rewrote the rest of
the file around it. `npm run typecheck` covers them.

**The first run with a real credential (image 1.0.8, the owner's Claude Code
subscription token).** The whole chain held up to the last step: the token was
sealed for the org through the credential route, the heartbeat handed it to
the running engine, the runner placed it as `CLAUDE_CODE_OAUTH_TOKEN`, the
root started (`claude-opus-5-5`, the Nightshift MCP server connected over the
engine token), and the root reasoned correctly: it called `run.attach`, was
refused, looked for the cause, refused to start a run of its own or to write
code itself, and reported exactly why in its final message. The cause was
ours: `run.attach` resolved the program from contract files in the checkout,
which a remote repository need not carry. On a machine the root's server is
now told the dispatch's run (`NIGHTSHIFT_PINNED_RUN`) and attaches to it from
the plane, whatever the checkout holds; `run.start` is refused there. The same
run showed a second gap: a root that finishes on its own left the dispatch
`running`, because the runner's `stopped` report was legal only from
`stopping`; it is legal from `ready` and `running` now. An org's credential may
also be a Claude Code subscription token (`claude setup-token`, by its
`sk-ant-oat` prefix) or Codex's `auth.json` login file (placed on tmpfs under
`CODEX_HOME`); `org providers set --file` takes the latter. Both of the owner's
are sealed.

**T4's live acceptance, 2026-10-02, image 1.0.11 (commit `2c7cc9c`).** With the
owner's Claude Code subscription token sealed for the org, a dispatched run of
the fixture program ran to its end on an `m7g.xlarge` with no one watching:
the root (`claude-opus-5-5`) attached to its pinned run, delegated the one
strand, a `claude-sonnet-5` worker implemented `median` with tests in its
worktree, verification (`npm ci --prefer-offline`, `npm test`) passed, an
`claude-opus-5-5` examiner passed it, the merge queue integrated it as
`6934e317`, the engine raised one publication intent with the pack as a
bundle, the publisher pushed `program/fixture` from `aab0973d` to `6934e317`
with the lease, and the run finished `succeeded` with the root's own summary.
The dispatch's `publication.head` equalled the branch's head at GitHub. The
runner then ended the dispatch itself, the reconciler snapshotted and
cleaned up. From the API accepting the dispatch: 102 s to `ready`, 142 s
from `ready` to the runner's own stop with the program done and published.
SC-P10-01's publication half and SC-P10-04 are proven live. The proof then
passed whole on its next run (`npm run runner:boot` with the token): the
program ran and published in 111 s from `ready`, the warm run dispatched the
moved head and came up on the snapshot, the branch was reset, and nothing
was left in the account.

Between the first credentialed run and this one, every failure was in the
proof's own fixture or in a string an edit script mangled, and each was found
from the run's events rather than guessed: a root node narrower than its
program (a correct `scope_widening` refusal), a pinned-run value that was
not an id (the server refused it and Claude saw the connection close), and a
second dispatch at a base the branch had moved past (a correct
`head_mismatch` refusal). The root's conduct under each refusal was exactly
what D-P10-17 and D-P10-20 ask for: it looked for the cause, started no run
of its own, wrote no code itself, and left a precise reason on the record.

### T4, second chunk, 2026-10-02: workers as their own users (D-P10-25)

Built in `a85e75b`, live-accepted on image 1.0.13 (`2b1cfe4`): the proof ran
the program to its end with two processes started as worker users (the sudo
log says so), the worker implemented and completed the job as `worker-1`,
the branch was published, and nothing was left behind. The first attempt, on
1.0.12, got as far as `job.complete`, whose `git rev-parse` in the worktree
failed with "dubious ownership": the repository is the engine's and the
process was the worker's. The image now marks every directory a safe git
directory, which is right where every user is Nightshift's. What it does: `HarnessStartInput` gains
`runAs`, which both adapters honour by spawning `sudo -n -u worker-N -H env …
sh -c 'umask 002 && exec …'` with the sanitised environment passed explicitly
and the engine's account variables dropped, granting the user the adapter's
own files (Claude's configuration directory, Codex's git guard) by `chown`,
and signalling the tree as the user. The engine names the users round-robin
from the image's sixteen (`NIGHTSHIFT_WORKER_USERS`), copies a file credential
such as Codex's login under each worker's own directory, and keeps its token
file and credentials at `engine`-only. The workspace is the `nightshift`
group's: set-group-id, group-writable, `core.sharedRepository=group` on the
mirror and the checkout, the runner's umask 0002. The root orchestrator stays
`engine`. The live proof asserts, from the machine's sudo log, that processes
were started as worker users. Still open from T4's spec: worker token renewal
before expiry, and the root's harness session id on the dispatch for T6.
