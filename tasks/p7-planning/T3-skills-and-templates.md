# T3 — The skills and templates: `plan-program`, `author-specs`

**Program:** `p7-planning`
**Depends on:** T1; H-P7-03 (the keyart trial's observations)
**Unblocks:** T8
**Decisions applied:** D-P7-02, D-P7-04, D-P7-05, D-P7-06, D-P7-08, D-P7-09

## Objective

The planning flow a developer actually uses, as two skills shipped in
`skills/`, producing the same artifacts in the same places for every program.

## Deliverables

1. **`skills/plan-program/SKILL.md`**, interactive, with the human:
   - loads context: `nightshift.config.json`, the vision, `docs/as-built.md`,
     `AGENTS.md`, the context documents, `docs/backlog/`, and when re-planning
     the prior report, its parked workstreams and its pending prerequisites;
   - resolves the program id and the feature set, asking only for what is
     missing;
   - chooses `atomic` or `orchestrated` and writes the causal reason;
   - runs the **actor audit** over a provisional decomposition, with the
     enumerable tells (admin credentials, console-only actions, trust anchors,
     secrets the crew may not set, third-party accounts, DNS), the
     cannot-versus-tedious test, the perform-versus-observe rule for
     `verifyCommand`, and hoist-and-batch;
   - cuts the seams: independently green workstreams, expand → migrate →
     contract for shared contracts, scopes with real `excludes`;
   - lists anticipated decisions with options, a leaning and a reason, and asks
     the human the ones that matter;
   - writes `docs/programs/{id}-program.md` and `{id}-manifest.json` **to disk**
     and replies with a short summary and the two paths. The files are the
     review surface. Revisions are edits in place.
2. **`skills/author-specs/SKILL.md`**: for each workstream, a **clean sub-agent**
   given the program document, the roster (ids, names, scopes only) and its own
   manifest entry, writing `tasks/{id}/{WS-id}-{slug}.md` in the §4.2 shape; then
   `nightshift plan check`, and a summary of what is not ready and why. It never
   writes a spec in the planning conversation's own context.
3. **Templates** for the program document, the manifest and the spec, in
   `skills/*/templates/`, matched when a repository already has programs.
4. **The `nightshift` skill** learns the third step: a ratified plan is what an
   orchestrator executes, and `nightshift run {id}` is how.
5. **Skill tests**: each template parses; a recorded planning transcript over the
   slice fixture produces artifacts that pass `checkPlan`.

## Notes

- A program with no human-only step produces no prerequisites and no Human
  Prerequisites section. The audit discovers; it never blocks.
- Fold in what the keyart trial showed: which choices the developer wanted to
  make, and where a job boundary was wrong.
