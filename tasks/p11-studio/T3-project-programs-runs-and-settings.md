# T3 — Project, programs, runs and settings

**Program:** `p11-studio`
**Depends on:** T1
**Unblocks:** T6
**Decisions applied:** D-P11-07, D-P11-10

## Objective

From a project, the owner sees its programs, their plans and every run, and
edits what is configurable. Proven over the memory stores with jsdom.

## Deliverables

1. **The project page**: name and description (editable, `project.put`);
   programs from `program.list`, each with its objective, plan status
   (`isPlanned`, `status`, the latest ratification and hash), pending
   prerequisites (`prerequisitesOf`, with remediation shown on demand), and its
   runs from `run.list`, merged into one table across programs sorted by
   `startedAt` descending: status, location, started, ended, outcome reason.
   Pagination follows the stores' cursors; no new index.
2. **Settings › organisation**: the org's config from `orgConfig.get`: the
   ladders (per provider, rungs by tier with routes and effort), the rules
   (classification → ladder and tier), unavailable routes, the price table, the
   examination policy per risk. Editable as structured forms validated with the
   contract schemas in the browser (`OrgConfigBodySchema`), saved with
   `replacesVersion` set to the version read; a 409 is shown as "changed since
   you read it" with a reload, never retried silently. A raw JSON view beside
   the forms, for what the forms do not cover.
3. **Settings › project and policies** (read-only): the project's cross-account
   role if any; for the selected program, the contract's `verification`,
   `modelPolicy`, `delegationLimits`, `costPolicy`, `examinationPolicy`,
   `defaultRisk`, `routing`; for a run, its effective policy
   (`Run.policy`, with the org config version it fixed).
4. **Me**: email, acting org, sign-out (from T1).
5. Component tests over memory stores: the runs table across two programs; a
   stale org-config save refused; forms round-trip the default org config.

## Acceptance

- SC-P11-02 and SC-P11-06 proven offline; the P8 org-config API tests unchanged.
- `npm run verify` green.
