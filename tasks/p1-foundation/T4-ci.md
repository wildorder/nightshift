# T4 — CI workflow

**Program:** `p1-foundation`
**Depends on:** T1, T2, T3
**Unblocks:** exit gate
**Decisions applied:** D-P1-06
**Human prerequisite:** H-01 (branch on GitHub, Actions enabled)

## Objective

Every command in the contract's §6 runs on every push and pull request, on
both Linux and Windows, and the branch cannot be considered done unless CI is
green.

## Deliverables

1. `.github/workflows/ci.yml`:
   - Triggers: `push` to `v1` and `program/**`; `pull_request` targeting `v1`.
   - Matrix: `ubuntu-latest`, `windows-latest`. Fail-fast off.
   - Steps: checkout, `actions/setup-node` with the version from
     `.node-version` and npm cache, `npm ci`, then in order `npm run build`,
     `npm run typecheck`, `npm run lint`, `npm test`, `npm run synth`,
     `npm run check:sterility`.
   - `concurrency` group per ref with cancel-in-progress.
   - No secrets, no AWS credentials, no `configure-aws-credentials` step.
     Adding one is a P2 change.
2. Pin every action by major tag at minimum.
3. `README.md` gains the CI badge.

## Acceptance

- A push to `program/p1-foundation` produces a green run on both OSes.
- A deliberate lint error on a throwaway branch produces a red run. Delete the
  branch afterwards.

## Notes

Windows runners are slower. If wall clock on Windows exceeds roughly ten
minutes, note it in the contract's §11 and consider splitting the job; do not
drop the Windows leg.
