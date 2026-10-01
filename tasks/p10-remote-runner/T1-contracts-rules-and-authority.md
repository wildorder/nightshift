# T1 — Contracts, rules and authority

**Program:** `p10-remote-runner`
**Depends on:** —
**Unblocks:** T2, T3, T7
**Decisions applied:** D-P10-13, D-P10-14, D-P10-18, D-P10-19, D-P10-20, D-P10-21, D-P10-23

## Objective

Everything remote execution needs that is pure or offline exists and is proven
before a single machine launches: the records, the state rules, the engine's
authority, the spend arithmetic, the recommendation functions, the credentials
store, and the API routes that carry them, all green over the memory and SQLite
stores with no AWS in sight.

## Deliverables

1. **Contracts** (`packages/contracts/src/v1/`):
   - `compute.ts`: `ComputeTierSchema` (`good | better | best`), `COMPUTE_TIERS`
     (tier → `instanceType`, `vcpu`, `memoryGiB`, `volumeGiB`, `usdPerHour`,
     with the D-P10-13 classes and the prices confirmed 2026-10-01: 0.1632,
     0.3264, 0.6528), `tierRank`, `ComputeChoiceSchema` (`{ tier?, recommended?:
     { tier, reasons[] } }`) added as optional `compute` to `ProgramContractSchema`
     and `NightshiftConfigSchema` (and to `INHERITED_CONTRACT_FIELDS`), and
     `ComputeCeilingsSchema` (`maxTier`, `maxConcurrentRuns`, `maxRunHours`,
     `maxUsdPerMonth`, `maxUsdPerRun`) added as optional `compute` to
     `OrgConfigSchema` and `OrgConfigBodySchema`, with
     `DEFAULT_COMPUTE_CEILINGS` = best, 2, 24, 300, 50. A narrowing helper,
     `narrowerCeilings(a, b)`, like `stricterExaminationPolicy`.
   - `dispatch.ts`: `DispatchSchema`, run scoped (`projectScoped` + `programId`
     + `runId`): `status` (`requested | provisioning | ready | running | stopping
     | stopped | failed`), `tier`, `instanceType`, `usdPerHour`, `amiVersion`,
     `availabilityZone?`, `instanceId?`, `volumeId?`, `generation` (int ≥ 1),
     `leaseExpiresAt?`, `idempotencyKey`, `input: { repositoryUrl, branch,
     baseSha, planHash }`, `attempts[]` (`{ generation, startedAt, endedAt?,
     reason? }`), `spend: { estimatedUsd, meteredUsd, meteredSeconds }`,
     `publication: { head?, lastIntentAt?, blocked? }`, `cleanup: { snapshotId?,
     volumeDeleted, failures[] }`, `failure?: { code, message }`, timestamps.
     `DispatchBodySchema` for `POST /runs/{runId}/dispatch`; `HeartbeatBodySchema`
     (`generation`, `utilizationSample`, `meteredSeconds`) and
     `HeartbeatResponseSchema` (`generation`, `token?`, `stop: boolean`,
     `credentials?: Record<provider, string>` per D-P10-23).
   - `compute-utilization.ts`: `ComputeUtilizationSchema`, run scoped: `tier`,
     `samples` count, `peakMemoryPct`, `peakCpuPct`, `cpuAbove90Pct` (fraction of
     wall clock), `peakDiskPct`, `oomKills`, `swapUsed: boolean`, `setupSeconds?`
     (the first setup's duration), `wallClockSeconds`.
   - `warm-cache.ts`: `WarmCacheSchema`, project scoped: `architecture`,
     `snapshotId`, `amiVersion`, `lockfileHashes: Record<path, sha256>`,
     `fromRunId`, `takenAt`, plus `history[]` of the last three.
   - `credentials.ts`: `ProviderSchema` (`anthropic | openai`),
     `OrgCredentialSchema` (identity record: `orgId`, `provider`, `ciphertext`,
     `wrappedKey`, `setAt`, `lastFour`) and `OrgCredentialViewSchema` (`provider`,
     `setAt`, `lastFour`): the only shape any read route may return.
   - `principal.ts`: `ExecutionRoleSchema` gains `engine`; the execution claims
     gain optional `generation`.
   - `OrgConfigSchema` also gains `github?: { installationId, account,
     repositories[] }`, written by `org github install`.
2. **Core rules** (`packages/core/src/rules/`):
   - `dispatch.ts`: the legal `Dispatch` transitions as a table (`requested →
     provisioning → ready → running → stopping → stopped`, `failed` from any
     non-terminal, `running → provisioning` on recovery with `generation + 1`),
     `nextGeneration`, `leaseLost(dispatch, now, missed = 3, intervalSeconds =
     20)`, `attemptsExhausted(dispatch, max = 3)`, `mayDispatch(org ceilings,
     monthSpend, concurrentRuns, tier, hours)` returning the refusal reason.
   - `compute.ts`: `recommendFromProbe(signals): { tier, reasons }` over the
     §4.2 table (`ProbeSignals`: `lockfileBytes`, `workspaces`, `docker`,
     `browser`, `nativeBuild`, `cdkBundling`, `maxConcurrency`);
     `recommendFromUse(records: ComputeUtilization[], current: tier)` over the
     D-P10-14 thresholds (three records, under 45% memory and 50% CPU → down;
     any OOM, swap, disk > 85% or `cpuAbove90Pct ≥ 0.1` → up; else keep), with
     the evidence sentence; `chooseTier(flag, contract, config, recommendation)`
     in the D-P10-14 order, defaulting to `good`; `estimateUsd(tier, hours)`,
     `meterUsd(tier, seconds, volumeGiB)` (gp3 at the published per-GiB-month
     rate as a constant beside the tier table).
   - `authorize.ts`: `ENGINE_ACCESS`: everything in `ORCHESTRATOR_ACCESS` plus
     `mintToken` for `worker | examiner | arbiter` on its own run, `heartbeat`,
     `requestPublication`, `readOrgCredentials` (for its run's org only); never
     `ratifyPlan`, `reverseDecision`, `writeOrgConfig`, nor any node outside the
     run. Every engine write also requires `claims.generation ===
     dispatch.generation`, a refusal of its own (`stale_generation`). The
     existing role tables are untouched, and the A-05 property tests still pass.
3. **Ports** (`packages/core/src/ports/`): `DispatchStore`, `ComputeUtilizationStore`,
   `WarmCacheStore`, `CredentialsStore` (`put(orgId, provider, ciphertext,
   wrappedKey, lastFour)`, `view(orgId)`, `sealed(orgId, provider)`), added to
   `ProjectStores` / `IdentityStores`; `Envelope` (`wrap(orgId, provider,
   plaintext) → { ciphertext, wrappedKey }`, `open(...)`) as the port the API's
   KMS client and the local key-file implementation both satisfy; `ComputeControl`
   (`launch`, `terminate`, `createVolumeFromSnapshot`, `attach`, `snapshot`,
   `deleteVolume`, `deleteSnapshot`, `describeInstance`) as the port T2's EC2
   client implements and the fault tests fake.
4. **Persistence**: the four stores over the memory `TableFactory` and therefore
   SQLite for free; the `Credentials` store is its **own table** in the AWS
   adapter (`CREDENTIALS_TABLE_NAME` env, items keyed `ORG#<id>` /
   `PROVIDER#<p>`), never the main table; a local `Envelope` over a key file
   beside the database (`credentials.key`, mode 0600, created on first use, as
   the token key pair is).
5. **API** (`apps/api/src/operations/`): `dispatch.ts` (`POST
   /runs/{runId}/dispatch` idempotent on the key, writes `requested` and
   enqueues; `GET /runs/{runId}/dispatch`; `POST /runs/{runId}/dispatch/cancel`;
   `POST /runs/{runId}/dispatch/resume`), `heartbeat.ts` (`POST
   /runs/{runId}/dispatch/heartbeat`: generation check, lease extend, token
   renewal, utilization fold, spend meter, `stop` and credentials in the
   response), `publication.ts` (`POST /runs/{runId}/publication` records an
   intent; the push itself is T4's), `credentials.ts` (`PUT
   /orgs/{orgId}/credentials/{provider}` and `GET /orgs/{orgId}/credentials`
   returning views only), `github.ts` (`PUT /orgs/{orgId}/github` records the
   installation; `GET` reads it). The set route is added to the handler's
   **body-mask list** so no log line carries it; a test asserts the access log
   for that route shows `[masked]`. Authorization through `authorize` for every
   one. The route table in `persistence/http/routes.ts` and the HTTP stores
   gain the matching client calls.
6. **CLI** (`apps/cli/src/commands/`): `org-github.ts` (`install` prints the
   App's installation URL from the API's `GET /github/app` and, given
   `--installation <id>`, records it; `status`), `org-providers.ts` (`set
   <provider>` reads the key from `--stdin` or a prompt, never an argument;
   `status`). `USAGE` updated. The CLI imports nothing new.
7. **Tests**: transition table exhaustively (every status × every event);
   property: `generation` never decreases and a stale generation is refused on
   every engine operation; `recommendFromProbe` table-driven over the five
   fixture repositories of SC-P10-06 (fixtures under `test/fixtures/compute/`);
   `recommendFromUse` over hand-built records for down, up and keep;
   `mayDispatch` refusals (tier over ceiling, month over cap, run over cap,
   concurrency); the credentials round trip over memory and SQLite; the view
   never contains ciphertext; AR-1 still holds (`core` and `contracts` import
   nothing).

## Acceptance

- `npm run verify` and `npm run check:architecture` green; the API handler
  suite covers every new route including the refusals.
- SC-P10-02's API-side refusals, SC-P10-03's idempotency, SC-P10-06,
  SC-P10-07's rule, SC-P10-11's authority half and SC-P10-12's view-only and
  log-mask assertions proven offline.
