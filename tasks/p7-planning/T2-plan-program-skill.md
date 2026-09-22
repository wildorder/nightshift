# T2 — The `plan-program` skill and the plan template

**Program:** `p7-planning`
**Depends on:** T1; H-P7-03 (the keyart trial's observations)
**Unblocks:** T5
**Decisions applied:** D-P7-01, D-P7-03, D-P7-04, D-P7-05, D-P7-06, D-P7-08

## Objective

The planning conversation a developer actually has, as one skill shipped in
`skills/`, producing the same two files in the same place for every program.

## Deliverables

1. **`skills/plan-program/SKILL.md`**. With the human, it:
   - loads context: `nightshift.config.json`, the vision, `docs/as-built.md`,
     `AGENTS.md`, the context documents, `docs/backlog/`, and when re-planning
     the prior `report.md`, its parked strands and pending prerequisites;
   - resolves the program id and the brief, asking only for what is missing;
   - **reads the code** the brief touches before proposing anything;
   - proposes the **seams**: as few strands as the work honestly has (one is
     fine), each independently green, scopes with real `excludes`, `dependsOn`
     only where it is causal, shared contracts sequenced expand → migrate →
     contract;
   - writes each strand's **approach** at medium fidelity: what will exist,
     modules touched, interface and data shapes, what was considered and
     rejected. **It names no jobs**, and says why when asked;
   - runs the **actor audit** with the enumerable tells (admin credentials,
     console-only actions, trust anchors, secrets the crew may not set,
     third-party accounts, DNS), the cannot-versus-tedious test, and the
     perform-versus-observe rule for `verifyCommand`;
   - **hoists first**: every human step becomes a prerequisite done before the
     run. It proposes splitting the program only when a step depends on an
     output of the run, names that output, and asks;
   - surfaces the decisions it can see coming, with options, a leaning and a
     reason, and asks the human the ones that are expensive to reverse;
   - writes `docs/programs/{id}/plan.md` and `contract.json` **to disk** and
     replies with a short summary and the paths. The files are the review
     surface; every revision is an edit in place; the human may edit by hand;
   - runs `nightshift plan check` and says what is not ready and why.
2. **The plan template** (`skills/plan-program/templates/plan.md`), the §4.2
   shape, matched when a repository already has programs.
3. **The `nightshift` skill** learns that a ratified plan is what an orchestrator
   executes and `nightshift run {id}` is how.
4. **Tests**: the template parses into sections `checkPlan` can read; a recorded
   planning session over the slice fixture produces files that are `READY`.

## Notes

- A program with no human-only step produces no prerequisites and no section for
  them. The audit discovers; it never blocks.
- Fold in what the keyart trial showed: which choices the developer wanted to
  make, and where a boundary was wrong.
- The line is D-P7-01's test. When the skill is tempted to list jobs, it is past
  the end of planning.
