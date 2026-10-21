# Claude Code measurement capture: what is known, and how it was learned

Pinned Claude Code: **2.1.286**. Status key used throughout:

- `verified-live`: observed from the installed 2.1.286 CLI (dates below).
- `verified-by-fixture`: decoded correctly from a fixture built from vendor documentation or recorded shapes; the real CLI has not been seen emitting it.
- `documented-only`: taken from the vendor's documentation; nothing in this repository exercises it.

## 1. How capture works

Two channels feed the measurement sink (`MeasurementSink`, metadata only):

1. **Stream.** `stream.ts` decodes the `--output-format stream-json` frames: one `request` observation per assistant message (`claude:assistant:<message id>`), a `cumulative_snapshot` (scope `session`, inclusion `includes_children`) from each `result` frame's `modelUsage`/`total_cost_usd`, and the exit aggregate.
2. **OTLP.** With `requestCapture` on, the adapter starts a loopback receiver (`capture.ts`, built on `startLocalReceiver`), points the child's OTLP/HTTP logs exporter at it, and decodes the `api_request` log events into `request` observations (`claude:api_request:<request_id>`, falling back to `client_request_id`, then `session.id:event.sequence`). Only attributes in `CLAUDE_TELEMETRY_ATTRIBUTES` are ever journaled.

The receiver's capability (its shared secret) reaches the exporter through `otelHeadersHelper` in the `--settings` file, which prints a 0600 headers file. On win32 only, where `runAs` never applies, it is the `OTEL_EXPORTER_OTLP_HEADERS` environment header instead. The journal lives in engine-owned storage outside any directory granted to the agent's user, and the adapter removes it after `onCapture` has run.

**Coverage rule.** A launch's capture is `complete` only with a non-error `result` frame **and** a complete receiver capture (no `receiver_lost`, `stopped_before_flush`, `journal_full`, `records_truncated`, `torn_tail`, `unidentified_request_dropped`, `records_dropped`, `no_api_request`). Anything else is `partial`, with the reasons on the ending payload.

## 2. Field-by-field matrix

### `api_request` attributes

All `documented-only` unless stated: **no `api_request` was observed live**, because every live run to date was unauthenticated. The decoder handles each (`capture.test.ts` against `__fixtures__/telemetry/`, hence `verified-by-fixture`). Rows marked *live* were seen on `api_error` (below), same exporter.

| Attribute | Status |
|---|---|
| `event.name` | verified-live (on api_error) / verified-by-fixture for api_request |
| `event.timestamp` | verified-live (on api_error) / verified-by-fixture |
| `event.sequence` | verified-live (on api_error) / verified-by-fixture |
| `session.id` | verified-live (on api_error) / verified-by-fixture |
| `app.version` | verified-live (`2.1.286`) |
| `model` | verified-live (on api_error) / verified-by-fixture |
| `input_tokens` (excludes cache) | documented-only; decoded by fixture |
| `output_tokens` | documented-only; decoded by fixture |
| `cache_read_tokens` | documented-only; decoded by fixture |
| `cache_creation_tokens` | documented-only; decoded by fixture |
| `cost_usd` | documented-only; decoded by fixture |
| `cost_usd_micros` | documented-only; not in the fixture's bodies |
| `duration_ms` | verified-live (on api_error; the live mcp event carried it as a string `"60"`) / verified-by-fixture |
| `request_id` | documented-only; decoded by fixture |
| `client_request_id` | verified-live (on api_error) / verified-by-fixture |
| `query_source` | verified-live (`sdk` on api_error) / verified-by-fixture (`main`, `subagent`, `compact`) |
| `agent.name` | documented-only; decoded by fixture |
| `speed` | verified-live (`normal`, on api_error) / verified-by-fixture |
| `effort` | verified-live (on api_error, 2026-10-21 probe) / verified-by-fixture |

### `api_error` attributes (verified-live)

2026-10-20/21 sandbox: `user.id`, `session.id`, `app.version` (`2.1.286`), `terminal.type`, `event.name`, `event.timestamp`, `event.sequence`, `prompt.id`, `model`, `error`, `duration_ms`, `attempt`, `client_request_id`, `speed` (`normal`), `query_source` (`sdk`). The 2026-10-21 probe (journal after the allowlist) additionally showed `effort`.

### Resource attributes (verified-live)

