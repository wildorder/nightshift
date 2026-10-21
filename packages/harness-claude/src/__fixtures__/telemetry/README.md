# Claude telemetry fixtures

Placeholder ids throughout; nothing here came from a real account.

- `otlp-logs-export.json` — the raw OTLP/JSON body as Claude Code 2.1.286 POSTs it to `/v1/logs`.
- `journal-reduced.ndjson` — the loopback receiver's own journal line format (reduced envelopes): main, compaction and sub-agent `api_request`, a redelivered duplicate of the main request, an `api_request` with no token counters (`req_nocount_0004`: kept with `counters: {}`, makes the capture partial), an `api_error`, a `user_prompt`, and a torn last line (no newline).

## Observed live on Claude Code 2.1.286 (2026-10-20/21, unauthenticated sandbox)

- Transport: `POST /v1/logs`, `content-type: application/json`, with the Authorization header delivered both through `OTEL_EXPORTER_OTLP_HEADERS` and through the `otelHeadersHelper` setting in a `--settings` file (with `--setting-sources ""`).
- Body shape: `resourceLogs[].resource.attributes`, `scopeLogs[].logRecords[]` with `timeUnixNano`, `observedTimeUnixNano`, `severityText`, `body.stringValue = "claude_code.<event>"`, `attributes[]`.
- Resource attribute keys: `host.arch`, `os.type`, `os.version`, `service.name`, `service.version`.
- Event names: `managed_settings_resolved`, `plugin_loaded`, `user_prompt`, `api_error`.
- `api_error` attribute set: `user.id`, `session.id`, `app.version`, `terminal.type`, `event.name`, `event.timestamp`, `event.sequence`, `prompt.id`, `model`, `error`, `duration_ms`, `attempt`, `client_request_id`, `speed`, `query_source`.

## Hand-built from vendor documentation, NOT verified live

- Every `api_request` field: `model`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `input_tokens` (excludes cache), `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`, `client_request_id`, `speed`, `query_source` (`main`/`subagent`/`auxiliary`/`compact`/`sdk`/`repl_main_thread`/a sub-agent name), `effort`, `agent.name`.
- The `plugin_loaded` and `user_prompt` attribute sets here are minimal; `plugin.name` and `prompt` are included only to prove they are dropped.
- The reduced journal's records, which are what the receiver would write from such bodies.

`cost_usd` is Claude Code's client-side estimate, never billed spend.
