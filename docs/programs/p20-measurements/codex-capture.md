# Codex measurement capture (P20 S-03)

How the Codex adapter (`packages/harness-codex`) turns a `codex exec` launch into
measurement observations, what it can and cannot claim, and how to re-check it.
Verified against **codex-cli 0.155.1** (`VERIFIED_CODEX_VERSION`). Metadata only:
no prompt, response, tool argument or tool output is read out of any source.

Capture is active only when the execution layer supplies
`HarnessStartInput.measurements`. Without it the adapter behaves as before: no
receiver, no `otel` arguments, no rollout read, nothing emitted.

## The three sources, and their provenance

None is trusted alone; `capture.ts` reconciles them and `codexCoverage` decides
what the launch may claim.

| Source | Where | Gives | Cannot give |
| --- | --- | --- | --- |
| **Rollout** (`rollout.ts`, reader version `CODEX_ROLLOUT_READER_VERSION`) | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` (also `archived_sessions/`) | The requests: one `token_usage_record` per request with `response_id`, ordinal and counters; the thread total (`total_token_usage`); spawn evidence; abort | Anything for a thread whose file cannot be found or read |
| **OTLP log telemetry** (`telemetry.ts`) | A launch-scoped loopback receiver, journalled after an attribute allowlist and a record filter | One `response.completed` record with counters per request; transport (`codex.sse_event` vs `codex.websocket.*`); retries (`attempt`); auth flags | A request id or turn id. A completion is identified by position |
| **Stream** (`stream.ts`) | `codex exec --json` stdout | `turn.completed.usage`: the **thread-cumulative** total, carried on the exit as `usageScope: "session"` | Individual requests |

Counter semantics, all measured: `input` includes `cached`; `cache_write` and
`reasoning` are reported fields, never added to input or output. `last_token_usage`
and `token_usage_record.usage` are one request; `turn_token_usage` is the turn so
far; `thread_token_usage` / `total_token_usage` is the whole thread across resumes.
Only the request and the thread total become observations.

Per conversation the rollout's requests after the launch boundary are *the*
requests. Telemetry corroborates them by position and count, and stands in only
where no rollout is readable **and** no retry or unverified transport could have
replayed a completion. A disagreement is a named gap, not a silent pick.

## The launch boundary

A resume appends to the same rollout and the stream/thread totals continue, so the
launch must say where its own requests start. Before spawning,
`beginCapture` reads the resumed thread's rollout and records the next ordinal
(`{ kind: "ordinal", fromOrdinal }`). Records below it belong to earlier launches
and are counted as `excludedBeforeBoundary`. If that read fails the boundary is by
time (`notBefore` the launch start) and the launch carries the gap
`launch boundary by time`; that cannot be `complete`.

## The replay policy

Telemetry cannot prove a completion was not replayed after a transport reconnect.
Telemetry-derived requests are emitted only when the conversation saw no retry
(`attempt` > 0 on any `codex.api_request`) and every transport seen is in
`CODEX_VERIFIED_TRANSPORTS` (today `["sse"]`). Otherwise the completions are
returned as *excluded* and the launch is partial. Rollout requests are never
replayed (ordinals and response ids are unique).

## The coverage rule

`complete` needs every condition; each failed one is a named gap and the launch is
`partial` (or `unknown` when no source reported at all):

1. the turn completed cleanly (so a cancelled or failed run is never complete);
2. the parent rollout was read, with an ordinal (not time) boundary;
3. the receiver started, stopped without a gap, and its journal was read without loss;
4. every transport seen is verified;
5. rollout and telemetry counts agree for every conversation, and no request came from telemetry alone;
6. **no native child could have gone unseen**: the parent rollout was read and shows
   *no spawn evidence* (`spawn_agent`/`spawn_agents` call, or a `collab_agent_spawn*`
   event), and the telemetry shows no other conversation.

Condition 6 is why a run **without** spawn evidence can be complete while one **with**
it is partial: absence of a spawn in a rollout that was read is evidence that there
were no children to miss, whereas a spawned child's rollout and telemetry are exactly
what the probe has not yet verified (`CODEX_VERIFIED_NATIVE_CHILDREN` is `false`).
An unread parent rollout is also partial, because then spawn evidence is unknown.
A child that is seen is attributed to the launching execution (`childRef`,
`inclusion`), never given an authority of its own.

## The launch boundary of the environment

The adapter sets the telemetry destination and capability through `-c` overrides on
the command line, and keeps `--ignore-user-config`. Receiver endpoint and bearer
capability are per launch and loopback only; the capability is not an execution
credential. The child's environment stays the allowlisted one (`CODEX_HOME` is on
it, which is how the rollout is found).

## The probes

Both are opt-in and skipped *with their reason* (never passed) when disabled; neither
runs under a plain `npm test` on a machine without the binary or the variable. Gates
are pure functions in `probe.ts` (`codexOfflineProbeGate`, `codexLiveProbeGate`).

**Offline** (`probe-offline.test.ts`). Enabled when `codex` is on `PATH` and
`codex --version` reports `0.155.1` (`NIGHTSHIFT_MEASUREMENT_PROBE_ALLOW_VERSION=1`
allows another version). It drives `createCodexHarness` end to end against the real
receiver, a loopback fake Responses API (`fakeResponsesProvider`) and a temporary
`CODEX_HOME`; the provider overrides live in a wrapper script written into a temp
directory (`codexLauncherFor`), so the adapter's environment and arguments are
untouched. Nothing leaves the machine and nothing is written outside temp
directories. It asserts a two-request turn, a cancellation after the first response
(one request, `partial`), and a resume (only its own request, thread-cumulative exit).

```sh
npx vitest run packages/harness-codex/src/probe-offline.test.ts
```

`NIGHTSHIFT_MEASUREMENT_FIXTURES=write` additionally regenerates the sanitized
fixtures in `packages/harness-codex/src/__fixtures__/` (rollout and journals, through
`sanitizeRolloutLine` / `sanitizeJournalLine`) and
`docs/programs/p20-measurements/codex-capability-offline.json`. It asserts the line
types and attribute keys of the committed fixtures are still present and that a
sentinel prompt appears in nothing written. Regenerated ids differ, so the unit tests
that name committed ids must be updated with them (see the fixtures README).

**Live** (`probe-live.test.ts`). Enabled only by `NIGHTSHIFT_MEASUREMENT_PROBE=codex`.
It uses the operator's existing login and the real backend (this spends a few
requests): a short main task, a prompt asking the model to spawn a sub-agent, an
interrupted run and a resume. A missing login is recorded as a failed
`real_backend` dimension and never repaired. It writes
`docs/programs/p20-measurements/codex-capability-live.json`.

```sh
NIGHTSHIFT_MEASUREMENT_PROBE=codex npx vitest run packages/harness-codex/src/probe-live.test.ts
```

### The capability matrix

`CapabilityMatrix` (`probe.ts`): `harness`, `harnessVersion`, `producedAt`, `mode`
(`offline` | `live`), `transports` (from the event names seen), `authMode` (the
`auth.*` flags `codex.conversation_starts` reports, or `unobserved`), `fieldsObserved`,
`nativeChildren` and `dimensions`. A dimension is `observed`, `not_observed`,
`unverified` or `failed`; every dimension nobody established is listed `unverified`,
never omitted. `nativeChildren` is `observed` only if a second conversation id or a
child rollout appeared.

### Extending what is verified

Nothing is widened by reasoning. After a **committed live matrix** shows
`transport_websocket` observed, add `"websocket"` to `CODEX_VERIFIED_TRANSPORTS` in
`packages/harness-codex/src/telemetry.ts`. After one shows `nativeChildren: "observed"`
with the child's requests visible, set `CODEX_VERIFIED_NATIVE_CHILDREN` to `true` in
the same file. Receiver health is never evidence of either. Update the matching tests
(`telemetry.test.ts`, `capture.test.ts`) in the same change.

## Known limits

- **No request id in telemetry.** Completions are identified by their position among a
  conversation's completions in one launch's journal; only the rollout carries
  `response_id`.
- **WebSocket transport is unverified.** The event names exist in the binary but the
  scripted provider speaks SSE only; only a live observation can verify it.
- **Native children are unverified offline.** A scripted provider cannot make Codex
  spawn a child, so the offline matrix lists `native_children` as `unverified`
  (its `nativeChildren` field says `not_observed`: none appeared). A run with spawn
  evidence is therefore always `partial`.
- **Capability in argv.** The receiver's bearer capability is passed as a `-c`
  override and is visible to other processes of the same user via `ps` for the
  launch's lifetime. It is per launch, loopback only and worthless afterwards.
- A cancelled or interrupted run keeps the requests that had reached the rollout, but
  telemetry still batched in Codex's exporter at the signal may be lost (an exporter
  flushes on an interval of a few seconds): such a launch is `partial` regardless.
- The rollout format is Codex-internal and versioned by `CODEX_ROLLOUT_READER_VERSION`;
  a new Codex release may change it, which the offline probe is there to catch.
- An external interactive Codex session not launched by Nightshift cannot be claimed
  as measured.
