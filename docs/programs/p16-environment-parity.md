# Program P16 — Environment Parity

| Field | Value |
|-------|-------|
| Program ID | `p16-environment-parity` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p16-environment-parity` |
| Source stage | none: the owner's direction of 2026-10-08, after keki-backend's `lightning-ux` remote run (`run_01M4ETF3JX06TFX821DX4E8TD1`) |
| Status | **Planned**, 2026-10-09: `plan check` READY; awaiting ratification |
| Depends on | P10 (the runner, D-P10-29), P15 (gate health, the run-start audit, red-base repair) |

This document is the stable authority for P16. Its plan, contract and kept
conversation are in `docs/programs/p16-environment-parity/`. The success
criteria, strands, decisions and their answers live in `contract.json`; the
why and the how live in `plan.md`. Amend either only through a human
decision.

## Objective

Make a remote run's machine the environment the plan's gate audit certified,
and make the developer's walk-away moment the moment the machine has proved
it.

## Why

On 2026-10-08 keki-backend's `lightning-ux` was audited green on the owner's
laptop (Node 22, Docker). It was then dispatched to a machine with Node 24 and
no Docker for its worker users. The machine did three things wrong:

- It counted its Docker gates' deferrals as failures, because HP-01 had been
  checked on the laptop.
- It failed a unit test that only fails on Node 24.
- It called the base red and opened a repair job against keki's code.

The owner's ruling: a run that is green where it was planned and fails on the
machine cannot happen. The machine adapts to the project, never the reverse.

## Exit trial

These are the owner's, after the program lands, because deploying and image
builds are forbidden to the run:

1. Deploy, and build the runner image.
2. Run `npm run runner:boot` and see the Node and Docker checks pass as a
   worker user.
3. Dispatch keki-backend's `lightning-ux` remotely and see it reach OK GO and
   start its strands.

## Decision log

| Date | Decision | Authority |
|------|----------|-----------|
| 2026-10-09 | Plan drafted: D-01 … D-09 proposed | Agent |
| 2026-10-09 | D-03, D-05, D-06, D-07 and D-08 answered by the owner at the leanings. D-04 widened by the owner from Node to every language runtime through one polyglot version manager: "nightshift should work on any environment". D-01, D-02 and D-09 taken at the leanings under the owner's standing review style | Human |
