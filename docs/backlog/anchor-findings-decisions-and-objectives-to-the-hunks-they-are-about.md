---
status: captured
captured: 2026-10-20
---

# Anchor findings, decisions and objectives to the hunks they are about

## What the session hit and where

The session was decomposing the Pipkin brief (`pipkin-continuous-engineering-and-verified-releases.md`) into Linear issues PK-1 … PK-13, then compared Pipkin with Zed's DeltaDB. DeltaDB's one idea that survived the comparison was anchoring: a review comment attaches to the *edit* that produced a line, not to a file and line number, so it survives later changes and can be followed back to the conversation that caused it. The owner asked whether Nightshift's agents — worker, examiner, orchestrator — could do the same, and connected it to the decision graph (A-47): today you can see which decisions were made and reverse them; here you could also see the reasoning behind each piece of code.

The session's answer was to split the idea. **Authoring** (agents writing commentary on changes) is weak: the owner already ruled in P14 that links between intent and work are derived from records, never agent-written, because post-hoc rationale from a model is cheap to produce and unreliable to trust — and the reasoning already exists (the worker's transcript is an artifact, the examiner's findings are records, the orchestrator's decisions are stamped). **Anchoring** what is already recorded to a stable sub-commit identity is the valuable half, and this item is that half.

## Why it is bigger than this session

It needs a new primitive — a stable identity for a hunk of a job's commit that survives the merge queue's replay (`packages/execution/src/merge-queue.ts`) and strand merges (`packages/execution/src/strand.ts`) — and then changes to how examinations, decision stamps and job objectives reference code. It pays off only once repair work and candidates exist (PK-7 continuous landing, PK-5 candidates) and attaches naturally to snapshot lineage (PK-4). It is a PK-14 after those, not part of the thirteen filed on 2026-10-20 (Linear project "Pipkin", PIP-7 … PIP-19).

## Constraints discovered

- **Every commit is Nightshift's, one per job.** That is what makes this feasible here where DeltaDB has to build it: `git blame` → job commit → job record → its objective, the decision it implemented, its examination, its transcript artifact is a lookup, not an inference. The design must keep that property; it must not introduce worker-authored commits.
- **Links are derived, never agent-written** (P14's rule). A finding's anchor comes from mapping the examiner's named paths/ranges onto the hunks of the examined commit; a decision's reach from A-47's stamp (`produced`, `checkpointAfter`) narrowed to hunks; a job objective from the job's own commit. No agent is asked to write a comment on a change.
- **Identity must survive rewriting.** Root-level jobs are replayed onto the current head in the merge queue, which rewrites the commit SHA while keeping content (`merge-queue.ts:297-342`); strand jobs merge onto the strand branch and the strand lands by fast-forward. A content hash of the hunk (not its position, not its commit) is the only identity that survives both.
- **The defect this fixes is already named in P20's plan:** "a `fixed` finding only means it was not raised again; an `upheld` finding means the arbiter agreed. Neither is independently established truth." With hunk anchors, *fixed* can be derived: the finding named hunk H and the repair job's commit replaced H.
- **Large evidence belongs in artifact storage, not records** (architecture guarantee). Transcript segments are referenced, never copied into anchors.
- **Nothing here is a permissions boundary.** Knowing which hunks a job touched is provenance; it must not become a path scope on workers (see the standing rule against tool allow-lists and path scopes).

## Approaches considered or rejected, and why

- **Agents write comments on changes (the DeltaDB-user model).** Rejected: a fourth, less trustworthy copy of reasoning that already exists in transcripts, findings and decisions; contradicts P14's derived-links rule.
- **Anchor to file + line.** Rejected: rots on the next edit, which is exactly what a strand's fix rounds do.
- **Anchor to commit SHA only.** Insufficient: a job commit can be large, and replay changes the SHA; the question "did the repair touch what the finding named" needs sub-commit granularity.
- **Adopt DeltaDB.** Not available (no public engine; only an AGPL Claude Code plugin exists as of 2026-10-20), and it stores a CRDT operation log for live co-editing of a shared worktree, which the Pipkin brief rejects for isolated workers. At most a future provenance *source*.

## Pointers

- Benefits to prove, in order: (1) *fixed by evidence* — a finding's hunk was replaced by the repair commit; (2) *from a production line to its why* — blame → job → objective, decision, findings, transcript segment; (3) *decision reach in hunks, not whole commits* for `decision brief` and corrections (A-47); (4) *repair jobs read the hunk's history* instead of reconstructing intent.
- Related: `pipkin-continuous-engineering-and-verified-releases.md`, `pipkin-linear-issues.md` (PK-4 snapshots, PK-7 continuous landing); `docs/architecture.md` A-47 (decision stamps), A-59 (strand builds), A-60 (strand publication); P14 Intent (derived links); P20 plan §Architecture (finding evidence semantics).
- Code: `packages/execution/src/integrate.ts` (decision stamping after landing), `packages/execution/src/examine.ts` (findings), `packages/execution/src/merge-queue.ts` (replay), `packages/execution/src/strand.ts` (merge onto strand).
- Research: Zed, "Software Is Made Between Commits" (DeltaDB) and "Introducing Delta", 2026.
