# The remote fixture repository

The repository a Nightshift remote run (P10) checks out on its machine. It is
pushed to `wildorder/nightshift-remote-fixture`, where the Nightshift GitHub App
is installed, and the copy under `test/fixtures/remote-fixture` in the monorepo
is its source of truth: edit here, then push the two branches.

Unlike the slice fixture, this one **has dependencies on purpose**: a lockfile
whose `npm ci` does real work, so the install, the seeded worktrees and the
warm volume have something to show (D-P10-15, D-P10-24). It carries no
`nightshift.config.json`: the live proof supplies the program contract, with
`npm ci --prefer-offline` as its setup, through the plane, and the monorepo's
sterility rule forbids that file anywhere in this tree.

Branches: `main`, and `program/fixture` at the same commit, which is the program
branch the live proof (`npm run runner:boot`) dispatches.
