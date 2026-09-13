# Nightshift

[![CI](https://github.com/wildorder/nightshift/actions/workflows/ci.yml/badge.svg)](https://github.com/wildorder/nightshift/actions/workflows/ci.yml)

Autonomous engineering control plane: controlled delegation, deterministic
verification, model routing, and reversible decisions for frontier coding
agents.

This is the **v1** line, a greenfield rebuild. Start here:

- `docs/vision.md` — what Nightshift is and why
- `docs/architecture.md` — settled decisions (A-nn) and open ones (O-nn)
- `docs/programs/staging.md` — how v1 splits into nine programs
- `docs/programs/00-source-program-plan.md` — full stage detail
- `AGENTS.md` — directives, conventions, and the greenfield boundary

## Verify

```sh
npm ci
npm run verify   # build, typecheck, lint, test, synth, sterility
```

Individual gates: `npm run build`, `npm run typecheck`, `npm run lint`,
`npm test`, `npm run synth`, `npm run check:sterility`.

No AWS account or credentials are needed for any of these.

## The P1 demo

The one thing P1 exists to prove is that a delegated child can never widen the
authority it inherited. See it refuse, with the generated scopes printed:

```sh
npx vitest run --project test -t "P1 exit demo"
```

## Layout

See `docs/architecture.md` §1. Dependencies point downward only, and that is
enforced by the architecture tests in `test/architecture/`, not by convention.
