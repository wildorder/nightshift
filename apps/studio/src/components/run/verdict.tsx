/**
 * The run's one-click verdict (D-04): Worked / Did not work. A person's word,
 * saved at once; clicking the selected button clears it. The pressed state
 * follows only the stored record, so a failed save never shows as a vote.
 */
import type {
  IsoTimestamp,
  Run,
  RunFeedback,
  UserId,
  RunVerdict as Verdict,
} from "@nightshift/contracts";
import { buildRunFeedback, isRunTerminal, type RunScope, StaleWriteError } from "@nightshift/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleHelp, CircleX, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shortSha, when } from "../../lib/format.js";
import { useStudio } from "../../studio.js";

const STATE_TEXT: Readonly<Record<Verdict, string>> = {
  worked: "Worked",
  did_not_work: "Did not work",
};

const STATE_TONE: Readonly<Record<Verdict, string>> = {
  worked: "text-status-success-foreground",
  did_not_work: "text-status-danger-foreground",
};

const STATE_ICON: Readonly<Record<Verdict | "none", typeof CircleCheck>> = {
  worked: CircleCheck,
  did_not_work: CircleX,
  none: CircleHelp,
};

/** The human acceptance state as text with an icon; never colour alone. */
export const AcceptanceState = ({ verdict }: { readonly verdict: Verdict | null }) => {
  const Icon = STATE_ICON[verdict ?? "none"];
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm font-medium ${verdict === null ? "text-muted-foreground" : STATE_TONE[verdict]}`}
      data-testid="acceptance-state"
    >
      <Icon className="size-4" aria-hidden="true" />
      {verdict === null ? "Not rated" : STATE_TEXT[verdict]}
    </span>
  );
};

const attribution = (feedback: RunFeedback | undefined): string => {
  if (feedback === undefined) return "No one has rated this run.";
  const commit =
    feedback.resultCommit === undefined ? "" : ` · result ${shortSha(feedback.resultCommit)}`;
  return feedback.verdict === null
    ? `Cleared by ${feedback.actor.userId} at ${when(feedback.recordedAt)}${commit}`
    : `Rated by ${feedback.actor.userId} at ${when(feedback.recordedAt)}${commit}`;
};

export const RunVerdict = ({ scope, run }: { readonly scope: RunScope; readonly run: Run }) => {
  const { stores, identity, orgId, now } = useStudio();
  const client = useQueryClient();
  const key = ["feedback", scope.runId] as const;
  const stored = useQuery({
    queryKey: key,
    queryFn: async () => (await stores.feedback.get(scope)) ?? null,
  });
  const save = useMutation({
    mutationFn: async (verdict: Verdict | null): Promise<void> => {
      if (identity.subject === undefined || orgId === undefined) {
        throw new Error("not signed in");
      }
      const loaded = await stores.feedback.get(scope);
      await stores.feedback.put(
        buildRunFeedback({
          ...(loaded === undefined ? {} : { stored: loaded }),
          scope,
          verdict,
          actor: { kind: "user", userId: identity.subject as UserId, orgId },
          at: now() as IsoTimestamp,
        }),
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: ["run-status", scope.runId] });
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: key });
    },
  });

  if (!isRunTerminal(run.status)) return null;

  const record = stored.data ?? undefined;
  const current = record?.verdict ?? null;
  const signedIn = identity.subject !== undefined && orgId !== undefined;
  const disabled = save.isPending || stored.isPending || !signedIn;
  const press = (verdict: Verdict) => save.mutate(current === verdict ? null : verdict);

  return (
    <div className="grid gap-2" data-testid="run-verdict">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          className="[&_svg:not([class*='size-'])]:size-5"
          variant={current === "worked" ? "default" : "outline"}
          aria-pressed={current === "worked"}
          disabled={disabled}
          onClick={() => press("worked")}
        >
          <ThumbsUp aria-hidden="true" />
          Worked
        </Button>
        <Button
          type="button"
          size="lg"
          className="[&_svg:not([class*='size-'])]:size-5"
          variant={current === "did_not_work" ? "default" : "outline"}
          aria-pressed={current === "did_not_work"}
          disabled={disabled}
          onClick={() => press("did_not_work")}
        >
          <ThumbsDown aria-hidden="true" />
          Did not work
        </Button>
        {/* A given verdict is the pressed button, labelled in words; only "Not rated" needs its own text. */}
        {current === null ? <AcceptanceState verdict={null} /> : null}
      </div>
      <p className="text-xs text-muted-foreground">{attribution(record)}</p>
      {signedIn ? null : <p className="text-xs text-muted-foreground">Sign in to rate this run.</p>}
      {save.isError ? (
        <p role="alert" className="text-sm text-status-danger-foreground">
          {save.error instanceof StaleWriteError
            ? "Could not save: someone else changed this rating; reloaded."
            : `Could not save your rating: ${save.error instanceof Error ? save.error.message : String(save.error)}`}
        </p>
      ) : null}
    </div>
  );
};
