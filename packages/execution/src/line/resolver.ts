import type { CommitSha, LineVerification } from "@nightshift/contracts";
import { LINE_RESOLVER_ATTEMPTS } from "@nightshift/core";
import type {
  LineFailure,
  LineResolution,
  LineResolverDecision,
  LineResolverPorts,
  LineUnit,
  LineWorktree,
} from "./ports.js";

const unitCommit = (unit: LineUnit): CommitSha =>
  unit.kind === "main" ? unit.commit : unit.range.upTo;

const unitLabel = (unit: LineUnit): string =>
  unit.kind === "main"
    ? `main at ${unit.commit}`
    : `program ${unit.range.program} range ${unit.range.from ?? "(start)"}..${unit.range.upTo}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const describeFailure = (failure: LineFailure): string[] => {
  const { cause } = failure;
  if (cause.kind === "conflict") {
    return [
      "The merge conflicted.",
      `Conflicted paths: ${cause.paths.join(", ") || "(none listed)"}`,
      `Detail: ${cause.detail}`,
    ];
  }
  const lines = [
    `The merge was clean but the landing checks failed on candidate ${cause.candidate} (${cause.verification.outcome}).`,
  ];
  for (const log of cause.logs) {
    lines.push(`Command \`${log.command}\` exit code ${log.exitCode ?? "none"}; log tail:`);
    lines.push(log.tail);
  }
  return lines;
};

const briefOf = (failure: LineFailure, earlier: string[]): string => {
  const lines = [
    `The line could not take ${unitLabel(failure.unit)} (commit ${unitCommit(failure.unit)}) onto line head ${failure.base}.`,
    ...describeFailure(failure),
    "",
    `The merge of commit ${unitCommit(failure.unit)} is already in progress in this worktree, which is at ${failure.base}.`,
    "Edit files only; do not run any git command. Nightshift makes the commit.",
    "Leave a merged tree that keeps both sides' work and passes the landing checks.",
  ];
  if (earlier.length > 0) {
    lines.push("", "Earlier attempts failed:");
    earlier.forEach((note, index) => {
      lines.push(`Attempt ${index + 1}: ${note}`);
    });
  }
  return lines.join("\n");
};

export const resolveLineFailure = async (
  ports: LineResolverPorts,
  failure: LineFailure,
): Promise<LineResolution> => {
  const { checkout, verifier, agents, decisions, clock } = ports;
  const limit = Math.max(
    0,
    Math.min(failure.attemptsLeft, ports.limits?.attempts ?? LINE_RESOLVER_ATTEMPTS),
  );
  const deadlineMs = Date.parse(failure.deadline);
  const passed = () => clock.now() >= deadlineMs;
  const commitOfUnit = unitCommit(failure.unit);
  const notes: string[] = [];
  let attempts = 0;
  let last: { commit: CommitSha; verification: LineVerification } | undefined;

  const parked = (reason: string, timeLimit: boolean): LineResolution => ({
    kind: "parked",
    reason: `${timeLimit ? "the composition's time limit passed" : `the resolver's attempt limit (${limit}) was spent`}; last failure: ${reason}`,
    resolver: { decision: "gave_up", attempts },
    ...(last ? { commit: last.commit, verification: last.verification } : {}),
  });
  const lastNote = () => notes[notes.length - 1] ?? "none (no attempt ran)";

  while (attempts < limit) {
    if (passed()) return parked(lastNote(), true);
    attempts += 1;
    const opened: LineWorktree[] = [];
    const fail = (note: string) => {
      notes.push(note);
    };
    try {
      const wt = await checkout.open(failure.base);
      opened.push(wt);
      await checkout.startMerge(wt, commitOfUnit);
      const brief = briefOf(failure, notes);

      const resolved = await agents.resolve({
        brief,
        worktree: wt,
        deadline: failure.deadline,
      });
      if (resolved.status !== "finished") {
        fail(`the resolver agent failed${resolved.summary ? `: ${resolved.summary}` : ""}`);
        continue;
      }
      if (passed()) return parked(lastNote(), true);

      const message = `Line resolver: merge ${unitLabel(failure.unit)} onto ${failure.base}`;
      let candidate: CommitSha;
      try {
        candidate = await checkout.commitMerge(wt, message);
      } catch (error) {
        fail(`the merge could not be committed: ${messageOf(error)}`);
        continue;
      }
      if (
        failure.cause.kind === "red" &&
        (await checkout.sameTree(candidate, failure.cause.candidate))
      ) {
        fail("the candidate's tree is the same as the failing candidate's; nothing was repaired");
        continue;
      }
      if (
        !(await checkout.isAncestor(failure.base, candidate)) ||
        !(await checkout.isAncestor(commitOfUnit, candidate))
      ) {
        fail("the candidate does not contain both the line head and the unit's commit");
        continue;
      }

      const verifyWt = await checkout.open(candidate);
      opened.push(verifyWt);
      const result = await verifier.verify({
        worktree: verifyWt,
        commit: candidate,
        base: failure.base,
        deadline: failure.deadline,
      });
      last = { commit: candidate, verification: result.verification };
      if (result.timedOut || passed()) return parked(lastNote(), true);
      if (result.verification.outcome !== "passed") {
        const tails = result.logs
          .map((log) => `\`${log.command}\` exit ${log.exitCode ?? "none"}:\n${log.tail}`)
          .join("\n");
        fail(
          `the candidate ${candidate} failed verification (${result.verification.outcome}).\n${tails}`,
        );
        continue;
      }

      const examined = await agents.examine({
        brief,
        worktree: verifyWt,
        commit: candidate,
        base: failure.base,
        verification: result.verification,
        avoidModel: resolved.model,
        deadline: failure.deadline,
      });
      if (passed()) return parked(lastNote(), true);
      if (examined.model === resolved.model) {
        fail(
          `the examiner used the resolver's own model (${resolved.model}); no independent review`,
        );
        continue;
      }
      if (examined.verdict !== "approved") {
        fail(
          `the examiner rejected the candidate ${candidate}. Findings:\n${examined.findings.map((f) => `- ${f}`).join("\n")}`,
        );
        continue;
      }

      const decision: LineResolverDecision = {
        authority: "line",
        unit: failure.unit,
        base: failure.base,
        commit: candidate,
        context: `${unitLabel(failure.unit)} could not be merged onto ${failure.base}: ${failure.cause.kind === "conflict" ? `conflict in ${failure.cause.paths.join(", ")}` : "the landing checks failed"}`,
        alternatives: [
          {
            summary: "Park the range and leave it out of the line",
            rejectedBecause: "a verified, independently examined resolution was available",
          },
        ],
        choice: resolved.summary ?? "Resolved the merge by editing files",
        rationale: `Verified ${result.verification.verificationId} passed and examiner ${examined.model} approved${examined.findings.length > 0 ? `: ${examined.findings.join("; ")}` : ""}`,
        reversibility: "reversible",
        resolverModel: resolved.model,
        examinerModel: examined.model,
        attempts,
        verificationId: result.verification.verificationId,
        decidedAt: new Date(clock.now()).toISOString(),
      };
      await decisions.record(decision);
      return {
        kind: "resolved",
        commit: candidate,
        verification: result.verification,
        resolver: { decision: "resolved", attempts },
        decision,
      };
    } catch (error) {
      fail(`the attempt threw: ${messageOf(error)}`);
    } finally {
      for (const wt of opened) await checkout.close(wt).catch(() => undefined);
    }
  }
  return parked(lastNote(), false);
};