`host.arch`, `os.type`, `os.version`, `service.name`, `service.version`. (The probe's evidence lists none because the journal reduces resource attributes; the earlier raw capture is the source.)

### Other events (verified-live)

`managed_settings_resolved`, `plugin_loaded`, `user_prompt`, `api_error`, and (2026-10-21 probe) `mcp_server_connection`.

### Transport (verified-live)

OTLP http/json log export to a 127.0.0.1 endpoint, `POST /v1/logs`, `content-type: application/json`. The Authorization header was delivered both from `OTEL_EXPORTER_OTLP_HEADERS` and from `otelHeadersHelper` in a `--settings` file under `--setting-sources ""`.

### Stream fields

| Field | Status |
|---|---|
| `claude_code_version` on the init frame (`2.1.286`) | verified-live |
| `<synthetic>` assistant frame (uuid id, all-zero usage) after an auth failure, then a success `result` with empty `modelUsage` and `total_cost_usd` 0 | verified-live |
| `result.usage` (main loop, per turn) | verified-by-fixture (recording on 2.1.273) |
| `total_cost_usd`, `modelUsage` (whole tree, session-cumulative) | verified-by-fixture; documented-only for the restore-on-resume behaviour |
| `modelUsage.thinkingTokens`, `modelUsage.contextWindow` | verified-by-fixture |
| assistant `usage` (output_tokens is a placeholder) | verified-by-fixture |
| `parent_tool_use_id` | verified-by-fixture (`stream/subagent.jsonl`) |
| `compact_boundary` pre/post tokens | verified-by-fixture (schema read from the CLI binary; never emitted live) |

## 3. Semantics relied on

- `result.usage` is the **main loop and per turn**; it excludes children. ([Claude Code headless](https://code.claude.com/docs/en/headless))
- `total_cost_usd` and `modelUsage` are **whole-tree** and, since **Claude Code 2.1.277**, **session-cumulative on resume**. The adapter therefore reports them with `usageScope: "session"` and `inclusion: "includes_children"`, and S-01's recorder baselines them (subtracting the session figure at the start of the segment). On a CLI older than 2.1.277 this would double count. ([Costs](https://code.claude.com/docs/en/costs), [changelog](https://code.claude.com/docs/en/changelog))
- Assistant-frame `output_tokens` is a streaming placeholder; the final figure is in `result`/`api_request`.
- `input_tokens` excludes cache tokens; the adapter sets `inputIncludesCache: false` everywhere. ([Monitoring usage](https://code.claude.com/docs/en/monitoring-usage))
- `cost_usd`, `cost_usd_micros` and `total_cost_usd` are **client-side estimates, never billed spend**. They are recorded as `reportedUsd`/`reportedCostUsd`, never as actual spend.

## 4. Explicit unknowns and limits

- **`api_request` emission is unverified live.** No authenticated run has been made; the attribute set above for api_request is documented plus fixture.
- **Compaction** (`compact_boundary` frame plus a `query_source: compact` request) has not been observed live; see section 6.
- **Per-request context window** is not emitted by the provider. `contextWindowTokens` comes only from `modelUsage.contextWindow` and only on stream requests.
- **SIGKILL before the exporter flushes** loses the unexported tail of requests: capture is `partial`, with `stopped_before_flush` (or `receiver_lost`) on the ending payload. The stream channel still carries what had been printed.
- **Windows** uses the env header (`OTEL_EXPORTER_OTLP_HEADERS`) because `runAs` never applies there.
- The flush interval (`exportIntervalMs`, default 1000 ms) bounds how stale the journal can be at a hard stop.

## 5. No pin change

Installed `claude --version`, `VERIFIED_CLAUDE_VERSION` (`src/command.ts`) and `RUNNER_TOOLCHAIN.claude` (`infra/cdk/src/lib/runner-image.ts`) are all **2.1.286**, so this strand needed no pin change. If the pin moves, re-verify: the `api_request` attribute set (names, types, units); `otelHeadersHelper` under `--setting-sources ""`; `modelUsage`/`total_cost_usd` restore-on-resume (>= 2.1.277); and the `<synthetic>` assistant frame.

## 6. How to run

- The probe (spawns the real CLI; needs a Claude Code sign-in):
  `NIGHTSHIFT_CLAUDE_CAPTURE_PROBE=1 NIGHTSHIFT_CLAUDE_CAPTURE_KEEP=packages/harness-claude/src/__fixtures__/probe npx vitest run packages/harness-claude/src/probe.test.ts`
  Without `…_KEEP` the evidence is printed. Unset, the suite is skipped by name with the reason.
- Conformance against the real CLI: `NIGHTSHIFT_SLICE_HARNESS=claude` (as `npm run slice` sets it).
- `npm run conformance` for the repository's conformance run.

## 7. Probe outcome (2026-10-21, installed 2.1.286)

The probe ran once in the worker's sandbox, which has **no credential for a child `claude` process**: every dimension's session hit an `api_error` before any model response, and the adapter reported the exit `failed` with coverage `partial` and `no_api_request`. Each record carries `unverified: "live capability unverified: …"`. Nothing was fabricated; these records are the probe's output, sanitized.

| Dimension | Outcome | Evidence |
|---|---|---|
| main | **unavailable**: provider refused (api_error / authentication; the CLI's message was "Could not resolve authentication method…"). 0 `api_request`, 1 `api_error`. | [evidence](src/__fixtures__/probe/main.evidence.json), [journal](src/__fixtures__/probe/main.journal.ndjson) |
| child | **unavailable**: same refusal; no sub-agent was created (`sawSubagent` false). | [evidence](src/__fixtures__/probe/child.evidence.json), [journal](src/__fixtures__/probe/child.journal.ndjson) |
| compaction | **not observed**: same refusal; no `compact_boundary`, no compact request. | [evidence](src/__fixtures__/probe/compaction.evidence.json), [journal](src/__fixtures__/probe/compaction.journal.ndjson) |
| interrupted | **unavailable**: the session failed on the refusal before the cancel could cut a generation. | [evidence](src/__fixtures__/probe/interrupted.evidence.json), [journal](src/__fixtures__/probe/interrupted.journal.ndjson) |

What the records do prove on 2.1.286: transport (`/v1/logs`, `application/json`), `app.version` `2.1.286`, event names (`managed_settings_resolved`, `mcp_server_connection`, `plugin_loaded` x3, `user_prompt`, `api_error`), the `api_error` attribute set after the allowlist (including `effort`), and that `api_error` is counted as an error, not a request. Re-run the probe on a signed-in machine to settle the rest.
