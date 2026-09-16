# T6 — The MCP server, the fixed route and the skill

**Program:** `p3-vertical-slice`
**Depends on:** T3, T5
**Unblocks:** T9
**Decisions applied:** D-P3-01, D-P3-04, D-P3-07, D-P3-08, D-P3-12, D-P3-14, D-P3-17; A-02, A-03, A-04, A-16, A-32

## Objective

Build the Nightshift MCP server in `apps/mcp`: one binary, two roles, the tool
surface in the contract §4.5, the composition root that wires the http adapter
and the Claude Code adapter into the execution layer, and the skill that tells an
orchestrator how to use it.

## Deliverables

1. **Dependency.** `@modelcontextprotocol/sdk` at `1.30.0` in `apps/mcp`,
   recorded in `AGENTS.md` (D-P3-14). Confirm it accepts the repository's zod 4
   for tool input schemas; if it needs its own zod, that is a decision to
   surface, not a second pin to add quietly.
2. **Roles** (D-P3-01). `NIGHTSHIFT_ROLE` is `orchestrator` or `worker`; absent
   means `orchestrator`. The worker role requires the seven identity variables
   from the contract §4.2 and refuses to start without them, naming the missing
   ones. Each role registers only its tools. The server speaks stdio; it opens
   no socket.
3. **Orchestrator tools**: `run.start`, `run.attach`, `run.finish`,
   where `run.start` and the CLI's `nightshift run` (T7) call one exported
   function for the control-plane writes (D-P3-17), and `run.attach` with no
   `runId` binds to the single pending run for the repository's program;
   `program.get`, `program.status`, `delegate`, `job.get`, `job.wait`,
   `job.cancel`, `decision.record`, `checkpoint.create`, `execution.status`, with
   the semantics in the contract §4.5. Tool input schemas are zod, derived from
   `@nightshift/contracts` where a contract type exists (`ScopeRequestSchema`,
   `RiskLevelSchema`, `ReversibilitySchema`, …). Results are structured JSON
   with a one-paragraph text summary an orchestrator can read without parsing.
   Refusals are the typed `code` plus the message, never a stack trace.
4. **Worker tools**: `job.get`, `job.progress`, `job.complete`, `job.fail`,
   `decision.record`, over T5's worker-side functions.
5. **`delegate`** validates the request into a `JobContract` first (A-03), then
   applies D-P3-07 (examination policy for the job's risk must be
   `required: false`), then calls T5's runner, which persists everything before
   the harness starts. It returns once the harness has started. The job runs in
   the background of the server process; `job.wait` polls the control plane,
   not process memory, so the answer is the same one `GET …/state` would give.
6. **Routing** in `packages/routing` (D-P3-08): `fixedRoute(program, job,
   override?)` → the `RoutingDecision` to persist and the `RouteTarget` to run:
   harness `claude`, provider `anthropic`, model the override if given and
   allowed by the policy, else the first allowed model, else a documented
   default. Every considered option is listed with eligibility and reason;
   `wasOverride` set when the orchestrator pinned a model. Unit tests over the
   policy cases including a forbidden override.
7. **Composition root** (D-P3-12): `apps/mcp/src/compose.ts` is the only module
   that imports `@nightshift/harness-claude` and `@nightshift/persistence/http`.
   Amend `test/src/architecture/rules.ts` so AR-2 permits harness
   implementations in exactly that file, with a negative fixture proving any
   other file in `apps/mcp` is still refused. Update the layer table for
   `apps/mcp` (`harness`, `harness-claude`) and the scaffold map.
8. **Graceful shutdown**: on stdin close, SIGTERM or SIGINT, call T5's
   `shutdown`, wait a bounded time, exit. The worker role flushes its outbox on
   stdin close so a worker's last progress events are not lost when the harness
   exits.
9. **The skill** at `skills/nightshift/SKILL.md`: how an orchestrator starts a
   run, writes a delegation (objective, scope, acceptance; what "scope" means
   and that it can only narrow), waits, reads a result, records a decision,
   finishes. It states what the orchestrator must not do: edit the program
   contract, commit on a worker's behalf, treat `implemented` as done. Short,
   and addressed to the model.
10. Tests: an MCP client from the SDK, in-process over a paired stdio-like
    transport, exercising every tool in both roles against the local control
    plane and a fake harness; the worker role's refusal to start with a missing
    variable; the orchestrator role's refusal to register `delegate` as a
    worker; `delegate` refused for an examination-requiring risk; `job.wait`
    returning before its cap with `timedOut: true`.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`apps/mcp` exposes a `bin` (`nightshift-mcp`) that runs from `dist`, so a
harness can launch it with `node <path>` and no TypeScript loader.

## Notes

- The MCP client's `clientInfo.name` and `version` from the initialize
  handshake are the orchestrator agent's `harness`; the model comes from
  `run.start`. Record both; do not guess a model.
- Check the installed Claude Code's MCP tool timeout and set `job.wait`'s cap
  below it, with the number and its source in a comment.
- `program.get` returns the persisted contract, not the file. If the file and
  the record disagree, the record wins and the tool says the file has drifted.
- The skill is for target projects. It is not used to build Nightshift
  (`AGENTS.md`: no dogfooding).
