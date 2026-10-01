# T5 — Providers and the AgentCore worker

**Program:** `p10-remote-runner`
**Depends on:** T1, T2; H-P10-05 (Bedrock satisfied)
**Gate before it starts:** the owner has run `nightshift org providers set
anthropic` and `nightshift org providers set openai`, and `nightshift org
providers status` shows both present.
**Unblocks:** T8
**Decisions applied:** D-P10-03, D-P10-04, D-P10-23; SC-04, SC-05

## Objective

Claude Code and Codex workers run on the machine with the org's API keys,
the AgentCore harness worker runs there with a Bedrock model under the
project's role and passes the unchanged conformance suite, and subscription
sign-in is attempted with its result recorded, whichever way it goes.

## Deliverables

1. **API keys on the machine**: the heartbeat response carries the org's
   decrypted keys (`credentials.anthropic`, `credentials.openai`) to `engine`
   only when the dispatch is `running` and the generation matches; the runner
   holds them in memory and `createWorkerEnvironment` puts exactly one in a
   worker's environment, by the route's provider (`ANTHROPIC_API_KEY` for
   `claude`, `OPENAI_API_KEY` for `codex`), never both, never on disk, never in
   the root's environment unless the root's route needs it. `harness-codex`'s
   deliberate exclusion of API-key auth is lifted with a test that the
   adapter starts with `OPENAI_API_KEY` and no `auth.json`. A worker's
   environment is asserted in a test to contain no key for a provider it does
   not use.
2. **Bedrock through A-25**: the runner assumes the project's `crossAccount`
   role (`sts:AssumeRole` with the external id, from the instance role, which
   gains that single action on `*` with a condition on the external id tag)
   and refreshes before expiry; the credentials go to the AgentCore worker's
   environment only. The routing policy's `prices` gain the Bedrock model id;
   `routeUnavailableReason` reports a missing role or an unauthorized model as
   an unavailable route before any job is started on it (D-P10-04's "prove
   access before dispatch" is a `preflight` check: `bedrock:GetFoundationModelAvailability`
   through the assumed role).
3. **`@nightshift/harness-agentcore`**: the adapter over the exported harness.
   `export/` holds the pinned Python export of the harness loop (Strands) with
   a `requirements.txt` pinned exactly and a `uv.lock`; `adapter.ts` implements
   `Harness` (`start`, `cancel`, `status`, capabilities: no session resume
   unless the export supports it, documented either way) by spawning
   `python3 -m nightshift_agentcore` in the worktree with the brief on stdin,
   the MCP launch as the harness's remote MCP server configuration, and the
   model from the route; `stream.ts` maps its event stream to the adapter's
   lifecycle events and `usage`; `command.ts` pins the Python entry and the
   model id format. Provider-specific imports stay inside the package (AR-2).
   The AMI (T2) carries the export and its venv under `/opt/nightshift/agentcore`.
4. **Conformance**: `test/src/harness/adapter-conformance.test.ts` runs the
   AgentCore adapter with a scripted Python double offline; `npm run
   conformance -- --harness agentcore` runs the real thing against the deployed
   plane from a developer machine, like the other two, and `all` includes it.
   The suite is unchanged; the adapter conforms to it.
5. **Subscription sign-in, attempted** (`nightshift remote login <provider>
   --run <id>`): opens a session on the machine over SSM Session Manager
   (the instance role gains `ssmmessages:*` and the Lambda-free path is the
   developer's own `aws ssm start-session`; the CLI prints the exact command)
   under a dedicated `subscription-<provider>` user whose home is on the
   volume; runs the native device login (`claude` / `codex login --device`);
   the resulting credential file is readable by that user alone and workers of
   that provider run as that user when the org's chosen mode is `subscription`
   (`OrgConfig.providers[provider].mode`, default `api_key`). The attempt is
   made once per provider on a real machine and recorded in the contract's §15
   as: works (with concurrency and recovery observations), blocked by terms
   (quoting the clause), or blocked mechanically (with the error). A blocked
   mode is reported by `preflight` as unavailable and never falls back to the
   key (SC-P10-12). This deliverable is complete when the record is written,
   whichever outcome.
6. **Tests, offline**: the key routing per provider; nothing on disk after a
   worker ends (the worktree and the user's home are scanned for the key's
   last four); the heartbeat withholds credentials on a stale generation and
   on any status but `running`; the AgentCore adapter's conformance; the
   preflight's unavailable-route reasons.

## Acceptance

- SC-P10-04's AgentCore half and SC-P10-12 proven: offline for the key
  handling and the adapter, live through `npm run conformance -- --harness
  agentcore` and one remote run of the fixture where a cheap job routes to
  AgentCore on Bedrock.
- The subscription record is in §15 for both providers.
- `npm run verify` green.
