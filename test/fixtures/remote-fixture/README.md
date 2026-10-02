# The remote fixture repository

The repository a Nightshift remote run (P10) checks out on its machine. It is
pushed to `wildorder/nightshift-remote-fixture`, where the Nightshift GitHub App
is installed, and the copy under `test/fixtures/remote-fixture` in the monorepo
is its source of truth: edit here, then push the two branches.

Unlike the slice fixture, this one **has dependencies on purpose**: a lockfile
whose `npm ci` downloads enough that the difference between a cold volume and
the project's warm one is measurable (SC-P10-08). `nightshift.config.json`
carries the setup `nightshift init` would write, `npm ci --prefer-offline`, so
the npm cache on the volume answers before the registry does.

Branches: `main`, and `program/fixture` at the same commit, which is the program
branch the live proof (`npm run runner:boot`) dispatches.
