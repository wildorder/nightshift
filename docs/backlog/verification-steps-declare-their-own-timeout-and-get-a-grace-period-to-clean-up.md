---
status: captured
captured: 2026-10-19
---

# Verification steps declare their own timeout and get a grace period to clean up

## What the session hit and where

keki-backend's `aws-postgres` program (run `run_01M5ANBX8TKYWXR6M3H51DCFM4`,
2026-10-19) had a `"at": "end"` verification step, `trial`, that deploys a
throwaway SST stage (VPC, two NAT instances, an RDS instance, every Lambda),
proves the program against it, and removes it with `sst remove` from a shell
`trap`. A real run of that script takes 30 to 60 minutes: about 10 to create
RDS, a few to deploy the rest, and 15 to 40 to remove, because AWS holds a VPC
Lambda's hyperplane ENIs for up to ~40 minutes after the function is deleted.

Nightshift killed the step at 10 minutes and recorded exit 124. Two things
went wrong, and they are separate:

1. **The cap is fixed and a contract cannot raise it.** Every step gets
   `environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS`
   (`packages/execution/src/environment.ts:320`, 10 minutes; read in
   `verify.ts:309`, `setup.ts:53`, `examine.ts:938`). The CLI's `gates`
   command and the MCP runner use the same default. A step has no field
   for it. So a whole class of legitimate end gates (deploy-and-prove an
   infra change, a long end-to-end suite) can never pass, and the run
   cannot end `succeeded` while one is in the contract.
2. **The kill skips the step's own cleanup.** On timeout `run.ts` calls
   `killProcessTree`, which sends `SIGKILL` to the process group straight
   away (`packages/verification/src/spawn.ts:142`; `KILL_GRACE_MS = 2_000`
   in `run.ts:122` only bounds how long Nightshift waits after the kill, it
   does not give the child a chance). The script's `trap … EXIT` never ran,
   so the AWS stage was left running and billing (RDS `available`, both NAT
   instances `running`), and SST's state lock stayed held by a dead process.
   The root had to notice, `sst unlock`, and remove the stage by hand.

## Why it is bigger than this session

The session was running a keki program, not changing Nightshift. Both fixes
touch the contract schema (`@nightshift/contracts`), `plan check`, the
verification runner, the `gates` diagnostic's forecast, and every caller that
supplies a timeout. The kill semantics also matter on Windows, where
`killProcessTree` takes a different path. keki ended the run `failed`
(decision `dec_01M5B6B0MAZY5NFRRQ5NG087B4`) instead of working around it.

## Constraints discovered

- **Carry-over requires an identical plan hash** (`packages/execution/src/carry-over.ts`,
  `root?.plan?.planHash !== program.planHash → skip`). Editing a contract to
  drop or retune a gate that cannot pass forces every finished strand to be
  rebuilt. So the timeout has to be right in the plan from the start, and
  `plan check` or `gates` should say when a step's measured or declared
  duration exceeds its cap, before anyone ratifies.
- **Exit 124 is forced on purpose** (`run.ts` comment: a process killed
  mid-exit can still report 0). Any grace period must keep that: a step that
  finishes cleanup and exits 0 *after* its timeout fired is still a timeout.
- **A step's process tree may hold external resources and locks** (cloud
  stacks, Docker containers, `sst`/Pulumi state locks). SIGTERM followed by a
  bounded grace and then SIGKILL is what lets a `trap` release them. The grace
  needs to be long enough for real teardown (minutes for a cloud stack), so it
  probably wants to be per step too, or a fraction of the step's timeout.
- **Deferral is unaffected:** a step that exits 75 with `NIGHTSHIFT_DEFER`
  inside its timeout is deferred as today; the same step killed by the timeout
  is a failure.
- The `gates` diagnostic (P17) already measures step durations and prints
  recommendations; it is the natural place to warn "step X took N minutes
  against a cap of M".

## Approaches considered or rejected, and why

- **Raising the global default.** It hides hung steps for every program to
  fix one, and still has no right value for a 60-minute infra gate.
- **Telling planners to keep gates under 10 minutes.** An RDS create alone
  takes about 10, so infra programs would lose their only real proof.
- **Having the step background its own teardown so it exits fast.** That
  leaves resources outliving the step with nobody accountable for them, and
  verification would pass before cleanup is known to have worked.
- **A Nightshift-side "cleanup command" field per step.** Possible, but a
  SIGTERM grace lets the step's own `trap` do it with no new concept, and it
  also covers locks the step took that Nightshift cannot know about.

## Pointers

- keki-backend `docs/programs/aws-postgres/report.md` and `contract.json`
  (`trial` step, `verify-trial.sh`, `scripts/rds-trial.sh`).
- Decision `dec_01M5B6B0MAZY5NFRRQ5NG087B4` in run `run_01M5ANBX8TKYWXR6M3H51DCFM4`.
- Code: `packages/verification/src/run.ts` (timeout and `TIMEOUT_EXIT_CODE`),
  `packages/verification/src/spawn.ts` (`killProcessTree`),
  `packages/execution/src/environment.ts` (`verificationTimeoutMs`,
  `DEFAULT_VERIFICATION_TIMEOUT_MS`), `packages/execution/src/carry-over.ts`.
