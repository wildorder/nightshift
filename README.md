# Nightshift

[![CI](https://github.com/wildorder/nightshift/actions/workflows/ci.yml/badge.svg)](https://github.com/wildorder/nightshift/actions/workflows/ci.yml)

**A control plane for code written by agents.** You plan a program with
Nightshift in two files, a plan and a contract, until the choices left are the
cheap ones; then it runs unattended. Every job gets its own git worktree, is
verified deterministically on the real head of the branch, and lands as a
commit Nightshift owns, because an agent saying it is done is not the same as
the work being right. Cheap, well-tested jobs route to cheap models; risky ones
are examined by a different provider before they land. Every decision is
recorded with the alternatives it beat and the commits it produced, and you can
reverse one and have the correction planned from the record. The Studio shows
all of it, live. Claude Code and Codex are the harnesses today.

## Quick start

You need Node 24, git, and Claude Code or Codex signed in on your machine. No
cloud account.

```sh
git clone https://github.com/wildorder/nightshift.git && cd nightshift
npm ci
npm run build
(cd apps/cli && npm link)                 # puts `nightshift` on your PATH

nightshift local                         # the control plane, on this machine
```

`nightshift local` runs the whole control plane in one process on
`127.0.0.1:47820`, over a SQLite file in your state directory, and opens the
Studio. Leave it running; `Ctrl-C` stops it, and starting it again finds
everything where you left it.

Then, in another terminal, in a repository of yours:

```sh
nightshift init                          # the project, its config, the skills and the MCP server
```

In Claude Code, ask it to plan something (`/plan-program`). It writes
`docs/programs/<id>/plan.md` and `contract.json` with you, and when
`nightshift plan check <id>` says `READY` you ratify it:

```sh
nightshift plan ratify <id>
nightshift run <id>                      # unattended, to docs/programs/<id>/report.md
nightshift report <id>                   # the report again, from the control plane
nightshift decision reverse <id> <decisionId> --choice "…" --reason "…"
```

Watch the run in the Studio while it goes: the execution tree, every agent and
its model, the timeline, each job's verifications and examinations, cost, and
the decision graph, from which you can reverse a decision.

`nightshift use <stage>` switches between this local instance and a hosted
one. The hosted stage at `nightshift.wildorder.dev` is the author's.

## How it is built

Start with these; they are the record of every decision and why.

- `docs/vision.md` — what Nightshift is and why
- `docs/architecture.md` — settled decisions (A-nn) and open ones (O-nn)
- `docs/programs/` — each program's contract, its ratified decisions and its as-built
- `AGENTS.md` — directives, conventions, and the as-built notes a later program needs

The layering is enforced by tests (`npm run check:architecture`): dependencies
point downward only, provider-specific code lives only in a `harness-*`
package, and `contracts` and `core` import nothing from outside.

## Verify

```sh
npm ci
npm run verify       # build, typecheck, lint, test, synth, sterility
npm run local:e2e    # a stranger's first run, on a local instance, end to end
```

No cloud account or credentials are needed for any of these.

## Licence

Apache-2.0. See `LICENSE`.
