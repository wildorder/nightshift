# The slice fixture repository

A deliberately small Node project, used as the target repository for the
Nightshift slice suite. It is materialised into a temporary directory by the
suite — `git init`, one commit, a program branch — and never itself a git
repository inside the monorepo.

Three properties matter, and each is a constraint rather than a preference:

- **No dependencies.** Verification runs `node --test` on a clean checkout, and
  a fixture that needed `npm install` would make every verification a network
  call and every CI run slower than the thing it is testing.
- **Its tests genuinely pass, and can genuinely be broken.** The
  `implement-broken` script adds a failing test; SC-P3-07 is only a proof if the
  verification it runs is real.
- **It has somewhere out of scope to stray.** `package.json` and this file sit
  outside `src/**` and `test/**`, which is what the `out-of-scope` script edits.
