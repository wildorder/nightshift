---
status: captured
captured: 2026-10-09
---

# Ratification proves the plan commit keeps the gates green

## What the session hit and where

P16 (`docs/programs/p16-environment-parity/`) was planned on 2026-10-09. The
planning gate audit (`nightshift gates p16-environment-parity`) ran on `main` at
`afd578e` and was green. The plan was then committed on
`program/p16-environment-parity` (`339c334`) and ratified.

That plan commit added `contract.json`, written by the planning agent with
Python's `json.dumps(indent=2)`. The repository's lint gate (`biome check .`)
formats JSON differently, so it rejected the file. `nightshift plan check` and
`nightshift plan ratify` both passed, because neither runs a gate.

The first remote run (`run_01M4FP9NX7FM19E4NKZM54FA09`) audited its base on the
machine. It correctly found `lint` red and recorded `gate.red`. Its next step
would have been a red-base repair job, whose fix is to reformat a contract
that ratification forbids changing.

The owner's agent cancelled the run, ran `biome format --write` on the
contract, committed `aca17d4` ("formatted as the lint gate requires"),
re-ratified and re-dispatched (`run_01M4FQ2A0RVJBX1N6EAAYM96MV`). The plan
hash did not change, because it is taken over the parsed content, not the
bytes.

## Why it is bigger than this session

The gap is structural, not a slip in one plan. The planning audit certifies
the base *before* the plan commit. The plan commit then changes the base:
- it adds `docs/programs/{id}/` and sometimes `nightshift.config.json`;
- nothing checks the gates on the result before a run starts from it.

Any repository whose gates lint, format-check or test-discover files under
`docs/` can be broken by its own plan. The owner chose to handle this
separately, rather than amend the running P16.

## Constraints discovered

**A ratified plan's files cannot be edited.** `nightshift run` refuses an
edit under `docs/programs/{id}/` until it is ratified again. A red-base
repair job must never be the thing that fixes a plan file.

**The plan hash is over parsed content.** A formatting-only fix needs a fresh
commit and a re-ratify, but leaves the hash unchanged.

**P16 helps, but only after ratification.** P16's reference audit at dispatch
(D-06) audits the laptop at the exact base, so it would catch this before a
machine is paid for. That is still after ratification.

**The gate-health fingerprint can't see this.** It covers setup and gate
commands, lockfiles and named machinery. A new `contract.json` does not change
it. A healthy record therefore says nothing about whether the plan commit
itself passes.

## Approaches considered or rejected, and why

**`plan ratify` (or `plan check`) runs the gates on the plan commit, or on the
head it would ratify.** This is the most direct: ratification would then mean
"this exact commit is green". It costs a full audit at ratify time, about
four minutes for Nightshift and longer for projects with e2e. A cheaper
variant runs only the gates whose inputs the plan commit touched, but nothing
today knows which gates read `docs/`.

**The planning skill writes plan files through the repository's own
formatter**, or runs the lint gate before committing. This would fix the
symptom seen here, but not the class. A test that discovers files, or a docs
link checker, would still break.

**Exclude `docs/programs/**` from the repository's gates.** This removes
checking that may be wanted. It is the project's call, not Nightshift's. At
most it becomes a finding the gate audit offers.

## Pointers

- **The plan.** `docs/programs/p16-environment-parity/plan.md`: D-06 (the
  laptop reference audit at dispatch) and S-02.
- **The gate audit and its fingerprint.**
  `apps/cli/src/commands/gate-health.ts` (`recordGates`) and
  `packages/core/src/rules/gate-fingerprint.ts`.
- **Ratification.** `apps/cli/src/commands/plan.ts`.
- **Related backlog work.** The planning skill's step 3a and its ratify steps,
  in `skills/plan-program/SKILL.md`.
